// HiveLogic General Ledger — journal entries, financial reports, and close
// readiness. Talks to the already-live /api/bookkeeping/ledger/* routes,
// which wrap the ported double-entry engine in server/bookkeeping/src/
// (ledger.js, reporting.js, close.js). BOOKKEEPING_ENABLED=true is already
// confirmed live in production; this file is the first UI that ever calls
// these routes.
//
// Auth pattern matches app-purchase-orders.js exactly: every call (GET and
// POST) attaches the real Supabase session token via hlTokenSync(), because
// api/bookkeeping/ledger/_actor.js requires a server-verified actor and
// never trusts client-supplied identity headers.
//
// No fake or mock data anywhere. Every number on this page comes from a
// real API response. Where the server itself says a check isn't backed by
// real data yet (close.js's readiness note), that note is surfaced to the
// user verbatim, not hidden or softened.

(function () {
  const money = v => Math.round((Number(v) || 0) * 100) / 100;
  const fmt = v => `$${money(v).toFixed(2)}`;
  const todayStr = () => new Date().toISOString().slice(0, 10);

  const state = { accounts: [], entries: [], lineSeq: 0, bank: { accounts: [], transactions: [], reconciliations: [] }, bankLoaded: false };

  function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

  // Same fallback guard the rest of the codebase uses so this file can
  // stand alone if the main toast helper hasn't loaded yet on this page.
  if (!window.hlToast) {
    window.hlToast = function (msg) { try { console.log('[toast]', msg); } catch (e) {} };
  }

  async function api(path, method, body) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(`/api/bookkeeping/ledger${path}`, {
      method: method || (body ? 'POST' : 'GET'),
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  function describeResult(ok, status, data, fallbackVerb) {
    if (ok) return data.note || `${fallbackVerb} succeeded.`;
    if (status === 401) return `Not authenticated: ${data.error || ''} (sign in and try again — your session may have expired).`;
    return `Not ${fallbackVerb.toLowerCase()}: ${data.error || 'the server rejected this action.'}`;
  }

  function setStatus(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = text ? 'block' : 'none';
    el.textContent = text || '';
  }

  // -------------------------------------------------------------------
  // Sub-nav (Journal entries / Financial reports / Close readiness)
  // -------------------------------------------------------------------
  function wireSubnav() {
    const nav = document.getElementById('glx-subnav');
    if (!nav || nav.dataset.wired) return;
    nav.dataset.wired = '1';
    nav.addEventListener('click', e => {
      const opt = e.target.closest('[data-glx-tab]');
      if (!opt) return;
      const key = opt.getAttribute('data-glx-tab');
      nav.querySelectorAll('[data-glx-tab]').forEach(el => el.classList.toggle('sel', el === opt));
      ['entries', 'reports', 'close', 'bank'].forEach(k => {
        const panel = document.getElementById(`glx-panel-${k}`);
        if (panel) panel.style.display = (k === key) ? '' : 'none';
      });
      // Bank feed's whole panel is dynamic (no single "run" button the way
      // reports/close have) -- load it once, the first time this tab is
      // actually shown, same lazy-on-first-visit idea EXPX_TABS already uses
      // for whole sub-nav tabs one level up.
      if (key === 'bank' && !state.bankLoaded) { state.bankLoaded = true; loadBank(); }
    });
  }

  // -------------------------------------------------------------------
  // Journal entry line rows (create form)
  // -------------------------------------------------------------------
  function accountOptionsHtml(selectedId) {
    let html = '<option value="">Choose account</option>';
    for (const a of state.accounts) html += `<option value="${escapeHtml(a.id)}"${a.id === selectedId ? ' selected' : ''}>${escapeHtml(a.name)} (${escapeHtml(a.type)})</option>`;
    return html;
  }

  function lineRow() {
    state.lineSeq += 1;
    const el = document.createElement('div');
    el.className = 'bkx-grid2 glx-newline';
    el.dataset.lineId = String(state.lineSeq);
    el.innerHTML = `
      <label class="bkx-field"><span>Account</span><select data-field="accountId">${accountOptionsHtml('')}</select></label>
      <label class="bkx-field"><span>Debit</span><input type="number" min="0" step="0.01" data-field="debit" placeholder="0.00"></label>
      <label class="bkx-field"><span>Credit</span><input type="number" min="0" step="0.01" data-field="credit" placeholder="0.00"></label>
      <label class="bkx-field"><span>Line memo</span><input type="text" data-field="memo" placeholder="Optional"></label>
      <button type="button" class="gbtn" data-action="remove-line">Remove line</button>`;
    return el;
  }

  function addLine() {
    const container = document.getElementById('glx-new-lines');
    container.appendChild(lineRow());
    recalcNewEntry();
  }

  function refreshLineAccountOptions() {
    document.querySelectorAll('#glx-new-lines .glx-newline [data-field="accountId"]').forEach(select => {
      const current = select.value;
      select.innerHTML = accountOptionsHtml(current);
    });
  }

  function readNewLines() {
    return [...document.querySelectorAll('#glx-new-lines .glx-newline')].map(el => ({
      accountId: el.querySelector('[data-field="accountId"]').value,
      debit: Number(el.querySelector('[data-field="debit"]').value) || 0,
      credit: Number(el.querySelector('[data-field="credit"]').value) || 0,
      memo: el.querySelector('[data-field="memo"]').value.trim()
    }));
  }

  function recalcNewEntry() {
    const lines = readNewLines();
    const debits = money(lines.reduce((s, l) => s + l.debit, 0));
    const credits = money(lines.reduce((s, l) => s + l.credit, 0));
    document.getElementById('glx-recon-debits').textContent = fmt(debits);
    document.getElementById('glx-recon-credits').textContent = fmt(credits);
    const diff = money(debits - credits);
    const diffEl = document.getElementById('glx-recon-diff');
    diffEl.textContent = fmt(diff);
    diffEl.className = (Math.abs(diff) < 0.005 && debits > 0) ? 'good' : 'bad';
  }

  // -------------------------------------------------------------------
  // Journal entries: load / render / create / approve / post
  // -------------------------------------------------------------------
  async function loadEntries() {
    const { ok, data } = await api('/entries');
    if (!ok && data.enabled === false) {
      document.getElementById('glx-entries-list').innerHTML = '<div class="note">General ledger is disabled. Set BOOKKEEPING_ENABLED=true to try it.</div>';
      return;
    }
    if (!ok) {
      document.getElementById('glx-entries-list').innerHTML = `<div class="note">Could not load journal entries: ${escapeHtml(data.error || 'unknown error')}</div>`;
      return;
    }
    state.accounts = data.accounts || [];
    state.entries = data.entries || [];
    refreshLineAccountOptions();
    renderEntries();
    updateStats();
  }

  function accountName(accountId) {
    const acct = state.accounts.find(a => a.id === accountId);
    return acct ? acct.name : accountId;
  }

  function statusBadgeClass(status) {
    if (status === 'posted') return 'tr up';
    if (status === 'pending_approval') return 'tr down';
    return 'tr';
  }

  const STATUS_LABELS = { pending_approval: 'Pending approval', approved: 'Approved, not posted', posted: 'Posted', voided: 'Voided' };

  function entryActionButtons(entry) {
    const buttons = [];
    if (entry.status === 'pending_approval') buttons.push('<button class="gbtn" data-action="approve">Approve</button>');
    if (entry.status === 'approved') buttons.push('<button class="gbtn go" data-action="post">Post</button>');
    return buttons.join(' ');
  }

  function entryLinesTable(entry) {
    const lines = entry.lines || [];
    const rows = lines.map(l => `<tr><td>${escapeHtml(accountName(l.accountId))}</td><td>${escapeHtml(l.memo || '')}</td><td>${l.debit ? fmt(l.debit) : ''}</td><td>${l.credit ? fmt(l.credit) : ''}</td></tr>`).join('');
    return `<table><thead><tr><th>Account</th><th>Memo</th><th>Debit</th><th>Credit</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderEntries() {
    const list = document.getElementById('glx-entries-list');
    if (!state.entries.length) {
      list.innerHTML = '<div class="note">No journal entries yet. Create one above.</div>';
      return;
    }
    const sorted = [...state.entries].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    list.innerHTML = sorted.map(entry => `
      <div class="w" data-entry-id="${escapeHtml(entry.id)}" style="display:block">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <b>${escapeHtml(entry.date)} &middot; ${escapeHtml(entry.description)}</b>
            <div class="note" style="text-align:left;margin:2px 0 8px">${escapeHtml(entry.memo || '')} ${entry.kind && entry.kind !== 'standard' ? `&middot; ${escapeHtml(entry.kind)}` : ''} &middot; ${escapeHtml(entry.basis)} basis</div>
          </div>
          <span class="${statusBadgeClass(entry.status)}">${escapeHtml(STATUS_LABELS[entry.status] || entry.status)}</span>
        </div>
        ${entryLinesTable(entry)}
        <div class="glx-actions" style="margin-top:8px">${entryActionButtons(entry)}</div>
        <div class="note" data-role="entry-status" style="text-align:left;margin-top:6px"></div>
      </div>
    `).join('');
  }

  function updateStats() {
    document.getElementById('glx-stat-pending').textContent = state.entries.filter(e => e.status === 'pending_approval').length;
    document.getElementById('glx-stat-approved').textContent = state.entries.filter(e => e.status === 'approved').length;
    document.getElementById('glx-stat-posted').textContent = state.entries.filter(e => e.status === 'posted').length;
    document.getElementById('glx-stat-total').textContent = state.entries.length;
  }

  async function createEntry() {
    const lines = readNewLines().filter(l => l.accountId || l.debit || l.credit);
    const payload = {
      date: document.getElementById('glx-date').value,
      description: document.getElementById('glx-description').value.trim(),
      memo: document.getElementById('glx-memo').value.trim(),
      kind: document.getElementById('glx-kind').value,
      lines: lines.map(l => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, memo: l.memo }))
    };
    const basis = document.getElementById('glx-basis').value;
    if (basis) payload.basis = basis;

    if (lines.length < 2) { setStatus('glx-create-status', 'At least two journal lines are required.'); return; }
    if (lines.some(l => !l.accountId)) { setStatus('glx-create-status', 'Every line needs an account.'); return; }
    if (lines.some(l => (l.debit > 0) === (l.credit > 0))) { setStatus('glx-create-status', 'Every line must have either a debit or a credit, not both and not neither.'); return; }
    const debits = money(lines.reduce((s, l) => s + l.debit, 0));
    const credits = money(lines.reduce((s, l) => s + l.credit, 0));
    if (debits !== credits) { setStatus('glx-create-status', `Debits and credits must balance. Difference: ${fmt(debits - credits)}.`); return; }
    if (debits <= 0) { setStatus('glx-create-status', 'Journal entry total must be greater than zero.'); return; }

    const { ok, status, data } = await api('/entries', 'POST', payload);
    setStatus('glx-create-status', describeResult(ok, status, data, 'Create'));
    if (ok) {
      document.getElementById('glx-description').value = '';
      document.getElementById('glx-memo').value = '';
      document.getElementById('glx-new-lines').innerHTML = '';
      addLine(); addLine();
      await loadEntries();
    }
  }

  async function approveEntry(entryId) {
    const { ok, status, data } = await api('/approve', 'POST', { entryId });
    const row = document.querySelector(`[data-entry-id="${entryId}"] [data-role="entry-status"]`);
    if (row) row.textContent = describeResult(ok, status, data, 'Approve');
    if (ok) await loadEntries();
  }

  async function postEntry(entryId) {
    const idempotencyKey = `post:${entryId}`;
    const { ok, status, data } = await api('/post', 'POST', { entryId, idempotencyKey });
    const row = document.querySelector(`[data-entry-id="${entryId}"] [data-role="entry-status"]`);
    if (row) row.textContent = describeResult(ok, status, data, 'Post');
    if (ok) await loadEntries();
  }

  function wireEntryActions() {
    document.getElementById('glx-new-lines').addEventListener('click', e => {
      const btn = e.target.closest('[data-action="remove-line"]');
      if (!btn) return;
      btn.closest('.glx-newline').remove();
      recalcNewEntry();
    });
    document.getElementById('glx-new-lines').addEventListener('input', recalcNewEntry);
    document.getElementById('glx-add-line').addEventListener('click', addLine);
    document.getElementById('glx-create').addEventListener('click', createEntry);
    document.getElementById('glx-entries-list').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const entryId = btn.closest('[data-entry-id]').dataset.entryId;
      if (btn.dataset.action === 'approve') approveEntry(entryId);
      if (btn.dataset.action === 'post') postEntry(entryId);
    });
  }

  // -------------------------------------------------------------------
  // Financial reports
  // -------------------------------------------------------------------
  function updateReportFieldsVisibility() {
    const type = document.getElementById('glx-report-type').value;
    const show = (id, on) => { document.getElementById(id).style.display = on ? '' : 'none'; };
    show('glx-report-through-field', type === 'trial-balance' || type === 'balance-sheet' || type === 'general-ledger' || type === 'ar-aging' || type === 'ap-aging');
    show('glx-report-start-field', type === 'income-statement' || type === 'general-ledger' || type === 'expense-summary');
    show('glx-report-end-field', type === 'income-statement' || type === 'expense-summary');
    show('glx-report-groupby-field', type === 'expense-summary');
  }

  function renderTrialBalance(result) {
    const rows = (result.rows || []).map(r => `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.type)}</td><td>${r.debit ? fmt(r.debit) : ''}</td><td>${r.credit ? fmt(r.credit) : ''}</td><td>${fmt(r.balance)}</td></tr>`).join('');
    return `
      <div class="note" style="text-align:left;margin-bottom:8px">Through ${escapeHtml(result.throughDate)} &middot; ${escapeHtml(result.basis)} basis &middot; ${result.balanced ? 'Balanced' : 'NOT balanced'}</div>
      <table><thead><tr><th>Account</th><th>Type</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="2"><b>Totals</b></td><td><b>${fmt(result.totalDebits)}</b></td><td><b>${fmt(result.totalCredits)}</b></td><td></td></tr></tfoot></table>`;
  }

  function renderIncomeStatement(result) {
    const lines = (result.lines || []).map(l => `<tr><td>${escapeHtml(l.effectiveDate)}</td><td>${escapeHtml(l.account.name)}</td><td>${escapeHtml(l.account.type)}</td><td>${l.debit ? fmt(l.debit) : ''}</td><td>${l.credit ? fmt(l.credit) : ''}</td><td>${escapeHtml(l.memo || '')}</td></tr>`).join('');
    return `
      <div class="statrow" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:14px">
        <div class="stat"><span>Revenue</span><b>${fmt(result.revenue)}</b></div>
        <div class="stat"><span>Expenses</span><b>${fmt(result.expenses)}</b></div>
        <div class="stat"><span>Net income</span><b>${fmt(result.netIncome)}</b></div>
      </div>
      <div class="note" style="text-align:left;margin-bottom:8px">${escapeHtml(result.startDate)} through ${escapeHtml(result.endDate)} &middot; ${escapeHtml(result.basis)} basis</div>
      <table><thead><tr><th>Date</th><th>Account</th><th>Type</th><th>Debit</th><th>Credit</th><th>Memo</th></tr></thead><tbody>${lines}</tbody></table>`;
  }

  function renderBalanceSheet(result) {
    return `
      <div class="statrow" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
        <div class="stat"><span>Assets</span><b>${fmt(result.assets)}</b></div>
        <div class="stat"><span>Liabilities</span><b>${fmt(result.liabilities)}</b></div>
        <div class="stat"><span>Equity</span><b>${fmt(result.equity)}</b></div>
        <div class="stat"><span>Balanced</span><b>${result.balanced ? 'Yes' : 'No'}</b><span class="tr ${result.balanced ? 'up' : 'down'}">${result.balanced ? 'assets = liabilities + equity' : `off by ${fmt(result.difference)}`}</span></div>
      </div>
      <div class="note" style="text-align:left">Through ${escapeHtml(result.throughDate)} &middot; ${escapeHtml(result.basis)} basis. Equity = ${fmt(result.equityPosted)} posted equity + ${fmt(result.retainedEarningsAndCurrentIncome)} retained earnings/current income.</div>`;
  }

  function renderGeneralLedger(result) {
    const rows = (result.rows || []).map(r => `<tr><td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.entryId)}</td><td>${escapeHtml(r.accountName)}</td><td>${escapeHtml(r.description)}</td><td>${r.debit ? fmt(r.debit) : ''}</td><td>${r.credit ? fmt(r.credit) : ''}</td><td>${escapeHtml(r.memo || '')}</td></tr>`).join('');
    return `
      <div class="note" style="text-align:left;margin-bottom:8px">${escapeHtml(result.startDate)} through ${escapeHtml(result.throughDate)} &middot; ${escapeHtml(result.basis)} basis &middot; ${result.balanced ? 'Balanced' : 'NOT balanced'}</div>
      <table><thead><tr><th>Date</th><th>Entry</th><th>Account</th><th>Description</th><th>Debit</th><th>Credit</th><th>Memo</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="4"><b>Totals</b></td><td><b>${fmt(result.totalDebits)}</b></td><td><b>${fmt(result.totalCredits)}</b></td><td></td></tr></tfoot></table>`;
  }

  function renderAgingBuckets(buckets) {
    const order = ['Current', '1–30 days', '31–60 days', '61–90 days', '90+ days'];
    return `<div class="statrow" style="grid-template-columns:repeat(${order.length},minmax(0,1fr));margin-bottom:14px">${order.map(b => `<div class="stat"><span>${escapeHtml(b)}</span><b>${fmt(buckets[b] || 0)}</b></div>`).join('')}</div>`;
  }

  function renderApAging(result) {
    const rows = (result.bills || []).map(b => `<tr><td>${escapeHtml(b.vendor)}</td><td>${escapeHtml(b.transactionDate)}</td><td>${escapeHtml(b.dueDate)}</td><td>${fmt(b.total)}</td><td>${b.daysPastDue}</td><td>${escapeHtml(b.bucket)}</td></tr>`).join('');
    return `
      ${renderAgingBuckets(result.buckets)}
      <div class="note" style="text-align:left;margin-bottom:8px">Through ${escapeHtml(result.throughDate)} &middot; ${result.count} open bill${result.count === 1 ? '' : 's'} &middot; total outstanding ${fmt(result.totalOutstanding)}</div>
      <table><thead><tr><th>Vendor</th><th>Bill date</th><th>Due date</th><th>Amount</th><th>Days past due</th><th>Bucket</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="note">No open bills.</td></tr>'}</tbody></table>`;
  }

  function renderArAging(result) {
    const rows = (result.invoices || []).map(i => `<tr><td>${escapeHtml(i.invoiceNumber)}</td><td>${escapeHtml(i.subject || '')}</td><td>${escapeHtml(i.dueDate)}</td><td>${fmt(i.balance)}</td><td>${i.daysPastDue}</td><td>${escapeHtml(i.bucket)}</td><td>${escapeHtml(i.status)}</td></tr>`).join('');
    const undatedNote = result.undatedExcluded ? ` &middot; ${result.undatedExcluded} invoice${result.undatedExcluded === 1 ? '' : 's'} excluded (no due or issued date on file)` : '';
    return `
      ${renderAgingBuckets(result.buckets)}
      <div class="note" style="text-align:left;margin-bottom:8px">Through ${escapeHtml(result.throughDate)} &middot; ${result.count} open invoice${result.count === 1 ? '' : 's'} &middot; total outstanding ${fmt(result.totalOutstanding)}${undatedNote}</div>
      <table><thead><tr><th>Invoice #</th><th>Subject</th><th>Due date</th><th>Balance</th><th>Days past due</th><th>Bucket</th><th>Status</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="note">No open invoices.</td></tr>'}</tbody></table>`;
  }

  const EXPENSE_HOME_LABELS = { job: 'Job / project', subcontractor: 'Subcontractor', rental: 'Equipment / tool rental', truck: 'Truck', loan: 'Loan payment', insurance: 'Insurance', rent: 'Rent / lease', gas: 'Gas / fuel', maintenance: 'Repairs / maintenance', tools: 'Tools / equipment', inventory: 'Stock inventory', asset: 'Fixed asset', overhead: 'Overhead / office', license: 'Licenses / permits', payroll: 'Payroll / payroll tax', tax: 'Taxes', unknown: 'Unknown', unassigned: 'Unassigned' };

  function renderExpenseSummary(result) {
    const labelFor = key => result.groupBy === 'ownerType' ? (EXPENSE_HOME_LABELS[key] || key) : key;
    const rows = (result.rows || []).map(r => `<tr><td>${escapeHtml(labelFor(r.key))}</td><td>${fmt(r.total)}</td><td>${r.lineCount}</td></tr>`).join('');
    return `
      <div class="note" style="text-align:left;margin-bottom:8px">${escapeHtml(result.startDate)} through ${escapeHtml(result.endDate)} &middot; grouped by ${result.groupBy === 'ownerType' ? 'expense home' : 'vendor'} &middot; ${result.transactionCount} expense${result.transactionCount === 1 ? '' : 's'} included (drafts and rejected expenses excluded) &middot; grand total ${fmt(result.grandTotal)}</div>
      <table><thead><tr><th>${result.groupBy === 'ownerType' ? 'Expense home' : 'Vendor'}</th><th>Total</th><th>Line items</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="note">No expenses in this range.</td></tr>'}</tbody></table>`;
  }

  const REPORT_RENDERERS = {
    'trial-balance': renderTrialBalance,
    'income-statement': renderIncomeStatement,
    'balance-sheet': renderBalanceSheet,
    'general-ledger': renderGeneralLedger,
    'ar-aging': renderArAging,
    'ap-aging': renderApAging,
    'expense-summary': renderExpenseSummary
  };
  const REPORT_TITLES = {
    'trial-balance': 'Trial balance',
    'income-statement': 'Income statement',
    'balance-sheet': 'Balance sheet',
    'general-ledger': 'General ledger',
    'ar-aging': 'AR aging',
    'ap-aging': 'AP aging',
    'expense-summary': 'Expense summary'
  };

  async function runReport() {
    const type = document.getElementById('glx-report-type').value;
    const basis = document.getElementById('glx-report-basis').value;
    const params = new URLSearchParams({ report: type, basis });
    const through = document.getElementById('glx-report-through').value;
    const start = document.getElementById('glx-report-start').value;
    const end = document.getElementById('glx-report-end').value;
    if (through && (type === 'trial-balance' || type === 'balance-sheet' || type === 'general-ledger' || type === 'ar-aging' || type === 'ap-aging')) params.set('throughDate', through);
    if (start && (type === 'income-statement' || type === 'general-ledger' || type === 'expense-summary')) params.set('startDate', start);
    if (end && (type === 'income-statement' || type === 'expense-summary')) params.set('endDate', end);
    if (type === 'expense-summary') params.set('groupBy', document.getElementById('glx-report-groupby').value);

    const { ok, status, data } = await api(`/reports?${params.toString()}`);
    if (!ok) {
      setStatus('glx-report-status', describeResult(ok, status, data, 'Run'));
      document.getElementById('glx-report-result-card').style.display = 'none';
      return;
    }
    setStatus('glx-report-status', '');
    const renderer = REPORT_RENDERERS[type];
    document.getElementById('glx-report-result-title').textContent = REPORT_TITLES[type] || type;
    document.getElementById('glx-report-result').innerHTML = renderer ? renderer(data) : '<div class="note">Unknown report type.</div>';
    document.getElementById('glx-report-result-card').style.display = '';
  }

  async function syncAccountsFromQbo() {
    const btn = document.getElementById('glx-accounts-sync');
    btn.disabled = true;
    setStatus('glx-accounts-sync-status', 'Pulling your real chart of accounts from QuickBooks...');
    const { ok, status, data } = await api('/reseed-accounts', 'POST');
    btn.disabled = false;
    setStatus('glx-accounts-sync-status', describeResult(ok, status, data, 'Sync'));
    if (ok) await loadEntries();
  }

  function wireReports() {
    document.getElementById('glx-report-type').addEventListener('change', updateReportFieldsVisibility);
    document.getElementById('glx-report-run').addEventListener('click', runReport);
    updateReportFieldsVisibility();
    document.getElementById('glx-accounts-sync').addEventListener('click', syncAccountsFromQbo);
  }

  // -------------------------------------------------------------------
  // Close readiness
  // -------------------------------------------------------------------
  async function checkCloseReadiness() {
    const throughDate = document.getElementById('glx-close-through').value || todayStr();
    const { ok, status, data } = await api(`/close?throughDate=${encodeURIComponent(throughDate)}`);
    if (!ok) {
      setStatus('glx-close-status', describeResult(ok, status, data, 'Check'));
      document.getElementById('glx-close-result-card').style.display = 'none';
      document.getElementById('glx-close-note-card').style.display = 'none';
      return;
    }
    setStatus('glx-close-status', '');

    document.getElementById('glx-close-note-card').style.display = data.note ? '' : 'none';
    document.getElementById('glx-close-note').textContent = data.note || '';

    document.getElementById('glx-close-headline').textContent = `${data.ready ? 'Ready to close' : 'Not ready to close'} through ${data.throughDate} — score ${data.score}/100`;
    const summary = data.summary || {};
    document.getElementById('glx-close-summary').textContent = `${summary.expenses || 0} in-period expense record(s) considered, ${summary.postedEntries || 0} posted journal entr${(summary.postedEntries === 1) ? 'y' : 'ies'}, ${summary.unresolved || 0} unresolved item(s).`;
    const list = document.getElementById('glx-close-checklist');
    list.innerHTML = (data.checks || []).map(c => `<li class="${c.passed ? 'good' : ''}">${c.passed ? '&#10003;' : '&#9675;'} <b>${escapeHtml(c.label)}</b> — ${escapeHtml(c.detail)}${c.blocking === false ? ' (informational, not blocking)' : ''}</li>`).join('');
    document.getElementById('glx-close-result-card').style.display = '';
  }

  async function verifyAuditChain() {
    const { ok, status, data } = await api('/audit-verify');
    if (!ok) { setStatus('glx-audit-status', describeResult(ok, status, data, 'Verify')); document.getElementById('glx-audit-result').innerHTML = ''; return; }
    setStatus('glx-audit-status', '');
    document.getElementById('glx-audit-result').innerHTML = `
      <div class="statrow" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <div class="stat"><span>Overall</span><b>${data.valid ? 'Valid' : 'BROKEN'}</b><span class="tr ${data.valid ? 'up' : 'down'}">against the independent append-only log</span></div>
        <div class="stat"><span>Ledger chain</span><b>${data.ledger.valid ? 'Valid' : 'BROKEN'}</b><span class="tr">${data.ledger.checkedRecords} record(s) checked</span></div>
        <div class="stat"><span>Controls chain</span><b>${data.controls.valid ? 'Valid' : 'BROKEN'}</b><span class="tr">${data.controls.checkedRecords} record(s) checked</span></div>
      </div>
      ${(data.ledger.mismatches.length || data.controls.mismatches.length) ? `<div class="note" style="text-align:left;color:#c0392b;margin-top:10px">${[...data.ledger.mismatches, ...data.controls.mismatches].map(m => escapeHtml(m.reason)).join('<br>')}</div>` : ''}`;
  }

  function wireClose() {
    document.getElementById('glx-close-through').value = todayStr();
    document.getElementById('glx-close-check').addEventListener('click', checkCloseReadiness);
    document.getElementById('glx-audit-verify').addEventListener('click', verifyAuditChain);
  }

  // -------------------------------------------------------------------
  // Bank feed -- imports a bank/card statement CSV (an uploaded file, never
  // a live bank connection -- see api/bookkeeping/ledger/bank-import.js's
  // header comment), then matches each transaction to an already-recorded
  // expense or classifies it directly into a real pending journal entry,
  // and reconciles an account against a real, server-computed book balance
  // (never a number typed into the page). Talks to the bank/bank-import/
  // bank-classify/bank-match/bank-reconcile routes added alongside this.
  // -------------------------------------------------------------------
  function accountNameBank(accountId) {
    const account = state.bank.accounts.find(a => a.id === accountId);
    return account ? account.name : accountId;
  }

  function bankStatusBadge(status) {
    const map = { unmatched: ['down', 'Unmatched'], matched: ['up', 'Matched'], classified_pending: ['', 'Classified, pending post'], classified: ['up', 'Classified'] };
    const [cls, label] = map[status] || ['', status];
    return `<span class="tr ${cls}">${escapeHtml(label)}</span>`;
  }

  function populateBankAccountSelects() {
    const importExportOptions = '<option value="">Choose account</option>' + state.bank.accounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join('');
    ['glx-bank-import-account', 'glx-bank-reconcile-account'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { const previous = el.value; el.innerHTML = importExportOptions; if (previous) el.value = previous; }
    });
    const filterEl = document.getElementById('glx-bank-filter-account');
    if (filterEl) {
      const previous = filterEl.value;
      filterEl.innerHTML = '<option value="">All accounts</option>' + state.bank.accounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join('');
      if (previous) filterEl.value = previous;
    }
  }

  function updateBankStats() {
    const txns = state.bank.transactions;
    document.getElementById('glx-bank-stat-unmatched').textContent = txns.filter(t => t.status === 'unmatched').length;
    document.getElementById('glx-bank-stat-pending').textContent = txns.filter(t => t.status === 'classified_pending').length;
    document.getElementById('glx-bank-stat-resolved').textContent = txns.filter(t => t.status === 'matched' || t.status === 'classified').length;
    const reconciledAccounts = new Set(state.bank.reconciliations.filter(r => r.status === 'complete').map(r => r.accountId));
    document.getElementById('glx-bank-stat-reconciled').textContent = reconciledAccounts.size;
  }

  function visibleBankTransactions() {
    const account = document.getElementById('glx-bank-filter-account')?.value || '';
    const status = document.getElementById('glx-bank-filter-status')?.value || '';
    return state.bank.transactions.filter(t => (!account || t.accountId === account) && (!status || t.status === status));
  }

  function renderBankTransactions() {
    const el = document.getElementById('glx-bank-transactions');
    if (!el) return;
    const rows = visibleBankTransactions();
    if (!rows.length) { el.innerHTML = '<div class="note">No imported transactions match these filters. Import a statement above to get started.</div>'; return; }
    el.innerHTML = rows.map(t => {
      let action = '';
      if (t.status === 'unmatched') action = `<button class="gbtn" type="button" data-bank-resolve="${escapeHtml(t.id)}">Match or classify</button>`;
      else if (t.status === 'classified_pending') action = `<small style="color:var(--mut)">Approve &amp; post in Journal entries to resolve</small>`;
      else if (t.status === 'matched') action = `<small style="color:var(--mut)">Matched to an expense</small>`;
      return `
      <div class="w" style="display:grid;grid-template-columns:88px 1fr 100px 190px auto;gap:10px;align-items:center;padding:10px 4px;border-bottom:1px solid var(--line)">
        <span style="font-family:var(--mono);font-size:10.5px;color:var(--mut)">${escapeHtml(t.postedDate)}</span>
        <span>${escapeHtml(t.description || '(no description)')}<br><small style="color:var(--mut)">${escapeHtml(accountNameBank(t.accountId))}</small></span>
        <b style="text-align:right">${fmt(t.amount)}</b>
        ${bankStatusBadge(t.status)}
        <span style="text-align:right">${action}</span>
      </div>
      <div class="glx-bank-resolve-row" data-resolve-for="${escapeHtml(t.id)}" style="display:none;padding:12px 4px 18px;border-bottom:1px solid var(--line)"></div>`;
    }).join('');
  }

  async function openBankResolve(transactionId) {
    const row = document.querySelector(`[data-resolve-for="${transactionId}"]`);
    if (!row) return;
    if (row.style.display !== 'none') { row.style.display = 'none'; return; }
    row.style.display = 'block';
    row.innerHTML = '<div class="note" style="text-align:left">Loading match candidates&hellip;</div>';
    const { ok, data } = await api(`/bank-match?bankTransactionId=${encodeURIComponent(transactionId)}`);
    if (!ok) { row.innerHTML = `<div class="note" style="text-align:left">${escapeHtml(data.error || 'Could not load match candidates.')}</div>`; return; }
    const candidates = data.candidates || [];
    const candidatesHtml = candidates.length
      ? candidates.map(c => `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0"><span>${escapeHtml(c.expense?.vendor || c.expenseId)} &middot; ${fmt(c.expense?.total)} &middot; ${escapeHtml(c.expense?.transactionDate || '')} <small style="color:var(--mut)">${Math.round(c.score * 100)}% match &mdash; ${escapeHtml(c.reasons.join(', '))}</small></span><button class="gbtn go" type="button" data-confirm-match="${escapeHtml(transactionId)}" data-expense-id="${escapeHtml(c.expenseId)}">Confirm match</button></div>`).join('')
      : '<div class="note" style="text-align:left">No likely expense matches found.</div>';
    row.innerHTML = `
      <div style="margin-bottom:12px"><b style="font-size:12px">Match to an already-recorded expense</b>${candidatesHtml}</div>
      <div style="margin-bottom:6px"><b style="font-size:12px">Or classify this transaction directly</b></div>
      <div class="bkx-grid2">
        <label class="bkx-field"><span>Offset account</span><select data-classify-offset="${escapeHtml(transactionId)}"><option value="">Choose account</option>${state.accounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)} (${escapeHtml(a.type)})</option>`).join('')}</select></label>
        <label class="bkx-field"><span>Description</span><input type="text" data-classify-desc="${escapeHtml(transactionId)}" placeholder="Optional"></label>
      </div>
      <button class="gbtn" type="button" data-classify-btn="${escapeHtml(transactionId)}" style="margin-top:8px">Classify this transaction</button>
      <div class="note" data-resolve-status="${escapeHtml(transactionId)}" style="display:none;text-align:left;margin-top:8px"></div>
    `;
  }

  async function confirmBankMatchClick(transactionId, expenseId) {
    const statusEl = document.querySelector(`[data-resolve-status="${transactionId}"]`);
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Confirming match…'; }
    const { ok, status, data } = await api('/bank-match', 'POST', { bankTransactionId: transactionId, expenseId });
    if (!ok) { if (statusEl) statusEl.textContent = describeResult(ok, status, data, 'Match'); return; }
    if (statusEl) statusEl.textContent = data.note || 'Matched.';
    await loadBank();
  }

  async function classifyBankTransactionClick(transactionId) {
    const offsetSelect = document.querySelector(`[data-classify-offset="${transactionId}"]`);
    const descInput = document.querySelector(`[data-classify-desc="${transactionId}"]`);
    const statusEl = document.querySelector(`[data-resolve-status="${transactionId}"]`);
    if (!offsetSelect?.value) { if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Choose an offset account first.'; } return; }
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Classifying…'; }
    const { ok, status, data } = await api('/bank-classify', 'POST', { bankTransactionId: transactionId, offsetAccountId: offsetSelect.value, description: descInput?.value || undefined });
    if (!ok) { if (statusEl) statusEl.textContent = describeResult(ok, status, data, 'Classify'); return; }
    if (statusEl) statusEl.textContent = data.note || 'Classified.';
    await loadBank();
    await loadEntries(); // the new pending-approval journal entry belongs in Journal entries too
  }

  function onBankTransactionsClick(e) {
    const resolveBtn = e.target.closest('[data-bank-resolve]');
    if (resolveBtn) { openBankResolve(resolveBtn.getAttribute('data-bank-resolve')); return; }
    const confirmBtn = e.target.closest('[data-confirm-match]');
    if (confirmBtn) { confirmBankMatchClick(confirmBtn.getAttribute('data-confirm-match'), confirmBtn.getAttribute('data-expense-id')); return; }
    const classifyBtn = e.target.closest('[data-classify-btn]');
    if (classifyBtn) { classifyBankTransactionClick(classifyBtn.getAttribute('data-classify-btn')); return; }
  }

  async function importBankStatement() {
    const accountSelect = document.getElementById('glx-bank-import-account');
    const fileInput = document.getElementById('glx-bank-import-file');
    if (!accountSelect.value) { setStatus('glx-bank-import-status', 'Choose an account first.'); return; }
    const file = fileInput.files[0];
    if (!file) { setStatus('glx-bank-import-status', 'Choose a CSV file first.'); return; }
    setStatus('glx-bank-import-status', 'Reading file…');
    let csvText;
    try { csvText = await file.text(); } catch { setStatus('glx-bank-import-status', 'Could not read that file.'); return; }
    setStatus('glx-bank-import-status', 'Importing…');
    const { ok, status, data } = await api('/bank-import', 'POST', { accountId: accountSelect.value, filename: file.name, csvText });
    if (!ok) { setStatus('glx-bank-import-status', describeResult(ok, status, data, 'Import')); return; }
    let message = data.note || `${data.imported} transaction(s) imported.`;
    if (data.parseWarnings?.length) message += ` ${data.parseWarnings.length} row warning(s) -- first: ${data.parseWarnings[0]}`;
    setStatus('glx-bank-import-status', message);
    fileInput.value = '';
    await loadBank();
  }

  function renderBankReconciliations() {
    const el = document.getElementById('glx-bank-reconciliations');
    if (!el) return;
    if (!state.bank.reconciliations.length) { el.innerHTML = '<div class="note">No completed reconciliations yet.</div>'; return; }
    el.innerHTML = state.bank.reconciliations.map(r => `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 4px;border-bottom:1px solid var(--line)">
        <span><b>${escapeHtml(accountNameBank(r.accountId))}</b> &middot; ${escapeHtml(r.startDate)} to ${escapeHtml(r.endDate)} &middot; statement ending ${fmt(r.statementEndingBalance)} &middot; ${escapeHtml(r.status)}</span>
        <button class="gbtn" type="button" data-verify-reconciliation="${escapeHtml(r.id)}">Verify</button>
      </div>
      <div class="note" data-reconciliation-verify-status="${escapeHtml(r.id)}" style="display:none;text-align:left;margin:2px 0 10px"></div>
    `).join('');
  }

  async function onBankReconciliationsClick(e) {
    const btn = e.target.closest('[data-verify-reconciliation]');
    if (!btn) return;
    const id = btn.getAttribute('data-verify-reconciliation');
    const statusEl = document.querySelector(`[data-reconciliation-verify-status="${id}"]`);
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Verifying…'; }
    const { ok, status, data } = await api(`/bank-reconcile?reconciliationId=${encodeURIComponent(id)}`);
    if (statusEl) statusEl.textContent = ok ? (data.valid ? 'Valid -- snapshot matches the independent audit log.' : `BROKEN -- ${(data.ledger?.mismatches || data.mismatches || []).map(m => m.reason).join(' ') || 'snapshot no longer matches.'}`) : describeResult(ok, status, data, 'Verify');
  }

  async function reconcileBankAccount() {
    const accountId = document.getElementById('glx-bank-reconcile-account').value;
    const startDate = document.getElementById('glx-bank-reconcile-start').value;
    const endDate = document.getElementById('glx-bank-reconcile-end').value;
    const beginBalance = document.getElementById('glx-bank-reconcile-begin').value;
    const endBalance = document.getElementById('glx-bank-reconcile-endbal').value;
    if (!accountId || !startDate || !endDate || beginBalance === '' || endBalance === '') { setStatus('glx-bank-reconcile-status', 'All fields are required.'); return; }
    setStatus('glx-bank-reconcile-status', 'Reconciling…');
    const { ok, status, data } = await api('/bank-reconcile', 'POST', { accountId, startDate, endDate, statementBeginningBalance: Number(beginBalance), statementEndingBalance: Number(endBalance) });
    if (!ok) { setStatus('glx-bank-reconcile-status', describeResult(ok, status, data, 'Reconcile')); return; }
    setStatus('glx-bank-reconcile-status', 'Reconciliation complete.');
    await loadBank();
  }

  async function loadBank() {
    const { ok, status, data } = await api('/bank');
    if (!ok) {
      document.getElementById('glx-bank-transactions').innerHTML = `<div class="note">Could not load the bank feed: ${escapeHtml(describeResult(ok, status, data, 'Load'))}</div>`;
      return;
    }
    state.bank = { accounts: data.accounts || [], transactions: data.transactions || [], reconciliations: data.reconciliations || [] };
    populateBankAccountSelects();
    renderBankTransactions();
    renderBankReconciliations();
    updateBankStats();
  }

  function wireBank() {
    document.getElementById('glx-bank-import-btn').addEventListener('click', importBankStatement);
    document.getElementById('glx-bank-filter-account').addEventListener('change', renderBankTransactions);
    document.getElementById('glx-bank-filter-status').addEventListener('change', renderBankTransactions);
    document.getElementById('glx-bank-transactions').addEventListener('click', onBankTransactionsClick);
    document.getElementById('glx-bank-reconcile-btn').addEventListener('click', reconcileBankAccount);
    document.getElementById('glx-bank-reconciliations').addEventListener('click', onBankReconciliationsClick);
    document.getElementById('glx-bank-reconcile-start').value = new Date(new Date().setDate(1)).toISOString().slice(0, 10);
    document.getElementById('glx-bank-reconcile-end').value = todayStr();
  }

  // -------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------
  window.hlInitBookkeepingLedger = function () {
    if (document.getElementById('glx-subnav').dataset.hlInited) { loadEntries(); return; }
    document.getElementById('glx-subnav').dataset.hlInited = '1';
    document.getElementById('glx-date').value = todayStr();
    document.getElementById('glx-report-through').value = todayStr();
    wireSubnav();
    wireEntryActions();
    wireReports();
    wireClose();
    wireBank();
    addLine();
    addLine();
    loadEntries();
  };
})();
