// Phase 19 -- Command Center Home/Plan enrichment: real budget pacing,
// real leads-by-channel/cost-per-lead, and an owner-settable quarterly
// revenue goal with real progress. All three degrade honestly (never
// fabricate a number) when the underlying data isn't set up/synced yet.

import fs from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';

const apiPath = 'api/marketing.js';
const api = fs.readFileSync(apiPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function extractCcFeaturesSource() {
  const start = api.indexOf('async function handleBudgetPacingGet(req, res) {');
  assert.ok(start > -1, 'expected handleBudgetPacingGet to exist');
  const end = api.indexOf('async function handleCommandCenterBudgetPost(req, res) {', start);
  assert.ok(end > start, 'expected handleCommandCenterBudgetPost to follow the new CC feature handlers');
  return api.slice(start, end);
}

function loadCcFeatureFns(overrides) {
  const o = overrides || {};
  const sandbox = {
    getBudgetCap: o.getBudgetCap || (async () => { throw new Error('getBudgetCap not stubbed'); }),
    monthSpendCents: o.monthSpendCents || (async () => { throw new Error('monthSpendCents not stubbed'); }),
    currentMonthBoundsUTC: o.currentMonthBoundsUTC || (() => { throw new Error('currentMonthBoundsUTC not stubbed'); }),
    fetchAllRows: o.fetchAllRows || (async () => { throw new Error('fetchAllRows not stubbed'); }),
    setupBudgetShape: o.setupBudgetShape || (async () => ({ channels: [] })),
    ccAssumptionsRow: o.ccAssumptionsRow || (async () => null),
    supabaseRequest: o.supabaseRequest || (async () => ({ ok: true })),
    logMarketingAuditEvent: o.logMarketingAuditEvent || (async () => {}),
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(extractCcFeaturesSource(), sandbox);
  return {
    handleBudgetPacingGet: sandbox.handleBudgetPacingGet,
    handleChannelPerformanceGet: sandbox.handleChannelPerformanceGet,
    handleMarketingGoalGet: sandbox.handleMarketingGoalGet,
    handleMarketingGoalPost: sandbox.handleMarketingGoalPost,
  };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

// vm.runInContext executes in a separate V8 realm -- see the identical note
// in test/marketing-phase18-attribution-snapshot.test.mjs.
function norm(v) { return JSON.parse(JSON.stringify(v)); }

// ---------- Structural / wiring checks ----------

check('all 4 new Command Center resources are wired into the dispatch chain', () => {
  const idx = api.indexOf("resource === 'command_center_assumptions' && req.method === 'POST'");
  assert.ok(idx > -1, "expected the command_center_assumptions POST dispatch to exist");
  const chunk = api.slice(idx);
  assert.match(chunk, /resource === 'command_center_budget_pacing' && req\.method === 'GET'/);
  assert.match(chunk, /return await handleBudgetPacingGet\(req, res\);/);
  assert.match(chunk, /resource === 'command_center_channel_performance' && req\.method === 'GET'/);
  assert.match(chunk, /return await handleChannelPerformanceGet\(req, res\);/);
  assert.match(chunk, /resource === 'command_center_goal' && req\.method === 'GET'/);
  assert.match(chunk, /return await handleMarketingGoalGet\(req, res\);/);
  assert.match(chunk, /resource === 'command_center_goal' && req\.method === 'POST'/);
  assert.match(chunk, /return await handleMarketingGoalPost\(req, res\);/);
});

check('the resource-list error string documents all 3 new resource names', () => {
  assert.match(api, /command_center_budget_pacing \(GET\)/);
  assert.match(api, /command_center_channel_performance \(GET\)/);
  assert.match(api, /command_center_goal \(GET\/POST\)/);
});

// ---------- handleBudgetPacingGet behavior ----------

check('handleBudgetPacingGet honestly reports configured:false when no budget cap is set up', async () => {
  const { handleBudgetPacingGet } = loadCcFeatureFns({
    getBudgetCap: async () => null,
  });
  const res = makeRes();
  await handleBudgetPacingGet({}, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(norm(res.body), { ok: true, configured: false });
});

check('handleBudgetPacingGet computes on-pace projection correctly when spend is under cap', async () => {
  const { handleBudgetPacingGet } = loadCcFeatureFns({
    getBudgetCap: async () => ({ cap_cents: 300000, autonomy_level: 'suggest' }),
    monthSpendCents: async () => 100000,
    currentMonthBoundsUTC: () => ({ daysInMonth: 30, daysRemaining: 20 }),
  });
  const res = makeRes();
  await handleBudgetPacingGet({}, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.configured, true);
  assert.strictEqual(res.body.capCents, 300000);
  assert.strictEqual(res.body.spentCents, 100000);
  assert.strictEqual(res.body.daysElapsed, 11);
  assert.strictEqual(res.body.projectedCents, 272727);
  assert.ok(Math.abs(res.body.pctUsed - (100000 / 300000)) < 1e-9);
  assert.strictEqual(res.body.autonomyLevel, 'suggest');
  assert.strictEqual(res.body.overPace, false);
});

check('handleBudgetPacingGet flags overPace when projected spend exceeds the cap', async () => {
  const { handleBudgetPacingGet } = loadCcFeatureFns({
    getBudgetCap: async () => ({ cap_cents: 300000, autonomy_level: 'auto' }),
    monthSpendCents: async () => 200000,
    currentMonthBoundsUTC: () => ({ daysInMonth: 30, daysRemaining: 20 }),
  });
  const res = makeRes();
  await handleBudgetPacingGet({}, res);
  assert.strictEqual(res.body.projectedCents, 545455);
  assert.strictEqual(res.body.overPace, true);
});

// ---------- handleChannelPerformanceGet behavior ----------

check('handleChannelPerformanceGet honestly reports configured:false when lead_pipeline is not synced', async () => {
  const { handleChannelPerformanceGet } = loadCcFeatureFns({
    fetchAllRows: async () => { const e = new Error('relation "lead_pipeline" does not exist'); e.notSynced = true; throw e; },
  });
  const res = makeRes();
  await handleChannelPerformanceGet({}, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(norm(res.body), { ok: true, configured: false, rows: [], totalLeads: 0 });
});

check('handleChannelPerformanceGet rethrows any error that is not a notSynced condition', async () => {
  const { handleChannelPerformanceGet } = loadCcFeatureFns({
    fetchAllRows: async () => { throw new Error('boom: unexpected database error'); },
  });
  const res = makeRes();
  await assert.rejects(() => handleChannelPerformanceGet({}, res), /boom: unexpected database error/);
});

check('handleChannelPerformanceGet groups real leads by lead_source, computes cost-per-lead only for mapped/tracked channels, and never fabricates a cost', async () => {
  const rows = [
    { lead_source: 'google' },
    { lead_source: 'Google' },
    { lead_source: 'facebook' },
    { lead_source: 'website' },
    { lead_source: 'referral' },
    { lead_source: '  ' },
    { lead_source: null },
  ];
  const { handleChannelPerformanceGet } = loadCcFeatureFns({
    fetchAllRows: async () => rows,
    setupBudgetShape: async () => ({ channels: [
      { key: 'google_ads', monthlyCents: 10000 },
      { key: 'meta_ads', monthlyCents: 5000 },
    ] }),
  });
  const res = makeRes();
  await handleChannelPerformanceGet({}, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.configured, true);
  assert.strictEqual(res.body.totalLeads, 7, 'totalLeads reflects the raw fetched row count, including blank/null rows');

  const bySource = Object.fromEntries(res.body.rows.map((r) => [r.source, r]));
  assert.strictEqual(Object.keys(bySource).length, 4, 'blank and null lead_source values must never produce a row');

  assert.strictEqual(bySource.google.leads, 2, 'lead_source grouping is case-insensitive/trimmed');
  assert.strictEqual(bySource.google.channelKey, 'google_ads');
  assert.strictEqual(bySource.google.spendCents, 10000);
  assert.strictEqual(bySource.google.costPerLeadCents, 5000);

  assert.strictEqual(bySource.facebook.leads, 1);
  assert.strictEqual(bySource.facebook.channelKey, 'meta_ads');
  assert.strictEqual(bySource.facebook.spendCents, 5000);
  assert.strictEqual(bySource.facebook.costPerLeadCents, 5000);

  assert.strictEqual(bySource.website.leads, 1);
  assert.strictEqual(bySource.website.channelKey, 'website_cms');
  assert.strictEqual(bySource.website.spendCents, 0, 'mapped channel with no tracked spend yet reports real 0, not null');
  assert.strictEqual(bySource.website.costPerLeadCents, 0);

  assert.strictEqual(bySource.referral.leads, 1);
  assert.strictEqual(bySource.referral.channelKey, null, 'unmapped lead source honestly has no channel match');
  assert.strictEqual(bySource.referral.spendCents, null, 'no fabricated cost for an unmapped source');
  assert.strictEqual(bySource.referral.costPerLeadCents, null);

  assert.strictEqual(res.body.rows[0].source, 'google', 'rows are sorted by lead volume, highest first');
});

// ---------- handleMarketingGoalGet behavior ----------

check('handleMarketingGoalGet reports goalCents:null and pct:null when no goal has been set', async () => {
  const { handleMarketingGoalGet } = loadCcFeatureFns({
    ccAssumptionsRow: async () => null,
    fetchAllRows: async () => [],
  });
  const res = makeRes();
  await handleMarketingGoalGet({}, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.goalCents, null);
  assert.strictEqual(res.body.progressCents, 0);
  assert.strictEqual(res.body.pct, null);
});

check('handleMarketingGoalGet computes real quarter-to-date progress against a set goal', async () => {
  const { handleMarketingGoalGet } = loadCcFeatureFns({
    ccAssumptionsRow: async () => ({ quarterly_revenue_goal_cents: 500000 }),
    fetchAllRows: async () => ([
      { total: '1000', completed_at: '2026-08-01T00:00:00Z' },
      { total: '250.50', completed_at: '2026-08-02T00:00:00Z' },
    ]),
  });
  const res = makeRes();
  await handleMarketingGoalGet({}, res);
  assert.strictEqual(res.body.goalCents, 500000);
  assert.strictEqual(res.body.progressCents, 125050);
  assert.ok(Math.abs(res.body.pct - (125050 / 500000)) < 1e-9);
});

check('handleMarketingGoalGet honestly degrades progress to 0 (never a 500) when jobs is not synced yet', async () => {
  const { handleMarketingGoalGet } = loadCcFeatureFns({
    ccAssumptionsRow: async () => ({ quarterly_revenue_goal_cents: 500000 }),
    fetchAllRows: async () => { const e = new Error('relation "jobs" does not exist'); e.notSynced = true; throw e; },
  });
  const res = makeRes();
  await handleMarketingGoalGet({}, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.progressCents, 0);
});

// ---------- handleMarketingGoalPost behavior ----------

check('handleMarketingGoalPost rejects a negative goal with a 400 and never writes', async () => {
  let wrote = false;
  const { handleMarketingGoalPost } = loadCcFeatureFns({
    ccAssumptionsRow: async () => { wrote = true; return null; },
    supabaseRequest: async () => { wrote = true; return { ok: true }; },
  });
  const res = makeRes();
  await handleMarketingGoalPost({ body: { goalDollars: -5 } }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.ok, false);
  assert.match(res.body.error, /0 or more/);
  assert.strictEqual(wrote, false, 'validation must short-circuit before any read/write');
});

check('handleMarketingGoalPost treats a blank goalDollars as clearing the goal (null), not an error', async () => {
  const { handleMarketingGoalPost } = loadCcFeatureFns({
    ccAssumptionsRow: async () => null,
    supabaseRequest: async () => ({ ok: true }),
  });
  const res = makeRes();
  await handleMarketingGoalPost({ body: { goalDollars: '' } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.goalCents, null);
});

check('handleMarketingGoalPost PATCHes the existing assumptions row when one already exists', async () => {
  let calledMethod = null, calledPath = null;
  const { handleMarketingGoalPost } = loadCcFeatureFns({
    ccAssumptionsRow: async () => ({ tenant_id: 'ghgrp' }),
    supabaseRequest: async (path, opts) => { calledPath = path; calledMethod = opts.method; return { ok: true }; },
  });
  const res = makeRes();
  await handleMarketingGoalPost({ body: { goalDollars: 5000 } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.goalCents, 500000);
  assert.strictEqual(calledMethod, 'PATCH');
  assert.match(calledPath, /tenant_id=eq\.ghgrp/);
});

check('handleMarketingGoalPost POSTs a new assumptions row when none exists yet', async () => {
  let calledMethod = null;
  const { handleMarketingGoalPost } = loadCcFeatureFns({
    ccAssumptionsRow: async () => null,
    supabaseRequest: async (path, opts) => { calledMethod = opts.method; return { ok: true }; },
  });
  const res = makeRes();
  await handleMarketingGoalPost({ body: { goalDollars: 5000 } }, res);
  assert.strictEqual(calledMethod, 'POST');
});

check('handleMarketingGoalPost logs an audit event on success', async () => {
  let auditArgs = null;
  const { handleMarketingGoalPost } = loadCcFeatureFns({
    ccAssumptionsRow: async () => null,
    supabaseRequest: async () => ({ ok: true }),
    logMarketingAuditEvent: async (...args) => { auditArgs = args; },
  });
  const res = makeRes();
  await handleMarketingGoalPost({ body: { goalDollars: 5000 } }, res);
  assert.ok(auditArgs, 'expected logMarketingAuditEvent to be called');
  assert.strictEqual(auditArgs[1], 'quarterly_goal_updated');
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
