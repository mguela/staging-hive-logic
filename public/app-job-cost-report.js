// HiveLogic Job Cost Report — the owner/controller/accounting-facing view of
// approved actual costs flowing out of the PO engine, with preapproved and
// after-the-fact dollars kept in permanently separate totals (never blended
// into one number, per Chris's hard rule). Talks to
// /api/bookkeeping/purchase-orders/job-cost-report.js.
//
// Rebuilt for parity with the approved reference's job-cost-report.js: a
// per-line supporting-detail table (date / PO / vendor / description /
// timing / actual) inside every job card, a search + timing filter that
// operates on the already-fetched report client-side (no refetch), a real
// CSV export, and a print button. All of this consumes the same
// /job-cost-report route as before -- the route itself was extended (see
// api/bookkeeping/purchase-orders/job-cost-report.js) to attach
// vendor/timing/transactionDate onto each line, which the engine's
// approvedActualCostsForJobCosting() does not produce on its own.

(function () {
  function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  // Fix (verified stored-XSS gap, review round 2026-07-21): job.jobId,
  // job.overheadCategory, n.poNumber, and n.reason all ultimately trace back
  // to user-entered PO fields and were inserted into innerHTML unescaped.
  function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

  // Round 5 fix: reuse the same session-token helper as app-purchase-orders.js
  // and the rest of the real app (hlTokenSync() in index.html) -- this call
  // was previously unauthenticated and would 401 against the secured
  // job-cost-report route.
  async function api(path) {
    const headers = {};
    const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(`/api/bookkeeping/purchase-orders${path}`, { headers });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  // Holds the full fetched report so search/timing filters and CSV export
  // can all work against the same in-memory data without re-fetching --
  // matches the reference's architecture (report kept module-level, render()
  // re-derives visible rows from it on every filter change).
  let report = { companyTotals: { preapprovedTotal: 0, afterTheFactTotal: 0, total: 0 }, jobs: [], notReady: [] };

  function visibleLines(job) {
    const timing = document.getElementById('jcr-timing')?.value || '';
    const query = (document.getElementById('jcr-search')?.value || '').trim().toLowerCase();
    return (job.lines || []).filter(line => (!timing || line.timing === timing) && (!query || [
      job.jobId,
      job.overheadCategory,
      line.poNumber,
      line.vendor,
      line.description
    ].some(value => String(value || '').toLowerCase().includes(query))));
  }

  function timingBadge(line) {
    const afterFact = line.timing === 'after_the_fact';
    return `<span class="jcr-timing${afterFact ? ' after' : ''}">${afterFact ? 'After-the-fact' : 'Preapproved'}</span>`;
  }

  function renderReport() {
    const el = document.getElementById('jcr-body');
    if (!el) return;

    document.getElementById('jcr-stat-preapproved').textContent = money(report.companyTotals.preapprovedTotal);
    document.getElementById('jcr-stat-afterfact').textContent = money(report.companyTotals.afterTheFactTotal);
    document.getElementById('jcr-stat-total').textContent = money(report.companyTotals.total);
    const countEl = document.getElementById('jcr-stat-jobcount');
    if (countEl) countEl.textContent = report.jobs.length;

    const notReadyCard = document.getElementById('jcr-not-ready');
    if (notReadyCard) {
      if ((report.notReady || []).length) {
        notReadyCard.style.display = 'block';
        notReadyCard.innerHTML = `<h3>Not in job cost yet <span style="font-size:10px;color:var(--mut);font-weight:700">${report.notReady.length} PURCHASE ORDER${report.notReady.length === 1 ? '' : 'S'}</span></h3>` +
          `<div class="jcr-not-ready-list">${report.notReady.map(item => `<div class="jcr-not-ready-row"><b>${escapeHtml(item.poNumber || '(unnumbered)')}</b><span>${escapeHtml(item.reason)}</span></div>`).join('')}</div>`;
      } else {
        notReadyCard.style.display = 'none';
        notReadyCard.innerHTML = '';
      }
    }

    const rows = report.jobs.map(job => ({ ...job, visible: visibleLines(job) })).filter(job => job.visible.length);
    if (!rows.length) {
      el.innerHTML = `<div class="note">${report.jobs.length ? 'No approved actual costs match those filters.' : 'No approved PO-linked receipt costs yet. Create and approve a PO, then attach its receipt from Expense entry.'}</div>`;
      return;
    }

    el.innerHTML = rows.map(job => {
      const preapproved = job.visible.filter(line => line.timing === 'preapproved').reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
      const after = job.visible.filter(line => line.timing === 'after_the_fact').reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
      return `
      <section class="jcr-job-card">
        <div class="jcr-job-head">
          <div><h2>${job.jobId ? `Job ${escapeHtml(job.jobId)}` : escapeHtml(job.overheadCategory || 'Overhead')}</h2><p>${job.visible.length} approved cost line${job.visible.length === 1 ? '' : 's'} &middot; full source trail retained</p></div>
          <div class="jcr-job-total"><b>${money(preapproved + after)}</b><small>approved actual</small></div>
        </div>
        <div class="jcr-split">
          <div><small>Preapproved actual</small><b>${money(preapproved)}</b></div>
          <div class="after"><small>After-the-fact actual</small><b>${money(after)}</b></div>
        </div>
        <div class="jcr-table-wrap"><table class="jcr-table"><thead><tr><th>Date</th><th>PO</th><th>Vendor</th><th>Description</th><th>Timing</th><th>Actual</th></tr></thead><tbody>${job.visible.map(line => `<tr><td>${escapeHtml(line.transactionDate ? new Date(line.transactionDate).toLocaleDateString('en-US') : '—')}</td><td>${escapeHtml(line.poNumber)}</td><td>${escapeHtml(line.vendor || '—')}</td><td>${escapeHtml(line.description)}</td><td>${timingBadge(line)}</td><td>${money(line.amount)}</td></tr>`).join('')}</tbody></table></div>
      </section>
    `;
    }).join('');
  }

  async function refresh() {
    const { ok, data } = await api('/job-cost-report');
    if (!ok || data.enabled === false) {
      const el = document.getElementById('jcr-body');
      if (el) el.innerHTML = '<div class="note">Job cost report is disabled or not reachable in this environment.</div>';
      return;
    }
    report = { companyTotals: data.companyTotals || { preapprovedTotal: 0, afterTheFactTotal: 0, total: 0 }, jobs: data.jobs || [], notReady: data.notReady || [] };
    renderReport();
  }

  // Real CSV export from the already-fetched report -- matches the
  // reference's downloadCsv() field-for-field, using this app's real line
  // shape (vendor/timing/transactionDate now attached by the route).
  function downloadCsv() {
    const headers = ['Job / cost home', 'Date', 'PO', 'Vendor', 'Description', 'Timing', 'Actual'];
    const rows = report.jobs.flatMap(job => (job.lines || []).map(line => [
      job.jobId ? `Job ${job.jobId}` : (job.overheadCategory || 'Overhead'),
      line.transactionDate ? new Date(line.transactionDate).toLocaleDateString('en-US') : '',
      line.poNumber,
      line.vendor,
      line.description,
      line.timing === 'after_the_fact' ? 'After-the-fact' : 'Preapproved',
      Number(line.amount || 0).toFixed(2)
    ]));
    const csv = [headers, ...rows].map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    link.download = `hivelogic-job-cost-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function init() {
    if (!document.getElementById('jcr-body')) return;
    document.getElementById('jcr-search')?.addEventListener('input', renderReport);
    document.getElementById('jcr-timing')?.addEventListener('change', renderReport);
    document.getElementById('jcr-download')?.addEventListener('click', downloadCsv);
    document.getElementById('jcr-print')?.addEventListener('click', () => window.print());
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.__jcrRefresh = refresh; // exposed so expView() can re-pull on tab switch
  // Exposed so the Expenses sub-nav can (re)run init once this fragment is
  // fetched into the DOM -- init() itself is idempotent-safe (no-ops unless
  // #jcr-body exists).
  window.hlInitJobCostReport = init;
})();
