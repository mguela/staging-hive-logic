import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, '..', 'public', 'index.html');
const source = fs.readFileSync(SRC_PATH, 'utf-8');

function extractConstLine(src, declSnippet) {
  const start = src.indexOf(declSnippet);
  if (start === -1) throw new Error('const line not found: ' + declSnippet);
  const end = src.indexOf('\n', start);
  return src.slice(start, end === -1 ? undefined : end);
}

// declSnippet must end exactly at the function's opening brace (whitespace
// before the brace varies across this file's functions -- some are
// 'name(){' with no space, some are 'name() {' with one -- so we anchor on
// the literal end of the snippet itself rather than re-searching for ') {'.
function extractFunction(src, declSnippet) {
  const declStart = src.indexOf(declSnippet);
  if (declStart === -1) throw new Error('function not found: ' + declSnippet);
  if (declSnippet[declSnippet.length - 1] !== '{') throw new Error('declSnippet must end with the opening brace: ' + declSnippet);
  const braceStart = declStart + declSnippet.length - 1;
  let depth = 1;
  let i = braceStart + 1;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(declStart, i);
}

const CC_BUNDLE_PROMISE_SRC = extractConstLine(source, 'var ccBundlePromise = null;');
const CC_BUNDLE_AT_SRC = extractConstLine(source, 'var ccBundleAt = 0;');
const CC_BUNDLE_FETCH_SRC = extractFunction(source, 'function ccBundleFetch(key) {');
const blockSrc = [CC_BUNDLE_PROMISE_SRC, CC_BUNDLE_AT_SRC, CC_BUNDLE_FETCH_SRC].join('\n\n');

function makeSandbox(startNow, fetchImpl) {
  let currentNow = startNow;
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(currentNow);
      else super(...args);
    }
  }
  FakeDate.now = () => currentNow;
  const sandbox = { Date: FakeDate, API: 'https://api.example.test', fetch: fetchImpl, console, Promise };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: 'public/index.html' });
  return { sandbox, advance(ms) { currentNow += ms; } };
}

test('real ccBundleFetch makes exactly one real fetch for the first call and resolves to the requested key', async () => {
  let fetchCount = 0;
  let lastUrl = null;
  const fetchImpl = (url) => {
    fetchCount++;
    lastUrl = url;
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, maplocations: { ok: true, office: { lat: 1 } } }) });
  };
  const { sandbox } = makeSandbox(1000000, fetchImpl);
  const d = await sandbox.ccBundleFetch('maplocations');
  assert.strictEqual(fetchCount, 1);
  assert.strictEqual(lastUrl, 'https://api.example.test/api/track1?resource=cc_bundle');
  assert.strictEqual(d.office.lat, 1);
});

test('real ccBundleFetch dedupes near-simultaneous calls into a single real fetch -- this is the entire point of the feature', async () => {
  let fetchCount = 0;
  const fetchImpl = () => {
    fetchCount++;
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, maplocations: { ok: true, a: 1 }, dispatch_alerts: { ok: true, alerts: [] } }) });
  };
  const { sandbox } = makeSandbox(1000000, fetchImpl);
  const [mapD, dispatchD] = await Promise.all([
    sandbox.ccBundleFetch('maplocations'),
    sandbox.ccBundleFetch('dispatch_alerts'),
  ]);
  assert.strictEqual(fetchCount, 1, 'the 5 Command Center load*() calls firing together must share ONE real network request');
  assert.strictEqual(mapD.a, 1);
  assert.deepStrictEqual(dispatchD.alerts, []);
});

test('real ccBundleFetch re-fetches once the 2s cache window has actually elapsed', async () => {
  let fetchCount = 0;
  const fetchImpl = () => {
    fetchCount++;
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, maplocations: { ok: true, call: fetchCount } }) });
  };
  const { sandbox, advance } = makeSandbox(1000000, fetchImpl);
  const d1 = await sandbox.ccBundleFetch('maplocations');
  advance(2500);
  const d2 = await sandbox.ccBundleFetch('maplocations');
  assert.strictEqual(fetchCount, 2, 'a call after the cache window must trigger a genuinely fresh fetch, not stale data');
  assert.strictEqual(d1.call, 1);
  assert.strictEqual(d2.call, 2);
});

test('real ccBundleFetch reuses the still-fresh cache for a call inside the window even after an earlier one completed', async () => {
  let fetchCount = 0;
  const fetchImpl = () => {
    fetchCount++;
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, maplocations: { ok: true, call: fetchCount } }) });
  };
  const { sandbox, advance } = makeSandbox(1000000, fetchImpl);
  const d1 = await sandbox.ccBundleFetch('maplocations');
  advance(500); // well inside the 2000ms window
  const d2 = await sandbox.ccBundleFetch('maplocations');
  assert.strictEqual(fetchCount, 1, 'a call inside the cache window must reuse the prior result, not fetch again');
  assert.strictEqual(d1.call, 1);
  assert.strictEqual(d2.call, 1);
});

test('real ccBundleFetch throws honestly when the bundle response itself reports ok:false, instead of silently returning undefined', async () => {
  const fetchImpl = () => Promise.resolve({ json: () => Promise.resolve({ ok: false, error: 'bundle exploded' }) });
  const { sandbox } = makeSandbox(1000000, fetchImpl);
  await assert.rejects(() => sandbox.ccBundleFetch('maplocations'), /bundle exploded/);
});

// Regression guards on the real rewired call sites: each must route through
// ccBundleFetch with the right resource key and must no longer make its old
// standalone fetch() call for that specific resource. Phase 2 (2026-08-04)
// added leads and crew_schedule to the bundle. It deliberately did NOT bundle
// watching_unscheduled or watching_margin_fade: those were split into
// independent fetches on 2026-07-31 so the fast Jobber unscheduled count never
// renders behind the slow QBO margin-fade call, and folding them into the
// single bundle Promise.all would re-introduce exactly that regression. The
// guards below assert those two stay standalone. Resources also deliberately
// left out of scope (the /api/jobs half of loadJobsBoardLive; the Job Schedule
// page's own crew_schedule fetch) must be confirmed still present and untouched
// -- not an oversight, the documented scope boundary (see status doc).

test("loadMapLive routes through ccBundleFetch('maplocations') and no longer fetches that resource directly", () => {
  const body = extractFunction(source, 'function loadMapLive(){');
  assert.ok(body.includes("ccBundleFetch('maplocations')"), 'loadMapLive must call ccBundleFetch');
  assert.ok(!/fetch\(API\+'\/api\/track1\?resource=maplocations'\)/.test(body), 'the old direct fetch for maplocations must be gone');
});

test("loadJobsBoardLive routes its job_workflow_list half through ccBundleFetch, but keeps its independent /api/jobs fetch untouched (out of scope)", () => {
  const body = extractFunction(source, 'function loadJobsBoardLive() {');
  assert.ok(body.includes("ccBundleFetch('job_workflow_list')"), 'loadJobsBoardLive must call ccBundleFetch for job_workflow_list');
  assert.ok(!/resource=job_workflow_list/.test(body), 'the old direct fetch for job_workflow_list must be gone');
  assert.ok(/fetch\(API \+ '\/api\/jobs\?status=active&limit=1000'\)/.test(body), 'the unrelated /api/jobs fetch must still be untouched -- deliberately out of this slice\'s scope');
});

test("loadWatchingLive routes only its watching_bridge_status fetch through ccBundleFetch, and keeps watching_unscheduled + watching_margin_fade as independent standalone fetches (the 2026-07-31 split, deliberately NOT bundled)", () => {
  const body = extractFunction(source, 'function loadWatchingLive(){');
  assert.ok(body.includes("ccBundleFetch('watching_bridge_status')"), 'must route watching_bridge_status through the bundle');
  assert.ok(!/resource=watching_bridge_status/.test(body), 'the old direct fetch for watching_bridge_status must be gone');
  // The two 2026-07-31-split resources must stay standalone so the fast
  // unscheduled count never renders behind the slow QBO margin-fade call.
  assert.ok(!body.includes("ccBundleFetch('watching_unscheduled')"), 'watching_unscheduled must NOT be bundled -- it stays a standalone fast fetch');
  assert.ok(!body.includes("ccBundleFetch('watching_margin_fade')"), 'watching_margin_fade must NOT be bundled -- the slow QBO call must not gate the bundle');
  assert.ok(/fetch\(API\+'\/api\/track1\?resource=watching_unscheduled'\)/.test(body), 'watching_unscheduled must still be an independent standalone fetch');
  assert.ok(/fetch\(API\+'\/api\/track1\?resource=watching_margin_fade'\)/.test(body), 'watching_margin_fade must still be an independent standalone fetch');
});

// ---- Phase 2 (2026-08-04) newly-bundled Command Center call sites ----

test("loadJobsAttention's attnFetch helper stays on its own standalone track1 fetch -- the two watching resources are deliberately NOT bundled so the fast unscheduled count renders independently of the slow margin-fade", () => {
  const body = extractFunction(source, 'function loadJobsAttention(){');
  assert.ok(!body.includes('return ccBundleFetch(resource);'), 'attnFetch must NOT delegate to ccBundleFetch -- these two resources stay standalone');
  assert.ok(/fetch\(API\+'\/api\/track1\?resource='\+resource\)/.test(body), 'attnFetch must keep its own standalone per-resource fetch');
  // The tile still renders both signals independently.
  assert.ok(body.includes("attnFetch('watching_unscheduled')"), 'the unscheduled signal must still be requested');
  assert.ok(body.includes("attnFetch('watching_margin_fade')"), 'the margin-fade signal must still be requested');
});

test("loadLeadsLive routes through ccBundleFetch('leads') and no longer makes its own hlApiGet('leads') call", () => {
  const body = extractFunction(source, 'function loadLeadsLive() {');
  assert.ok(body.includes("ccBundleFetch('leads')"), 'loadLeadsLive must call ccBundleFetch for leads');
  assert.ok(!/hlApiGet\('leads'\)/.test(body), "the old standalone hlApiGet('leads') call must be gone");
});

test("loadTechLocationsLive (the Command Center map's fleet layer) routes through ccBundleFetch('crew_schedule') and no longer fetches that resource directly", () => {
  const body = extractFunction(source, 'function loadTechLocationsLive(map){');
  assert.ok(body.includes("ccBundleFetch('crew_schedule')"), 'the CC map caller must route crew_schedule through the bundle');
  assert.ok(!/fetch\(API\+'\/api\/track1\?resource=crew_schedule'\)/.test(body), 'the old standalone crew_schedule fetch in the CC map caller must be gone');
});

test("the Job Schedule page's own crew_schedule fetch is deliberately left standalone -- only the Command Center map caller was rewired", () => {
  // Exactly one CC caller was converted; the source must still contain at least
  // one untouched standalone resource=crew_schedule fetch elsewhere (the Job
  // Schedule / crew board pages), proving the rewire was surgically scoped.
  assert.ok(/fetch\([^)]*'\/api\/track1\?resource=crew_schedule'\)/.test(source),
    'a non-CC standalone crew_schedule fetch must remain -- the rewire is scoped to the CC map only');
});

test("loadDispatchAlertsLive routes through ccBundleFetch('dispatch_alerts')", () => {
  const body = extractFunction(source, 'function loadDispatchAlertsLive() {');
  assert.ok(body.includes("ccBundleFetch('dispatch_alerts')"));
  assert.ok(!/resource=dispatch_alerts/.test(body));
});

test("loadTodaySchedule routes through ccBundleFetch('today_schedule')", () => {
  const body = extractFunction(source, 'function loadTodaySchedule(){');
  assert.ok(body.includes("ccBundleFetch('today_schedule')"));
  assert.ok(!/resource=today_schedule/.test(body));
});
