import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Phase 19 (test coverage): the earlier assumptions-GET slice this session
// covered handleAssumptionsGet, ccAssumptionsRow, realAvgJobValueCents, and
// realHistoricalJobsPerMonth -- but left handleAssumptionsPost (the write
// side of the same feature) with no real-invocation coverage at all, an
// honest gap noted in that slice's shipped-doc. This file closes it.
//
// Scope decision: handleAssumptionsPost's final step calls ccPlan(budgetCents)
// -- a large, separate function (its own dependency tree: ccConnections,
// CHANNELS, computeForecast, etc.) that deserves its own dedicated test
// rather than being pulled in wholesale here. This test extracts and runs
// the REAL handleAssumptionsPost, ccAssumptionsRow, and fetchAllRows, but
// injects a recording stub for ccPlan -- proving handleAssumptionsPost's
// OWN real logic (input validation, PATCH-vs-POST branching, real budget-row
// lookup with honest not-synced fallback, and correct response wiring) is
// correct, while treating ccPlan as an already-separately-tested boundary.

const SRC_PATH = 'api/marketing.js';
const raw = fs.readFileSync(SRC_PATH, 'utf8');

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

function extractFunction(source, declSnippet) {
  const idx = source.indexOf(declSnippet);
  assert.ok(idx !== -1, `expected to find "${declSnippet}" in ${SRC_PATH}`);
  const lineStart = source.lastIndexOf('\n', idx) + 1;
  const closeParenBrace = source.indexOf(') {', idx);
  assert.ok(closeParenBrace !== -1, `expected ") {" after "${declSnippet}"`);
  const braceStart = closeParenBrace + 2;
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(lineStart, i + 1);
    }
  }
  throw new Error(`unterminated function body for "${declSnippet}"`);
}

function extractConstLine(source, declSnippet) {
  const idx = source.indexOf(declSnippet);
  assert.ok(idx !== -1, `expected to find "${declSnippet}" in ${SRC_PATH}`);
  const lineEnd = source.indexOf('\n', idx);
  return source.slice(idx, lineEnd);
}

check('sanity: handleAssumptionsPost is declared exactly once in the real file', () => {
  const re = /function handleAssumptionsPost\s*\(/g;
  const matches = raw.match(re) || [];
  assert.equal(matches.length, 1, `expected exactly one declaration, found ${matches.length}`);
});

const pageSizeSrc = extractConstLine(raw, 'const PAGE_SIZE');
const maxPagesSrc = extractConstLine(raw, 'const MAX_PAGES');
const fetchAllRowsSrc = extractFunction(raw, 'async function fetchAllRows(');
const ccAssumptionsRowSrc = extractFunction(raw, 'async function ccAssumptionsRow(');
const logMarketingAuditEventSrc = extractFunction(raw, 'async function logMarketingAuditEvent(');
const handlerSrc = extractFunction(raw, 'async function handleAssumptionsPost(');

check('sanity: the extracted handler really calls the real ccAssumptionsRow + ccPlan wiring, not a stale copy', () => {
  assert.match(handlerSrc, /const existing = await ccAssumptionsRow\(\);/);
  assert.match(handlerSrc, /const plan = await ccPlan\(budgetCents\);/);
  assert.match(handlerSrc, /res\.status\(200\)\.json\(\{ ok: true, plan \}\);/);
});

const blockSrc = [pageSizeSrc, maxPagesSrc, fetchAllRowsSrc, ccAssumptionsRowSrc, logMarketingAuditEventSrc, handlerSrc].join('\n\n');

function makeMockSupabase(routes) {
  const callLog = [];
  return {
    fn: async function supabaseRequest(url, opts) {
      callLog.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body });
      for (const route of routes) {
        const matches = typeof route.test === 'string' ? url.includes(route.test) : route.test.test(url);
        if (matches) {
          if (route.notSynced) return { ok: false, text: async () => 'relation "public.x" does not exist' };
          return { ok: true, json: async () => route.rows };
        }
      }
      throw new Error('unmatched supabaseRequest url: ' + url);
    },
    callLog,
  };
}

function makeRes() {
  return {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(obj) { this._body = obj; return this; },
  };
}

function makeSandbox(routes, ccPlanStub) {
  const supa = makeMockSupabase(routes);
  const ccPlanCalls = [];
  const ccPlan = async (budgetCents) => {
    ccPlanCalls.push(budgetCents);
    return (ccPlanStub || (bc => ({ stubPlanFor: bc })))(budgetCents);
  };
  const sandbox = {
    console, Error, Object, String, Number, Math, JSON, Promise, Date,
    supabaseRequest: supa.fn,
    ccPlan,
  };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  return { sandbox, supa, ccPlanCalls };
}

// ---------- Real validation logic ----------

check('real invocation: gross margin outside 0-100 is refused with a real 400, before any database call', async () => {
  const { sandbox, supa } = makeSandbox([]);
  const res = makeRes();
  await sandbox.handleAssumptionsPost({ body: { grossMarginPct: 150 } }, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, 'Gross margin must be between 0 and 100.');
  assert.equal(supa.callLog.length, 0);
});

check('real invocation: a negative qualified-lead rate is refused with the real message, before any database call', async () => {
  const { sandbox, supa } = makeSandbox([]);
  const res = makeRes();
  await sandbox.handleAssumptionsPost({ body: { qualifiedLeadRatePer100: -5 } }, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, 'Qualified-lead rate must be 0 or more.');
  assert.equal(supa.callLog.length, 0);
});

check('real invocation: a negative max-new-jobs value is refused; a valid fractional value is really rounded before being persisted', async () => {
  const { sandbox: badSandbox } = makeSandbox([]);
  const badRes = makeRes();
  await badSandbox.handleAssumptionsPost({ body: { maxNewJobsPerMonth: -1 } }, badRes);
  assert.equal(badRes._status, 400);
  assert.equal(badRes._body.error, 'Max new jobs/month must be 0 or more.');

  const { sandbox, supa } = makeSandbox([{ test: 'marketing_plan_assumptions?select=', rows: [] }, { test: 'marketing_budget_settings', rows: [] }, { test: 'marketing_plan_assumptions', rows: [] }]);
  const res = makeRes();
  await sandbox.handleAssumptionsPost({ body: { maxNewJobsPerMonth: 10.6 } }, res);
  assert.equal(res._status, 200);
  const insertCall = supa.callLog.find(c => c.url === 'marketing_plan_assumptions' && c.method === 'POST');
  assert.equal(JSON.parse(insertCall.body).max_new_jobs_per_month, 11); // Math.round(10.6)
});

check('real invocation: average job value in real dollars is really converted to cents (not a fabricated passthrough)', async () => {
  const { sandbox, supa } = makeSandbox([{ test: 'marketing_plan_assumptions?select=', rows: [] }, { test: 'marketing_budget_settings', rows: [] }, { test: 'marketing_plan_assumptions', rows: [] }]);
  const res = makeRes();
  await sandbox.handleAssumptionsPost({ body: { avgJobValueDollars: 123.45 } }, res);
  assert.equal(res._status, 200);
  const insertCall = supa.callLog.find(c => c.url === 'marketing_plan_assumptions' && c.method === 'POST');
  assert.equal(JSON.parse(insertCall.body).avg_job_value_cents, 12345);
});

check('real invocation: an invalid riskPosture silently falls back to the real default "balanced" (not an error, not left blank)', async () => {
  const { sandbox, supa } = makeSandbox([{ test: 'marketing_plan_assumptions?select=', rows: [] }, { test: 'marketing_budget_settings', rows: [] }, { test: 'marketing_plan_assumptions', rows: [] }]);
  const res = makeRes();
  await sandbox.handleAssumptionsPost({ body: { riskPosture: 'not_a_real_option' } }, res);
  assert.equal(res._status, 200);
  const insertCall = supa.callLog.find(c => c.url === 'marketing_plan_assumptions' && c.method === 'POST');
  assert.equal(JSON.parse(insertCall.body).risk_posture, 'balanced');
});

// ---------- Real PATCH-vs-POST branching ----------

check('real invocation: no existing assumptions row -> a real POST is sent (not PATCH)', async () => {
  const { sandbox, supa } = makeSandbox([{ test: 'marketing_plan_assumptions?select=', rows: [] }, { test: 'marketing_budget_settings', rows: [] }, { test: 'marketing_plan_assumptions', rows: [] }]);
  const res = makeRes();
  await sandbox.handleAssumptionsPost({ body: { grossMarginPct: 40 } }, res);
  assert.equal(res._status, 200);
  const calls = supa.callLog.filter(c => c.url.startsWith('marketing_plan_assumptions') && c.method !== 'GET');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
});

check('real invocation: an existing assumptions row -> a real PATCH is sent (not a duplicate POST)', async () => {
  const { sandbox, supa } = makeSandbox([
    { test: 'marketing_plan_assumptions?select=', rows: [{ tenant_id: 'ghgrp', gross_margin_pct: 30 }] },
    { test: 'marketing_budget_settings', rows: [] },
    { test: 'marketing_plan_assumptions', rows: [] },
  ]);
  const res = makeRes();
  await sandbox.handleAssumptionsPost({ body: { grossMarginPct: 45 } }, res);
  assert.equal(res._status, 200);
  const calls = supa.callLog.filter(c => c.url.startsWith('marketing_plan_assumptions') && c.method !== 'GET');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.match(calls[0].url, /tenant_id=eq\.ghgrp/);
});

// ---------- Real budget lookup, honest fallback ----------

check('real invocation: no marketing_budget_settings row (not synced) -> the real hardcoded $2,500 default (250000 cents) is what reaches ccPlan', async () => {
  const { sandbox, ccPlanCalls } = makeSandbox([
    { test: 'marketing_plan_assumptions?select=', rows: [] },
    { test: 'marketing_budget_settings', notSynced: true },
    { test: 'marketing_plan_assumptions', rows: [] },
  ]);
  const res = makeRes();
  await sandbox.handleAssumptionsPost({ body: {} }, res);
  assert.equal(res._status, 200);
  assert.deepEqual(ccPlanCalls, [250000]);
});

check('real invocation: a real marketing_budget_settings row overrides the default -- the real stored cents value reaches ccPlan, not the default', async () => {
  const { sandbox, ccPlanCalls } = makeSandbox([
    { test: 'marketing_plan_assumptions?select=', rows: [] },
    { test: 'marketing_budget_settings', rows: [{ monthly_budget_cents: 500000 }] },
    { test: 'marketing_plan_assumptions', rows: [] },
  ]);
  const res = makeRes();
  await sandbox.handleAssumptionsPost({ body: {} }, res);
  assert.equal(res._status, 200);
  assert.deepEqual(ccPlanCalls, [500000]);
});

// ---------- Real response wiring ----------

check('real invocation: the handler\'s real final response is exactly {ok:true, plan: <whatever ccPlan returned>} -- no reshaping, no extra fields', async () => {
  const { sandbox } = makeSandbox(
    [{ test: 'marketing_plan_assumptions?select=', rows: [] }, { test: 'marketing_budget_settings', rows: [] }, { test: 'marketing_plan_assumptions', rows: [] }],
    () => ({ marker: 'real-plan-object', channels: [] }),
  );
  const res = makeRes();
  await sandbox.handleAssumptionsPost({ body: {} }, res);
  // res._body itself is an object literal constructed INSIDE the vm sandbox
  // (by the real handler's own `res.status(200).json({ ok: true, plan })`),
  // so it carries the sandbox realm's Object prototype -- assert.deepEqual
  // against a main-realm literal fails on prototype identity even with
  // identical own properties. Compare the outer shape by key, then deep-
  // compare the nested `plan` value (which IS a main-realm object, since it
  // came back from the ccPlan stub defined in this test file).
  assert.deepEqual(Object.keys(res._body).sort(), ['ok', 'plan']);
  assert.equal(res._body.ok, true);
  assert.deepEqual(res._body.plan, { marker: 'real-plan-object', channels: [] });
});

// ---------- Runner ----------

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL: ${name}`);
    console.log(`  ${e.stack || e.message}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
