// HiveLogic Bookkeeper Confidence Lab — a safe practice run of the real
// ledger/reporting/banking/close/export engine against a fictional practice
// company. Never touches real company data. Talks to
// /api/bookkeeping/confidence-lab.

(function () {
  function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

  async function api(path) {
    const headers = {};
    const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(`/api/bookkeeping${path}`, { headers });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  let latest = null;

  function render(lab) {
    latest = lab;
    const { summary, financialSnapshot, checks } = lab;
    document.getElementById('cl-score').textContent = `${summary.score}%`;
    document.getElementById('cl-headline').textContent = summary.failed ? `${summary.failed} practice check${summary.failed === 1 ? '' : 's'} needs attention` : 'The practice month held together.';
    document.getElementById('cl-summary').textContent = summary.failed ? 'The safe practice run found a control that needs work before relying on it.' : `${summary.passed} controls passed. The ledger balanced, the bank statement sealed, and the accountant package verified.`;
    document.getElementById('cl-passed').textContent = summary.passed;
    document.getElementById('cl-failed').textContent = summary.failed;
    document.getElementById('cl-revenue').textContent = money(financialSnapshot.revenue);
    document.getElementById('cl-profit').textContent = money(financialSnapshot.netIncome);

    const groups = new Map();
    for (const check of checks) groups.set(check.family, [...(groups.get(check.family) || []), check]);
    document.getElementById('cl-checks').innerHTML = [...groups.entries()].map(([family, familyChecks]) => `
      <h3 style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin:16px 0 8px">${escapeHtml(family)}</h3>
      ${familyChecks.map(check => `
        <div class="w">
          <span class="wic">${check.passed ? '&#9989;' : '&#9888;'}</span>
          <div><b>${escapeHtml(check.title)}</b><span>${escapeHtml(check.plainEnglish)}</span><span style="color:#1c6e9e;font-weight:700">${escapeHtml(check.evidence)}</span></div>
        </div>
      `).join('')}
    `).join('');
  }

  async function load() {
    const runBtn = document.getElementById('cl-run');
    if (runBtn) runBtn.disabled = true;
    const el = document.getElementById('cl-checks');
    if (el) el.innerHTML = '<div class="note">Running the practice month&#8230;</div>';
    try {
      const { ok, data } = await api('/confidence-lab');
      if (!ok || data.enabled === false) { if (el) el.innerHTML = '<div class="note">Confidence lab is disabled or not reachable in this environment.</div>'; return; }
      if (data.error) { if (el) el.innerHTML = `<div class="note">Could not run the confidence lab: ${escapeHtml(data.error)}</div>`; return; }
      render(data);
    } finally {
      if (runBtn) runBtn.disabled = false;
    }
  }

  function downloadLab() {
    if (!latest) return;
    const blob = new Blob([JSON.stringify(latest, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'hivelogic-bookkeeper-confidence-lab.json';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function init() {
    if (!document.getElementById('cl-checks')) return;
    const runBtn = document.getElementById('cl-run');
    const downloadBtn = document.getElementById('cl-download');
    if (runBtn) runBtn.addEventListener('click', load);
    if (downloadBtn) downloadBtn.addEventListener('click', downloadLab);
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.__confidenceLabRefresh = load;
  // Exposed so the Expenses sub-nav can (re)run init once this fragment is
  // fetched into the DOM -- init() itself is idempotent-safe (no-ops unless
  // #cl-checks exists).
  window.hlInitConfidenceLab = init;
})();
