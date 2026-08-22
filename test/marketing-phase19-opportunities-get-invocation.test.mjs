import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Phase 19 (test coverage): handleOpportunitiesGet in api/marketing.js is the
// single biggest consolidation point in the Marketing Suite -- it fans out
// to 6 independent compute*() functions via Promise.all and returns their
// results, in order, as the Opportunities list the owner sees. A hand-merge
// here (the same failure mode that produced the historical
// handleAssumptionsGet bug: a duplicate/shadowed declaration silently
// swallowing real behavior) could drop, duplicate, or reorder an entry
// without any static/regex test noticing, since a regex only proves the
// SOURCE TEXT mentions each function name -- not that calling the real
// aggregator actually produces 6 correct, correctly-ordered, correctly
// computed results. This file proves that with a real invocation: the real
// handleOpportunitiesGet and all 6 real compute functions (plus every real
// helper/constant they depend on) are extracted from the live file and run
// for real in a vm sandbox, with only the outermost I/O boundary
// (supabaseRequest) mocked.

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

function extractConstLine(source, declSnippet) {
  const idx = source.indexOf(declSnippet);
  assert.ok(idx !== -1, `expected to find "${declSnippet}" in ${SRC_PATH}`);
  const lineEnd = source.indexOf('\n', idx);
  return source.slice(idx, lineEnd);
}

function extractConstArray(source, declSnippet) {
  const idx = source.indexOf(declSnippet);
  assert.ok(idx !== -1, `expected to find "${declSnippet}" in ${SRC_PATH}`);
  const lineStart = source.lastIndexOf('\n', idx) + 1;
  const bracketStart = source.indexOf('[', idx);
  let depth = 0;
  for (let i = bracketStart; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') {
      depth--;
      if (depth === 0) {
        const semi = source.indexOf(';', i);
        return source.slice(lineStart, semi + 1);
      }
    }
  }
  throw new Error(`unterminated const array for "${declSnippet}"`);
}

function extractConstObject(source, declSnippet) {
  const idx = source.indexOf(declSnippet);
  assert.ok(idx !== -1, `expected to find "${declSnippet}" in ${SRC_PATH}`);
  const lineStart = source.lastIndexOf('\n', idx) + 1;
  const braceStart = source.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        const semi = source.indexOf(';', i);
        return source.slice(lineStart, semi + 1);
      }
    }
  }
  throw new Error(`unterminated const object for "${declSnippet}"`);
}

check('sanity: handleOpportunitiesGet is declared exactly once in the real file', () => {
  const re = /function handleOpportunitiesGet\s*\(/g;
  const matches = raw.match(re) || [];
  assert.equal(matches.length, 1, `expected exactly one declaration, found ${matches.length}`);
});

// ---------- Pull every real dependency straight from the shipped file ----------

const pageSizeSrc = extractConstLine(raw, 'const PAGE_SIZE =');
const maxPagesSrc = extractConstLine(raw, 'const MAX_PAGES =');
const gridSrc = extractConstLine(raw, 'const NEIGHBORHOOD_GRID_DEGREES =');
const minJobsSrc = extractConstLine(raw, 'const NEIGHBORHOOD_MIN_JOBS =');
const eligibilitySrc = extractConstObject(raw, 'const OPPORTUNITY_ELIGIBILITY =');

const fetchAllRowsSrc = extractFunction(raw, 'async function fetchAllRows(table, query) {');
const fetchLocationsSrc = extractFunction(raw, 'async function fetchAllClientLocationsForOpportunities() {');
const moneySrc = extractFunction(raw, 'function money(n) {');
const jobDivisionSrc = extractFunction(raw, 'function jobDivisionServer(title) {');

const computeUnsoldEstimatesSrc = extractFunction(raw, 'async function computeUnsoldEstimates() {');
const computeNeighborhoodExpansionSrc = extractFunction(raw, 'async function computeNeighborhoodExpansion() {');
const computeReviewRequestsOpportunitySrc = extractFunction(raw, 'async function computeReviewRequestsOpportunity() {');
const computeReactivateCustomersSrc = extractFunction(raw, 'async function computeReactivateCustomers() {');
const computeReferralOpportunitiesSrc = extractFunction(raw, 'async function computeReferralOpportunities() {');
const computeSeasonalPromotionSrc = extractFunction(raw, 'async function computeSeasonalPromotion() {');
const handleOpportunitiesGetSrc = extractFunction(raw, 'async function handleOpportunitiesGet(req, res) {');
const commonLeadSourceCatalogSrc = extractConstArray(raw, 'const COMMON_LEAD_SOURCE_CATALOG =');
const computeMissedLeadSourcesOpportunitySrc = extractFunction(raw, 'async function computeMissedLeadSourcesOpportunity() {');

const blockSrc = [
  pageSizeSrc, maxPagesSrc, gridSrc, minJobsSrc, eligibilitySrc,
  fetchAllRowsSrc, fetchLocationsSrc, moneySrc, jobDivisionSrc,
  computeUnsoldEstimatesSrc, computeNeighborhoodExpansionSrc,
  computeReviewRequestsOpportunitySrc, computeReactivateCustomersSrc,
  computeReferralOpportunitiesSrc, computeSeasonalPromotionSrc,
  commonLeadSourceCatalogSrc, computeMissedLeadSourcesOpportunitySrc,
  handleOpportunitiesGetSrc,
].join('\n\n');

// ---------- Fixture data (real dates computed at test-run time, not baked in) ----------

const DAY = 86400000;
const now = Date.now();
const isoDaysAgo = (d) => new Date(now - d * DAY).toISOString();

const thisMonthUtc = new Date().getUTCMonth();
const thisYearUtc = new Date().getUTCFullYear();
function isoInMonth(year, month, day) {
  return new Date(Date.UTC(year, month, day, 12, 0, 0)).toISOString();
}

function makeFakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(obj) { res.body = obj; return res; },
  };
  return res;
}

function makeOkResponse(rows) {
  return { ok: true, json: async () => rows, text: async () => JSON.stringify(rows) };
}

function makeSandbox() {
  const supabaseRequest = async (pathAndQuery) => {
    if (pathAndQuery.startsWith('quotes?')) {
      // 1 fresh (5 days old), 1 stale (45 days old) -- proves the real
      // 30-day staleness split, not just a count.
      return makeOkResponse([
        { jobber_id: 'q1', total: 1000, jobber_created_at: isoDaysAgo(5) },
        { jobber_id: 'q2', total: 2500, jobber_created_at: isoDaysAgo(45) },
      ]);
    }
    if (pathAndQuery.startsWith('client_locations?')) {
      // 3 clients clustered in the same ~0.01deg grid cell -> meets
      // NEIGHBORHOOD_MIN_JOBS (3) in exactly one area.
      return makeOkResponse([
        { jobber_id: 'c1', lat: 40.001, lng: -75.001 },
        { jobber_id: 'c2', lat: 40.0015, lng: -75.0012 },
        { jobber_id: 'c3', lat: 40.0018, lng: -75.0019 },
      ]);
    }
    if (pathAndQuery.startsWith('jobs?')) {
      if (pathAndQuery.includes('client_id,total,completed_at') && pathAndQuery.includes('order=completed_at.desc')) {
        // Reactivate-customers fixture: one customer squarely inside the
        // 6-24mo window (real hit), one too recent (60d, excluded), one too
        // old (800d, excluded) -- proves the real boundary logic, not just
        // that SOME row exists.
        return makeOkResponse([
          { client_id: 'recent', total: 500, completed_at: isoDaysAgo(60) },
          { client_id: 'reactivate-me', total: 3000, completed_at: isoDaysAgo(300) },
          { client_id: 'too-old', total: 999, completed_at: isoDaysAgo(800) },
        ]);
      }
      if (pathAndQuery.includes('client_id,total,completed_at')) {
        // Neighborhood-expansion jobs, matching the 3 clustered client_locations above.
        return makeOkResponse([
          { client_id: 'c1', total: 1000, completed_at: isoDaysAgo(10) },
          { client_id: 'c2', total: 1000, completed_at: isoDaysAgo(20) },
          { client_id: 'c3', total: 1000, completed_at: isoDaysAgo(30) },
        ]);
      }
      if (pathAndQuery.includes('jobber_id,client_id,completed_at')) {
        return makeOkResponse([]); // review-requests: honest-empty path
      }
      if (pathAndQuery.includes('title,total,completed_at')) {
        return makeOkResponse([]); // seasonal-promotion: honest-empty path
      }
      throw new Error('unexpected jobs query shape in test: ' + pathAndQuery);
    }
    if (pathAndQuery.startsWith('clients?')) {
      return makeOkResponse([]);
    }
    if (pathAndQuery.startsWith('review_requests?')) {
      return makeOkResponse([]);
    }
    if (pathAndQuery.startsWith('lead_pipeline?')) {
      return makeOkResponse([]); // referral-opportunities: honest-empty path
    }
    throw new Error('unexpected supabaseRequest call in test: ' + pathAndQuery);
  };
  const sandbox = { supabaseRequest, console, Error, Object, Math, Date, Number, Promise, String, JSON, Map, Set, RegExp, isFinite };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  return sandbox;
}

check('real invocation: handleOpportunitiesGet returns all 6 opportunities, in the real wired order', async () => {
  const sandbox = makeSandbox();
  const res = makeFakeRes();
  await sandbox.handleOpportunitiesGet({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.source, /real Jobber-synced/);
  // Phase 19 follow-up (test coverage fix): handleOpportunitiesGet now fans
  // out to a 7th compute function, computeMissedLeadSourcesOpportunity(),
  // added since this test was authored -- updated to expect it as the
  // real, current last entry rather than the stale 6-opportunity count.
  assert.equal(res.body.opportunities.length, 7);
  const keys = res.body.opportunities.map((o) => o.key);
  assert.deepEqual(keys, [
    'unsold_estimates',
    'neighborhood_expansion',
    'review_requests',
    'reactivate_customers',
    'referral_opportunities',
    'seasonal_promotion',
    'missed_lead_sources',
  ]);
});

check('real invocation: computeUnsoldEstimates real math -- 2 quotes, 1 genuinely stale (>30d)', async () => {
  const sandbox = makeSandbox();
  const opp = await sandbox.computeUnsoldEstimates();
  assert.equal(opp.count, 2);
  assert.equal(opp.estRevenue, 3500);
  assert.equal(opp.staleCount, 1);
  assert.equal(opp.staleValue, 2500);
  assert.equal(opp.actionable, true);
});

check('real invocation: computeNeighborhoodExpansion real geo-clustering -- 3 nearby jobs form exactly 1 qualifying area', async () => {
  const sandbox = makeSandbox();
  const opp = await sandbox.computeNeighborhoodExpansion();
  assert.equal(opp.count, 1);
  assert.equal(opp.estRevenue, 3000);
  // Real business rule: this opportunity type is ALWAYS non-actionable via
  // email regardless of data, per OPPORTUNITY_ELIGIBILITY -- proven here
  // against real (non-zero) data, not just the empty-data case.
  assert.equal(opp.actionable, false);
  assert.match(opp.actionableReason, /Launch Channels/);
});

check('real invocation: computeReactivateCustomers real 6-24 month boundary -- only the mid-window customer counts', async () => {
  const sandbox = makeSandbox();
  const opp = await sandbox.computeReactivateCustomers();
  assert.equal(opp.count, 1);
  assert.equal(opp.estRevenue, 3000); // only "reactivate-me", not "recent" or "too-old"
  assert.equal(opp.actionable, true);
});

check('real invocation: computeReviewRequestsOpportunity, computeReferralOpportunities, computeSeasonalPromotion degrade honestly on empty real data', async () => {
  const sandbox = makeSandbox();
  const review = await sandbox.computeReviewRequestsOpportunity();
  assert.equal(review.count, 0);
  assert.equal(review.actionable, false);
  assert.match(review.description, /No completed jobs are currently waiting/);

  const referral = await sandbox.computeReferralOpportunities();
  assert.equal(referral.count, 0);
  assert.equal(referral.estRevenue, null);
  assert.equal(referral.actionable, false);

  const seasonal = await sandbox.computeSeasonalPromotion();
  assert.equal(seasonal.actionable, false);
  assert.match(seasonal.description, /Not enough same-month history/);
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
