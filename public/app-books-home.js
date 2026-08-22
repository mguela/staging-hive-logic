// HiveLogic Books Home — the owner/controller-facing dashboard the reference
// app calls controller.html: one real close-readiness score, only the
// exceptions that need a person, the document review queue, and the
// evidence vault, all on one page. Chris chose (via an explicit
// architecture decision, since this app has one consolidated
// Expenses/Accounting section rather than the reference's separate
// controller.html + accounting.html pages) to add this as its own
// dedicated sub-nav tab rather than folding it into General Ledger.
//
// Talks to:
//  - GET /api/bookkeeping/ledger/close  (close-readiness score/blockers —
//    the same route the General Ledger tab's "Close readiness" sub-tab
//    already uses, now wired to REAL expense/evidence data, not empty
//    arrays — see that route's header comment)
//  - GET  /api/bookkeeping/evidence      (list stored documents — new)
//  - GET  /api/bookkeeping/evidence?id=  (fetch one document's raw bytes,
//    for the viewer — existing route, now also used for viewing not just
//    upload confirmation)
//  - POST /api/bookkeeping/evidence      (upload — existing route, reused
//    by the drop vault here exactly as app-bookkeeping.js already uses it)
//  - GET  /api/bookkeeping/document-reviews         (the document review
//    queue — new; every evidence document not yet marked reviewed, so
//    document_intake in close-readiness stops being a permanent,
//    unresolvable blocker the moment any document exists)
//  - POST /api/bookkeeping/document-reviews         (mark one document
//    reviewed — new; { id, resolution?, note? }, mirroring the reference's
//    one-click "Reviewed · no entry" action)
//  - POST /api/bookkeeping/ledger/close-package  (build + download the real
//    accountant package — new; wraps buildClosePackage(), a complete engine
//    that had no route anywhere in this app until this commit)
//  - POST /api/bookkeeping/ledger/export-package  (build + download an
//    audience-scoped export — new; wraps buildExportPackage()/
//    verifyExportPackage(), a second complete engine, distinct from
//    buildClosePackage(), that ALSO had no route anywhere in this app until
//    this commit. Unlike the accountant package above, this one supports
//    4 audiences with different redaction rules and doesn't require full
//    close readiness — see the route's own header comment for why.)
//  - POST /api/bookkeeping/backup  ("Back up now" — new; wraps
//    buildBackupArchive(), a full, checksum-manifested zip of every real
//    record this company has, including the actual bytes of every evidence
//    document, not just an index. See server/bookkeeping/src/backup.js's
//    header comment for why this is a downloadable snapshot rather than a
//    port of the reference's local-file-copy design. Never requires close
//    readiness — a backup is a safety net, not an accounting deliverable.)
//  - GET  /api/bookkeeping/controls/status          (pending QBO approvals +
//    outbox queue -- new; server/bookkeeping/src/controls.js's full
//    approval + sync-outbox engine, ported and tested since Phase 4
//    increment 1, had no route anywhere in this app until this commit)
//  - POST /api/bookkeeping/controls/decide-approval  (approve/reject one
//    pending approval -- new; { approvalId, decision, comment? }. Approving
//    an expense's QBO purchase/bill approval also auto-queues it into the
//    QBO outbox -- see that route's header comment)
//  - POST /api/bookkeeping/controls/qbo-sync         (the ONLY place in this
//    app that can write to real QuickBooks -- new; { outboxId }. A real,
//    honest no-op unless HIVELOGIC_QBO_WRITE_ENABLED=true for this whole
//    deployment; see that route's header comment)
//
// Deliberately NOT reproduced from the reference's controller.html:
//  - The "receipt ready" banner: driven entirely by Reina document-intake
//    records classified by an OCR/scan step, which is out of scope until
//    that pipeline exists (a separate, larger task — see the project's task
//    list). The document review queue above covers the review workflow this
//    app CAN honestly support today (manual review of stored evidence);
//    automatic document-type classification is intentionally not faked.
//  - A history of previously-prepared packages: buildClosePackage() is
//    stateless (builds fresh on each call, nothing is persisted), so there
//    is no package history to list. Every click regenerates the package
//    fresh instead. The same is true of backups: every "Back up now" click
//    builds a fresh snapshot; there is no list of past backups to show.

(function () {
  const todayStr = () => new Date().toISOString().slice(0, 10);
  function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

  function fmtBytes(n) {
    const bytes = Number(n) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  function fileDate(value) {
    if (!value) return '';
    return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function authHeaders(extra) {
    const headers = { ...(extra || {}) };
    const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }

  async function apiLedger(path, method, body) {
    const headers = authHeaders(body ? { 'Content-Type': 'application/json' } : {});
    const res = await fetch(`/api/bookkeeping/ledger${path}`, { method: method || (body ? 'POST' : 'GET'), headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  async function apiEvidenceList() {
    const res = await fetch('/api/bookkeeping/evidence', { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  async function apiDocumentReviews() {
    const res = await fetch('/api/bookkeeping/document-reviews', { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  async function apiResolveReview(id) {
    const res = await fetch('/api/bookkeeping/document-reviews', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id, resolution: 'reviewed_no_ledger_entry' })
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  async function apiControlsStatus() {
    const res = await fetch('/api/bookkeeping/controls/status', { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  // Task 7 -- sales tax & contractor 1099 tracking. Both are real, manually-
  // fed logs (see api/bookkeeping/sales-tax.js and ./contractors.js's header
  // comments for why): this app has no sales/invoicing data or live 1099
  // feed of its own, so these forms are the honest way to get real numbers
  // into the same salesTaxLiability()/contractorTaxReport() output the
  // close-readiness score, accountant package, and export above already
  // read via api/bookkeeping/_close_tax_adapters.js.
  async function apiTaxStatus(throughDate) {
    const res = await fetch(`/api/bookkeeping/sales-tax?throughDate=${encodeURIComponent(throughDate)}`, { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  async function apiRecordTax(body) {
    const res = await fetch('/api/bookkeeping/sales-tax', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  async function apiContractorsStatus(year) {
    const res = await fetch(`/api/bookkeeping/contractors?year=${encodeURIComponent(year)}`, { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  async function apiSaveContractor(body) {
    const res = await fetch('/api/bookkeeping/contractors', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  // Only destinations that really exist in this app -- no fabricated links.
  // A blocker id with no entry here renders as a label with no action, which
  // is the honest choice when this app has no dedicated screen for it yet
  // (approvals, bank/card matching, contractor paperwork, automation
  // exceptions, and source-link repair currently fall here). document_intake
  // now DOES have a real action -- an in-page anchor down to the review
  // queue below (a '#'-prefixed destination), rather than a separate tab to
  // switch to, since that queue lives on this same page.
  function actionFor(blockerId) {
    if (blockerId === 'document_intake') return ['Review below', '#bkh-review-section'];
    return {
      unknown_expenses: ['Assign the owner', 'bookkeeping'],
      supporting_evidence: ['Attach evidence', 'bookkeeping'],
      rejected_expenses: ['Correct in Expense entry', 'bookkeeping'],
      sales_tax: ['Assign tax state', 'bookkeeping'],
      posting: ['Review in General Ledger', 'general-ledger'],
      duplicates: ['Review in General Ledger', 'general-ledger'],
      closing_sequence: ['Review in General Ledger', 'general-ledger'],
      trial_balance: ['Review in General Ledger', 'general-ledger'],
      balance_sheet: ['Review in General Ledger', 'general-ledger'],
      ledger_audit: ['Review in General Ledger', 'general-ledger'],
      posted_seals: ['Review in General Ledger', 'general-ledger'],
      control_audit: ['Review in General Ledger', 'general-ledger']
    }[blockerId] || null;
  }

  const state = { readiness: null, evidence: [], reviews: [], controls: null, tax: null, contractors: null, contractorYear: new Date().getFullYear() };

  function showError(error) {
    const title = document.getElementById('bkh-score-title');
    const message = document.getElementById('bkh-score-message');
    if (title) title.textContent = 'Could not check the books';
    if (message) message.textContent = error?.message || 'Something went wrong loading books health.';
  }

  function renderExceptions(blockers) {
    const el = document.getElementById('bkh-exceptions');
    if (!el) return;
    if (!blockers.length) {
      el.innerHTML = '<div class="bkh-queue-clear"><b>No exceptions.</b> The period is ready for the accountant package.</div>';
      return;
    }
    el.innerHTML = blockers.map(item => {
      const action = actionFor(item.id);
      const isAnchor = action && String(action[1]).startsWith('#');
      const control = action
        ? (isAnchor
          ? `<a class="bkh-queue-action" href="${escapeHtml(action[1])}">${escapeHtml(action[0])} &rarr;</a>`
          : `<button type="button" class="bkh-queue-action" data-tab="${escapeHtml(action[1])}">${escapeHtml(action[0])} &rarr;</button>`)
        : '<span class="bkh-queue-noaction">No live screen for this yet</span>';
      return `<div class="bkh-queue-item"><div><b>${escapeHtml(item.label)}</b><p>${escapeHtml(item.detail)}</p></div>${control}</div>`;
    }).join('');
  }

  function renderEvidence(list) {
    const el = document.getElementById('bkh-evidence-list');
    if (!el) return;
    if (!list.length) {
      el.innerHTML = '<div class="note">No documents stored yet. Drop the first one above.</div>';
      return;
    }
    el.innerHTML = list.map(doc => `<div class="bkh-evidence-row" data-id="${escapeHtml(doc.id)}"><div><button type="button" class="bkh-evidence-open">${escapeHtml(doc.filename)}</button><small>${escapeHtml(fmtBytes(doc.sizeBytes))} &middot; ${escapeHtml(fileDate(doc.createdAt))} &middot; SHA-256 protected &middot; click to view</small></div></div>`).join('');
  }

  // The document review queue: every evidence document not yet marked
  // reviewed. One click marks it reviewed with no further ledger entry --
  // matching the approved reference's own single "Reviewed · no entry"
  // action (no resolution picker in its UI either, so none is added here).
  function renderReviews(list) {
    const el = document.getElementById('bkh-review-list');
    if (!el) return;
    if (!list.length) {
      el.innerHTML = '<div class="bkh-queue-clear"><b>Nothing waiting on review.</b> Every stored document has been looked at.</div>';
      return;
    }
    el.innerHTML = list.map(doc => `<div class="bkh-review-row" data-id="${escapeHtml(doc.id)}"><div><b>${escapeHtml(doc.filename)}</b><small>${escapeHtml(fmtBytes(doc.sizeBytes))} &middot; ${escapeHtml(fileDate(doc.createdAt))} &middot; original evidence retained</small></div><button type="button" class="bkh-review-resolve" data-id="${escapeHtml(doc.id)}">Reviewed &middot; no entry</button></div>`).join('');
  }

  // QuickBooks sync controls: pending approvals (server/bookkeeping/src/
  // controls.js's requestApproval()/decideApproval()) and the QBO outbox
  // queue (enqueueQboSync()/beginQboSync()/finishQboSync()). Approving here
  // never writes to QuickBooks by itself -- it only queues the item; a
  // bookkeeper or controller must separately click "Sync" below, and that
  // click is itself a real no-op unless HIVELOGIC_QBO_WRITE_ENABLED=true for
  // this whole deployment (see api/bookkeeping/controls/qbo-sync.js).
  function renderControls(data) {
    const badge = document.getElementById('bkh-controls-mode');
    if (badge) {
      const live = Boolean(data?.qboWriteEnabled);
      badge.textContent = live ? 'LIVE WRITES ON' : 'Live writes off (safe)';
      badge.className = 'bkh-controls-mode ' + (live ? 'bkh-controls-mode-live' : 'bkh-controls-mode-safe');
    }
    const el = document.getElementById('bkh-controls-list');
    if (!el) return;
    const approvals = data?.pendingApprovals || [];
    const outbox = (data?.qboOutbox || []).filter(item => item.status !== 'complete');
    if (!approvals.length && !outbox.length) {
      el.innerHTML = '<div class="bkh-queue-clear"><b>Nothing waiting on QuickBooks.</b> No pending approvals or queued syncs.</div>';
      return;
    }
    const approvalRows = approvals.map(item => `<div class="bkh-review-row"><div><b>${escapeHtml(item.entityType)} approval</b><small>Requested ${escapeHtml(fileDate(item.requestedAt))} &middot; ${item.decisions.length}/${item.approvalsRequired} decision(s)</small></div><div><button type="button" class="bkh-review-resolve" data-approve="${escapeHtml(item.id)}">Approve</button><button type="button" class="bkh-review-resolve bkh-reject" data-reject="${escapeHtml(item.id)}">Reject</button></div></div>`).join('');
    const outboxRows = outbox.map(item => `<div class="bkh-review-row"><div><b>${escapeHtml(item.entityType)} · ${escapeHtml(item.status)}</b><small>${item.attempts.length} attempt(s)${item.status === 'blocked' ? ' &middot; needs manual review' : ''}</small></div>${item.status === 'blocked' ? '<span class="bkh-queue-noaction">Needs manual review</span>' : `<button type="button" class="bkh-review-resolve" data-sync="${escapeHtml(item.id)}">Sync</button>`}</div>`).join('');
    el.innerHTML = approvalRows + outboxRows;
  }

  function money(value) {
    const n = Number(value) || 0;
    return '$' + n.toFixed(2);
  }

  function renderTax() {
    const liabilityEl = document.getElementById('bkh-tax-liability');
    if (liabilityEl) {
      const states = state.tax?.liability?.states || [];
      if (!states.length) {
        liabilityEl.innerHTML = '<div class="bkh-queue-clear"><b>No sales-tax entries logged yet.</b> Nothing is owed because nothing has been recorded.</div>';
      } else {
        liabilityEl.innerHTML = states.map(row => `<div class="bkh-tax-row"><b>${escapeHtml(row.state)}</b><span>Taxable ${money(row.taxableSales)}</span><span>Collected ${money(row.taxCollected)}</span><span>Remitted ${money(row.taxRemitted)}</span><span class="${row.liability > 0 ? 'bad' : ''}">Owed ${money(row.liability)}</span></div>`).join('');
      }
    }

    const contractorEl = document.getElementById('bkh-contractor-list');
    if (contractorEl) {
      const contractors = state.contractors?.report?.contractors || [];
      if (!contractors.length) {
        contractorEl.innerHTML = '<div class="bkh-queue-clear"><b>No tracked 1099 contractors yet.</b> Track one below to see a real report.</div>';
      } else {
        contractorEl.innerHTML = contractors.map(item => `<div class="bkh-tax-row"><b>${escapeHtml(item.vendorName)}</b><span>${money(item.total)} paid</span><span>${item.reportable ? 'Reportable' : 'Below threshold'}</span><span class="${item.blockers.length ? 'bad' : ''}">${item.blockers.length ? escapeHtml(item.blockers.join(', ')) : 'Ready'}</span></div>`).join('');
      }
    }
  }

  function render() {
    const readiness = state.readiness;
    if (!readiness) return;
    const scoreEl = document.getElementById('bkh-score');
    if (scoreEl) scoreEl.style.setProperty('--score', readiness.score);
    const scoreText = document.getElementById('bkh-score-text');
    if (scoreText) scoreText.textContent = `${readiness.score}%`;
    const bar = document.getElementById('bkh-bar');
    if (bar) bar.style.width = `${readiness.score}%`;
    const blockerCount = (readiness.blockers || []).length;
    const title = document.getElementById('bkh-score-title');
    if (title) title.textContent = readiness.ready ? 'Ready to close' : `${blockerCount} answer${blockerCount === 1 ? '' : 's'} still needed`;
    const message = document.getElementById('bkh-score-message');
    if (message) message.textContent = readiness.ready ? 'Every close control passed. The accountant package can be prepared.' : 'Nothing will be silently forced through. Resolve the items beside this score.';
    const expensesEl = document.getElementById('bkh-metric-expenses');
    if (expensesEl) expensesEl.textContent = readiness.summary?.expenses ?? 0;
    const documentsEl = document.getElementById('bkh-metric-documents');
    if (documentsEl) documentsEl.textContent = state.evidence.length;
    const blockersEl = document.getElementById('bkh-metric-blockers');
    if (blockersEl) blockersEl.textContent = blockerCount;
    const reviewEl = document.getElementById('bkh-metric-reviews');
    if (reviewEl) reviewEl.textContent = state.reviews.length;
    const prepareBtn = document.getElementById('bkh-prepare');
    if (prepareBtn) prepareBtn.disabled = !readiness.ready;
    const noteEl = document.getElementById('bkh-close-note');
    if (noteEl) noteEl.textContent = readiness.note || '';
    renderExceptions(readiness.blockers || []);
    renderReviews(state.reviews);
    renderEvidence(state.evidence);
    renderControls(state.controls);
  }

  async function refresh() {
    const throughInput = document.getElementById('bkh-through');
    const throughDate = (throughInput && throughInput.value) || todayStr();
    const [closeResult, evidenceResult, reviewsResult, controlsResult] = await Promise.all([
      apiLedger(`/close?throughDate=${encodeURIComponent(throughDate)}`),
      apiEvidenceList(),
      apiDocumentReviews(),
      apiControlsStatus()
    ]);
    if (!closeResult.ok) { showError(new Error(closeResult.data?.error || 'Books health could not be loaded.')); return; }
    state.readiness = closeResult.data;
    state.evidence = (evidenceResult.ok && Array.isArray(evidenceResult.data?.documents)) ? evidenceResult.data.documents : [];
    state.reviews = (reviewsResult.ok && Array.isArray(reviewsResult.data?.reviews)) ? reviewsResult.data.reviews : [];
    state.controls = (controlsResult.ok && controlsResult.data) ? controlsResult.data : null;
    render();
    await Promise.all([refreshTax(), refreshContractors()]);
  }

  async function refreshTax() {
    const throughInput = document.getElementById('bkh-through');
    const throughDate = (throughInput && throughInput.value) || todayStr();
    const result = await apiTaxStatus(throughDate);
    if (result.ok && result.data) state.tax = result.data;
    renderTax();
  }

  async function refreshContractors() {
    const yearInput = document.getElementById('bkh-contractor-year');
    const year = (yearInput && yearInput.value) || state.contractorYear;
    const result = await apiContractorsStatus(year);
    if (result.ok && result.data) state.contractors = result.data;
    renderTax();
  }

  async function onTaxCollectedSubmit(event) {
    event.preventDefault();
    const statusEl = document.getElementById('bkh-tax-status');
    const btn = event.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Saving\u2026';
    try {
      const result = await apiRecordTax({
        kind: 'collected',
        taxState: document.getElementById('bkh-tc-state').value,
        date: document.getElementById('bkh-tc-date').value,
        taxableAmount: document.getElementById('bkh-tc-taxable').value,
        exemptAmount: document.getElementById('bkh-tc-exempt').value || 0,
        taxCollected: document.getElementById('bkh-tc-collected').value,
        jobRef: document.getElementById('bkh-tc-job').value || null
      });
      if (!result.ok) throw new Error(result.data?.error || 'Could not log this entry.');
      if (statusEl) statusEl.textContent = result.data?.note || 'Logged.';
      event.target.reset();
      await refreshTax();
    } catch (error) {
      if (statusEl) statusEl.innerHTML = `<span class="bkh-error-note">${escapeHtml(error.message || 'Could not log this entry.')}</span>`;
    }
    if (btn) btn.disabled = false;
  }

  async function onTaxRemittedSubmit(event) {
    event.preventDefault();
    const statusEl = document.getElementById('bkh-tax-status');
    const btn = event.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Saving\u2026';
    try {
      const result = await apiRecordTax({
        kind: 'remitted',
        taxState: document.getElementById('bkh-tr-state').value,
        date: document.getElementById('bkh-tr-date').value,
        amount: document.getElementById('bkh-tr-amount').value
      });
      if (!result.ok) throw new Error(result.data?.error || 'Could not log this entry.');
      if (statusEl) statusEl.textContent = result.data?.note || 'Logged.';
      event.target.reset();
      await refreshTax();
    } catch (error) {
      if (statusEl) statusEl.innerHTML = `<span class="bkh-error-note">${escapeHtml(error.message || 'Could not log this entry.')}</span>`;
    }
    if (btn) btn.disabled = false;
  }

  async function onContractorFormSubmit(event) {
    event.preventDefault();
    const statusEl = document.getElementById('bkh-contractor-status');
    const btn = event.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Saving\u2026';
    try {
      const result = await apiSaveContractor({
        vendorName: document.getElementById('bkh-ctr-name').value,
        track1099: document.getElementById('bkh-ctr-track').checked,
        w9OnFile: document.getElementById('bkh-ctr-w9').checked,
        taxIdLast4: document.getElementById('bkh-ctr-taxid').value || null
      });
      if (!result.ok) throw new Error(result.data?.error || 'Could not save this contractor.');
      if (statusEl) statusEl.textContent = result.data?.note || 'Saved.';
      event.target.reset();
      await refreshContractors();
    } catch (error) {
      if (statusEl) statusEl.innerHTML = `<span class="bkh-error-note">${escapeHtml(error.message || 'Could not save this contractor.')}</span>`;
    }
    if (btn) btn.disabled = false;
  }

  function onContractorYearChange() { refreshContractors().catch(showError); }

  async function fileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function uploadFiles(fileList) {
    const list = [...(fileList || [])];
    if (!list.length) return;
    const statusEl = document.getElementById('bkh-upload-status');
    let completed = 0;
    for (const file of list) {
      if (statusEl) statusEl.textContent = `Uploading ${completed + 1} of ${list.length}…`;
      try {
        const dataBase64 = await fileBase64(file);
        const res = await fetch('/api/bookkeeping/evidence', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ filename: file.name, mimeType: file.type || 'application/octet-stream', dataBase64 })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Upload failed.');
        completed += 1;
      } catch (error) {
        if (statusEl) statusEl.innerHTML = `<span class="bkh-error-note">${escapeHtml(file.name)}: ${escapeHtml(error.message)}</span>`;
      }
    }
    if (statusEl && completed === list.length) statusEl.textContent = `${completed} file${completed === 1 ? '' : 's'} stored.`;
    const input = document.getElementById('bkh-drop-input');
    if (input) input.value = '';
    await refresh().catch(showError);
  }

  async function resolveReview(id, button) {
    if (button) { button.disabled = true; button.textContent = 'Saving…'; }
    const statusEl = document.getElementById('bkh-review-status');
    const result = await apiResolveReview(id);
    if (!result.ok) {
      if (statusEl) statusEl.innerHTML = `<span class="bkh-error-note">${escapeHtml(result.data?.error || 'Could not mark this document reviewed.')}</span>`;
      if (button) { button.disabled = false; button.textContent = 'Reviewed · no entry'; }
      return;
    }
    if (statusEl) statusEl.textContent = 'Document marked reviewed. The original evidence and audit record were retained.';
    await refresh().catch(showError);
  }

  async function refreshControls() {
    const result = await apiControlsStatus();
    if (result.ok && result.data) state.controls = result.data;
    renderControls(state.controls);
  }

  async function decideApproval(approvalId, decision, button) {
    if (button) button.disabled = true;
    const statusEl = document.getElementById('bkh-controls-status');
    if (statusEl) statusEl.textContent = decision === 'approve' ? 'Approving\u2026' : 'Rejecting\u2026';
    try {
      const res = await fetch('/api/bookkeeping/controls/decide-approval', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ approvalId, decision })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not decide this approval.');
      if (statusEl) statusEl.textContent = data.note || `Approval ${decision}d.`;
    } catch (error) {
      if (statusEl) statusEl.innerHTML = `<span class="bkh-error-note">${escapeHtml(error.message || 'Could not decide this approval.')}</span>`;
    }
    await refreshControls();
  }

  async function syncOutboxItem(outboxId, button) {
    if (button) { button.disabled = true; button.textContent = 'Syncing\u2026'; }
    const statusEl = document.getElementById('bkh-controls-status');
    if (statusEl) statusEl.textContent = 'Contacting QuickBooks\u2026';
    try {
      const res = await fetch('/api/bookkeeping/controls/qbo-sync', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ outboxId })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not sync this item to QuickBooks.');
      if (statusEl) statusEl.textContent = data.note || (data.synced ? 'Synced to QuickBooks.' : 'Not synced.');
    } catch (error) {
      if (statusEl) statusEl.innerHTML = `<span class="bkh-error-note">${escapeHtml(error.message || 'Could not sync this item to QuickBooks.')}</span>`;
    }
    await refreshControls();
  }

  async function openEvidence(id) {
    const doc = state.evidence.find(d => d.id === id);
    if (!doc) return;
    const res = await fetch(`/api/bookkeeping/evidence?id=${encodeURIComponent(id)}`, { headers: authHeaders() });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const isImage = String(doc.mimeType || '').startsWith('image/');
    const isPdf = doc.mimeType === 'application/pdf' || String(doc.filename || '').toLowerCase().endsWith('.pdf');
    const titleEl = document.getElementById('bkh-evidence-viewer-title');
    const img = document.getElementById('bkh-evidence-viewer-image');
    const frame = document.getElementById('bkh-evidence-viewer-frame');
    if (titleEl) titleEl.textContent = doc.filename;
    if (img) { img.hidden = !isImage; if (isImage) img.src = url; }
    if (frame) { frame.hidden = isImage; if (!isImage) frame.src = isPdf ? `${url}#view=FitH` : url; }
    const dialog = document.getElementById('bkh-evidence-viewer');
    if (dialog && typeof dialog.showModal === 'function') {
      dialog.showModal();
      dialog.addEventListener('close', () => URL.revokeObjectURL(url), { once: true });
    }
  }

  async function prepareClose() {
    const btn = document.getElementById('bkh-prepare');
    const statusEl = document.getElementById('bkh-close-status');
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Verifying and packaging…';
    const throughInput = document.getElementById('bkh-through');
    const throughDate = (throughInput && throughInput.value) || todayStr();
    try {
      const res = await fetch('/api/bookkeeping/ledger/close-package', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ throughDate })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (statusEl) statusEl.innerHTML = `<span class="bkh-error-note">${escapeHtml(data.error || 'Could not prepare the accountant package.')}</span>`;
        await refresh().catch(showError);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `hivelogic-close-package-${throughDate}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      if (statusEl) statusEl.textContent = 'Package downloaded.';
    } catch (error) {
      if (statusEl) statusEl.innerHTML = `<span class="bkh-error-note">${escapeHtml(error.message || 'Could not prepare the accountant package.')}</span>`;
    }
    await refresh().catch(showError);
  }

  // "Back up now": builds and downloads a full, checksum-manifested backup
  // of every real record this company has (see server/bookkeeping/src/
  // backup.js). Never gated on close readiness -- a backup is a safety net,
  // not an accounting deliverable, so this works even mid-period.
  async function backupNow() {
    const btn = document.getElementById('bkh-backup');
    const statusEl = document.getElementById('bkh-backup-status');
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Backing up…';
    try {
      const res = await fetch('/api/bookkeeping/backup', { method: 'POST', headers: authHeaders() });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (statusEl) statusEl.innerHTML = `<span class="bkh-error-note">${escapeHtml(data.error || 'Could not build a backup.')}</span>`;
        if (btn) btn.disabled = false;
        return;
      }
      const fileCount = res.headers.get('x-backup-file-count');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `hivelogic-backup-${todayStr()}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      if (statusEl) statusEl.textContent = fileCount ? `Backup verified and downloaded — ${fileCount} file(s), checksummed.` : 'Backup verified and downloaded.';
    } catch (error) {
      if (statusEl) statusEl.innerHTML = `<span class="bkh-error-note">${escapeHtml(error.message || 'Could not build a backup.')}</span>`;
    }
    if (btn) btn.disabled = false;
  }

  async function exportPackage() {
    const btn = document.getElementById('bkh-export');
    const statusEl = document.getElementById('bkh-export-status');
    const audienceSelect = document.getElementById('bkh-export-audience');
    const audience = (audienceSelect && audienceSelect.value) || 'accountant';
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Building export…';
    const throughInput = document.getElementById('bkh-through');
    const throughDate = (throughInput && throughInput.value) || todayStr();
    try {
      const res = await fetch('/api/bookkeeping/ledger/export-package', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ audience, throughDate })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (statusEl) statusEl.innerHTML = `<span class="bkh-error-note">${escapeHtml(data.error || 'Could not build this export.')}</span>`;
        if (btn) btn.disabled = false;
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `hivelogic-${audience}-export-${throughDate}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      if (statusEl) statusEl.textContent = 'Export downloaded.';
    } catch (error) {
      if (statusEl) statusEl.innerHTML = `<span class="bkh-error-note">${escapeHtml(error.message || 'Could not build this export.')}</span>`;
    }
    if (btn) btn.disabled = false;
  }

  // Named, module-scope handlers (not inline closures created fresh per
  // init() call) so that wire() is safe to call every time this tab is
  // revisited: the DOM/EventTarget spec dedupes addEventListener calls with
  // an identical (type, listener, capture) triple, so re-registering the
  // same function reference on every visit never produces duplicate
  // handlers -- the same pattern app-job-cost-report.js and
  // app-bookkeeping-ledger.js already rely on.
  function onThroughDateChange() { refresh().catch(showError); }
  function onDropInputChange(event) { uploadFiles(event.target.files); }
  function onDragEnter(event) { event.preventDefault(); const vault = document.getElementById('bkh-drop-vault'); if (vault) vault.classList.add('dragging'); }
  function onDragLeave(event) { event.preventDefault(); const vault = document.getElementById('bkh-drop-vault'); if (vault) vault.classList.remove('dragging'); }
  function onDrop(event) { event.preventDefault(); const vault = document.getElementById('bkh-drop-vault'); if (vault) vault.classList.remove('dragging'); uploadFiles(event.dataTransfer.files); }
  function onExceptionsClick(event) {
    const btn = event.target.closest('[data-tab]');
    if (btn && typeof window.hlSelectExpxTab === 'function') window.hlSelectExpxTab(btn.getAttribute('data-tab'));
  }
  function onEvidenceListClick(event) {
    const row = event.target.closest('.bkh-evidence-row[data-id]');
    if (row) openEvidence(row.getAttribute('data-id'));
  }
  function onReviewListClick(event) {
    const btn = event.target.closest('.bkh-review-resolve[data-id]');
    if (btn) resolveReview(btn.getAttribute('data-id'), btn);
  }
  function onControlsClick(event) {
    const approveBtn = event.target.closest('[data-approve]');
    if (approveBtn) { decideApproval(approveBtn.getAttribute('data-approve'), 'approve', approveBtn); return; }
    const rejectBtn = event.target.closest('[data-reject]');
    if (rejectBtn) { decideApproval(rejectBtn.getAttribute('data-reject'), 'reject', rejectBtn); return; }
    const syncBtn = event.target.closest('[data-sync]');
    if (syncBtn) syncOutboxItem(syncBtn.getAttribute('data-sync'), syncBtn);
  }
  function onViewerCloseClick() { const dialog = document.getElementById('bkh-evidence-viewer'); if (dialog) dialog.close(); }
  function onViewerBackdropClick(event) { if (event.target && event.target.id === 'bkh-evidence-viewer') { const dialog = document.getElementById('bkh-evidence-viewer'); if (dialog) dialog.close(); } }

  function wire() {
    const throughInput = document.getElementById('bkh-through');
    if (throughInput) { if (!throughInput.value) throughInput.value = todayStr(); throughInput.addEventListener('change', onThroughDateChange); }
    const yearInput = document.getElementById('bkh-contractor-year');
    if (yearInput) { if (!yearInput.value) yearInput.value = state.contractorYear; yearInput.addEventListener('change', onContractorYearChange); }
    document.getElementById('bkh-tax-collected-form')?.addEventListener('submit', onTaxCollectedSubmit);
    document.getElementById('bkh-tax-remitted-form')?.addEventListener('submit', onTaxRemittedSubmit);
    document.getElementById('bkh-contractor-form')?.addEventListener('submit', onContractorFormSubmit);
    document.getElementById('bkh-drop-input')?.addEventListener('change', onDropInputChange);
    const vault = document.getElementById('bkh-drop-vault');
    if (vault) {
      vault.addEventListener('dragenter', onDragEnter);
      vault.addEventListener('dragover', onDragEnter);
      vault.addEventListener('dragleave', onDragLeave);
      vault.addEventListener('drop', onDrop);
    }
    document.getElementById('bkh-exceptions')?.addEventListener('click', onExceptionsClick);
    document.getElementById('bkh-evidence-list')?.addEventListener('click', onEvidenceListClick);
    document.getElementById('bkh-review-list')?.addEventListener('click', onReviewListClick);
    document.getElementById('bkh-controls-list')?.addEventListener('click', onControlsClick);
    document.getElementById('bkh-evidence-viewer-close')?.addEventListener('click', onViewerCloseClick);
    document.getElementById('bkh-evidence-viewer')?.addEventListener('click', onViewerBackdropClick);
    document.getElementById('bkh-prepare')?.addEventListener('click', prepareClose);
    document.getElementById('bkh-backup')?.addEventListener('click', backupNow);
    document.getElementById('bkh-export')?.addEventListener('click', exportPackage);
  }

  function init() {
    if (!document.getElementById('bkh-score')) return;
    wire();
    refresh().catch(showError);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  // Exposed so the Expenses sub-nav can (re)run init once this fragment is
  // fetched into the DOM -- init() itself is idempotent-safe (no-ops unless
  // #bkh-score exists; wire()'s handlers are stable references so repeat
  // calls never double-bind).
  window.hlInitBooksHome = init;
})();
