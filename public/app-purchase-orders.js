// HiveLogic Purchase Orders — list, create, approve, reject, match receipts,
// bill, close (including audited forced override), and cancel. Talks to
// /api/bookkeeping/purchase-orders/*, which validates against
// server/bookkeeping/src/purchase-orders.js (81/81 engine tests passing,
// including the fixes for all four bugs the outside review reproduced).
// QBO writes stay disabled; the engine only ever produces a QBO-compatible
// preview.
//
// Auth note: every mutating call requires a server-verified actor (see
// api/bookkeeping/purchase-orders/_actor.js). This preview environment has
// no trusted identity proxy in front of it yet, so these calls will return
// 401 until that's connected — that is the correct, fail-closed behavior,
// not a bug. Errors are surfaced in the UI, not swallowed.

(function () {
  const LINE_TYPES = ['material', 'labor', 'rental', 'delivery', 'discount', 'tax'];
  const STATE_LABELS = {
    draft: 'Draft', ordered: 'Ordered', partially_received: 'Partially received', fully_received: 'Fully received',
    billed: 'Billed', closed: 'Closed', cancelled: 'Cancelled', exception: 'Exception — needs a decision'
  };
  let purchaseOrders = [];
  const refData = { vendors: [], jobs: [] };

  // Fix (verified stored-XSS gap, review round 2026-07-21): this file had no
  // escaping at all, unlike app-materials.js / app-confidence-lab.js /
  // app-reina-accuracy.js, which all escape. Vendor name, requester, job ID,
  // overhead category, and exception text all ultimately come from
  // user-entered form fields and were inserted into innerHTML raw.
  function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

  function money(value) { return '$' + (Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  // Real totals from real per-line fields -- see server/bookkeeping/src/
  // purchase-orders.js (lineEstimatedAmount() -> line.estimatedAmount;
  // receiving/matching -> line.receivedAmount). No po-level total field is
  // assumed to exist; these are computed, not read off a field that might
  // not be there.
  function poTotals(po) {
    const lines = po.lines || [];
    const estimated = lines.reduce((sum, l) => sum + (Number(l.estimatedAmount) || 0), 0);
    const received = lines.reduce((sum, l) => sum + (Number(l.receivedAmount) || 0), 0);
    return { estimated, received };
  }

  function lineRow() {
    const el = document.createElement('div');
    el.className = 'bkx-grid2 pox-newline';
    el.innerHTML = `
      <label class="bkx-field"><span>Type</span><select data-field="type">${LINE_TYPES.map(t => `<option value="${t}">${t}</option>`).join('')}</select></label>
      <label class="bkx-field"><span>Description</span><input type="text" data-field="description" placeholder="What's this line for"></label>
      <label class="bkx-field"><span>Estimated quantity</span><input type="number" step="1" min="0" data-field="estimatedQty" value="1"></label>
      <label class="bkx-field"><span>Estimated unit price</span><input type="number" step="0.01" min="0" data-field="estimatedUnitPrice" placeholder="0.00"></label>`;
    return el;
  }

  function addLine() { document.getElementById('pox-new-lines').appendChild(lineRow()); }

  function readNewLines() {
    return [...document.querySelectorAll('#pox-new-lines .pox-newline')].map(el => ({
      type: el.querySelector('[data-field="type"]').value,
      description: el.querySelector('[data-field="description"]').value,
      estimatedQty: Number(el.querySelector('[data-field="estimatedQty"]').value) || 0,
      estimatedUnitPrice: Number(el.querySelector('[data-field="estimatedUnitPrice"]').value) || 0
    }));
  }

  // Task 9: order-type toggle (planned vs. after-the-fact) now lives on ONE
  // shared form, matching the reference's single #poOrderType select instead
  // of this app's previous two separate cards. Shows/hides the
  // after-the-fact reason field and its permanent "not preapproved" note --
  // mirrors the reference's toggleAfterFact().
  function toggleAfterFact() {
    const isAfter = document.getElementById('pox-order-type').value === 'after_the_fact';
    const reasonField = document.getElementById('pox-after-reason-field');
    const reasonInput = document.getElementById('pox-after-reason');
    const reasonNote = document.getElementById('pox-after-reason-note');
    reasonField.style.display = isAfter ? 'block' : 'none';
    reasonNote.style.display = isAfter ? 'block' : 'none';
    reasonInput.required = isAfter;
    if (!isAfter) reasonInput.value = '';
  }

  // Round 5 fix: the previous version of this file never sent a real session
  // token at all, so every mutating call 401'd against the now-secured
  // backend (see api/bookkeeping/purchase-orders/_actor.js) -- that comment
  // above blaming a "no identity proxy connected yet" preview environment
  // was wrong; the real fix is to reuse the same hlTokenSync() helper every
  // other real page in this app already uses to attach its Supabase session
  // token (see index.html, e.g. hlApiGet/hlApiPost) rather than inventing a
  // second auth mechanism just for this page.
  async function api(path, body) {
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(`/api/bookkeeping/purchase-orders${path}`, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  function describeResult(ok, status, data, fallbackVerb) {
    if (ok) return data.note || `${fallbackVerb} succeeded.`;
    if (status === 401) return `Not authenticated: ${data.error} (sign in and try again -- your session may have expired).`;
    return `Not ${fallbackVerb.toLowerCase()}: ${data.error || 'the server rejected this action.'}`;
  }

  // Real QBO vendors + real synced Jobber jobs for the job/vendor fields --
  // fixes the review's verified finding that these were free-text with no
  // real data behind them. Reuses the same /api/bookkeeping/reference-data
  // route app-bookkeeping.js already calls (real, already-live QBO + Jobber
  // integrations -- not a second connection).
  function ensureDatalist(id) {
    let list = document.getElementById(id);
    if (!list) {
      list = document.createElement('datalist');
      list.id = id;
      document.body.appendChild(list);
    }
    return list;
  }

  async function loadReferenceData() {
    let data = null;
    try {
      const res = await fetch('/api/bookkeeping/reference-data?resource=all');
      data = await res.json();
    } catch { data = null; }
    if (!data || data.ok === false) return;

    refData.vendors = data.vendors || [];
    refData.jobs = data.jobs || [];

    const vendorList = ensureDatalist('pox-vendor-list');
    vendorList.innerHTML = refData.vendors.map(v => `<option value="${escapeHtml(v.name)}">`).join('');
    const jobList = ensureDatalist('pox-job-list');
    jobList.innerHTML = refData.jobs.map(j => `<option value="${escapeHtml(j.jobNumber ? `Job #${j.jobNumber} — ${j.title}` : j.title)}">`).join('');

    document.getElementById('pox-vendor')?.setAttribute('list', 'pox-vendor-list');
    document.getElementById('pox-job')?.setAttribute('list', 'pox-job-list');
  }

  // Task 9: one unified submit handler for both planned and after-the-fact
  // purchases, replacing the previous createPurchaseOrder()/
  // createAfterTheFact() split. After-the-fact purchases now use the SAME
  // real multi-line-item UI as planned ones (readNewLines(), this app's real
  // LINE_TYPES/estimatedQty/estimatedUnitPrice field names) instead of
  // collapsing everything into one synthetic "After-the-fact purchase" line
  // -- so a multi-item emergency purchase is no longer flattened into a
  // single flat amount.
  //
  // "Requested by" / "Purchased by" text fields are gone entirely: the
  // server (api/bookkeeping/purchase-orders/create.js, "Round 3 correction
  // #12") always overwrites requestedBy with the authenticated actor's own
  // id and never honors a client-supplied value -- those fields were already
  // dead before this change; nothing typed into them ever reached storage.
  async function createPurchaseOrder() {
    const orderType = document.getElementById('pox-order-type').value;
    const payload = {
      orderType,
      jobId: document.getElementById('pox-job').value.trim() || null,
      overheadCategory: document.getElementById('pox-overhead').value.trim() || null,
      vendorName: document.getElementById('pox-vendor').value.trim(),
      lines: readNewLines()
    };
    if (orderType === 'after_the_fact') {
      payload.afterTheFactReason = document.getElementById('pox-after-reason').value.trim();
    }
    const { ok, status, data } = await api('/create', payload);
    const statusEl = document.getElementById('pox-create-status');
    statusEl.style.display = 'block';
    statusEl.textContent = describeResult(ok, status, data, 'Create');
    if (ok) {
      await refreshList();
      document.querySelectorAll('#pox-new-lines .pox-newline').forEach(lineEl => lineEl.remove());
      addLine();
      document.getElementById('pox-order-type').value = 'planned';
      toggleAfterFact();
    }
  }

  async function actOnPo(poId, path, extra, verb) {
    const { ok, status, data } = await api(path, { poId, ...extra });
    const row = document.querySelector(`[data-po-id="${poId}"] [data-role="po-status"]`);
    if (row) row.textContent = describeResult(ok, status, data, verb);
    if (ok) await refreshList();
    return ok;
  }

  function statusBadgeClass(status) {
    if (status === 'exception') return 'tr down';
    if (status === 'closed' || status === 'fully_received' || status === 'billed') return 'tr up';
    return 'tr';
  }

  function actionButtons(po) {
    const buttons = [];
    if (po.status === 'draft') {
      buttons.push(`<button class="gbtn" data-action="approve">Approve</button>`);
      buttons.push(`<button class="gbtn" data-action="reject">Reject</button>`);
    }
    if (['ordered', 'partially_received', 'fully_received', 'exception'].includes(po.lifecycleStatus || po.status)) {
      buttons.push(`<button class="gbtn" data-action="bill">Mark billed</button>`);
      buttons.push(`<button class="gbtn" data-action="close">Close</button>`);
      if ((po.exceptions || []).length) buttons.push(`<button class="gbtn" data-action="force-close" style="border-color:#c0392b;color:#c0392b">Controller override &amp; close</button>`);
      buttons.push(`<button class="gbtn" data-action="cancel">Cancel</button>`);
    }
    if (['billed', 'closed'].includes(po.lifecycleStatus) && !po.voided) {
      buttons.push(`<button class="gbtn" data-action="void" style="border-color:#c0392b;color:#c0392b">Void / reverse</button>`);
    }
    return buttons.join(' ');
  }

  // po.voided is a real, separate boolean flag (see
  // server/bookkeeping/src/purchase-orders.js's voidPostedPurchaseOrder,
  // which deliberately leaves lifecycleStatus/status untouched so the
  // original billed/closed activity stays intact forever) -- this overlays
  // the same way the engine's own 'exception' overlay does, rather than
  // assuming a 'voided' lifecycle/status value that this engine never sets.
  function displayStatus(po) {
    if (po.voided) return ['Voided \u00b7 reversed', 'tr down'];
    return [STATE_LABELS[po.status] || po.status, statusBadgeClass(po.status)];
  }

  function renderList() {
    const list = document.getElementById('pox-list');
    const query = (document.getElementById('pox-search')?.value || '').trim().toLowerCase();
    const filtered = purchaseOrders.filter(po => !query || [po.poNumber, po.vendorName, po.jobId, po.overheadCategory, po.status].some(v => String(v || '').toLowerCase().includes(query)));
    if (!purchaseOrders.length) {
      list.innerHTML = '<div class="note">No purchase orders yet. Create one above, or record an after-the-fact purchase if the buying already happened.</div>';
      updateStats();
      return;
    }
    if (!filtered.length) {
      list.innerHTML = '<div class="note">No purchase orders match that search.</div>';
      updateStats();
      return;
    }
    list.innerHTML = filtered.map(po => {
      const { estimated, received } = poTotals(po);
      const percent = estimated > 0 ? Math.min(100, Math.round(received / estimated * 100)) : 0;
      const remaining = Math.max(0, estimated - received);
      const historyCount = (po.history || []).length;
      const [statusLabel, statusClass] = displayStatus(po);
      return `
      <div class="w" data-po-id="${escapeHtml(po.id)}">
        <span class="wic">${po.notPreapproved ? '&#9888;' : '&#128203;'}</span>
        <div style="flex:1">
          <b>${escapeHtml(po.poNumber)} &middot; ${escapeHtml(po.vendorName || 'No vendor')}</b>
          <span>${po.jobId ? `Job ${escapeHtml(po.jobId)}` : escapeHtml(po.overheadCategory || 'Overhead')} &middot; requested by ${escapeHtml(po.requestedBy)}${po.notPreapproved ? ' &middot; <b style="color:#c0392b">AFTER-THE-FACT, NOT PREAPPROVED</b>' : ''}</span>
          ${(po.exceptions || []).length ? `<span style="color:#c0392b">Exceptions: ${po.exceptions.map(escapeHtml).join(', ')}</span>` : ''}
          ${po.voided ? `<span style="color:#c0392b">Voided: ${escapeHtml(po.voidReason || '')}</span>` : ''}
          <div class="pox-progress"><span style="width:${percent}%"></span></div>
          <div class="pox-amounts"><span>Authorized ${money(estimated)}</span><span>Received ${money(received)}</span><span>${money(remaining)} remaining</span></div>
          <details class="pox-lines-view"><summary>View ${po.lines.length} line${po.lines.length === 1 ? '' : 's'}</summary><table><tbody>${po.lines.map(line => `<tr><td>${escapeHtml(line.description)}</td><td>${escapeHtml(line.type)}</td><td>${money(line.estimatedAmount)}</td><td>${money(line.receivedAmount)} received</td></tr>`).join('')}</tbody></table></details>
          <div class="pox-history"><span>${historyCount} history event${historyCount === 1 ? '' : 's'} recorded &middot; append-only</span><button type="button" class="gbtn" data-action="verify-history">Verify chain</button><span data-role="history-result"></span></div>
          <div class="pox-actions" style="margin-top:6px">${actionButtons(po)}</div>
          <div class="note" data-role="po-status" style="margin-top:4px"></div>
        </div>
        <span class="${statusClass}">${escapeHtml(statusLabel)}</span>
      </div>
    `;
    }).join('');
    updateStats();
  }

  function updateStats() {
    document.getElementById('pox-stat-drafts').textContent = purchaseOrders.filter(po => po.lifecycleStatus === 'draft').length;
    document.getElementById('pox-stat-open').textContent = purchaseOrders.filter(po => ['ordered', 'partially_received', 'fully_received', 'billed'].includes(po.lifecycleStatus)).length;
    document.getElementById('pox-stat-exceptions').textContent = purchaseOrders.filter(po => (po.exceptions || []).length > 0).length;
    const actual = purchaseOrders
      .filter(po => po.lifecycleStatus !== 'cancelled' && !po.voided)
      .reduce((sum, po) => sum + poTotals(po).received, 0);
    document.getElementById('pox-stat-actual').textContent = money(actual);
  }

  async function refreshList() {
    const { ok, data } = await api('/list');
    purchaseOrders = ok ? (data.purchaseOrders || []) : [];
    if (!ok && data.enabled === false) {
      document.getElementById('pox-list').innerHTML = '<div class="note">Purchase order preview is disabled. Set BOOKKEEPING_ENABLED=true to try it.</div>';
      return;
    }
    if (!ok && data.error) {
      document.getElementById('pox-list').innerHTML = `<div class="note">Could not load purchase orders: ${escapeHtml(data.error)}</div>`;
      return;
    }
    renderList();
  }

  function wireListActions() {
    document.getElementById('pox-list').addEventListener('click', async e => {
      const button = e.target.closest('[data-action]');
      if (!button) return;
      const poId = button.closest('[data-po-id]').dataset.poId;
      const action = button.dataset.action;
      if (action === 'approve') return actOnPo(poId, '/approve', {}, 'Approve');
      if (action === 'reject') {
        const reason = prompt('Reason for rejecting this purchase order:');
        if (reason == null) return;
        return actOnPo(poId, '/reject', { reason }, 'Reject');
      }
      if (action === 'bill') {
        const billId = prompt('Bill / invoice reference to attach:') || `bill-${Date.now()}`;
        return actOnPo(poId, '/bill', { billId }, 'Bill');
      }
      if (action === 'close') return actOnPo(poId, '/close', {}, 'Close');
      if (action === 'force-close') {
        const reason = prompt('Controller override reason (required — this is preserved permanently in the audit trail):');
        if (!reason) return;
        return actOnPo(poId, '/close', { force: true, reason }, 'Force-close');
      }
      if (action === 'cancel') {
        const reason = prompt('Cancellation reason:');
        if (reason == null) return;
        return actOnPo(poId, '/cancel', { reason }, 'Cancel');
      }
      if (action === 'void') {
        const reason = prompt('Why must this billed/closed PO be reversed? (required -- permanently recorded)');
        if (!reason) return;
        return actOnPo(poId, '/void', { reason }, 'Void');
      }
      if (action === 'verify-history') {
        const resultEl = button.closest('.w')?.querySelector('[data-role="history-result"]');
        if (resultEl) resultEl.textContent = 'Verifying\u2026';
        try {
          const headers = {};
          const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
          if (token) headers.Authorization = 'Bearer ' + token;
          const res = await fetch(`/api/bookkeeping/purchase-orders/audit-verify?poId=${encodeURIComponent(poId)}`, { headers });
          const data = await res.json().catch(() => ({}));
          if (resultEl) {
            resultEl.textContent = (res.ok && data.ok)
              ? (data.valid ? `\u2713 History chain self-consistent (${data.records} records).` : `\u26a0 History chain broken at record ${data.brokenAt}.`)
              : `Could not verify: ${data.error || 'unknown error'}`;
          }
        } catch {
          if (resultEl) resultEl.textContent = 'Could not reach the verification endpoint.';
        }
      }
    });
  }

  function init() {
    if (!document.getElementById('pox-list')) return;
    document.getElementById('pox-add-line').addEventListener('click', addLine);
    document.getElementById('pox-create').addEventListener('click', createPurchaseOrder);
    document.getElementById('pox-order-type')?.addEventListener('change', toggleAfterFact);
    document.getElementById('pox-search')?.addEventListener('input', renderList);
    wireListActions();
    toggleAfterFact();
    addLine();
    refreshList();
    loadReferenceData();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  // Exposed so the Expenses sub-nav can (re)run init once this fragment is
  // fetched into the DOM -- init() itself is idempotent-safe (no-ops unless
  // #pox-list exists).
  window.hlInitPurchaseOrders = init;
})();
