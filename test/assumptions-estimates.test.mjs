// Planning Assumptions -- real open-estimates reference data slice.
// Surfaces computeUnsoldEstimates() (already real, already used by the
// Opportunities engine) into handleAssumptionsGet()'s reference block and
// the Planning Assumptions "Real reference data" card, so the owner sees
// real open/stale estimate counts and dollar values there too. Values are
// plain dollars (matching quotes.total / computeUnsoldEstimates' own
// convention), never fabricated, and honestly report zero/none states.

import fs from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const marketingPath = 'api/marketing.js';
const htmlPath = 'public/marketing-command-center/index.html';
const marketing = fs.readFileSync(marketingPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('marketing.js syntax is valid', () => {
  execFileSync(process.execPath, ['--check', marketingPath]);
});

check('handleAssumptionsGet calls computeUnsoldEstimates() alongside the existing real reference calls', () => {
  const start = marketing.indexOf('async function handleAssumptionsGet');
  const end = marketing.indexOf('\nasync function', start + 10);
  const fn = marketing.slice(start, end);
  assert.match(fn, /const \[row, realAvgJobValue, realHistJobsPerMonth, realDivisionMonthFacts, realUnsoldEstimates, realPastCustomers, realExistingLeads, realPriorCampaignResults, realCompanyCamAvailability, realServiceTerritory, realChannelAvailability\] = await Promise\.all\(\[/);
  assert.match(fn, /realUnsoldEstimatesForPlan\(\),/);
  assert.match(fn, /realOpenEstimatesCount: realUnsoldEstimates\.count,/);
  assert.match(fn, /realOpenEstimatesValue: realUnsoldEstimates\.estRevenue,/);
  assert.match(fn, /realOpenEstimatesStaleCount: realUnsoldEstimates\.staleCount,/);
  assert.match(fn, /realOpenEstimatesStaleValue: realUnsoldEstimates\.staleValue,/);
  assert.match(fn, /realOpenEstimatesSource: realUnsoldEstimates\.count \?/);
});

function loadRealHandler(fixtures) {
  const start = marketing.indexOf('async function handleAssumptionsGet');
  const end = marketing.indexOf('\nasync function', start + 10);
  const fnSrc = marketing.slice(start, end);
  const sandbox = {
    ccAssumptionsRow: async () => fixtures.row !== undefined ? fixtures.row : null,
    realAvgJobValueCents: async () => fixtures.realAvgJobValue !== undefined ? fixtures.realAvgJobValue : null,
    realHistoricalJobsPerMonth: async () => fixtures.realHistJobsPerMonth !== undefined ? fixtures.realHistJobsPerMonth : null,
    realJobFactsByDivisionAndMonth: async () => fixtures.divisionMonthFacts || { realJobFactsByDivision: [], realSeasonalDistribution: [] },
    realUnsoldEstimatesForPlan: async () => fixtures.unsoldEstimates || { count: 0, estRevenue: 0, staleCount: 0, staleValue: 0 },
    realPastCustomersForPlan: async () => fixtures.pastCustomers || { count: 0, estRevenue: 0 },
    realExistingLeadsForPlan: async () => fixtures.existingLeads || { count: 0, estRevenue: 0 },
    realPriorCampaignResultsForPlan: async () => fixtures.priorCampaignResults || { attributedJobs: 0, unattributedJobs: 0, attributedRevenueCents: 0, coveragePct: null },
    realCompanyCamAvailabilityForPlan: async () => fixtures.companyCamAvailability || { totalCount: 0, photoCount: 0, videoCount: 0, recentCount: 0, daysSinceLastCapture: null },
    realServiceTerritoryForPlan: async () => fixtures.serviceTerritory || { geocodedCustomerCount: 0, avgDistanceMiles: null, maxDistanceMiles: null, officeSet: false },
    realChannelAvailabilityForPlan: async () => fixtures.channelAvailability || { readyCount: 0, totalCount: 0, notReady: [] },
    computePlanRationale: () => [],
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc, sandbox);
  return sandbox.handleAssumptionsGet;
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

check('returns real, non-fabricated open-estimate reference fields when estimates exist', async () => {
  const handler = loadRealHandler({
    unsoldEstimates: { count: 7, estRevenue: 84250, staleCount: 3, staleValue: 31000 },
  });
  const res = fakeRes();
  await handler({}, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.reference.realOpenEstimatesCount, 7);
  assert.strictEqual(res.body.reference.realOpenEstimatesValue, 84250);
  assert.strictEqual(res.body.reference.realOpenEstimatesStaleCount, 3);
  assert.strictEqual(res.body.reference.realOpenEstimatesStaleValue, 31000);
  assert.match(res.body.reference.realOpenEstimatesSource, /Real open \(awaiting-response\) quotes synced from Jobber/);
  assert.match(res.body.reference.realOpenEstimatesSource, /not cents/);
});

check('honestly reports zero/none rather than fabricating when there are no open estimates', async () => {
  const handler = loadRealHandler({
    unsoldEstimates: { count: 0, estRevenue: 0, staleCount: 0, staleValue: 0 },
  });
  const res = fakeRes();
  await handler({}, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.reference.realOpenEstimatesCount, 0);
  assert.strictEqual(res.body.reference.realOpenEstimatesValue, 0);
  assert.strictEqual(res.body.reference.realOpenEstimatesSource, 'No open estimates awaiting a client response yet.');
});

check('existing realAvgJobValue / realHistoricalJobsPerMonth reference fields are untouched (additive change only)', async () => {
  const handler = loadRealHandler({
    realAvgJobValue: 250000,
    realHistJobsPerMonth: 12,
    unsoldEstimates: { count: 1, estRevenue: 5000, staleCount: 0, staleValue: 0 },
  });
  const res = fakeRes();
  await handler({}, res);
  assert.strictEqual(res.body.reference.realAvgJobValueCents, 250000);
  assert.strictEqual(res.body.reference.realHistoricalJobsPerMonth, 12);
  assert.match(res.body.reference.realAvgJobValueSource, /real completed\/quoted jobs synced from Jobber/);
});

check('assumptions row shape (existing behavior) is unchanged', async () => {
  const handler = loadRealHandler({
    row: { gross_margin_pct: '40', qualified_lead_rate_per_100: '5', close_rate_pct: '20', max_new_jobs_per_month: '10', risk_posture: 'aggressive', avg_job_value_cents: 300000, updated_at: '2026-08-01', updated_by: 'chris' },
    unsoldEstimates: { count: 0, estRevenue: 0, staleCount: 0, staleValue: 0 },
  });
  const res = fakeRes();
  await handler({}, res);
  assert.strictEqual(res.body.assumptions.grossMarginPct, 40);
  assert.strictEqual(res.body.assumptions.riskPosture, 'aggressive');
});

// ---------------------------------------------------------------------
// Frontend wiring -- Planning Assumptions "Real reference data" card
// ---------------------------------------------------------------------

function extractMainScript() {
  // The page has more than one bare `<script>` tag -- the first is a tiny
  // embedded-mode check near the top of the body. The real application
  // code (including renderAssumptions) lives in the next one. Skip past
  // the first so we grab the actual script block.
  const first = html.indexOf('<script>');
  assert.ok(first > -1);
  const start = html.indexOf('<script>', first + 1) + '<script>'.length;
  const end = html.indexOf('</script>', start);
  assert.ok(start > -1 && end > start);
  return html.slice(start, end);
}

check('the main inline script is still syntactically valid JavaScript after the reference-card edit', () => {
  new vm.Script(extractMainScript(), { filename: htmlPath });
});

check('renderAssumptions reads the three new real-open-estimates reference fields', () => {
  const src = extractMainScript();
  const start = src.indexOf('function renderAssumptions');
  const end = src.indexOf('\n  // ----------', start + 10);
  const fn = src.slice(start, end > -1 ? end : undefined);
  assert.match(fn, /var refEstCount = ref\.realOpenEstimatesCount;/);
  assert.match(fn, /var refEstValue = ref\.realOpenEstimatesValue;/);
  assert.match(fn, /var refEstStale = ref\.realOpenEstimatesStaleCount;/);
});

check('the Real reference data card renders open-estimate count, dollar value, and stale count honestly', () => {
  const src = extractMainScript();
  const start = src.indexOf('function renderAssumptions');
  const end = src.indexOf('\n  // ----------', start + 10);
  const fn = src.slice(start, end > -1 ? end : undefined);
  assert.match(fn, /refEstCount \? refEstCount \+ ' open estimate' \+ \(refEstCount === 1 \? '' : 's'\)/);
  assert.match(fn, /money\(refEstValue\)/);
  assert.match(fn, /refEstStale \? ', ' \+ refEstStale \+ ' stale 30\+ days' : ''/);
  assert.match(fn, /'No open estimates awaiting response'/, 'must honestly render a no-data state, never a fabricated one');
});

check('no scratch/temp files leaked into the tracked source files', () => {
  assert.doesNotMatch(marketing, /scratch_/);
  assert.doesNotMatch(html, /scratch_/);
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
