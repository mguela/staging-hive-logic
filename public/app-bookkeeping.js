// HiveLogic Bookkeeping — expense-entry view logic.
// Ported allocation math from server/bookkeeping/src/accounting.js (distributeSalesTax,
// validateExpense) so the live reconciliation bar in the browser matches the server's
// authoritative check exactly. QBO writes, bank-feed writes, and Reina server-side
// extraction stay disabled here — see /api/bookkeeping for live flags.

(function () {
  const money = v => Math.round((Number(v) || 0) * 100) / 100;
  const fmt = v => `$${money(v).toFixed(2)}`;

  // Security: escape any EXTERNAL / user-controlled value before it is placed
  // into an innerHTML template. Keeps the five HTML-significant characters
  // inert so a crafted API response (receipt-scan OCR, QBO vendor/job names,
  // arithmetic warnings) cannot inject markup or script. Mirrors the canonical
  // helper unit-tested in test/escape-html.test.mjs.
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  // Populate a <datalist>/<select> from external names without innerHTML: every
  // option value is set via the DOM, so the string is never parsed as markup.
  function setDatalistOptions(listEl, values) {
    listEl.innerHTML = '';
    for (const v of values) {
      const opt = document.createElement('option');
      opt.value = v;
      listEl.appendChild(opt);
    }
  }

  const STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
  // ownerType value (job/subcontractor/rental/...) matches the server's own
  // suggestion table exactly (server/bookkeeping/src/accounting.js's
  // classifyExpense) and the approved hivelogic-expense-control reference's
  // owner-type list -- was previously a numeric id with no semantic meaning,
  // which meant every submission's ownerType silently didn't match what the
  // server's own classifier/validator expect. Real bug fix, not cosmetic.
  const EXPENSE_HOMES = [
    { id: '64', label: 'Job / project', value: 'job' }, { id: '65', label: 'Subcontractor', value: 'subcontractor' },
    { id: '73', label: 'Equipment / tool rental', value: 'rental' }, { id: '67', label: 'Truck', value: 'truck' },
    { id: '74', label: 'Loan payment', value: 'loan' }, { id: '68', label: 'Insurance', value: 'insurance' },
    { id: '75', label: 'Rent / lease', value: 'rent' }, { id: '76', label: 'Gas / fuel', value: 'gas' },
    { id: '77', label: 'Repairs / maintenance', value: 'maintenance' }, { id: '72', label: 'Tools / equipment', value: 'tools' },
    { id: '66', label: 'Stock inventory', value: 'inventory' }, { id: '72', label: 'Fixed asset', value: 'asset' },
    { id: '71', label: 'Overhead / office', value: 'overhead' }, { id: '69', label: 'Licenses / permits', value: 'license' },
    { id: '70', label: 'Payroll / payroll tax', value: 'payroll' }, { id: '78', label: 'Taxes', value: 'tax' },
    { id: '99', label: 'Unknown \u2014 bookkeeper must reconcile', value: 'unknown' }
  ];
  const EXPENSE_HOME_OWNER_PROMPTS = {
    job: 'Job or project', subcontractor: 'Subcontractor or company', rental: 'Rental item or agreement',
    truck: 'Truck name or unit number', loan: 'Lender or loan account', insurance: 'Policy or coverage',
    rent: 'Property or lease', gas: 'Truck or equipment', maintenance: 'Asset, truck, or property',
    tools: 'Tool, crew, or job'
  };

  let lineSeq = 0;
  const state = { lines: [], vendors: [], banks: [], expenseAccounts: [], jobs: [], evidenceId: null };

  function distributeSalesTax(lines, salesTaxTotal) {
    const taxCents = Math.round((Number(salesTaxTotal) || 0) * 100);
    const subtotals = lines.map(l => Math.max(0, Math.round((Number(l.subtotal) || 0) * 100)));
    const subtotalCents = subtotals.reduce((s, v) => s + v, 0);
    if (!taxCents || !subtotalCents) return subtotals.map(() => 0);
    const shares = subtotals.map((v, i) => ({ i, exact: taxCents * v / subtotalCents }));
    const cents = shares.map(s => Math.floor(s.exact));
    let remainder = taxCents - cents.reduce((s, v) => s + v, 0);
    shares.sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || a.i - b.i);
    for (let k = 0; k < remainder; k += 1) cents[shares[k].i] += 1;
    return cents.map(v => v / 100);
  }

  function selectOptions(select, options, placeholder) {
    select.innerHTML = '';
    if (placeholder) select.appendChild(new Option(placeholder, ''));
    for (const opt of options) select.appendChild(new Option(opt.label, opt.id ?? opt.value ?? opt));
  }

  // Expense-home options need the semantic owner type ('job', 'subcontractor', ...)
  // as the <option> value; selectOptions() above uses opt.id for every other
  // list, so this is a small dedicated helper rather than overloading it.
  function selectOwnerTypeOptions(select, options, placeholder) {
    select.innerHTML = '';
    if (placeholder) select.appendChild(new Option(placeholder, ''));
    for (const opt of options) select.appendChild(new Option(opt.label, opt.value));
  }

  const EXPENSE_HOME_DEFAULT_ACCOUNT = Object.fromEntries(EXPENSE_HOMES.map(o => [o.value, o.id]));

  function lineTemplate(line) {
    const el = document.createElement('div');
    el.className = 'bkx-line card';
    el.dataset.id = line.id;
    el.innerHTML = `
      <div class="bkx-line-head"><span class="tag">Allocation ${line.index}</span><button type="button" class="bkx-remove" data-action="remove">Remove</button></div>
      <label class="bkx-field"><span>Receipt line / material</span><input type="text" data-field="description" list="bkx-material-list" placeholder="Search the materials catalog or type the line item"></label>
      <div class="bkx-grid2">
        <label class="bkx-field"><span>Product nickname</span><input type="text" data-field="nickname" placeholder="Searchable short name"></label>
        <label class="bkx-field"><span>Vendor SKU</span><input type="text" data-field="sku" placeholder="Scanned when printed"></label>
        <label class="bkx-field"><span>Quantity</span><input type="number" min="0" step="1" data-field="quantity" value="1"></label>
        <label class="bkx-field"><span>Unit price</span><input type="number" min="0" step="0.01" data-field="unitPrice" placeholder="0.00"></label>
        <label class="bkx-field"><span>Pre-tax subtotal</span><input type="number" min="0" step="0.01" data-field="subtotal" placeholder="0.00"></label>
        <label class="bkx-field"><span>Line sales tax</span><input type="number" min="0" step="0.01" data-field="salesTaxAmount" placeholder="0.00" readonly></label>
        <label class="bkx-field"><span>Tax state</span><select data-field="salesTaxState"></select></label>
        <label class="bkx-field"><span>Expense home</span><select data-field="ownerType"></select></label>
        <label class="bkx-field"><span>Specific owner</span><input type="text" data-field="ownerId" list="bkx-job-list" placeholder="Job, truck, policy, department..."></label>
        <label class="bkx-field"><span>QBO expense account</span><select data-field="qboAccountId"><option value="">Choose QBO account</option></select></label>
      </div>
      <label class="bkx-field"><span>Line total</span><input type="number" data-field="amount" readonly></label>
      <label class="bkx-check"><input type="checkbox" data-field="billable"> Billable to customer</label>
      <label class="bkx-check"><input type="checkbox" data-field="trackQuantity"> Track quantity / inventory impact</label>
      <div class="bkx-line-actions">
        <button type="button" class="gbtn" data-action="save-catalog">Update materials catalog</button>
        <button type="button" class="gbtn" data-action="save-reusable">Save as reusable expense</button>
        <span class="tr up" data-role="catalog-match"></span>
        <span class="tr up" data-role="reina-suggest"></span>
        <button type="button" class="gbtn" data-action="use-reina-suggestion" hidden>Use Reina's suggestion</button>
      </div>`;
    selectOptions(el.querySelector('[data-field="salesTaxState"]'), STATES.map(s => ({ id: s, label: s })), 'None');
    selectOwnerTypeOptions(el.querySelector('[data-field="ownerType"]'), EXPENSE_HOMES, 'Choose a home');
    const acctSelect = el.querySelector('[data-field="qboAccountId"]');
    if (state.expenseAccounts.length) {
      selectOptions(acctSelect, state.expenseAccounts.map(a => ({ id: a.id, label: `${a.name} (${a.type})` })), 'Choose QBO account');
    }
    return el;
  }

  function addLine() {
    lineSeq += 1;
    const line = { id: `line-${lineSeq}`, index: state.lines.length + 1 };
    state.lines.push(line);
    const container = document.getElementById('bkx-lines');
    container.appendChild(lineTemplate(line));
    recalc();
  }

  function removeLine(id) {
    state.lines = state.lines.filter(l => l.id !== id);
    document.querySelector(`.bkx-line[data-id="${id}"]`)?.remove();
    document.querySelectorAll('#bkx-lines .bkx-line').forEach((el, i) => {
      el.querySelector('.tag').textContent = `Allocation ${i + 1}`;
    });
    recalc();
  }

  function readLine(el) {
    const get = f => el.querySelector(`[data-field="${f}"]`);
    return {
      el,
      description: get('description').value,
      nickname: get('nickname').value,
      sku: get('sku').value,
      quantity: Number(get('quantity').value) || 0,
      unitPrice: Number(get('unitPrice').value) || 0,
      subtotal: Number(get('subtotal').value) || 0,
      salesTaxState: get('salesTaxState').value,
      ownerType: get('ownerType').value,
      ownerId: get('ownerId').value,
      qboAccountId: get('qboAccountId').value,
      trackQuantity: get('trackQuantity') ? get('trackQuantity').checked : false
    };
  }

  // Real catalog persistence: POSTs to /api/bookkeeping/catalog, which now
  // has an actual dual-backend store behind it (api/bookkeeping/_catalog_store.js
  // + sql/021_bookkeeping_catalog.sql) instead of always returning an empty
  // list with no write route. 'save-catalog' stores this line as a
  // materials-catalog item; 'save-reusable' stores it as a reusable-expense
  // template -- same fields, different `type`, matching the type vocabulary
  // server/bookkeeping/src/catalog.js's upsertCatalogItem() already enforces.
  //
  // vendor/inventoryTracked: real gap fix (flagged, unstarted, since the
  // Phase 1 increment 7 Materials Catalog card-grid rebuild) -- both fields
  // already exist in this app's catalog schema and are already rendered by
  // app-materials.js (vendor meta row, "Tracked"/"Expense" use pill), but
  // this save path never sent them, so every item rendered through the
  // "Not assigned" fallback regardless of real data. vendor comes from the
  // whole-expense #bkx-vendor field (this app has no per-line vendor concept,
  // matching the reference's own client, which reads the same single vendor
  // field for every line's catalog save). inventoryTracked comes from the
  // existing "Track quantity / inventory impact" checkbox on this line
  // (data-field="trackQuantity") -- that checkbox already existed in the UI
  // and was already being silently dropped on save. imageUrl is deliberately
  // still not sent: this app has no product-photo upload UI and no Reina
  // scan pipeline to source one from (see reina/accounting-control-parity
  // project doc, Phase 4 increment 3) -- sending a fabricated value would be
  // worse than the honest "no image yet" fallback this already falls back to.
  async function saveLineToCatalog(lineEl, action) {
    const status = lineEl.querySelector('[data-role="catalog-match"]');
    const line = readLine(lineEl);
    if (!line.description.trim()) {
      status.textContent = 'Add a description before saving to the catalog.';
      status.classList.remove('up'); status.classList.add('dn');
      return;
    }
    status.textContent = 'Saving\u2026';
    status.classList.remove('up', 'dn');
    const vendor = (document.getElementById('bkx-vendor')?.value || '').trim();
    const payload = {
      type: action === 'save-reusable' ? 'expense' : 'material',
      name: line.description,
      nickname: line.nickname,
      sku: line.sku,
      vendor: vendor || null,
      inventoryTracked: !!line.trackQuantity,
      defaultUnitPrice: line.unitPrice || null,
      defaultQboAccountId: line.qboAccountId || null,
      defaultOwnerType: line.ownerType || null,
      defaultSalesTaxState: line.salesTaxState || null
    };
    try {
      const headers = { 'Content-Type': 'application/json' };
      const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
      if (token) headers.Authorization = 'Bearer ' + token;
      const res = await fetch('/api/bookkeeping/catalog', { method: 'POST', headers, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        status.textContent = data.error || 'Could not save this catalog item.';
        status.classList.remove('up'); status.classList.add('dn');
        return;
      }
      status.textContent = data.created ? `Added to the catalog (${data.storeBackend} backend).` : `Updated in the catalog (${data.storeBackend} backend).`;
      status.classList.remove('dn'); status.classList.add('up');
    } catch {
      status.textContent = 'Could not reach the catalog. Nothing was saved.';
      status.classList.remove('up'); status.classList.add('dn');
    }
  }

  // Task 6 -- Reina auto-suggest (suggest-only, never auto-applied without
  // an explicit human click). Calls the real, persisted suggestion route
  // (api/bookkeeping/reina-suggest.js), which itself reads Reina's real
  // approved-learning memory (api/bookkeeping/_learning_store.js) --
  // recorded automatically when a submitted expense with this same
  // vendor/sku/description was previously approved (see
  // api/bookkeeping/controls/decide-approval.js). Debounced per line so a
  // check only fires once someone finishes typing a field, not on every
  // keystroke. If HIVELOGIC_REINA_LEARNING_AUTOFILL_ENABLED is off (the
  // default), the server itself caps every suggestion's strength at
  // "review" -- this code never knows or cares which; it only ever shows
  // text and waits for an explicit click either way.
  const reinaSuggestTimers = new Map();
  const reinaSuggestions = new WeakMap();

  function checkReinaSuggestion(lineEl) {
    clearTimeout(reinaSuggestTimers.get(lineEl));
    reinaSuggestTimers.set(lineEl, setTimeout(async () => {
      const status = lineEl.querySelector('[data-role="reina-suggest"]');
      const useBtn = lineEl.querySelector('[data-action="use-reina-suggestion"]');
      if (!status || !useBtn) return;
      const vendor = (document.getElementById('bkx-vendor')?.value || '').trim();
      const line = readLine(lineEl);
      if (!vendor || (!line.sku.trim() && !line.description.trim())) {
        status.textContent = '';
        useBtn.hidden = true;
        reinaSuggestions.delete(lineEl);
        return;
      }
      try {
        const headers = { 'Content-Type': 'application/json' };
        const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
        if (token) headers.Authorization = 'Bearer ' + token;
        const res = await fetch('/api/bookkeeping/reina-suggest', {
          method: 'POST',
          headers,
          body: JSON.stringify({ vendor, sku: line.sku, description: line.description })
        });
        const data = await res.json();
        if (!res.ok || !data.ok || data.enabled === false || !data.suggestions?.length) {
          status.textContent = '';
          useBtn.hidden = true;
          reinaSuggestions.delete(lineEl);
          return;
        }
        const suggestion = data.suggestions[0];
        if (suggestion.decision === 'unknown') {
          status.textContent = '';
          useBtn.hidden = true;
          reinaSuggestions.delete(lineEl);
          return;
        }
        const homeLabel = (EXPENSE_HOMES.find(h => h.value === suggestion.ownerType) || {}).label || suggestion.ownerType;
        const strength = suggestion.decision === 'auto_fill' ? 'Reina is confident' : 'Reina suggests';
        status.textContent = `${strength}: ${homeLabel} \u00b7 account ${suggestion.qboAccountId} (${Math.round((suggestion.confidence || 0) * 100)}%, ${suggestion.support} prior approval${suggestion.support === 1 ? '' : 's'})`;
        reinaSuggestions.set(lineEl, suggestion);
        useBtn.hidden = false;
      } catch {
        status.textContent = '';
        useBtn.hidden = true;
        reinaSuggestions.delete(lineEl);
      }
    }, 500));
  }

  // Never called automatically -- only from the explicit "Use Reina's
  // suggestion" button click. Fills the same real fields a human would,
  // then dispatches change/input events so recalc() and the existing
  // ownerType change handler (which fills in a default QBO account and the
  // "unknown" styling) run exactly as if a person had picked them --
  // ownerType is set first, then qboAccountId is set last so the
  // suggestion's own account wins over that handler's generic default.
  function applyReinaSuggestion(lineEl) {
    const suggestion = reinaSuggestions.get(lineEl);
    if (!suggestion) return;
    const set = (field, value) => {
      if (value === undefined || value === null || value === '') return;
      const el = lineEl.querySelector(`[data-field="${field}"]`);
      if (!el) return;
      el.value = value;
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    };
    set('ownerType', suggestion.ownerType);
    set('ownerId', suggestion.ownerId);
    set('qboAccountId', suggestion.qboAccountId);
    const useBtn = lineEl.querySelector('[data-action="use-reina-suggestion"]');
    if (useBtn) useBtn.hidden = true;
    recalc();
  }

  function recalc() {
    const total = Number(document.getElementById('bkx-total').value) || 0;
    const taxTotal = Number(document.getElementById('bkx-tax-total').value) || 0;
    const rows = [...document.querySelectorAll('#bkx-lines .bkx-line')];
    const lines = rows.map(readLine);
    const taxShares = distributeSalesTax(lines, taxTotal);
    let assigned = 0;
    rows.forEach((el, i) => {
      const line = lines[i];
      const lineTax = taxShares[i] || 0;
      const lineTotal = money(line.subtotal + lineTax);
      el.querySelector('[data-field="salesTaxAmount"]').value = lineTax ? lineTax.toFixed(2) : '';
      el.querySelector('[data-field="amount"]').value = lineTotal ? lineTotal.toFixed(2) : '';
      assigned += lineTotal;
    });
    document.getElementById('bkx-recon-total').textContent = fmt(total);
    document.getElementById('bkx-recon-assigned').textContent = fmt(assigned);
    const diff = money(total - assigned);
    const diffEl = document.getElementById('bkx-recon-diff');
    diffEl.textContent = fmt(diff);
    diffEl.className = Math.abs(diff) < 0.005 ? 'good' : 'bad';
    updateControlChecks({ total, assigned, diff, lines });
    updateFinalizationRule(diff);
    updateBookkeeperAlert(lines);
  }

  function updateFinalizationRule(diff) {
    const el = document.getElementById('bkx-rule-text');
    if (!el) return;
    el.textContent = Math.abs(diff) < 0.005 ? 'Every dollar has a home.' : `${fmt(Math.abs(diff))} still needs a home`;
  }

  function updateBookkeeperAlert(lines) {
    const alert = document.getElementById('bkx-bookkeeper-alert');
    if (!alert) return;
    const unknownCount = lines.filter(l => l.ownerType === 'unknown').length;
    alert.style.display = unknownCount ? 'flex' : 'none';
    if (unknownCount) {
      document.getElementById('bkx-bookkeeper-alert-text').textContent =
        `${unknownCount} line${unknownCount === 1 ? '' : 's'} on this expense ${unknownCount === 1 ? 'is' : 'are'} routed to Unrecorded Expenses until a bookkeeper reconciles ${unknownCount === 1 ? 'it' : 'them'}.`;
    }
  }

  function updateControlChecks({ total, assigned, diff, lines }) {
    const vendor = document.getElementById('bkx-vendor').value.trim();
    const date = document.getElementById('bkx-date').value;
    const paidFrom = document.getElementById('bkx-paid-from').value;
    const treatment = document.getElementById('bkx-treatment').value;
    const evidenceAttached = document.getElementById('bkx-attached-badge').style.display !== 'none';
    const taxState = document.getElementById('bkx-tax-state').value;
    const taxTotal = Number(document.getElementById('bkx-tax-total').value) || 0;

    const vendorKnown = !vendor || state.vendors.length === 0 || state.vendors.some(v => (v.name || '').trim().toLowerCase() === vendor.toLowerCase());
    const checks = [
      { id: 'txn', label: 'Transaction and payment / bill terms', ok: !!vendor && !!date && (treatment === 'bill' ? !!document.getElementById('bkx-due-date').value : !!paidFrom) },
      { id: 'vendorKnown', label: 'Vendor/sub matches a known QuickBooks vendor', ok: vendorKnown },
      { id: 'evidence', label: 'Receipt stored as evidence', ok: evidenceAttached },
      { id: 'owners', label: 'Every line has an owner or is flagged unknown', ok: lines.length > 0 && lines.every(l => l.ownerType) },
      { id: 'accounts', label: 'Every line has a QBO account', ok: lines.length > 0 && lines.every(l => l.qboAccountId) },
      { id: 'tax', label: 'Tax assigned by state', ok: taxTotal <= 0 || !!taxState },
      { id: 'zero', label: 'Allocated with zero difference', ok: total > 0 && Math.abs(diff) < 0.005 }
    ];

    document.getElementById('bkx-vendor').classList.toggle('bkx-invalid', !vendor || !vendorKnown);
    document.getElementById('bkx-date').classList.toggle('bkx-invalid', !date);
    document.getElementById('bkx-tax-state').classList.toggle('bkx-invalid', taxTotal > 0 && !taxState);
    if (treatment === 'bill') {
      document.getElementById('bkx-due-date').classList.toggle('bkx-invalid', !document.getElementById('bkx-due-date').value);
      document.getElementById('bkx-paid-from').classList.remove('bkx-invalid');
    } else {
      document.getElementById('bkx-paid-from').classList.toggle('bkx-invalid', !paidFrom);
      document.getElementById('bkx-due-date').classList.remove('bkx-invalid');
    }
    const list = document.getElementById('bkx-control-list');
    list.innerHTML = checks.map(c => `<li class="${c.ok ? 'good' : ''}">${c.ok ? '&#10003;' : '&#9675;'} ${c.label}</li>`).join('');
    const allPass = checks.every(c => c.ok);
    document.getElementById('bkx-control-headline').textContent = allPass
      ? 'This expense is ready to submit.'
      : 'This expense is not ready';
    document.getElementById('bkx-submit').disabled = !allPass;
  }

  function markAttached(name) {
    document.getElementById('bkx-attached-name').textContent = name;
    document.getElementById('bkx-attached-name').style.display = 'block';
    document.getElementById('bkx-attached-badge').style.display = 'inline';
  }

  function clearAttached(message) {
    state.evidenceId = null;
    document.getElementById('bkx-attached-badge').style.display = 'none';
    const nameEl = document.getElementById('bkx-attached-name');
    nameEl.textContent = message || '';
    nameEl.style.display = message ? 'block' : 'none';
    hideEvidencePreview();
  }

  // Real evidence thumbnail + full-screen viewer -- backed by the actual
  // /api/bookkeeping/evidence GET route (api/bookkeeping/evidence.js +
  // _evidence_store.js), not a client-only blob preview. Matches the
  // approved hivelogic-expense-control reference's showReceiptDocument()/
  // openReceiptViewer() behavior (thumbnail with an 'Open full screen'
  // overlay, plus a <dialog> full-screen viewer), bkx-prefixed ids to match
  // this app's existing naming convention.
  let evidenceDoc = null;

  // Real bug fix (2026-07-24): api/bookkeeping/evidence.js's GET handler
  // requires a trusted server-verified actor (getTrustedActor()) for EVERY
  // request, including fetching a document's raw bytes -- but a plain
  // <img src="..."> or <iframe src="..."> request from the browser can never
  // attach an Authorization header. That meant the thumbnail and full-screen
  // viewer always 401'd (broken image / blank PDF frame) even on documents
  // that uploaded successfully. Fix: fetch the bytes with the same Bearer
  // token every other authenticated call in this file already uses, then
  // point the <img>/<iframe> at an in-memory blob: URL instead of the raw
  // API URL. Revokes the previous blob URL first so repeated previews don't
  // leak memory.
  let evidenceBlobUrl = null;
  async function fetchEvidenceBlobUrl(id) {
    const headers = {};
    const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(`/api/bookkeeping/evidence?id=${encodeURIComponent(id)}`, { headers });
    if (!res.ok) throw new Error(`Could not load this document (status ${res.status}).`);
    const blob = await res.blob();
    if (evidenceBlobUrl) URL.revokeObjectURL(evidenceBlobUrl);
    evidenceBlobUrl = URL.createObjectURL(blob);
    return evidenceBlobUrl;
  }

  async function showEvidencePreview(evidence) {
    const wrap = document.getElementById('bkx-evidence-preview');
    if (!wrap || !evidence) return;
    const isPdf = evidence.mimeType === 'application/pdf' || /\.pdf$/i.test(evidence.filename || '');
    evidenceDoc = { id: evidence.id, fileName: evidence.filename || 'Receipt', isPdf };
    wrap.style.display = 'flex';
    document.getElementById('bkx-evidence-name').textContent = evidence.filename || 'Receipt';
    const size = evidence.sizeBytes
      ? (evidence.sizeBytes >= 1024 * 1024 ? `${(evidence.sizeBytes / 1024 / 1024).toFixed(1)} MB` : `${(evidence.sizeBytes / 1024).toFixed(1)} KB`)
      : '';
    document.getElementById('bkx-evidence-detail').textContent =
      `${isPdf ? 'PDF document' : 'Receipt image'}${size ? ` \u00b7 ${size}` : ''} \u00b7 sha256 ${String(evidence.sha256 || '').slice(0, 12)}\u2026`;
    const img = document.getElementById('bkx-evidence-thumb-image');
    const pdf = document.getElementById('bkx-evidence-thumb-pdf');
    img.style.display = isPdf ? 'none' : 'block';
    pdf.style.display = isPdf ? 'block' : 'none';
    try {
      const blobUrl = await fetchEvidenceBlobUrl(evidence.id);
      if (isPdf) pdf.src = `${blobUrl}#page=1&view=FitH&toolbar=0&navpanes=0&scrollbar=0`;
      else img.src = blobUrl;
    } catch (err) {
      document.getElementById('bkx-evidence-detail').textContent += ` \u2014 preview failed: ${err.message}`;
    }
  }

  function hideEvidencePreview() {
    evidenceDoc = null;
    const wrap = document.getElementById('bkx-evidence-preview');
    if (wrap) wrap.style.display = 'none';
  }

  async function openEvidenceViewer() {
    if (!evidenceDoc) return;
    const { id, fileName, isPdf } = evidenceDoc;
    document.getElementById('bkx-evidence-viewer-title').textContent = fileName;
    const img = document.getElementById('bkx-evidence-viewer-image');
    const pdf = document.getElementById('bkx-evidence-viewer-pdf');
    img.style.display = isPdf ? 'none' : 'block';
    pdf.style.display = isPdf ? 'block' : 'none';
    document.getElementById('bkx-evidence-viewer').showModal();
    try {
      // Reuses the already-fetched blob: URL from showEvidencePreview() when
      // available (same document, no second network round-trip); only
      // re-fetches if the viewer is somehow opened without a prior preview.
      const blobUrl = evidenceBlobUrl || await fetchEvidenceBlobUrl(id);
      if (isPdf) pdf.src = `${blobUrl}#page=1&view=FitH&toolbar=1&navpanes=1`;
      else img.src = blobUrl;
    } catch (err) {
      document.getElementById('bkx-evidence-viewer-title').textContent = `${fileName} \u2014 preview failed: ${err.message}`;
    }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',').pop());
      reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
      reader.readAsDataURL(file);
    });
  }

  async function uploadEvidence(file) {
    if (!file) return;
    clearAttached(`Uploading ${file.name}…`);
    try {
      const dataBase64 = await fileToBase64(file);
      const headers = { 'Content-Type': 'application/json' };
      // Same real Supabase session token every other write route in this file
      // attaches (saveExpense, saveLineToCatalog) -- api/bookkeeping/evidence.js's
      // POST handler requires a trusted server-verified actor via getTrustedActor(),
      // so a request with no Authorization header always 401s. This call was
      // missing that header entirely, meaning every photo/scan/drag-drop upload
      // silently failed in production (caught below and shown as 'Could not
      // reach the evidence vault', which reads like a network error, not an
      // auth bug) -- confirmed live via a direct fetch test on 2026-07-24 before
      // this fix (401 without the header, 200 with it).
      const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
      if (token) headers.Authorization = 'Bearer ' + token;
      const res = await fetch('/api/bookkeeping/evidence', {
        method: 'POST',
        headers,
        body: JSON.stringify({ filename: file.name, mimeType: file.type || 'application/octet-stream', dataBase64 })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        clearAttached(`Could not save this file: ${data.error || 'upload failed'}`);
        recalc();
        return;
      }
      state.evidenceId = data.evidence.id;
      markAttached(file.name);
      showEvidencePreview(data.evidence);
      await scanEvidenceWithReina(data.evidence.id);
    } catch {
      clearAttached('Could not reach the evidence vault. Nothing was uploaded.');
    }
    recalc();
  }


  // Task 8 -- Reina receipt scan (OCR). Fires automatically right after a
  // successful evidence upload -- this is exactly what the "Reina receipt
  // scan" card at the top of this page has always promised ("Reina reads
  // the receipt and recommends where the expense belongs") but had no real
  // route behind it until api/bookkeeping/receipt-scan.js. Suggest-only,
  // same standing rule as Reina's line-level suggestions below: every
  // scanned value requires an explicit "Use" click before it touches a real
  // field. Nothing here ever auto-saves or auto-submits the expense.
  async function scanEvidenceWithReina(evidenceId) {
    const statusEl = document.getElementById('bkx-reina-status');
    const oldPanel = document.getElementById('bkx-reina-scan-panel');
    if (oldPanel) oldPanel.remove();
    statusEl.style.display = 'block';
    statusEl.textContent = 'Reina is reading the receipt…';
    try {
      const headers = { 'Content-Type': 'application/json' };
      const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
      if (token) headers.Authorization = 'Bearer ' + token;
      const res = await fetch('/api/bookkeeping/receipt-scan', {
        method: 'POST',
        headers,
        body: JSON.stringify({ evidenceId })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        statusEl.textContent = `Reina could not read this document: ${data.error || 'scan failed'}. Fill in the fields yourself below.`;
        return;
      }
      if (data.enabled === false) { statusEl.style.display = 'none'; return; }
      if (data.scannable === false) {
        statusEl.textContent = data.note || 'Reina cannot read this file type. Fill in the fields yourself below.';
        return;
      }
      if (!data.configured) {
        statusEl.textContent = 'Reina is not yet connected to an AI reader on this deployment — fill in the fields yourself for now.';
        return;
      }
      statusEl.textContent = 'Reina read the receipt below. Review each value, then click "Use" to fill in a field — nothing is filled in automatically.';
      renderReinaScanPanel(data.scan);
    } catch {
      statusEl.textContent = 'Could not reach Reina to scan this document. Fill in the fields yourself below.';
    }
  }

  function reinaScanFieldRow(scan, field, label, formatter) {
    const value = scan[field];
    if (value === null || value === undefined || value === '') return '';
    const decision = (scan.fieldDecisions || {})[field] || {};
    const pct = Math.round((decision.confidence || 0) * 100);
    const tagClass = decision.decision === 'auto_fill' ? 'up' : 'dn';
    const tagText = decision.decision === 'auto_fill' ? 'confident' : (decision.decision === 'review' ? 'needs review' : 'unsure');
    return `<div class="bkx-line-actions" data-scan-row="${field}" style="margin-top:6px">
      <span><b>${label}:</b> ${escapeHtml(formatter ? formatter(value) : value)}</span>
      <span class="tr ${tagClass}">${tagText} · ${pct}%</span>
      <button type="button" class="gbtn" data-scan-use="${field}">Use</button>
    </div>`;
  }

  function renderReinaScanPanel(scan) {
    const card = document.getElementById('bkx-reina-card');
    if (!card) return;
    const old = document.getElementById('bkx-reina-scan-panel');
    if (old) old.remove();
    const panel = document.createElement('div');
    panel.id = 'bkx-reina-scan-panel';
    panel.style.marginTop = '12px';

    const money = v => `$${Number(v || 0).toFixed(2)}`;
    const warnings = (scan.reviewSummary && scan.reviewSummary.arithmeticWarnings) || [];
    const lineItems = Array.isArray(scan.lineItems) ? scan.lineItems : [];

    panel.innerHTML = `
      <p style="margin:0 0 8px">${scan.reviewSummary && scan.reviewSummary.requiresReview
        ? '<b class="bad">Reina flagged this scan for review before you save.</b>'
        : '<b class="good">Reina is confident in this read.</b>'}</p>
      ${warnings.map(w => `<div class="note" style="display:block;margin-bottom:6px">${escapeHtml(w)}</div>`).join('')}
      ${reinaScanFieldRow(scan, 'vendor', 'Vendor')}
      ${reinaScanFieldRow(scan, 'transactionDate', 'Transaction date')}
      ${reinaScanFieldRow(scan, 'subtotal', 'Subtotal', money)}
      ${reinaScanFieldRow(scan, 'salesTaxTotal', 'Sales tax', money)}
      ${reinaScanFieldRow(scan, 'salesTaxState', 'Sales-tax state')}
      ${reinaScanFieldRow(scan, 'total', 'Total', money)}
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="gbtn go" id="bkx-scan-use-all">Use all fields above</button>
        ${lineItems.length ? `<button type="button" class="gbtn" id="bkx-scan-add-lines">Add ${lineItems.length} scanned line item${lineItems.length === 1 ? '' : 's'}</button>` : ''}
      </div>
    `;
    card.appendChild(panel);

    panel.querySelectorAll('[data-scan-use]').forEach(btn => {
      btn.addEventListener('click', () => applyReinaScanField(btn.dataset.scanUse, scan));
    });
    const useAllBtn = document.getElementById('bkx-scan-use-all');
    if (useAllBtn) useAllBtn.addEventListener('click', () => {
      ['vendor', 'transactionDate', 'subtotal', 'salesTaxTotal', 'salesTaxState', 'total'].forEach(f => applyReinaScanField(f, scan));
    });
    const addLinesBtn = document.getElementById('bkx-scan-add-lines');
    if (addLinesBtn) addLinesBtn.addEventListener('click', () => addScannedLines(lineItems));
  }

  // Never auto-applies -- only ever called from an explicit "Use" click
  // (single field or "Use all fields above"). Mirrors applyReinaSuggestion's
  // own dispatch-a-real-input-event pattern below so recalc() and every
  // other listener on these fields fire exactly as if a person had typed
  // the value in themselves.
  const REINA_SCAN_FIELD_TO_INPUT = {
    vendor: 'bkx-vendor', transactionDate: 'bkx-date', subtotal: 'bkx-subtotal',
    salesTaxTotal: 'bkx-tax-total', salesTaxState: 'bkx-tax-state', total: 'bkx-total'
  };
  function applyReinaScanField(field, scan) {
    const inputId = REINA_SCAN_FIELD_TO_INPUT[field];
    if (!inputId) return;
    const el = document.getElementById(inputId);
    const value = scan[field];
    if (!el || value === null || value === undefined || value === '') return;
    el.value = value;
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  }

  // Adds one real receipt line (via the existing addLine()) per scanned
  // line item and fills only the fields Reina actually read -- ownership
  // (Expense home / Specific owner / QBO account) is deliberately left for
  // the human or for checkReinaSuggestion()'s own separate approved-learning
  // suggestion (triggered here explicitly, same as a real focusout would),
  // never guessed by the document reader itself.
  function addScannedLines(lineItems) {
    lineItems.forEach(item => {
      addLine();
      const rows = document.querySelectorAll('#bkx-lines .bkx-line');
      const row = rows[rows.length - 1];
      if (!row) return;
      const set = (field, value) => {
        if (value === undefined || value === null || value === '') return;
        const el = row.querySelector(`[data-field="${field}"]`);
        if (!el) return;
        el.value = value;
        el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      };
      set('description', item.description);
      set('nickname', item.nickname);
      set('sku', item.sku);
      if (item.quantity) set('quantity', item.quantity);
      if (item.unitPrice) set('unitPrice', item.unitPrice);
      if (item.subtotal !== undefined && item.subtotal !== null) set('subtotal', item.subtotal);
      checkReinaSuggestion(row);
    });
    recalc();
  }

  function wireEvents() {
    document.getElementById('bkx-add-line').addEventListener('click', addLine);
    document.getElementById('bkx-lines').addEventListener('click', e => {
      const action = e.target.dataset.action;
      const lineEl = e.target.closest('.bkx-line');
      if (!lineEl) return;
      if (action === 'remove') removeLine(lineEl.dataset.id);
      if (action === 'save-catalog' || action === 'save-reusable') saveLineToCatalog(lineEl, action);
      if (action === 'use-reina-suggestion') applyReinaSuggestion(lineEl);
    });
    document.getElementById('bkx-lines').addEventListener('input', recalc);
    document.getElementById('bkx-lines').addEventListener('focusout', e => {
      if (!['sku', 'description'].includes(e.target.dataset.field)) return;
      const lineEl = e.target.closest('.bkx-line');
      if (lineEl) checkReinaSuggestion(lineEl);
    });
    document.getElementById('bkx-lines').addEventListener('change', e => {
      if (e.target.dataset.field !== 'ownerType') return;
      const row = e.target.closest('.bkx-line');
      const ownerIdInput = row.querySelector('[data-field="ownerId"]');
      const acctSelect = row.querySelector('[data-field="qboAccountId"]');
      const isUnknown = e.target.value === 'unknown';
      row.classList.toggle('unknown', isUnknown);
      if (isUnknown) {
        ownerIdInput.value = 'Unknown \u2014 needs reconciliation';
        acctSelect.value = '99';
      } else {
        if (ownerIdInput.value === 'Unknown \u2014 needs reconciliation') ownerIdInput.value = '';
        const defaultAccount = EXPENSE_HOME_DEFAULT_ACCOUNT[e.target.value];
        if (defaultAccount && !acctSelect.value) acctSelect.value = defaultAccount;
      }
      ownerIdInput.placeholder = EXPENSE_HOME_OWNER_PROMPTS[e.target.value] || 'Job, truck, policy, department\u2026';
      recalc();
    });
    ['bkx-total', 'bkx-tax-total', 'bkx-tax-state', 'bkx-vendor', 'bkx-date', 'bkx-due-date', 'bkx-paid-from', 'bkx-treatment']
      .forEach(id => document.getElementById(id).addEventListener('input', recalc));
    document.getElementById('bkx-vendor').addEventListener('change', () => {
      document.querySelectorAll('#bkx-lines .bkx-line').forEach(checkReinaSuggestion);
    });
    // Auto-align payment type when a credit card account is chosen -- Kevin UAT:
    // selecting a Credit Card payment account should set Payment type to Credit
    // card automatically instead of leaving it on whatever it defaulted to.
    document.getElementById('bkx-paid-from').addEventListener('change', (e) => {
      const acct = state.banks.find(a => String(a.id) === e.target.value);
      if (acct && acct.type === 'Credit Card') {
        document.getElementById('bkx-payment-type').value = 'CreditCard';
      }
    });
    document.getElementById('bkx-treatment').addEventListener('change', () => {
      const isBill = document.getElementById('bkx-treatment').value === 'bill';
      document.getElementById('bkx-due-date-field').style.display = isBill ? '' : 'none';
      document.getElementById('bkx-paid-from-field').style.display = isBill ? 'none' : '';
      document.getElementById('bkx-payment-type-field').style.display = isBill ? 'none' : '';
      recalc();
    });
    const fileInput = document.getElementById('bkx-file-input');
    document.getElementById('bkx-photo-receipt').addEventListener('click', () => fileInput.click());
    document.getElementById('bkx-choose-file').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) uploadEvidence(fileInput.files[0]); });
    const dropzone = document.getElementById('bkx-dropzone');
    dropzone.addEventListener('dragover', e => e.preventDefault());
    dropzone.addEventListener('drop', e => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) uploadEvidence(file);
    });
    document.getElementById('bkx-save-draft').addEventListener('click', () => saveExpense('draft'));
    document.getElementById('bkx-submit').addEventListener('click', () => saveExpense('submitted'));
    document.getElementById('bkx-evidence-thumb-open')?.addEventListener('click', openEvidenceViewer);
    document.getElementById('bkx-evidence-view-full')?.addEventListener('click', openEvidenceViewer);
    const viewerDialog = document.getElementById('bkx-evidence-viewer');
    document.getElementById('bkx-evidence-viewer-close')?.addEventListener('click', () => viewerDialog.close());
    viewerDialog?.addEventListener('click', e => { if (e.target === viewerDialog) viewerDialog.close(); });
  }

  function ensureJobList() {
    let list = document.getElementById('bkx-job-list');
    if (!list) {
      list = document.createElement('datalist');
      list.id = 'bkx-job-list';
      document.body.appendChild(list);
    }
    return list;
  }

  // Wires the description field's placeholder promise ("Search the materials
  // catalog") to a real datalist -- previously plain free text with zero
  // suggestions despite the label. Reuses the same trusted-actor auth as
  // loadOpenPurchaseOrders() since /api/bookkeeping/catalog requires it.
  function ensureMaterialList() {
    let list = document.getElementById('bkx-material-list');
    if (!list) {
      list = document.createElement('datalist');
      list.id = 'bkx-material-list';
      document.body.appendChild(list);
    }
    return list;
  }

  async function loadMaterialsCatalog() {
    const list = ensureMaterialList();
    try {
      const headers = {};
      const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
      if (token) headers.Authorization = 'Bearer ' + token;
      const res = await fetch('/api/bookkeeping/catalog', { headers });
      const data = await res.json();
      if (!res.ok || !data.ok || data.enabled === false) return;
      const names = Array.from(new Set((data.items || []).map(i => i.name).filter(Boolean)));
      setDatalistOptions(list, names);
    } catch {
      // Leave the datalist empty -- never block init(), typing still works.
    }
  }

  async function loadReferenceData() {
    selectOptions(document.getElementById('bkx-tax-state'), STATES.map(s => ({ id: s, label: s })), 'Choose state');
    let data = null;
    try {
      const res = await fetch('/api/bookkeeping/reference-data?resource=all');
      data = await res.json();
    } catch { data = null; }

    if (!data || data.ok === false) {
      state.vendors = []; state.expenseAccounts = []; state.jobs = [];
      selectOptions(document.getElementById('bkx-paid-from'), [], 'Choose bank or card');
      document.getElementById('bkx-vendor-count').textContent = 'Could not reach QBO reference data. Nothing was loaded.';
      return;
    }

    state.vendors = data.vendors || [];
    state.jobs = data.jobs || [];
    state.expenseAccounts = data.expenseAccounts || [];

    const vendorList = document.getElementById('bkx-vendor-list');
    setDatalistOptions(vendorList, state.vendors.map(v => v.name).filter(Boolean));
    document.getElementById('bkx-vendor-count').textContent = data.vendorsError
      ? `QBO vendor sync error: ${data.vendorsError}`
      : (state.vendors.length ? `${state.vendors.length} QBO vendors & subs synced` : 'No QBO vendors returned yet.');

    const jobList = ensureJobList();
    setDatalistOptions(jobList, state.jobs.map(j => (j.jobNumber ? `Job #${j.jobNumber} — ${j.title}` : j.title)));

    const bankAccounts = data.bankAccounts || [];
    state.banks = bankAccounts;
    selectOptions(document.getElementById('bkx-paid-from'), bankAccounts.map(a => ({ id: a.id, label: `${a.name} (${a.type})` })),
      bankAccounts.length ? 'Choose bank or card' : (data.accountsError ? `QBO account error: ${data.accountsError}` : 'No QBO bank/card accounts found'));

    // Any receipt lines already rendered before this resolved (shouldn't happen
    // now that init() awaits loadReferenceData first, but stays safe if that changes)
    // get their QBO account dropdown backfilled instead of staying stuck on the
    // placeholder-only option.
    document.querySelectorAll('#bkx-lines .bkx-line [data-field="qboAccountId"]').forEach(sel => {
      if (state.expenseAccounts.length && sel.options.length <= 1) {
        selectOptions(sel, state.expenseAccounts.map(a => ({ id: a.id, label: `${a.name} (${a.type})` })), 'Choose QBO account');
      }
    });
  }

  async function loadOpenPurchaseOrders() {
    const select = document.getElementById('bkx-po-link');
    if (!select) return;
    try {
      const headers = {};
      // Same trusted-actor auth this file already attaches in saveExpense()
      // -- unlike /api/bookkeeping/reference-data, the purchase-orders list
      // route requires a verified actor, not just a public GET.
      const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
      if (token) headers.Authorization = 'Bearer ' + token;
      const res = await fetch('/api/bookkeeping/purchase-orders/list', { headers });
      const data = await res.json();
      if (!res.ok || !data.ok || data.enabled === false) return;
      const eligible = (data.purchaseOrders || []).filter(po => ['ordered', 'partially_received', 'fully_received'].includes(po.lifecycleStatus));
      eligible.forEach(po => {
        select.appendChild(new Option(`${po.poNumber} — ${po.vendorName || 'No vendor'} (${po.jobId || po.overheadCategory || 'Overhead'})`, po.id));
      });
    } catch {
      // Leave the select at its single default option -- never block init().
    }
  }

  async function saveExpense(status) {
    if (!state.evidenceId) {
      const statusEl = document.getElementById('bkx-reina-status');
      statusEl.style.display = 'block';
      statusEl.textContent = 'Attach a receipt or document first — nothing was saved.';
      return;
    }
    const payload = buildPayload(status);
    try {
      const headers = { 'Content-Type': 'application/json' };
      // Same real Supabase session token every other page in this app already
      // attaches (see index.html / app-purchase-orders.js's api() helper) --
      // required now that this route verifies a trusted actor server-side.
      const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
      if (token) headers.Authorization = 'Bearer ' + token;
      const res = await fetch('/api/bookkeeping/expenses', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      const statusEl = document.getElementById('bkx-reina-status');
      statusEl.style.display = 'block';
      statusEl.textContent = res.ok
        ? (status === 'draft' ? `Saved as draft. ${data.note || ''}` : `Submitted for review. ${data.note || ''}`)
        : `Not saved: ${data.error || 'validation failed'}`;
    } catch {
      const statusEl = document.getElementById('bkx-reina-status');
      statusEl.style.display = 'block';
      statusEl.textContent = 'Could not reach the bookkeeping API. Nothing was saved.';
    }
  }

  function buildPayload(status) {
    const rows = [...document.querySelectorAll('#bkx-lines .bkx-line')].map(readLine);
    return {
      status,
      transactionKind: document.getElementById('bkx-treatment').value,
      vendor: document.getElementById('bkx-vendor').value,
      transactionDate: document.getElementById('bkx-date').value,
      dueDate: document.getElementById('bkx-due-date').value,
      receiptSubtotal: Number(document.getElementById('bkx-subtotal').value) || 0,
      salesTaxTotal: Number(document.getElementById('bkx-tax-total').value) || 0,
      total: Number(document.getElementById('bkx-total').value) || 0,
      paymentAccountId: document.getElementById('bkx-paid-from').value,
      paymentType: document.getElementById('bkx-payment-type').value,
      reference: document.getElementById('bkx-reference').value,
      memo: document.getElementById('bkx-memo').value,
      poId: document.getElementById('bkx-po-link')?.value || null,
      evidenceId: state.evidenceId,
      allocations: rows.map(l => ({
        description: l.description, nickname: l.nickname, sku: l.sku, quantity: l.quantity, unitPrice: l.unitPrice,
        subtotal: l.subtotal, salesTaxState: l.salesTaxState, ownerType: l.ownerType, ownerId: l.ownerId, qboAccountId: l.qboAccountId
      }))
    };
  }

  // Real "reuse this catalog item" hand-off from the Materials Catalog
  // page's "Use / edit" action (app-materials.js), matching the approved
  // reference's /?new=1&material=<id> deep link -- adapted for this app's
  // single-page tab layout instead of a page navigation. app-materials.js
  // stashes the chosen catalog item on window.__hlPendingCatalogReuse and
  // switches to this tab; this picks it up after the first blank line is
  // added and fills it with the item's own real saved fields (never
  // fabricated -- fields the item doesn't have are simply left blank).
  function applyPendingCatalogReuse() {
    const item = window.__hlPendingCatalogReuse;
    if (!item) return;
    window.__hlPendingCatalogReuse = null;
    const rows = document.querySelectorAll('#bkx-lines .bkx-line');
    const row = rows[rows.length - 1];
    if (!row) return;
    const set = (field, value) => {
      if (value === undefined || value === null || value === '') return;
      const el = row.querySelector(`[data-field="${field}"]`);
      if (!el) return;
      el.value = value;
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    };
    set('description', item.nickname || item.name);
    set('nickname', item.nickname);
    set('sku', item.sku);
    set('unitPrice', item.defaultUnitPrice);
    set('salesTaxState', item.defaultSalesTaxState);
    set('ownerType', item.defaultOwnerType);
    set('qboAccountId', item.defaultQboAccountId);
    recalc();
  }

  async function init() {
    if (!document.getElementById('bkx-lines')) return;
    document.getElementById('bkx-date').value = new Date().toISOString().slice(0, 10);
    wireEvents();
    await Promise.all([loadReferenceData(), loadOpenPurchaseOrders(), loadMaterialsCatalog()]);
    addLine();
    applyPendingCatalogReuse();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Exposed so the Expenses sub-nav can (re)run init once this fragment is
  // fetched into the DOM -- see the exp-subnav wiring in index.html. init()
  // itself is idempotent-safe: it no-ops unless #bkx-lines exists.
  window.hlInitBookkeeping = init;
})();
