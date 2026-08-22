// Phase 6 -- the real Plan-selection "why" logic. This is deterministic,
// rule-based reasoning over the exact reference facts handleAssumptionsGet
// already assembles (Phase 6's real avg job value, seasonal/division facts,
// unsold estimates, past customers, existing leads, prior campaign results,
// CompanyCam availability, service territory, channel availability) --
// deliberately NOT an AI-generated narrative like handleDraftPostPost's
// caption drafting, since a financial/operational recommendation must be
// exactly reproducible and carry zero hallucination risk. Every check here
// verifies a rule traces back to a real field and degrades honestly (returns
// nothing) when its triggering condition isn't met.

import fs from 'node:fs';
import assert from 'node:assert';

const apiPath = 'api/marketing.js';
const api = fs.readFileSync(apiPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function boundFn(text, startMarker, endMarker) {
  const startIdx = text.indexOf(startMarker);
  assert.ok(startIdx > -1, `start marker not found: ${startMarker}`);
  const endIdx = text.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, `end marker not found after start: ${endMarker}`);
  return text.slice(startIdx, endIdx);
}

// ---- structural: the real bug this slice also found and fixed ----
check('handleAssumptionsGet is declared exactly once -- a real duplicate nested declaration bug (found while building this slice) meant the handler never called res.json at all; this asserts it cannot regress', () => {
  const matches = api.match(/async function handleAssumptionsGet\(req, res\) \{/g) || [];
  assert.strictEqual(matches.length, 1, `expected exactly one handleAssumptionsGet declaration, found ${matches.length}`);
});

check('handleAssumptionsGet actually calls res.status(200).json(...) in its own body -- not just defining a function and returning nothing', () => {
  const fn = boundFn(api, 'async function handleAssumptionsGet(req, res) {', 'async function handleAssumptionsPost');
  assert.match(fn, /res\.status\(200\)\.json\(\{/);
  assert.match(fn, /rationale: computePlanRationale\(reference\)/);
});

// ---- load the real functions into a sandbox and exercise them directly ----
async function loadRationaleFns() {
  const rulesSrc = boundFn(api, 'function planRationaleChannelGate(reference) {', '\nasync function ccAssumptionsRow() {');
  const moneySrc = boundFn(api, 'function money(n) {', '\n// ----- Review Requests');
  const wrapped = `
    ${moneySrc}
    ${rulesSrc}
    return { planRationaleChannelGate, planRationaleReactivation, planRationaleExistingLeads, planRationaleUnsoldEstimates, planRationaleDivision, planRationaleContentFreshness, planRationaleSeasonal, planRationaleServiceTerritory, planRationaleAttributionCoverage, computePlanRationale };
  `;
  const fn = new Function(wrapped);
  return fn();
}

let mod;
try {
  mod = await loadRationaleFns();
} catch (e) {
  mod = null;
  check('rationale module loads without a syntax error', () => { throw e; });
}

if (mod) {
  const baseline = {
    realChannelAvailabilityReadyCount: 2,
    realChannelAvailabilityTotalCount: 4,
    realPastCustomersCount: 0,
    realPastCustomersEstRevenue: 0,
    realExistingLeadsCount: 0,
    realExistingLeadsEstRevenue: 0,
    realUnsoldEstimates: { count: 0, estRevenue: 0, staleCount: 0, staleValue: 0 },
    realJobFactsByDivision: [],
    realCompanyCamTotalAssets: 0,
    realCompanyCamDaysSinceLastCapture: null,
    realSeasonalDistribution: [],
    realServiceTerritoryCustomerCount: 0,
    realServiceTerritoryAvgDistanceMiles: null,
    realServiceTerritoryMaxDistanceMiles: null,
    realPriorCampaignCoveragePct: null,
    realPriorCampaignAttributedJobs: 0,
    realPriorCampaignUnattributedJobs: 0,
  };

  check('channel gate: 0 of N ready is a real blocker citing the real counts, never fabricated', () => {
    const r = mod.planRationaleChannelGate({ ...baseline, realChannelAvailabilityReadyCount: 0, realChannelAvailabilityTotalCount: 4 });
    assert.strictEqual(r.priority, 'blocker');
    assert.match(r.text, /0 of 4/);
  });

  check('channel gate: N of M ready is honest info, not a blocker, when at least one channel is ready', () => {
    const r = mod.planRationaleChannelGate({ ...baseline, realChannelAvailabilityReadyCount: 2, realChannelAvailabilityTotalCount: 4 });
    assert.strictEqual(r.priority, 'info');
    assert.match(r.text, /2 of 4/);
  });

  check('channel gate returns null (no fabricated claim) when there is no channel data at all', () => {
    assert.strictEqual(mod.planRationaleChannelGate({ ...baseline, realChannelAvailabilityTotalCount: 0 }), null);
  });

  check('reactivation rule cites the real count and real estRevenue via money(), and is silent when count is zero', () => {
    assert.strictEqual(mod.planRationaleReactivation({ ...baseline, realPastCustomersCount: 0 }), null);
    const r = mod.planRationaleReactivation({ ...baseline, realPastCustomersCount: 3, realPastCustomersEstRevenue: 15000 });
    assert.strictEqual(r.priority, 'opportunity');
    assert.match(r.text, /3 past customers/);
    assert.match(r.text, /\$15,000/);
  });

  check('existing-leads rule cites the real count/estRevenue and is silent at zero', () => {
    assert.strictEqual(mod.planRationaleExistingLeads({ ...baseline, realExistingLeadsCount: 0 }), null);
    const r = mod.planRationaleExistingLeads({ ...baseline, realExistingLeadsCount: 1, realExistingLeadsEstRevenue: 500 });
    assert.match(r.text, /1 lead /);
    assert.match(r.text, /\$500/);
  });

  check('unsold-estimates rule cites count, money(estRevenue), and only mentions staleCount when it is real and nonzero', () => {
    assert.strictEqual(mod.planRationaleUnsoldEstimates({ ...baseline, realUnsoldEstimates: { count: 0, estRevenue: 0, staleCount: 0, staleValue: 0 } }), null);
    const r = mod.planRationaleUnsoldEstimates({ ...baseline, realUnsoldEstimates: { count: 2, estRevenue: 8000, staleCount: 1, staleValue: 3000 } });
    assert.match(r.text, /2 open estimates/);
    assert.match(r.text, /\$8,000/);
    assert.match(r.text, /1 of them over 30 days old/);
    const r2 = mod.planRationaleUnsoldEstimates({ ...baseline, realUnsoldEstimates: { count: 1, estRevenue: 500, staleCount: 0, staleValue: 0 } });
    assert.ok(!r2.text.includes('over 30 days old'), 'must not fabricate a stale claim when staleCount is really 0');
  });

  check('division rule picks the real highest-avgJobValueCents division, ignoring divisions with null avgJobValueCents (no priced jobs)', () => {
    const divisions = [
      { division: 'HVAC', completedJobCount: 5, avgJobValueCents: 500000 },
      { division: 'Electric', completedJobCount: 3, avgJobValueCents: 900000 },
      { division: 'Handyman', completedJobCount: 2, avgJobValueCents: null },
    ];
    const r = mod.planRationaleDivision({ ...baseline, realJobFactsByDivision: divisions });
    assert.match(r.text, /Electric/);
    assert.match(r.text, /\$9,000/);
    assert.match(r.text, /3 completed jobs/);
  });

  check('division rule returns null when every division has a null avgJobValueCents (no priced jobs anywhere yet)', () => {
    const divisions = [{ division: 'HVAC', completedJobCount: 1, avgJobValueCents: null }];
    assert.strictEqual(mod.planRationaleDivision({ ...baseline, realJobFactsByDivision: divisions }), null);
  });

  check('content-freshness rule flags zero assets as an opportunity, flags stale (>14 days) as info, and is silent when fresh', () => {
    const none = mod.planRationaleContentFreshness({ ...baseline, realCompanyCamTotalAssets: 0 });
    assert.strictEqual(none.priority, 'opportunity');
    const stale = mod.planRationaleContentFreshness({ ...baseline, realCompanyCamTotalAssets: 10, realCompanyCamDaysSinceLastCapture: 30 });
    assert.strictEqual(stale.priority, 'info');
    assert.match(stale.text, /30 days ago/);
    const fresh = mod.planRationaleContentFreshness({ ...baseline, realCompanyCamTotalAssets: 10, realCompanyCamDaysSinceLastCapture: 2 });
    assert.strictEqual(fresh, null);
  });

  check('seasonal rule cites the real highest-completedJobCount month and is silent when every month is zero', () => {
    const dist = [{ month: 'Jan', completedJobCount: 2 }, { month: 'Jul', completedJobCount: 9 }, { month: 'Dec', completedJobCount: 4 }];
    const r = mod.planRationaleSeasonal({ ...baseline, realSeasonalDistribution: dist });
    assert.match(r.text, /Jul/);
    assert.match(r.text, /9 jobs/);
    const allZero = [{ month: 'Jan', completedJobCount: 0 }];
    assert.strictEqual(mod.planRationaleSeasonal({ ...baseline, realSeasonalDistribution: allZero }), null);
  });

  check('service-territory rule cites the real customer count and real avg/max distance, silent at zero customers', () => {
    assert.strictEqual(mod.planRationaleServiceTerritory({ ...baseline, realServiceTerritoryCustomerCount: 0 }), null);
    const r = mod.planRationaleServiceTerritory({ ...baseline, realServiceTerritoryCustomerCount: 12, realServiceTerritoryAvgDistanceMiles: 8.5, realServiceTerritoryMaxDistanceMiles: 22.1 });
    assert.match(r.text, /12 real geocoded customers/);
    assert.match(r.text, /8\.5 mi/);
    assert.match(r.text, /22\.1 mi/);
  });

  check('attribution-coverage rule only flags a real gap below 50% coverage, and is silent both when coverage is healthy and when there is no data at all', () => {
    assert.strictEqual(mod.planRationaleAttributionCoverage({ ...baseline, realPriorCampaignCoveragePct: null }), null);
    assert.strictEqual(mod.planRationaleAttributionCoverage({ ...baseline, realPriorCampaignCoveragePct: 75, realPriorCampaignAttributedJobs: 3, realPriorCampaignUnattributedJobs: 1 }), null);
    const r = mod.planRationaleAttributionCoverage({ ...baseline, realPriorCampaignCoveragePct: 20, realPriorCampaignAttributedJobs: 1, realPriorCampaignUnattributedJobs: 4 });
    assert.match(r.text, /Only 20%/);
    assert.match(r.text, /1 of 5/);
  });

  check('computePlanRationale orders results blocker > opportunity > info, and is deterministic across repeated calls with identical input', () => {
    const reference = {
      ...baseline,
      realChannelAvailabilityReadyCount: 0,
      realChannelAvailabilityTotalCount: 4,
      realPastCustomersCount: 3,
      realPastCustomersEstRevenue: 1000,
      realCompanyCamTotalAssets: 10,
      realCompanyCamDaysSinceLastCapture: 30,
    };
    const first = mod.computePlanRationale(reference);
    const second = mod.computePlanRationale(reference);
    assert.deepStrictEqual(first, second);
    const priorities = first.map((item) => item.priority);
    const blockerIdx = priorities.indexOf('blocker');
    const infoIdx = priorities.indexOf('info');
    assert.ok(blockerIdx === 0, 'blocker must sort first');
    assert.ok(infoIdx > priorities.indexOf('opportunity'), 'info must sort after opportunity');
  });

  check('computePlanRationale returns an empty array (not a fabricated placeholder) when every rule is silent', () => {
    const emptyReference = {
      realChannelAvailabilityReadyCount: 0,
      realChannelAvailabilityTotalCount: 0,
      realPastCustomersCount: 0,
      realExistingLeadsCount: 0,
      realUnsoldEstimates: { count: 0, estRevenue: 0, staleCount: 0 },
      realJobFactsByDivision: [],
      realCompanyCamTotalAssets: 0,
      realCompanyCamDaysSinceLastCapture: null,
      realSeasonalDistribution: [],
      realServiceTerritoryCustomerCount: 0,
      realPriorCampaignCoveragePct: null,
    };
    // realCompanyCamTotalAssets: 0 actually always fires an opportunity (no content yet),
    // so force it non-firing by pretending assets exist and content is fresh.
    emptyReference.realCompanyCamTotalAssets = 5;
    emptyReference.realCompanyCamDaysSinceLastCapture = 1;
    assert.deepStrictEqual(mod.computePlanRationale(emptyReference), []);
  });
}

let pass = 0, fail = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  not ok  - ${name}\n    ${e.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed (of ${checks.length})`);
process.exit(fail ? 1 : 0);
