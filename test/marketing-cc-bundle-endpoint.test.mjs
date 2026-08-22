import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, '..', 'api', 'track1.js');
const source = fs.readFileSync(SRC_PATH, 'utf-8');

function extractFunction(src, declSnippet) {
  const declStart = src.indexOf(declSnippet);
  if (declStart === -1) throw new Error('function not found: ' + declSnippet);
  const closeParenBrace = src.indexOf(') {', declStart);
  if (closeParenBrace === -1) throw new Error('opening brace not found for: ' + declSnippet);
  const braceStart = closeParenBrace + 2;
  let depth = 1;
  let i = braceStart + 1;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(declStart, i);
}

// Real, unmodified source for both new functions this slice added.
const CC_CAPTURE_JSON_SRC = extractFunction(source, 'function ccCaptureJson(fn) {');
const HANDLE_CC_BUNDLE_SRC = extractFunction(source, 'async function handleCcBundle(req, res) {');
const blockSrc = [CC_CAPTURE_JSON_SRC, HANDLE_CC_BUNDLE_SRC].join('\n\n');

test('regression guard: handler() still dispatches cc_bundle to handleCcBundle', () => {
  assert.ok(source.includes("if (resource === 'cc_bundle') return handleCcBundle(req, res);"),
    'the new dispatch line must still exist in the real handler');
});

// Phase 2 (2026-08-04): the bundle grew from 5 to 7 real handlers -- leads and
// crew_schedule were folded in, but watching_unscheduled and
// watching_margin_fade were deliberately left standalone (the fast Jobber
// unscheduled count must not render behind the slow QBO margin-fade call, the
// exact regression the 2026-07-31 split fixed). This guard proves those two
// resources are NOT bundled, so the regression can't silently creep back in.
test('regression guard: the two 2026-07-31-split resources stay OUT of the bundle', () => {
  // Check for the actual invocation inside the Promise.all, not any mention:
  // the surrounding comment legitimately names these handlers to document WHY
  // they are excluded, so a bare substring check would false-positive.
  assert.ok(!HANDLE_CC_BUNDLE_SRC.includes('handleWatchingUnscheduled(r)'),
    'watching_unscheduled must NOT be invoked in the bundle -- it stays a standalone fast fetch so it never renders behind the slow QBO margin-fade');
  assert.ok(!HANDLE_CC_BUNDLE_SRC.includes('handleWatchingMarginFade(r)'),
    'watching_margin_fade must NOT be invoked in the bundle -- folding the slow QBO call into the single Promise.all would gate every other resource behind it');
  assert.ok(!/watching_unscheduled:\s*\w+R\.body/.test(HANDLE_CC_BUNDLE_SRC),
    'no watching_unscheduled response key -- it is not part of the bundle envelope');
  assert.ok(!/watching_margin_fade:\s*\w+R\.body/.test(HANDLE_CC_BUNDLE_SRC),
    'no watching_margin_fade response key -- it is not part of the bundle envelope');
});

// Every test spreads noopHandlers() so it only has to declare the handlers it
// actually exercises; any handler it leaves as a no-op still resolves cleanly
// instead of ReferenceError-ing inside the real handleCcBundle.
function noopHandlers() {
  // Each stub must actually call res.json(), or ccCaptureJson's fake-res
  // promise never resolves and Promise.all hangs. handleJobWorkflowList and
  // handleLeads are invoked as handler(req, res) inside the bundle, so their
  // res is the SECOND arg; the other five get res as the first arg.
  const resFirst = async (res) => { res.status(200).json({ ok: true }); };
  const resSecond = async (_req, res) => { res.status(200).json({ ok: true }); };
  return {
    handleMapLocations: resFirst,
    handleJobWorkflowList: resSecond,
    handleWatchingBridgeStatus: resFirst,
    handleDispatchAlerts: resFirst,
    handleTodaySchedule: resFirst,
    handleLeads: resSecond,
    handleCrewSchedule: resFirst,
  };
}

function makeSandbox(handlers) {
  const sandbox = {
    handleMapLocations: handlers.handleMapLocations,
    handleJobWorkflowList: handlers.handleJobWorkflowList,
    handleWatchingBridgeStatus: handlers.handleWatchingBridgeStatus,
    handleDispatchAlerts: handlers.handleDispatchAlerts,
    handleTodaySchedule: handlers.handleTodaySchedule,
    handleLeads: handlers.handleLeads,
    handleCrewSchedule: handlers.handleCrewSchedule,
    Promise,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  return sandbox;
}

function makeRes() {
  const calls = [];
  return {
    _status: 200,
    status(code) { this._status = code; return this; },
    json(body) { calls.push({ status: this._status, body }); return this; },
    _calls: calls,
  };
}

test('real handleCcBundle calls all 7 real handler functions with the correct signatures (req+res for job_workflow_list and leads, res-only for the other 5) and merges their real responses under the right keys', async () => {
  const calledWith = {};
  const handlers = {
    ...noopHandlers(),
    handleMapLocations: async (res) => { calledWith.map = 'res-only'; res.status(200).json({ ok: true, office: { lat: 1, lng: 2 }, points: [] }); },
    handleJobWorkflowList: async (req, res) => { calledWith.jwl = req && req.__marker; res.status(200).json({ ok: true, resource: 'job_workflow_list', rows: [{ job_ref: 'A' }] }); },
    handleWatchingBridgeStatus: async (res) => { calledWith.watch = 'res-only'; res.status(200).json({ ok: true, online: true }); },
    handleDispatchAlerts: async (res) => { calledWith.dispatch = 'res-only'; res.status(200).json({ ok: true, resource: 'dispatch_alerts', alerts: [] }); },
    handleTodaySchedule: async (res) => { calledWith.today = 'res-only'; res.status(200).json({ ok: true, resource: 'today_schedule', visits: [] }); },
    handleLeads: async (req, res) => { calledWith.leads = req && req.__marker; res.status(200).json({ ok: true, leads: [{ clientId: 'L1' }] }); },
    handleCrewSchedule: async (res) => { calledWith.crew = 'res-only'; res.status(200).json({ ok: true, vehicles: [] }); },
  };
  const sandbox = makeSandbox(handlers);
  const fakeRes = makeRes();
  const fakeReq = { __marker: 'the-real-req' };
  await sandbox.handleCcBundle(fakeReq, fakeRes);

  assert.strictEqual(fakeRes._calls.length, 1, 'the outer res.json must be called exactly once');
  const { status, body } = fakeRes._calls[0];
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.resource, 'cc_bundle');
  // Phase 1 resources
  assert.strictEqual(body.maplocations.office.lat, 1);
  assert.deepStrictEqual(body.job_workflow_list.rows, [{ job_ref: 'A' }]);
  assert.strictEqual(body.watching_bridge_status.online, true);
  assert.deepStrictEqual(body.dispatch_alerts.alerts, []);
  assert.deepStrictEqual(body.today_schedule.visits, []);
  // Phase 2 resources (leads + crew_schedule only)
  assert.deepStrictEqual(body.leads.leads, [{ clientId: 'L1' }]);
  assert.deepStrictEqual(body.crew_schedule.vehicles, []);
  // The two 2026-07-31-split resources must NOT appear in the envelope.
  assert.ok(!('watching_unscheduled' in body), 'watching_unscheduled must not be in the bundle envelope');
  assert.ok(!('watching_margin_fade' in body), 'watching_margin_fade must not be in the bundle envelope');
  // Signatures: only job_workflow_list and leads receive the real req.
  assert.strictEqual(calledWith.jwl, 'the-real-req', 'handleJobWorkflowList must receive the real req object, not a fake one');
  assert.strictEqual(calledWith.leads, 'the-real-req', 'handleLeads must receive the real req object (it needs it for auth + method), not a fake one');
  assert.strictEqual(calledWith.map, 'res-only');
  assert.strictEqual(calledWith.crew, 'res-only');
});

test('a thrown error in one real handler is captured per-resource and does not break the other 6 (including a Phase-2 resource failing independently)', async () => {
  const handlers = {
    ...noopHandlers(),
    handleMapLocations: async () => { throw new Error('map sync not ready'); },
    handleJobWorkflowList: async (req, res) => { res.status(200).json({ ok: true, rows: [] }); },
    handleWatchingBridgeStatus: async (res) => { res.status(200).json({ ok: true, online: false }); },
    handleDispatchAlerts: async (res) => { res.status(200).json({ ok: true, alerts: [] }); },
    handleTodaySchedule: async (res) => { res.status(200).json({ ok: true, visits: [] }); },
    // Phase 2: a bundled Phase-2 resource (crew_schedule) also throws, but
    // leads and the rest must still come back cleanly -- the whole point of the
    // per-resource capture.
    handleCrewSchedule: async () => { throw new Error('crew schedule sync not ready'); },
    handleLeads: async (req, res) => { res.status(200).json({ ok: true, leads: [{ clientId: 'L1' }] }); },
  };
  const sandbox = makeSandbox(handlers);
  const fakeRes = makeRes();
  await sandbox.handleCcBundle({}, fakeRes);
  const body = fakeRes._calls[0].body;
  assert.strictEqual(body.ok, true, 'the bundle envelope itself must still report ok even when one sub-resource failed');
  assert.strictEqual(body.maplocations.ok, false, 'the failed resource must be honestly marked not-ok, never faked');
  assert.match(body.maplocations.error, /map sync not ready/);
  assert.strictEqual(body.job_workflow_list.ok, true, 'other resources must be unaffected by one failure');
  assert.strictEqual(body.watching_bridge_status.online, false);
  // Phase 2: crew_schedule failed but did not take leads with it.
  assert.strictEqual(body.crew_schedule.ok, false, 'the failed Phase-2 resource must be honestly marked not-ok');
  assert.match(body.crew_schedule.error, /crew schedule sync not ready/);
  assert.deepStrictEqual(body.leads.leads, [{ clientId: 'L1' }], 'leads must survive a sibling Phase-2 failure');
});

test('a handler that itself calls res.status(500).json(...) on a real internal failure (matching handleMapLocations\' actual error branch) is captured with that real status/body, not silently overwritten', async () => {
  const handlers = {
    ...noopHandlers(),
    handleMapLocations: async (res) => { res.status(500).json({ ok: false, error: 'office_location fetch failed' }); },
    handleJobWorkflowList: async (req, res) => { res.status(200).json({ ok: true, rows: [] }); },
    handleWatchingBridgeStatus: async (res) => { res.status(200).json({ ok: true }); },
    handleDispatchAlerts: async (res) => { res.status(200).json({ ok: true, alerts: [] }); },
    handleTodaySchedule: async (res) => { res.status(200).json({ ok: true, visits: [] }); },
  };
  const sandbox = makeSandbox(handlers);
  const fakeRes = makeRes();
  await sandbox.handleCcBundle({}, fakeRes);
  const body = fakeRes._calls[0].body;
  assert.strictEqual(body.maplocations.ok, false);
  assert.strictEqual(body.maplocations.error, 'office_location fetch failed');
});

test('all 7 handlers run concurrently via Promise.all, not sequentially -- this is the actual point of the bundle endpoint', async () => {
  let started = 0;
  let releaseAll;
  const gate = new Promise((resolve) => { releaseAll = resolve; });
  function makeSlowHandler(name, needsReq) {
    return async (a, b) => {
      started++;
      await gate;
      const res = needsReq ? b : a;
      res.status(200).json({ ok: true, name });
    };
  }
  const handlers = {
    handleMapLocations: makeSlowHandler('map', false),
    handleJobWorkflowList: makeSlowHandler('jwl', true),
    handleWatchingBridgeStatus: makeSlowHandler('watch', false),
    handleDispatchAlerts: makeSlowHandler('dispatch', false),
    handleTodaySchedule: makeSlowHandler('today', false),
    handleLeads: makeSlowHandler('leads', true),
    handleCrewSchedule: makeSlowHandler('crew', false),
  };
  const sandbox = makeSandbox(handlers);
  const fakeRes = makeRes();
  const p = sandbox.handleCcBundle({}, fakeRes);
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(started, 7, 'all 7 handlers must have started before any of them is released -- proves they run concurrently, not one after another');
  releaseAll();
  await p;
  assert.strictEqual(fakeRes._calls.length, 1);
});

test('real ccCaptureJson resolves the fake-res-captured body directly on success', async () => {
  const sandbox = makeSandbox(noopHandlers());
  const result = await sandbox.ccCaptureJson((res) => { res.status(201).json({ hello: 'world' }); });
  assert.strictEqual(result.status, 201);
  assert.strictEqual(result.body.hello, 'world');
});

test('real ccCaptureJson turns a thrown error into a 500 envelope instead of rejecting the outer promise', async () => {
  const sandbox = makeSandbox(noopHandlers());
  const result = await sandbox.ccCaptureJson(() => { throw new Error('boom'); });
  assert.strictEqual(result.status, 500);
  assert.strictEqual(result.body.ok, false);
  assert.match(result.body.error, /boom/);
});
