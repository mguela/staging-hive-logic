// api/test-workflow.js — Autonomous workflow test runner (Option 2).
// Chris 2026-07-29: "Build option 2" — a server-side runner so Reina can drive
// the real app as a test user WITHOUT a browser login or a live session, then
// "run everything exhaustively until you make it fail and then suggest repairs."
//
// HOW IT AUTHENTICATES (no password, no account creation by code):
//   ONE limited test user exists (TEST_USER_EMAIL). This endpoint mints a
//   short-lived session for THAT user via the Supabase GoTrue admin API
//   (generate_link(magiclink) -> verify) and uses the resulting user
//   access_token to call the app's OWN API exactly as a logged-in user would.
//   The app validates that token at /auth/v1/user, so real handler logic runs.
//   The test user has a profiles row (role=admin -> maps to bookkeeping
//   'controller'), so it can reach the Accounting Control routes too.
//
// SAFETY (safe by construction):
//   - Secret-gated (?key=RUN_SECRET). Vercel/Chris only.
//   - CORE PIPELINE steps create REAL HiveLogic-native rows (lead, job,
//     invoice DRAFT, job-workflow, material line) tagged 'ZZTESTRUN', then the
//     run DELETES every one of them by exact id in a finally block. Nothing is
//     left behind. A ?mode=cleanup sentinel sweep is the safety net.
//   - BOOKKEEPING steps (estimate / change order / PO / expense) are REACHABILITY
//     PROBES ONLY: they send a deliberately-incomplete payload so the engine
//     returns a 422 validation error — proving the endpoint is enabled, auth
//     works, and the body is parsed, WITHOUT creating any financial record.
//   - NEVER fires external actions: no Jobber write, no Twilio/Resend, no
//     Authorize.net. Those are logged as "external — skipped".
//
// AUTH (2026-08-01, Item 2 — was a hard-coded secret accepted via ?key=):
//   The runner secret now lives ONLY in the env var TEST_WORKFLOW_SECRET and
//   is accepted ONLY via the Authorization: Bearer <secret> header — never a
//   query string (query strings leak into logs, browser history, referrers).
//   Comparison is timing-safe, and the endpoint FAILS CLOSED (500) if the env
//   var is unset. The previously-committed literal secret must be rotated by
//   Chris (see the delivery report) — it is compromised by virtue of having
//   been in git history.
//
// Manual run:  curl -H "Authorization: Bearer $TEST_WORKFLOW_SECRET" \
//                   "https://hivelogic-live.vercel.app/api/test-workflow?mode=run"
// Cleanup:     ...same header... "?mode=cleanup"

import crypto from 'node:crypto';

import { selfOrigin, selfFetchInit } from './_lib/self-origin.js';

const TEST_USER_EMAIL = 'reina-test@ghgrp.net';
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const TAG = 'ZZTESTRUN';
const enc = encodeURIComponent;

function sbHeaders(extra) { return Object.assign({ apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, extra || {}); }

// Timing-safe string compare — no early-out on the first differing byte.
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

// Gate the runner: secret from env only, presented via Authorization: Bearer.
// Returns true if authorized; otherwise writes the response and returns false.
function authorizeRunner(req, res) {
  const secret = process.env.TEST_WORKFLOW_SECRET;
  if (!secret) { res.status(500).json({ ok: false, error: 'Runner is not configured (TEST_WORKFLOW_SECRET is unset).' }); return false; }
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const provided = String(authHeader).replace(/^Bearer\s+/i, '').trim();
  if (!provided || !timingSafeEqualStr(provided, secret)) {
    res.status(401).json({ ok: false, error: 'Runner is locked. Provide the run secret via Authorization: Bearer <secret>.' });
    return false;
  }
  return true;
}

// Mint a real user access_token for the existing test user — password-free.
async function mintTestToken() {
  const gen = await fetch(`${SB}/auth/v1/admin/generate_link`, {
    method: 'POST', headers: sbHeaders(),
    body: JSON.stringify({ type: 'magiclink', email: TEST_USER_EMAIL }),
  });
  const genJson = await gen.json().catch(() => ({}));
  const hashed = genJson.hashed_token || (genJson.properties && genJson.properties.hashed_token);
  if (!gen.ok || !hashed) return { ok: false, reason: 'generate_link_failed', detail: JSON.stringify(genJson).slice(0, 200) };
  const ver = await fetch(`${SB}/auth/v1/verify`, {
    method: 'POST', headers: sbHeaders(),
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed }),
  });
  const verJson = await ver.json().catch(() => ({}));
  if (!ver.ok || !verJson.access_token) return { ok: false, reason: 'verify_failed', detail: JSON.stringify(verJson).slice(0, 200) };
  return { ok: true, token: verJson.access_token, userId: verJson.user && verJson.user.id };
}

// Call an app API endpoint AS the test user.
//
// selfOrigin() rather than a pinned production URL: this runner does WRITES
// (create_job, job_workflow_set, materials_cart_add, create_invoice). Pinned
// to production, a run triggered on a preview deployment exercised
// production's functions under production's env -- so the preview's own code
// was never tested, and the fixtures landed in production's data.
async function asUser(token, method, path, body) {
  const r = await fetch(selfOrigin() + path, selfFetchInit({
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }));
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, ok: r.ok, data };
}

// Delete rows directly (service key) — used for exact-id self-cleanup.
async function sbDelete(table, filter) {
  const r = await fetch(`${SB}/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: sbHeaders({ Prefer: 'return=representation' }) });
  let rows = []; try { rows = await r.json(); } catch (e) {}
  return { table, filter, ok: r.ok, deleted: Array.isArray(rows) ? rows.length : 0 };
}
async function sbSelect(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: sbHeaders() });
  let rows = []; try { rows = await r.json(); } catch (e) {}
  return Array.isArray(rows) ? rows : [];
}

// Sentinel safety-net sweep (in case a run died before its finally cleanup).
async function cleanupBySentinel() {
  const log = [];
  log.push(await sbDelete('product_snapshots', `title=like.*${TAG}*`));
  const jobs = await sbSelect(`jobs?title=like.*${TAG}*&select=jobber_id`);
  for (const j of jobs) log.push(await sbDelete('job_workflow', `job_ref=eq.${enc(j.jobber_id)}`));
  log.push(await sbDelete('jobs', `title=like.*${TAG}*`));
  const clients = await sbSelect(`clients?name=like.*${TAG}*&select=jobber_id`);
  for (const c of clients) {
    log.push(await sbDelete('lead_pipeline', `client_id=eq.${enc(c.jobber_id)}`));
    log.push(await sbDelete('invoices', `client_id=eq.${enc(c.jobber_id)}`));
  }
  log.push(await sbDelete('clients', `name=like.*${TAG}*`));
  return log;
}

// Interpret a bookkeeping reachability probe (never creates anything).
function interpretBk(name, resp, sentPhrase) {
  const d = resp.data || {};
  if (d.enabled === false) return { name, verdict: 'FLAG_OFF', note: 'Built, but BOOKKEEPING_ENABLED is off — flip the env flag to switch it on.' };
  if (resp.ok && d.ok) return { name, verdict: 'CREATED', note: `HTTP 200 (store=${d.storeBackend || '?'}) — probe unexpectedly created a row; durable rows need cleanup.` };
  const err = String(d.error || '');
  if (resp.status === 422) {
    if (sentPhrase && err.toLowerCase().includes(sentPhrase.toLowerCase()))
      return { name, verdict: 'BODY_EMPTY', note: `Endpoint got an empty body (still asks for a field we sent) — same req.body bug as leads: "${err.slice(0, 90)}"` };
    return { name, verdict: 'REACHABLE', note: `Enabled + auth + body OK; engine reached, nothing created. Validation: "${err.slice(0, 90)}"` };
  }
  if (resp.status === 401) return { name, verdict: 'FAIL', note: `401 auth — ${err.slice(0, 120)}` };
  return { name, verdict: 'CHECK', note: `HTTP ${resp.status} — ${err.slice(0, 140)}` };
}

export default async function handler(req, res) {
  const q = req.query || {};
  if (!authorizeRunner(req, res)) return;
  if (!SB || !KEY) return res.status(500).json({ ok: false, error: 'Supabase env not configured.' });

  if (q.mode === 'cleanup') {
    const c = await cleanupBySentinel();
    return res.status(200).json({ ok: true, mode: 'cleanup', result: c });
  }

  if (q.mode === 'co') {
    // Full Change-Order lifecycle against the real engine (create -> list ->
    // send -> approve -> record-payment), then delete the durable row it made.
    const out = [];
    const auth0 = await mintTestToken();
    if (!auth0.ok) return res.status(200).json({ ok: false, blocked: auth0.reason });
    const tk = auth0.token;
    const jobTag = TAG + '-CO-' + (auth0.userId || '').slice(0, 6);
    const c1 = await asUser(tk, 'POST', '/api/bookkeeping/change-orders/create', {
      jobId: jobTag, jobLabel: jobTag, kind: 'estimate', description: TAG + ' add recessed lighting',
      lines: [{ type: 'labor', description: TAG + ' electrician', qty: 4, unit: 'hr', unitCost: 90, pmode: 'markup' }],
    });
    const coId = c1.data && c1.data.changeOrder && c1.data.changeOrder.id;
    out.push({ step: 'create', ok: c1.ok, id: coId || null, note: (c1.data && c1.data.error) || (c1.data && c1.data.changeOrder && c1.data.changeOrder.coNumber) || ('HTTP ' + c1.status) });
    const lst = await asUser(tk, 'GET', '/api/bookkeeping/change-orders/list');
    const found = lst.data && lst.data.changeOrders && lst.data.changeOrders.some(function (c) { return c.id === coId; });
    out.push({ step: 'list', ok: lst.ok && !!found, note: 'sees ' + ((lst.data && lst.data.changeOrders) ? lst.data.changeOrders.length : 0) + ' total; ours ' + (found ? 'present' : 'MISSING') });
    if (coId) {
      const sn = await asUser(tk, 'POST', '/api/bookkeeping/change-orders/send', { id: coId });
      out.push({ step: 'send', ok: sn.ok, note: (sn.data && sn.data.error) || ('HTTP ' + sn.status) });
      const ap = await asUser(tk, 'POST', '/api/bookkeeping/change-orders/approve', { id: coId });
      out.push({ step: 'approve', ok: ap.ok, note: (ap.data && ap.data.error) || ('HTTP ' + ap.status) });
      const pay = await asUser(tk, 'POST', '/api/bookkeeping/change-orders/record-payment', { id: coId, amount: 100, method: 'manual', reference: TAG });
      out.push({ step: 'record-payment', ok: pay.ok, note: (pay.data && pay.data.error) || ('HTTP ' + pay.status) });
    }
    const del = await sbDelete('change_orders', `data->>jobId=like.*${TAG}*`);
    out.push({ step: 'cleanup (durable row)', ok: del.ok, note: 'deleted ' + del.deleted });
    return res.status(200).json({ ok: true, mode: 'co-lifecycle', steps: out });
  }

  const steps = [];
  const log = (name, verdict, note) => steps.push({ name, verdict, note: note || '' });
  const created = { clients: [], leadPipeline: [], jobs: [], jobWorkflow: [], invoices: [], snapshots: [] };
  const cleanupLog = [];

  // --- authenticate as the test user ---
  const auth = await mintTestToken();
  if (!auth.ok) return res.status(200).json({ ok: false, blocked: auth.reason, detail: auth.detail || null });
  const token = auth.token;
  const tag6 = (auth.userId || '').slice(0, 6);
  log('Authenticate as test user', 'PASS', 'Minted a real session, no password.');

  try {
    // 1) read sanity
    const brief = await asUser(token, 'GET', '/api/track1?resource=dailybrief');
    log('Authed read (dailybrief)', brief.status === 200 ? 'PASS' : (brief.status === 401 ? 'FAIL' : 'CHECK'), 'HTTP ' + brief.status);

    // 2) CREATE LEAD (real) -> client (HL-*) + lead_pipeline row
    const lead = await asUser(token, 'POST', '/api/track1?resource=leads', {
      firstName: TAG, lastName: 'Lead ' + tag6, companyName: TAG + ' Co',
      email: 'zztestrun@example.invalid', phone: '000-000-0000', need: TAG + ' bathroom reno', leadSource: 'runner', division: 'GH',
    });
    let clientId = lead.data && lead.data.clientId;
    if (lead.ok && clientId) { created.clients.push(clientId); created.leadPipeline.push(clientId); }
    log('Create lead → client + pipeline', lead.ok ? 'PASS' : 'FAIL', 'HTTP ' + lead.status + (lead.data && lead.data.error ? ' — ' + lead.data.error : (clientId ? ' — client ' + clientId : '')));

    // 3) CREATE JOB (real) for that client
    let jobRef = null;
    if (clientId) {
      const job = await asUser(token, 'POST', '/api/track1?resource=create_job', { title: TAG + ' Bathroom Reno ' + tag6, clientId, total: 18500, division: 'GH' });
      jobRef = job.data && job.data.job && job.data.job.jobber_id;
      if (job.ok && jobRef) created.jobs.push(jobRef);
      log('Create job (from client)', job.ok ? 'PASS' : 'FAIL', 'HTTP ' + job.status + (job.data && job.data.error ? ' — ' + job.data.error : (jobRef ? ' — job ' + jobRef : '')));
    } else { log('Create job (from client)', 'SKIPPED', 'no client id from lead step'); }

    // 4) SET JOB WORKFLOW (deposit/materials/notes) on that job
    if (jobRef) {
      const wf = await asUser(token, 'POST', '/api/track1?resource=job_workflow_set', {
        jobRef, depositRequired: 1, depositAmount: 5000, materialsStatus: 'ordered', materialsEta: '2026-08-05', notes: TAG + ' runner workflow', updatedBy: 'runner',
      });
      if (wf.ok) created.jobWorkflow.push(jobRef);
      log('Set job workflow (deposit/materials)', wf.ok ? 'PASS' : 'FAIL', 'HTTP ' + wf.status + (wf.data && wf.data.error ? ' — ' + wf.data.error : ''));
    } else { log('Set job workflow (deposit/materials)', 'SKIPPED', 'no job'); }

    // 5) ADD MATERIAL LINE to the job's material list
    if (jobRef) {
      const mat = await asUser(token, 'POST', '/api/track1?resource=materials_cart_add', {
        target_id: jobRef, target_type: 'JOB_MATERIAL_LIST', quantity: 12,
        product: { vendor_title: TAG + ' 2x4x8 stud', vendor_sku: 'ZZT-2X4', unit_price: 4.25, product_url: 'https://example.invalid/zzt' },
      });
      const snapId = mat.data && mat.data.snapshot && mat.data.snapshot.id;
      if (mat.ok && snapId) created.snapshots.push(snapId);
      log('Add material to job list', mat.ok ? 'PASS' : 'FAIL', 'HTTP ' + mat.status + (mat.data && mat.data.error ? ' — ' + mat.data.error : (snapId ? ' — snapshot ' + snapId : '')));
    } else { log('Add material to job list', 'SKIPPED', 'no job'); }

    // 6) CREATE INVOICE (DRAFT, HiveLogic-only) for the client
    if (clientId) {
      const inv = await asUser(token, 'POST', '/api/track1?resource=create_invoice', { amount: 18500, clientId, dueDate: '2026-08-20' });
      const invId = inv.data && inv.data.invoice && inv.data.invoice.jobber_id;
      if (inv.ok && invId) created.invoices.push(invId);
      log('Create invoice (draft, no send)', inv.ok ? 'PASS' : 'FAIL', 'HTTP ' + inv.status + (inv.data && inv.data.error ? ' — ' + inv.data.error : (invId ? ' — invoice ' + invId : '')));
    } else { log('Create invoice (draft, no send)', 'SKIPPED', 'no client'); }

    // --- BOOKKEEPING reachability probes (create NOTHING; incomplete on purpose) ---
    const est = await asUser(token, 'POST', '/api/bookkeeping/estimates/create', { clientId: TAG + '-PROBE' });
    steps.push(interpretBk('Estimate engine (probe)', est, 'client is required'));

    const co = await asUser(token, 'POST', '/api/bookkeeping/change-orders/create', { jobId: TAG + '-PROBE', kind: 'estimate', description: TAG + ' probe' });
    steps.push(interpretBk('Change Order engine (probe)', co, 'chained to an existing job'));

    const po = await asUser(token, 'POST', '/api/bookkeeping/purchase-orders/create', { jobId: TAG + '-PROBE', vendorName: TAG });
    steps.push(interpretBk('Purchase Order engine (probe)', po, 'job or an overhead category'));

    const expData = { vendor: TAG, total: 0, transactionDate: '2026-07-29', transactionKind: 'paid', paymentAccountId: TAG, allocations: [{ subtotal: 0 }] };
    const exp = await asUser(token, 'POST', '/api/bookkeeping/expenses', expData);
    steps.push(interpretBk('Expense engine (probe)', exp, 'Vendor is required'));

    // --- EXTERNAL steps: never fired ---
    log('Schedule / assign crew', 'SKIPPED_EXTERNAL', 'writes to Jobber — not fired');
    log('Receive payment', 'SKIPPED_EXTERNAL', 'Authorize.net not set up — cannot charge');
    log('Text / email / call / video', 'SKIPPED_EXTERNAL', 'Twilio/Resend real sends — gated to test-only');
  } finally {
    // exact-id self-cleanup — always runs, even on a mid-run failure
    for (const id of created.snapshots) cleanupLog.push(await sbDelete('product_snapshots', `id=eq.${enc(id)}`));
    for (const id of created.invoices) cleanupLog.push(await sbDelete('invoices', `jobber_id=eq.${enc(id)}`));
    for (const ref of created.jobWorkflow) cleanupLog.push(await sbDelete('job_workflow', `job_ref=eq.${enc(ref)}`));
    for (const id of created.jobs) cleanupLog.push(await sbDelete('jobs', `jobber_id=eq.${enc(id)}`));
    for (const cid of created.leadPipeline) cleanupLog.push(await sbDelete('lead_pipeline', `client_id=eq.${enc(cid)}`));
    for (const id of created.clients) cleanupLog.push(await sbDelete('clients', `jobber_id=eq.${enc(id)}`));
  }

  const cleaned = cleanupLog.reduce((a, c) => a + (c.deleted || 0), 0);
  const tally = steps.reduce((a, s) => { a[s.verdict] = (a[s.verdict] || 0) + 1; return a; }, {});
  return res.status(200).json({
    ok: true, testUser: TEST_USER_EMAIL, tally, steps,
    cleanup: { rowsDeleted: cleaned, detail: cleanupLog },
    note: 'Core pipeline creates real rows then self-deletes them by id. Bookkeeping steps are non-creating reachability probes. Externals gated. Run ?mode=cleanup for a sentinel safety sweep.',
  });
}
