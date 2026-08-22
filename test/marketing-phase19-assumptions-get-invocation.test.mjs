import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Phase 19 (test coverage): api/marketing.js's handleAssumptionsGet is the
// EXACT handler where a real bug shipped in a prior session's Phase 6
// consolidation -- a hand-merge left a duplicate nested self-shadowing
// declaration, so the real response body was unreachable. That bug went
// undetected because every test touching this handler was a static
// regex/structural check on source text, never an actual invocation.
// api-no-duplicate-function-declarations.test.mjs now guards against the
// exact duplicate-declaration shape recurring; this file complements it by
// proving the CURRENT single declaration of handleAssumptionsGet actually
// behaves correctly end-to-end -- a real call, with mocked data sources,
// asserted against real expected output. If a future hand-merge reintroduces
// a shadow function that silently swallows the real body (even one that
// doesn't trip the duplicate-name guard, e.g. a differently-named inner
// function that never gets invoked), a real invocation test like this one
// is what would actually catch it.

const SRC_PATH = 'api/marketing.js';
const raw = fs.readFileSync(SRC_PATH, 'utf8');

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

// ---------- Extract the real function bodies straight from the shipped file ----------
// (brace-depth extraction, not a hand-copied duplicate -- this is the actual
// production source, so the test rides along with any future real edit.)

function extractFunction(source, declSnippet) {
  const idx = source.indexOf(declSnippet);
  assert.ok(idx !== -1, `expected to find "${declSnippet}" in ${SRC_PATH}`);
  const lineStart = source.lastIndexOf('\n', idx) + 1;
  const braceStart = source.indexOf('{', idx);
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

check('sanity: handleAssumptionsGet is declared exactly once in the real file (no regression of the historical bug shape)', () => {
  const re = /function handleAssumptionsGet\s*\(/g;
  const matches = raw.match(re) || [];
  assert.equal(matches.length, 1, `expected exactly one handleAssumptionsGet declaration, found ${matches.length}`);
});

// fetchAllRows closes over two module-level constants declared outside its
// own function body -- pull those in verbatim too, rather than
// hand-guessing their values, so the real pagination cap is what's tested.
function extractConstLine(source, declSnippet) {
  const idx = source.indexOf(declSnippet);
  assert.ok(idx !== -1, `expected to find "${declSnippet}" in ${SRC_PATH}`);
  const lineEnd = source.indexOf('\n', idx);
  return source.slice(idx, lineEnd);
}

const pageSizeSrc = extractConstLine(raw, 'const PAGE_SIZE =');
const maxPagesSrc = extractConstLine(raw, 'const MAX_PAGES =');
const jobDivisionsSrc = extractConstLine(raw, 'const JOB_DIVISIONS =');
const monthNamesSrc = extractConstLine(raw, 'const MONTH_NAMES_UTC =');
const fetchAllRowsSrc = extractFunction(raw, 'async function fetchAllRows(table, query) {');
const moneySrc = extractFunction(raw, 'function money(n) {');
const jobDivisionServerSrc = extractFunction(raw, 'function jobDivisionServer(title) {');
const haversineSrc = extractFunction(raw, 'function haversineMilesForPlan(lat1, lng1, lat2, lng2) {');
const ccAssumptionsRowSrc = extractFunction(raw, 'async function ccAssumptionsRow() {');
const realAvgJobValueCentsSrc = extractFunction(raw, 'async function realAvgJobValueCents() {');
const realHistoricalJobsPerMonthSrc = extractFunction(raw, 'async function realHistoricalJobsPerMonth() {');
const realJobFactsByDivisionAndMonthSrc = extractFunction(raw, 'async function realJobFactsByDivisionAndMonth() {');
const computeUnsoldEstimatesSrc = extractFunction(raw, 'async function computeUnsoldEstimates() {');
const realUnsoldEstimatesForPlanSrc = extractFunction(raw, 'async function realUnsoldEstimatesForPlan() {');
const computeReactivateCustomersSrc = extractFunction(raw, 'async function computeReactivateCustomers() {');
const realPastCustomersForPlanSrc = extractFunction(raw, 'async function realPastCustomersForPlan() {');
const realExistingLeadsForPlanSrc = extractFunction(raw, 'async function realExistingLeadsForPlan() {');
const computeFirstTouchAttributionSrc = extractFunction(raw, 'async function computeFirstTouchAttribution() {');
const realPriorCampaignResultsForPlanSrc = extractFunction(raw, 'async function realPriorCampaignResultsForPlan() {');
const realCompanyCamAvailabilityForPlanSrc = extractFunction(raw, 'async function realCompanyCamAvailabilityForPlan() {');
const realServiceTerritoryForPlanSrc = extractFunction(raw, 'async function realServiceTerritoryForPlan() {');
const handleAssumptionsGetSrc = extractFunction(raw, 'async function handleAssumptionsGet(req, res) {');

const blockSrc = [
  pageSizeSrc, maxPagesSrc, jobDivisionsSrc, monthNamesSrc,
  fetchAllRowsSrc, moneySrc, jobDivisionServerSrc, haversineSrc,
  ccAssumptionsRowSrc, realAvgJobValueCentsSrc, realHistoricalJobsPerMonthSrc,
  realJobFactsByDivisionAndMonthSrc,
  computeUnsoldEstimatesSrc, realUnsoldEstimatesForPlanSrc,
  computeReactivateCustomersSrc, realPastCustomersForPlanSrc,
  realExistingLeadsForPlanSrc,
  computeFirstTouchAttributionSrc, realPriorCampaignResultsForPlanSrc,
  realCompanyCamAvailabilityForPlanSrc, realServiceTerritoryForPlanSrc,
  handleAssumptionsGetSrc,
].join('\n\n');

// ---------- Real invocation harness ----------
// Mocks only the outermost I/O boundary (supabaseRequest) -- everything
// above it (fetchAllRows pagination, ccAssumptionsRow, realAvgJobValueCents,
// realHistoricalJobsPerMonth, handleAssumptionsGet itself) is the real,
// unmodified production code running for real.

function makeFakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(obj) { res.body = obj; return res; },
  };
  return res;
}

function makeSandbox({ assumptionsRow, jobTotals, jobberCreatedAts }) {
  const supabaseRequest = async (pathAndQuery) => {
    const makeOkResponse = (rows) => ({
      ok: true,
      json: async () => rows,
      text: async () => JSON.stringify(rows),
    });
    if (pathAndQuery.startsWith('marketing_plan_assumptions')) {
      return makeOkResponse(assumptionsRow ? [assumptionsRow] : []);
    }
    if (pathAndQuery.startsWith('jobs?select=total')) {
      return makeOkResponse(jobTotals.map((total) => ({ total })));
    }
    if (pathAndQuery.startsWith('jobs?select=jobber_created_at')) {
      return makeOkResponse(jobberCreatedAts.map((d) => ({ jobber_created_at: d })));
    }
    // Every other real query this richer handler now also fans out to is
    // deliberately left to this single honest-empty fallback -- each real
    // function behind those queries already has its own honest empty-data
    // degrade path (proven in its own dedicated test file elsewhere).
    return makeOkResponse([]);
  };
  const realChannelAvailabilityForPlan = async () => ({ readyCount: 0, totalCount: 0, notReady: [] });
  const computePlanRationale = () => [];
  const sandbox = {
    supabaseRequest, console, Error, Object, Math, Date, Number, Promise, String, JSON, Map, Set, isFinite,
    realChannelAvailabilityForPlan, computePlanRationale,
  };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  return sandbox;
}

check('real invocation: a fully configured assumptions row round-trips through the real handler untouched', async () => {
  const sandbox = makeSandbox({
    assumptionsRow: {
      gross_margin_pct: '42.5',
      qualified_lead_rate_per_100: '8',
      close_rate_pct: '35',
      max_new_jobs_per_month: '12',
      risk_posture: 'aggressive',
      avg_job_value_cents: '450000',
      updated_at: '2026-07-30T00:00:00.000Z',
      updated_by: 'owner',
    },
    jobTotals: [1000, 2000, 3000],
    jobberCreatedAts: ['2026-07-01T00:00:00Z', '2026-07-15T00:00:00Z', '2026-06-01T00:00:00Z'],
  });
  const res = makeFakeRes();
  await sandbox.handleAssumptionsGet({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  // Real field-by-field proof the real handler actually ran the real body,
  // not a shadow function returning undefined/nothing.
  assert.equal(res.body.assumptions.grossMarginPct, 42.5);
  assert.equal(res.body.assumptions.qualifiedLeadRatePer100, 8);
  assert.equal(res.body.assumptions.closeRatePct, 35);
  assert.equal(res.body.assumptions.maxNewJobsPerMonth, 12);
  assert.equal(res.body.assumptions.riskPosture, 'aggressive');
  assert.equal(res.body.assumptions.avgJobValueCents, 450000);
  assert.equal(res.body.assumptions.updatedBy, 'owner');
  // Real computed reference values -- avg of [1000,2000,3000] * 100 = 200000
  assert.equal(res.body.reference.realAvgJobValueCents, 200000);
  assert.match(res.body.reference.realAvgJobValueSource, /Average of real completed/);
  // 2 distinct months (2026-07, 2026-06) across 3 rows -> round(3/2) = 2
  assert.equal(res.body.reference.realHistoricalJobsPerMonth, 2);
});

check('real invocation: no assumptions row yet degrades to honest defaults, never a crash or fabricated number', async () => {
  const sandbox = makeSandbox({ assumptionsRow: null, jobTotals: [], jobberCreatedAts: [] });
  const res = makeFakeRes();
  await sandbox.handleAssumptionsGet({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.assumptions.grossMarginPct, null);
  assert.equal(res.body.assumptions.riskPosture, 'balanced'); // real default, not fabricated
  assert.equal(res.body.assumptions.avgJobValueCents, null);
  assert.equal(res.body.reference.realAvgJobValueCents, null);
  assert.match(res.body.reference.realAvgJobValueSource, /No priced jobs synced yet/);
  assert.equal(res.body.reference.realHistoricalJobsPerMonth, null);
  assert.match(res.body.reference.realHistoricalJobsPerMonthSource, /Not enough job history yet/);
});

check('real invocation: zero-value numeric fields are preserved as real zeros, not coerced into null/defaults', () => {
  return (async () => {
    const sandbox = makeSandbox({
      assumptionsRow: {
        gross_margin_pct: '0',
        qualified_lead_rate_per_100: '0',
        close_rate_pct: '0',
        max_new_jobs_per_month: '0',
        risk_posture: 'conservative',
        avg_job_value_cents: '0',
        updated_at: null,
        updated_by: null,
      },
      jobTotals: [500],
      jobberCreatedAts: ['2026-07-01T00:00:00Z'],
    });
    const res = makeFakeRes();
    await sandbox.handleAssumptionsGet({}, res);
    assert.equal(res.body.assumptions.grossMarginPct, 0);
    assert.equal(res.body.assumptions.qualifiedLeadRatePer100, 0);
    assert.equal(res.body.assumptions.closeRatePct, 0);
    assert.equal(res.body.assumptions.maxNewJobsPerMonth, 0);
    assert.equal(res.body.assumptions.avgJobValueCents, 0);
  })();
});

check('real invocation: a not_synced marketing_plan_assumptions table degrades to the null-assumptions shape, not a 500', async () => {
  const sandbox0 = makeSandbox({ assumptionsRow: null, jobTotals: [], jobberCreatedAts: [] });
  // Rebuild supabaseRequest to actually throw a notSynced error for the
  // assumptions table specifically, proving ccAssumptionsRow's own
  // try/catch (real code, not test code) is what handles it.
  const supabaseRequest = async (pathAndQuery) => {
    if (pathAndQuery.startsWith('marketing_plan_assumptions')) {
      const e = new Error('relation "marketing_plan_assumptions" does not exist');
      e.notSynced = true;
      throw e;
    }
    return { ok: true, json: async () => [], text: async () => '[]' };
  };
  const realChannelAvailabilityForPlan = async () => ({ readyCount: 0, totalCount: 0, notReady: [] });
  const computePlanRationale = () => [];
  const sandbox = {
    supabaseRequest, console, Error, Object, Math, Date, Number, Promise, String, JSON, Map, Set, isFinite,
    realChannelAvailabilityForPlan, computePlanRationale,
  };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  const res = makeFakeRes();
  await sandbox.handleAssumptionsGet({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.assumptions.riskPosture, 'balanced');
  assert.equal(res.body.assumptions.grossMarginPct, null);
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
