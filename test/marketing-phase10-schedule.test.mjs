// Phase 10 -- Schedule (replaces the admitted Calendar stub). First real
// slice: resource=schedule (GET) returns a rolling window of real scheduled
// campaign sends, read from campaigns.scheduled_at (the same column
// handleProcessScheduledSendsGet already fires sends from). Honestly names
// the other Phase 10 event categories (organic posts, videos, website
// promotions, landing-page launches, review campaigns, content-production
// deadlines, promo expirations) as notYetTracked -- none of them have a real
// schedulable date field in the schema yet, so no fabricated events for them.

import fs from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';

const apiPath = 'api/marketing.js';
const api = fs.readFileSync(apiPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function norm(v) { return JSON.parse(JSON.stringify(v)); }

function extractScheduleSource() {
  const start = api.indexOf('// ---------- Schedule (Phase 10');
  assert.ok(start > -1, 'expected the Schedule section header to exist');
  const end = api.indexOf('export default async function handler(req, res) {', start);
  assert.ok(end > start, 'expected the exported handler to follow the Schedule section');
  return api.slice(start, end);
}

function loadScheduleFn(fetchAllRows) {
  const sandbox = {
    fetchAllRows: fetchAllRows || (async () => { throw new Error('fetchAllRows not stubbed'); }),
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(extractScheduleSource(), sandbox);
  return sandbox.handleScheduleGet;
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

// ---------- Structural / wiring checks ----------

check('resource=schedule is wired into the dispatch chain right after process_scheduled_sends', () => {
  const idx = api.indexOf("resource === 'process_scheduled_sends' && req.method === 'GET')");
  assert.ok(idx > -1, 'expected the process_scheduled_sends GET dispatch to exist');
  const chunk = api.slice(idx, idx + 500); // widened: lifecycle_candidates (Phase 14) now sits between process_scheduled_sends and schedule in the dispatch chain
  assert.match(chunk, /resource === 'schedule' && req\.method === 'GET'/);
  assert.match(chunk, /return await handleScheduleGet\(req, res\);/);
});

check('the resource-list error string documents schedule (GET)', () => {
  assert.match(api, /process_scheduled_sends \(GET\), schedule \(GET\)/); // no longer list-final -- later phases append more resources after schedule
});

check('computeScheduleData fetches from campaigns.scheduled_at -- no new table, no migration', () => {
  const fn = api.slice(api.indexOf('async function computeScheduleData'), api.indexOf('export default async function handler'));
  assert.match(fn, /fetchAllRows\(\s*'campaigns'/);
  assert.match(fn, /scheduled_at=not\.is\.null/);
});

check('handleScheduleGet delegates to computeScheduleData (shared with handleCommandCenterGet, no duplicated query logic)', () => {
  const fn = api.slice(api.indexOf('async function handleScheduleGet'), api.indexOf('export default async function handler'));
  assert.match(fn, /await computeScheduleData\(req\.query\.days, req\.query\.pastDays\)/);
});

check('handleCommandCenterGet folds computeScheduleData() into its single merged payload', () => {
  const start = api.indexOf('async function handleCommandCenterGet');
  assert.ok(start > -1, 'expected handleCommandCenterGet to exist');
  const end = api.indexOf('export default async function handler', start);
  const fn = api.slice(start, end);
  assert.match(fn, /computeScheduleData\(\)/);
  assert.match(fn, /schedule,/);
});

// ---------- Behavior ----------

check('handleScheduleGet returns real campaign-send events shaped for a calendar, sorted by the query, within the default 90-day/7-day-past window', async () => {
  let capturedQuery = null;
  const handleScheduleGet = loadScheduleFn(async (table, query) => {
    assert.strictEqual(table, 'campaigns');
    capturedQuery = query;
    return [
      { id: 'c1', name: 'Spring Promo', type: 'seasonal', channel: 'email', status: 'draft', scheduled_at: '2026-08-05T00:00:00Z' },
      { id: 'c2', name: 'Referral Push', type: 'referral', channel: 'sms', status: 'scheduled', scheduled_at: '2026-09-01T00:00:00Z' },
    ];
  });
  const req = { query: {} };
  const res = makeRes();
  await handleScheduleGet(req, res);

  assert.match(capturedQuery, /select=id,name,type,channel,status,scheduled_at/);
  assert.match(capturedQuery, /scheduled_at=not\.is\.null/);
  assert.match(capturedQuery, /order=scheduled_at\.asc/);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.events.length, 2);
  assert.deepStrictEqual(norm(res.body.events[0]), {
    id: 'c1', kind: 'campaign_send', campaignId: 'c1', name: 'Spring Promo',
    type: 'seasonal', channel: 'email', status: 'draft', scheduledAt: '2026-08-05T00:00:00Z',
  });
  assert.deepStrictEqual(norm(res.body.events[1]), {
    id: 'c2', kind: 'campaign_send', campaignId: 'c2', name: 'Referral Push',
    type: 'referral', channel: 'sms', status: 'scheduled', scheduledAt: '2026-09-01T00:00:00Z',
  });

  // default window: ~7 days back, ~90 days forward from "now"
  const start = new Date(res.body.windowStart).getTime();
  const end = new Date(res.body.windowEnd).getTime();
  const spanDays = (end - start) / 86400000;
  assert.ok(Math.abs(spanDays - 97) < 1, `expected ~97 day span (7 back + 90 forward), got ${spanDays}`);
});

check('handleScheduleGet honestly lists every not-yet-schedulable Phase 10 event category instead of fabricating events for them', async () => {
  const handleScheduleGet = loadScheduleFn(async () => []);
  const req = { query: {} };
  const res = makeRes();
  await handleScheduleGet(req, res);
  assert.deepStrictEqual(norm(res.body.events), []);
  assert.deepStrictEqual(norm(res.body.notYetTracked), [
    'organic_posts', 'videos', 'website_promotions', 'landing_page_launches',
    'review_campaigns', 'content_production_deadlines', 'promo_expirations',
  ]);
});

check('handleScheduleGet clamps days/pastDays to sane bounds instead of trusting raw query input', async () => {
  const handleScheduleGet = loadScheduleFn(async () => []);
  const res = makeRes();
  await handleScheduleGet({ query: { days: '99999', pastDays: '-50' } }, res);
  const start = new Date(res.body.windowStart).getTime();
  const end = new Date(res.body.windowEnd).getTime();
  const spanDays = (end - start) / 86400000;
  // clamps to days<=180, pastDays>=0 -> span should be <= 180 days, not 99999+50
  assert.ok(spanDays <= 181, `expected clamped span <= ~180 days, got ${spanDays}`);
  assert.ok(spanDays >= 179, `expected clamped span close to 180 days, got ${spanDays}`);
});

check('handleScheduleGet honors an explicit, in-range days/pastDays request', async () => {
  const handleScheduleGet = loadScheduleFn(async () => []);
  const res = makeRes();
  await handleScheduleGet({ query: { days: '30', pastDays: '0' } }, res);
  const start = new Date(res.body.windowStart).getTime();
  const end = new Date(res.body.windowEnd).getTime();
  const spanDays = (end - start) / 86400000;
  assert.ok(Math.abs(spanDays - 30) < 1, `expected ~30 day span, got ${spanDays}`);
});

let pass = 0, fail = 0;
const results = [];
for (const { name, fn } of checks) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      results.push(r.then(() => { pass++; console.log(`  ok  - ${name}`); }).catch((e) => { fail++; console.log(`  not ok  - ${name}\n    ${e.message}`); }));
    } else {
      pass++;
      console.log(`  ok  - ${name}`);
    }
  } catch (e) {
    fail++;
    console.log(`  not ok  - ${name}\n    ${e.message}`);
  }
}
Promise.all(results).then(() => {
  console.log(`\n${pass} passed, ${fail} failed (of ${checks.length})`);
  process.exit(fail ? 1 : 0);
});
