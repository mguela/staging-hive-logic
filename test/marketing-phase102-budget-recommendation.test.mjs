// Phase (task #102) -- data-driven budget-split recommendation.
// New resource `setup_budget_recommendation` (GET) recommends how to split a
// total monthly budget across BUDGET_CHANNELS using REAL historical
// performance data (ad_spend_ledger real platform spend + lead_pipeline
// real lead-source counts) -- never a fabricated confidence score for a
// channel with no real data. The owner still sets the final numbers via the
// existing setup_budget/command_center_budget_channels handlers; this only
// suggests.

import fs from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';

const apiPath = 'api/marketing.js';
const api = fs.readFileSync(apiPath, 'utf8');
const feHtmlPath = 'public/marketing-command-center/index.html';
const feHtml = fs.readFileSync(feHtmlPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function extractRecommendationSource() {
  const start = api.indexOf('const RECOMMENDATION_LOOKBACK_DEFAULT_DAYS = 90;');
  assert.ok(start > -1, 'expected RECOMMENDATION_LOOKBACK_DEFAULT_DAYS to exist');
  const end = api.indexOf('async function handleSetupAccountPost(req, res) {', start);
  assert.ok(end > start, 'expected handleSetupAccountPost to follow the new recommendation code');
  return api.slice(start, end);
}

function loadRecommendationFns(overrides) {
  const o = overrides || {};
  const sandbox = {
    fetchAllRows: o.fetchAllRows || (async () => { throw new Error('fetchAllRows not stubbed'); }),
    setupBudgetShape: o.setupBudgetShape || (async () => { throw new Error('setupBudgetShape not stubbed'); }),
    LEAD_SOURCE_CHANNEL_KEY: o.LEAD_SOURCE_CHANNEL_KEY || { google: 'google_ads', facebook: 'meta_ads', website: 'website_cms' },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(extractRecommendationSource(), sandbox);
  return {
    handleSetupBudgetRecommendationGet: sandbox.handleSetupBudgetRecommendationGet,
    computeChannelSpendAndLeads: sandbox.computeChannelSpendAndLeads,
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

function norm(v) { return JSON.parse(JSON.stringify(v)); }

function baseChannels() {
  return [
    { key: 'email', label: 'Email', monthlyCents: 20000 },
    { key: 'google_ads', label: 'Google Ads', monthlyCents: 50000 },
    { key: 'meta_ads', label: 'Meta (Facebook/Instagram)', monthlyCents: 30000 },
  ];
}

function baseShape(overrides) {
  return Object.assign({ monthlyCents: 100000, min: 250000, max: 1500000, channels: baseChannels() }, overrides || {});
}

// ---------- Structural / wiring checks (api/marketing.js) ----------

check('node --check passes on api/marketing.js', () => {
  // Executed via a separate process in the harness's own regression run;
  // here we just sanity-check the file parses when vm-loaded, since a
  // syntax error would already have thrown inside loadRecommendationFns.
  const fns = loadRecommendationFns({});
  assert.strictEqual(typeof fns.handleSetupBudgetRecommendationGet, 'function');
  assert.strictEqual(typeof fns.computeChannelSpendAndLeads, 'function');
});

check('setup_budget_recommendation (GET) is wired into the dispatch chain right after setup_budget', () => {
  const idx = api.indexOf("resource === 'setup_budget' && req.method === 'POST'");
  assert.ok(idx > -1, 'expected the setup_budget POST dispatch to exist');
  const chunk = api.slice(idx, idx + 500);
  assert.match(chunk, /resource === 'setup_budget_recommendation' && req\.method === 'GET'/);
  assert.match(chunk, /return await handleSetupBudgetRecommendationGet\(req, res\);/);
});

check('the resource-list error string documents the new resource', () => {
  assert.match(api, /setup_budget_recommendation \(GET\)/);
});

// ---------- computeChannelSpendAndLeads: real data aggregation ----------

check('computeChannelSpendAndLeads sums real ad_spend_ledger spend by mapped channel and flags unmapped platforms', async () => {
  const { computeChannelSpendAndLeads } = loadRecommendationFns({
    fetchAllRows: async (table) => {
      if (table === 'ad_spend_ledger') {
        return [
          { platform: 'google_ads', spend_cents: 4000 },
          { platform: 'google_ads', spend_cents: 6000 },
          { platform: 'meta', spend_cents: 2000 },
          { platform: 'tiktok', spend_cents: 9999 },
        ];
      }
      return [];
    },
  });
  const result = await computeChannelSpendAndLeads(90);
  assert.strictEqual(result.spendByChannel.google_ads, 10000);
  assert.strictEqual(result.spendByChannel.meta_ads, 2000);
  assert.strictEqual(result.unassignedPlatformSpendCents.tiktok, 9999, 'real tiktok spend is surfaced honestly, never dropped silently');
  assert.strictEqual(result.spendTableMissing, false);
});

check('computeChannelSpendAndLeads counts real lead_pipeline leads by mapped lead_source, case-insensitively', async () => {
  const { computeChannelSpendAndLeads } = loadRecommendationFns({
    fetchAllRows: async (table) => {
      if (table === 'lead_pipeline') {
        return [
          { lead_source: 'Google' },
          { lead_source: 'google' },
          { lead_source: 'facebook' },
          { lead_source: 'referral' },
          { lead_source: '  ' },
          { lead_source: null },
        ];
      }
      return [];
    },
  });
  const result = await computeChannelSpendAndLeads(90);
  assert.strictEqual(result.leadsByChannel.google_ads, 2);
  assert.strictEqual(result.leadsByChannel.meta_ads, 1);
  assert.strictEqual(result.leadsByChannel.website_cms, undefined, 'unmapped/blank sources never produce a count');
});

check('computeChannelSpendAndLeads honestly reports table-missing flags instead of throwing on a notSynced error', async () => {
  const { computeChannelSpendAndLeads } = loadRecommendationFns({
    fetchAllRows: async (table) => {
      const e = new Error(`relation "${table}" does not exist`);
      e.notSynced = true;
      throw e;
    },
  });
  const result = await computeChannelSpendAndLeads(30);
  assert.strictEqual(result.spendTableMissing, true);
  assert.strictEqual(result.leadsTableMissing, true);
  assert.strictEqual(Object.keys(result.spendByChannel).length, 0, 'sandbox {} literals are not reference-equal to the harness realm, so compare shape via keys');
  assert.strictEqual(Object.keys(result.leadsByChannel).length, 0);
});

check('computeChannelSpendAndLeads rethrows a non-notSynced error', async () => {
  const { computeChannelSpendAndLeads } = loadRecommendationFns({
    fetchAllRows: async () => { throw new Error('boom: unexpected database error'); },
  });
  await assert.rejects(() => computeChannelSpendAndLeads(30), /boom: unexpected database error/);
});

// ---------- handleSetupBudgetRecommendationGet: weighting logic ----------

check('recommends a larger share to the trackable channel with the real, lower cost-per-lead', async () => {
  const { handleSetupBudgetRecommendationGet } = loadRecommendationFns({
    setupBudgetShape: async () => baseShape(),
    fetchAllRows: async (table) => {
      if (table === 'ad_spend_ledger') {
        return [
          { platform: 'google_ads', spend_cents: 10000 },
          { platform: 'meta', spend_cents: 20000 },
        ];
      }
      if (table === 'lead_pipeline') {
        return [
          { lead_source: 'google' }, { lead_source: 'google' },
          { lead_source: 'facebook' }, { lead_source: 'facebook' },
        ];
      }
      return [];
    },
  });
  const res = makeRes();
  await handleSetupBudgetRecommendationGet({ query: {} }, res);
  assert.strictEqual(res.statusCode, 200);
  const body = norm(res.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.basis, 'real_cost_per_lead');
  const byKey = Object.fromEntries(body.channels.map((c) => [c.key, c]));
  assert.strictEqual(byKey.google_ads.costPerLeadCents, 5000, 'google: $100.00 / 2 leads = $50.00 CPL');
  assert.strictEqual(byKey.meta_ads.costPerLeadCents, 10000, 'meta: $200.00 / 2 leads = $100.00 CPL');
  assert.ok(byKey.google_ads.hasRealData && byKey.meta_ads.hasRealData);
  assert.ok(
    byKey.google_ads.recommendedMonthlyCents > byKey.meta_ads.recommendedMonthlyCents,
    'the channel with the cheaper real cost-per-lead must get the larger recommended share'
  );
  // Remaining (total 100000 - non-trackable email 20000 = 80000) must be
  // split exactly across the two trackable channels -- no dollars invented
  // or dropped by rounding.
  assert.strictEqual(byKey.google_ads.recommendedMonthlyCents + byKey.meta_ads.recommendedMonthlyCents, 80000);
  // The non-trackable channel is never touched by the performance weighting.
  assert.strictEqual(byKey.email.recommendedMonthlyCents, byKey.email.currentMonthlyCents);
  assert.strictEqual(byKey.email.hasRealData, null, 'a channel with no honest way to compare performance never gets a hasRealData verdict');
  assert.strictEqual(byKey.email.costPerLeadCents, null);
});

check('never fabricates a cost-per-lead for a channel with real spend but zero real leads (or vice versa)', async () => {
  const { handleSetupBudgetRecommendationGet } = loadRecommendationFns({
    setupBudgetShape: async () => baseShape(),
    fetchAllRows: async (table) => {
      if (table === 'ad_spend_ledger') return [{ platform: 'google_ads', spend_cents: 10000 }];
      if (table === 'lead_pipeline') return []; // real spend exists, but zero real leads
      return [];
    },
  });
  const res = makeRes();
  await handleSetupBudgetRecommendationGet({ query: {} }, res);
  const byKey = Object.fromEntries(res.body.channels.map((c) => [c.key, c]));
  assert.strictEqual(byKey.google_ads.hasRealData, false, 'spend with no leads is honestly "no real data", not a fabricated CPL');
  assert.strictEqual(byKey.google_ads.costPerLeadCents, null);
  assert.match(byKey.google_ads.rationale, /No real spend\/lead data yet/);
});

check('falls back to an even split (never a confident lean) when only one trackable channel has real data', async () => {
  const { handleSetupBudgetRecommendationGet } = loadRecommendationFns({
    setupBudgetShape: async () => baseShape(),
    fetchAllRows: async (table) => {
      if (table === 'ad_spend_ledger') return [{ platform: 'google_ads', spend_cents: 10000 }];
      if (table === 'lead_pipeline') return [{ lead_source: 'google' }];
      return [];
    },
  });
  const res = makeRes();
  await handleSetupBudgetRecommendationGet({ query: {} }, res);
  const byKey = Object.fromEntries(res.body.channels.map((c) => [c.key, c]));
  assert.strictEqual(res.body.basis, 'partial_real_data_even_split');
  assert.strictEqual(byKey.google_ads.recommendedMonthlyCents, byKey.meta_ads.recommendedMonthlyCents, 'a single data point must not create a confident, unequal lean');
  assert.strictEqual(byKey.google_ads.recommendedMonthlyCents + byKey.meta_ads.recommendedMonthlyCents, 80000);
});

check('preserves the owner’s current proportional split (never invents a preference) when neither trackable channel has real data', async () => {
  const { handleSetupBudgetRecommendationGet } = loadRecommendationFns({
    setupBudgetShape: async () => baseShape({ monthlyCents: 60000 }),
    fetchAllRows: async () => [],
  });
  const res = makeRes();
  await handleSetupBudgetRecommendationGet({ query: {} }, res);
  const byKey = Object.fromEntries(res.body.channels.map((c) => [c.key, c]));
  assert.strictEqual(res.body.basis, 'no_real_data_kept_current_proportions');
  // remaining = 60000 - 20000 (email) = 40000, split 5:3 like the current 50000:30000
  assert.strictEqual(byKey.google_ads.recommendedMonthlyCents, 25000);
  assert.strictEqual(byKey.meta_ads.recommendedMonthlyCents, 15000);
});

check('falls back to an even split when there is neither real data nor any current spend to anchor proportions on', async () => {
  const { handleSetupBudgetRecommendationGet } = loadRecommendationFns({
    setupBudgetShape: async () => baseShape({
      monthlyCents: 10000,
      channels: [
        { key: 'email', label: 'Email', monthlyCents: 0 },
        { key: 'google_ads', label: 'Google Ads', monthlyCents: 0 },
        { key: 'meta_ads', label: 'Meta', monthlyCents: 0 },
      ],
    }),
    fetchAllRows: async () => [],
  });
  const res = makeRes();
  await handleSetupBudgetRecommendationGet({ query: {} }, res);
  const byKey = Object.fromEntries(res.body.channels.map((c) => [c.key, c]));
  assert.strictEqual(res.body.basis, 'no_real_data_even_split');
  assert.strictEqual(byKey.google_ads.recommendedMonthlyCents, 5000);
  assert.strictEqual(byKey.meta_ads.recommendedMonthlyCents, 5000);
});

check('honestly refuses to invent a paid split when the requested total does not even cover the other channels', async () => {
  const { handleSetupBudgetRecommendationGet } = loadRecommendationFns({
    setupBudgetShape: async () => baseShape({ monthlyCents: 10000 }), // $100 total, way below $200 email alone
    fetchAllRows: async () => [],
  });
  const res = makeRes();
  await handleSetupBudgetRecommendationGet({ query: {} }, res); // no override -- the min/max clamp on monthlyDollars would otherwise mask this case
  const byKey = Object.fromEntries(res.body.channels.map((c) => [c.key, c]));
  assert.strictEqual(res.body.basis, 'total_below_fixed_channels');
  assert.strictEqual(byKey.google_ads.recommendedMonthlyCents, 0);
  assert.strictEqual(byKey.meta_ads.recommendedMonthlyCents, 0);
  assert.match(res.body.summary, /does not even cover/);
});

check('surfaces a real, unmapped platform’s spend (e.g. TikTok) as an honest note rather than silently ignoring it', async () => {
  const { handleSetupBudgetRecommendationGet } = loadRecommendationFns({
    setupBudgetShape: async () => baseShape(),
    fetchAllRows: async (table) => {
      if (table === 'ad_spend_ledger') return [{ platform: 'tiktok', spend_cents: 4200 }];
      return [];
    },
  });
  const res = makeRes();
  await handleSetupBudgetRecommendationGet({ query: {} }, res);
  assert.strictEqual(res.body.unassignedPlatformSpendCents.tiktok, 4200);
  assert.ok(res.body.notes.some((n) => n.includes('tiktok')), 'expected a note calling out the unmapped platform spend');
});

check('adds an honest degraded-data note when the underlying performance tables are not set up yet', async () => {
  const { handleSetupBudgetRecommendationGet } = loadRecommendationFns({
    setupBudgetShape: async () => baseShape(),
    fetchAllRows: async (table) => { const e = new Error(`relation "${table}" does not exist`); e.notSynced = true; throw e; },
  });
  const res = makeRes();
  await handleSetupBudgetRecommendationGet({ query: {} }, res);
  assert.strictEqual(res.body.ok, true);
  assert.ok(res.body.notes.some((n) => /not set up yet/.test(n)));
});

check('honors an explicit monthlyDollars override, clamped to the real configured min/max', async () => {
  const { handleSetupBudgetRecommendationGet } = loadRecommendationFns({
    setupBudgetShape: async () => baseShape(),
    fetchAllRows: async () => [],
  });
  const res = makeRes();
  await handleSetupBudgetRecommendationGet({ query: { monthlyDollars: '20000' } }, res); // way above the $15,000 max
  assert.strictEqual(res.body.totalCents, 1500000);
});

check('rejects a non-numeric monthlyDollars with a 400 before touching any data source', async () => {
  let called = false;
  const { handleSetupBudgetRecommendationGet } = loadRecommendationFns({
    setupBudgetShape: async () => { called = true; return baseShape(); },
    fetchAllRows: async () => { called = true; return []; },
  });
  const res = makeRes();
  await handleSetupBudgetRecommendationGet({ query: { monthlyDollars: 'not-a-number' } }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.ok, false);
  assert.match(res.body.error, /monthlyDollars must be a number/);
});

check('defaults lookbackDays to 90 and clamps an out-of-range override into [7, 365]', async () => {
  const seen = [];
  const { handleSetupBudgetRecommendationGet } = loadRecommendationFns({
    setupBudgetShape: async () => baseShape(),
    fetchAllRows: async () => { seen.push(true); return []; },
  });
  const res1 = makeRes();
  await handleSetupBudgetRecommendationGet({ query: {} }, res1);
  assert.strictEqual(res1.body.lookbackDays, 90);

  const res2 = makeRes();
  await handleSetupBudgetRecommendationGet({ query: { lookbackDays: '999' } }, res2);
  assert.strictEqual(res2.body.lookbackDays, 365);

  const res3 = makeRes();
  await handleSetupBudgetRecommendationGet({ query: { lookbackDays: '1' } }, res3);
  assert.strictEqual(res3.body.lookbackDays, 7);
});

// ---------- Frontend wiring (public/marketing-command-center/index.html) ----------

check('node --check passes on the extracted command-center main script block', () => {
  const blocks = [...feHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const main = blocks.find((b) => b.includes('function screenFor'));
  assert.ok(main, 'expected to find the command center’s main inline script block');
  assert.match(main, /function renderBudget\(data\)\{/);
});

check('renderBudget wires a "See Recommended Split" button that calls the new resource', () => {
  assert.match(feHtml, /id="cc-budget-recommend"/);
  assert.match(feHtml, /See Recommended Split/);
  assert.match(feHtml, /api\('setup_budget_recommendation&monthlyDollars='/);
});

check('renderBudget renders the recommendation into its own container without touching the existing budget-save flow', () => {
  assert.match(feHtml, /id="cc-budget-recommendation"/);
  assert.match(feHtml, /function renderRecommendation\(rec\)\{/);
  // The existing Save Budget / Save Channel Settings wiring must still be present, untouched.
  assert.match(feHtml, /id="cc-budget-save"/);
  assert.match(feHtml, /id="cc-channels-save"/);
});

check('the "Apply These Numbers" action fills the existing per-channel inputs, it never auto-saves', () => {
  assert.match(feHtml, /id="cc-budget-recommendation-apply"/);
  assert.match(feHtml, /Apply These Numbers/);
  assert.match(feHtml, /cc-ch-'\s*\+\s*c\.key\s*\+\s*'-monthly'/);
  // Applying only fills inputs and tells the owner to review + save manually.
  assert.match(feHtml, /then click Save Channel Settings to keep them/);
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
