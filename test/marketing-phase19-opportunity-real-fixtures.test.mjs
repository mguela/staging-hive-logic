import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Phase 19 (test coverage): the phase19-opportunities-invocation slice earlier
// this session covered computeUnsoldEstimates, computeNeighborhoodExpansion,
// and computeReactivateCustomers with real (non-empty) fixtures, but left
// computeReviewRequestsOpportunity, computeReferralOpportunities, and
// computeSeasonalPromotion tested only against empty data -- an honest gap
// documented in that slice's shipped-doc. This file closes that gap with
// real-invocation tests against real, non-trivial fixtures for all three.

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

check('sanity: all three target functions are declared exactly once in the real file', () => {
  for (const name of ['computeReviewRequestsOpportunity', 'computeReferralOpportunities', 'computeSeasonalPromotion']) {
    const re = new RegExp(`function ${name}\\s*\\(`, 'g');
    const matches = raw.match(re) || [];
    assert.equal(matches.length, 1, `expected exactly one declaration of ${name}, found ${matches.length}`);
  }
});

const pageSizeSrc = extractConstLine(raw, 'const PAGE_SIZE');
const maxPagesSrc = extractConstLine(raw, 'const MAX_PAGES');
const fetchAllRowsSrc = extractFunction(raw, 'async function fetchAllRows(');
const moneySrc = extractFunction(raw, 'function money(');
const jobDivisionServerSrc = extractFunction(raw, 'function jobDivisionServer(');
const reviewReqSrc = extractFunction(raw, 'async function computeReviewRequestsOpportunity(');
const referralSrc = extractFunction(raw, 'async function computeReferralOpportunities(');
const seasonalSrc = extractFunction(raw, 'async function computeSeasonalPromotion(');

const blockSrc = [pageSizeSrc, maxPagesSrc, fetchAllRowsSrc, moneySrc, jobDivisionServerSrc, reviewReqSrc, referralSrc, seasonalSrc].join('\n\n');

// FakeDate: `new Date()` (no args) returns a fixed instant so
// computeSeasonalPromotion's YoY comparison is deterministic; `new Date(x)`
// (with an arg, as used to parse completed_at) behaves like the real Date.
const FIXED_NOW = '2026-06-15T12:00:00Z';
class FakeDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(FIXED_NOW);
    else super(...args);
  }
}
FakeDate.now = () => new Date(FIXED_NOW).getTime();

function makeMockSupabase(routes) {
  return async function supabaseRequest(url) {
    for (const route of routes) {
      const matches = typeof route.test === 'string' ? url.includes(route.test) : route.test.test(url);
      if (matches) {
        if (route.notSynced) {
          return { ok: false, text: async () => `relation "public.x" does not exist` };
        }
        return { ok: true, json: async () => route.rows };
      }
    }
    throw new Error('unmatched supabaseRequest url: ' + url);
  };
}

function makeSandbox(routes) {
  const sandbox = {
    console, Error, Object, Number, Math, Map, Set, Promise,
    Date: FakeDate,
    supabaseRequest: makeMockSupabase(routes),
  };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  return sandbox;
}

// ---------- computeReviewRequestsOpportunity ----------

check('real invocation: pending review requests count only completed jobs with a real client email that have not already been actioned', async () => {
  const sandbox = makeSandbox([
    { test: 'jobs?select=jobber_id,client_id,completed_at', rows: [
      { jobber_id: 'J1', client_id: 'C1', completed_at: '2026-06-01T00:00:00Z' },
      { jobber_id: 'J2', client_id: 'C2', completed_at: '2026-06-02T00:00:00Z' },
      { jobber_id: 'J3', client_id: 'C3', completed_at: '2026-06-03T00:00:00Z' },
    ] },
    { test: 'clients?select=jobber_id,email', rows: [
      { jobber_id: 'C1', email: 'c1@example.com' },
      { jobber_id: 'C2', email: null },
      { jobber_id: 'C3', email: 'c3@example.com' },
    ] },
    { test: 'review_requests?select=job_id,status', rows: [
      { job_id: 'J3', status: 'sent' },
    ] },
  ]);
  const result = await sandbox.computeReviewRequestsOpportunity();
  // J1: has email, not actioned -> counts. J2: no email -> skip. J3: actioned -> skip.
  assert.equal(result.count, 1);
  assert.equal(result.actionable, true);
  assert.equal(result.estRevenue, null); // deliberately no fabricated revenue guess
  assert.match(result.description, /1 completed job with a client email on file/);
});

check('real invocation: review_requests table not synced yet degrades honestly -- no throw, all emailed completed jobs count as pending', async () => {
  const sandbox = makeSandbox([
    { test: 'jobs?select=jobber_id,client_id,completed_at', rows: [
      { jobber_id: 'J1', client_id: 'C1', completed_at: '2026-06-01T00:00:00Z' },
      { jobber_id: 'J2', client_id: 'C2', completed_at: '2026-06-02T00:00:00Z' },
    ] },
    { test: 'clients?select=jobber_id,email', rows: [
      { jobber_id: 'C1', email: 'c1@example.com' },
      { jobber_id: 'C2', email: 'c2@example.com' },
    ] },
    { test: 'review_requests?select=job_id,status', notSynced: true },
  ]);
  const result = await sandbox.computeReviewRequestsOpportunity();
  assert.equal(result.count, 2);
  assert.equal(result.actionable, true);
});

// ---------- computeReferralOpportunities ----------

check('real invocation: real referral-sourced leads sum to a real, non-fabricated estimated revenue total', async () => {
  const sandbox = makeSandbox([
    { test: 'lead_pipeline?select=client_id,estimated_value', rows: [
      { client_id: 'C1', estimated_value: 1000 },
      { client_id: 'C2', estimated_value: 2500 },
      { client_id: 'C3', estimated_value: 1500.4 },
    ] },
  ]);
  const result = await sandbox.computeReferralOpportunities();
  assert.equal(result.count, 3);
  assert.equal(result.estRevenue, 5000); // Math.round(1000+2500+1500.4)
  assert.equal(result.actionable, true);
  assert.match(result.description, /3 leads logged as referrals/);
});

check('real invocation: lead_pipeline table not set up yet degrades honestly (no fabricated count/revenue)', async () => {
  const sandbox = makeSandbox([
    { test: 'lead_pipeline?select=client_id,estimated_value', notSynced: true },
  ]);
  const result = await sandbox.computeReferralOpportunities();
  assert.equal(result.count, 0);
  assert.equal(result.estRevenue, null);
  assert.equal(result.actionable, false);
  assert.equal(result.description, 'Lead pipeline table is not set up yet.');
});

// ---------- computeSeasonalPromotion ----------

check('real invocation: real YoY division comparison picks the division with the highest real positive growth, ignoring a division with negative growth', async () => {
  const sandbox = makeSandbox([
    { test: 'jobs?select=title,total,completed_at', rows: [
      // Plumbing: 5000 this June vs 4000 last June -> +25%
      { title: 'Water heater replacement', total: 5000, completed_at: '2026-06-10T00:00:00Z' },
      { title: 'Water heater replacement', total: 4000, completed_at: '2025-06-12T00:00:00Z' },
      // Electric: 2000 this June vs 3000 last June -> -33% (must NOT win, negative)
      { title: 'Panel upgrade install', total: 2000, completed_at: '2026-06-05T00:00:00Z' },
      { title: 'Panel upgrade install', total: 3000, completed_at: '2025-06-08T00:00:00Z' },
      // Off-month job (January) -- must be excluded from both years' totals
      { title: 'Water heater replacement', total: 9999, completed_at: '2026-01-01T00:00:00Z' },
    ] },
  ]);
  const result = await sandbox.computeSeasonalPromotion();
  assert.equal(result.actionable, true);
  assert.match(result.description, /^Plumbing job revenue is up 25% this month vs\. the same month last year \(\$5,000 vs \$4,000\)\.$/);
  assert.equal(result.count, null);
  assert.equal(result.estRevenue, null);
  assert.equal(result.actionLabel, 'Plan Promotion');
});

check('real invocation: no prior-year same-month data at all -- honest "not enough history" result, no fabricated trend', async () => {
  const sandbox = makeSandbox([
    { test: 'jobs?select=title,total,completed_at', rows: [
      { title: 'Water heater replacement', total: 5000, completed_at: '2026-06-10T00:00:00Z' },
    ] },
  ]);
  const result = await sandbox.computeSeasonalPromotion();
  assert.equal(result.actionable, false);
  assert.equal(result.description, 'Not enough same-month history yet to identify a real seasonal trend.');
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
