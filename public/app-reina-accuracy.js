// HiveLogic Reina Accuracy Lab — proves Reina's document extraction stays
// safe (uncertain fields held for a human, no wrong critical value silently
// accepted) using a synthetic curriculum benchmark. Talks to
// /api/bookkeeping/reina-accuracy. Reina's autonomous autofill and real
// document extraction stay hard-disabled; the "real benchmark" section is
// honestly empty/waiting until a controller authorizes a real document in.

(function () {
  function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

  async function api(path) {
    const headers = {};
    const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(`/api/bookkeeping${path}`, { headers });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  function caseRow(item) {
    const review = item.actualReview || item.actual === 'review' || item.actual === 'unknown';
    const bad = item.routedCorrectly === false || item.passed === false || item.dangerousErrors > 0;
    const detail = item.fields
      ? `${item.matchedFields} of ${item.totalFields} scored fields correct &middot; ${item.actualReview ? 'human review required' : 'safe to prefill'}`
      : `Expected ${String(item.expected).replaceAll('_', ' ')} &middot; Reina chose ${String(item.actual).replaceAll('_', ' ')}`;
    return `
      <div class="w">
        <span class="wic">${bad ? '&#9888;' : review ? '&#128064;' : '&#9989;'}</span>
        <div><b>${escapeHtml(item.label)}</b><span>${detail}</span></div>
        <span class="${bad ? 'tr down' : 'tr'}">${bad ? 'Needs work' : review ? 'Correctly held' : 'Passed'}</span>
      </div>`;
  }

  function render(data) {
    const { benchmark, learning, realBenchmark } = data;
    const summary = benchmark.summary;
    document.getElementById('ral-verdict-title').textContent = summary.safe ? 'Reina behaved safely across the curriculum.' : 'Reina found a safety failure.';
    document.getElementById('ral-verdict-copy').textContent = summary.safe
      ? `${benchmark.curriculum.documents} documents and ${benchmark.curriculum.fields} known fields were tested. Uncertain examples were held for a person, and no wrong critical value was silently accepted.`
      : 'Review the failed examples below before expanding automation.';
    document.getElementById('ral-stat-extraction').textContent = `${summary.extractionAccuracy}%`;
    document.getElementById('ral-stat-routing').textContent = `${summary.reviewRoutingAccuracy}%`;
    document.getElementById('ral-stat-learning').textContent = `${summary.learningAccuracy}%`;
    document.getElementById('ral-stat-dangerous').textContent = summary.dangerousAutoFillErrors;
    document.getElementById('ral-document-cases').innerHTML = benchmark.cases.map(caseRow).join('');
    document.getElementById('ral-learning-cases').innerHTML = benchmark.learning.cases.map(caseRow).join('');
    document.getElementById('ral-approved-corrections').textContent = learning.approvedCorrections;
    document.getElementById('ral-active-memories').textContent = learning.activeMemories;
    document.getElementById('ral-conflicting-contexts').textContent = learning.conflictingContexts;
    document.getElementById('ral-memory-integrity').textContent = learning.audit.valid ? 'Verified' : 'FAILED';
    document.getElementById('ral-autofill-enabled').textContent = learning.autoFillEnabled ? 'On' : 'Review only';
    document.getElementById('ral-real-cases').textContent = realBenchmark.cases;
    document.getElementById('ral-real-fields').textContent = realBenchmark.fields;
    document.getElementById('ral-real-dangerous').textContent = realBenchmark.cases ? realBenchmark.dangerousAutoFillErrors : 'Waiting';
    document.getElementById('ral-real-representative').textContent = realBenchmark.productionRepresentative ? 'Yes' : 'No';
    document.getElementById('ral-real-copy').textContent = realBenchmark.cases
      ? `${realBenchmark.extractionAccuracy}% exact field accuracy and ${realBenchmark.reviewRoutingAccuracy}% review-routing accuracy across explicitly authorized company documents.`
      : (realBenchmark.note || 'The protected framework is ready. No private company document has been placed in the benchmark.');
  }

  let current = null;

  async function load() {
    const el = document.getElementById('ral-document-cases');
    try {
      const { ok, data } = await api('/reina-accuracy');
      if (!ok || data.enabled === false) { if (el) el.innerHTML = '<div class="note">Reina accuracy lab is disabled or not reachable in this environment.</div>'; return; }
      if (data.error) throw new Error(data.error);
      current = data;
      render(data);
    } catch (error) {
      document.getElementById('ral-verdict-title').textContent = 'The accuracy lab could not run.';
      document.getElementById('ral-verdict-copy').textContent = error.message;
    }
  }

  function downloadReport() {
    if (!current) return;
    const blob = new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'hivelogic-reina-accuracy-report.json';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function init() {
    if (!document.getElementById('ral-document-cases')) return;
    const downloadBtn = document.getElementById('ral-download');
    if (downloadBtn) downloadBtn.addEventListener('click', downloadReport);
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.__reinaAccuracyRefresh = load;
  // Exposed so the Expenses sub-nav can (re)run init once this fragment is
  // fetched into the DOM -- init() itself is idempotent-safe (no-ops unless
  // #ral-document-cases exists).
  window.hlInitReinaAccuracy = init;
})();
