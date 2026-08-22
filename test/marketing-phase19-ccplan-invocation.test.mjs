import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Phase 19 (test coverage): the handleAssumptionsPost slice earlier this
// session deliberately stubbed ccPlan() as a documented, separately-tested
// boundary because of its own dependency tree. This file is that dedicated
// test: it extracts and runs the REAL ccPlan, ccConnections, computeForecast,
// ccAssumptionsRow, and realAvgJobValueCents directly from the live
// api/marketing.js, mocking only supabaseRequest (the real database I/O
// boundary) and isEmailConfigured/isEmailSendEnabled (imported from a
// separate module, ./_lib/email.js, whose real behavior depends on Vercel
// env vars this sandbox cannot see -- an intentionally mocked env boundary,
// same principle as mocking supabaseRequest).

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

check('sanity: ccPlan, ccConnections, and computeForecast are each declared exactly once in the real file', () => {
  for (const re of [/async function ccPlan\s*\(/g, /async function ccConnections\s*\(/g, /function computeForecast\s*\(/g]) {
    const matches = raw.match(re) || [];
    assert.equal(matches.length, 1, `expected exactly one match for ${re}, found ${matches.length}`);
  }
});

const pageSizeSrc = extractConstLine(raw, 'const PAGE_SIZE');
const maxPagesSrc = extractConstLine(raw, 'const MAX_PAGES');
const fetchAllRowsSrc = extractFunction(raw, 'async function fetchAllRows(');
const ccAssumptionsRowSrc = extractFunction(raw, 'async function ccAssumptionsRow(');
const realAvgJobValueCentsSrc = extractFunction(raw, 'async function realAvgJobValueCents(');
const forecastBandsSrc = extractConstObject(raw, 'const FORECAST_BANDS =');
const computeForecastSrc = extractFunction(raw, 'function computeForecast(');
const ccPlatformsSrc = extractConstArray(raw, 'const CC_PLATFORMS =');
const ccReadyStatesSrc = extractConstLine(raw, 'const CC_READY_STATES =');
const ccConnectionsSrc = extractFunction(raw, 'async function ccConnections(');
const ccPlanSrc = extractFunction(raw, 'async function ccPlan(');

check('sanity: the extracted ccPlan body really calls the real computeForecast + ccConnections wiring, not a stale copy', () => {
  assert.match(ccPlanSrc, /const connections = await ccConnections\(\);/);
  assert.match(ccPlanSrc, /const forecast = computeForecast\(\{ assumptions: assumptionsRow, budgetCents, readyPaidChannelKeys, realAvgJobValueCentsVal: realAvgJobValue \}\);/);
});

const blockSrc = [
  pageSizeSrc, maxPagesSrc, fetchAllRowsSrc, ccAssumptionsRowSrc, realAvgJobValueCentsSrc,
  forecastBandsSrc, computeForecastSrc, ccPlatformsSrc, ccReadyStatesSrc, ccConnectionsSrc, ccPlanSrc,
].join('\n\n');

function makeMockSupabase(routes) {
  return async function supabaseRequest(url) {
    for (const route of routes) {
      const matches = typeof route.test === 'string' ? url.includes(route.test) : route.test.test(url);
      if (matches) {
        if (route.notSynced) return { ok: false, text: async () => 'relation "public.x" does not exist' };
        return { ok: true, json: async () => route.rows };
      }
    }
    throw new Error('unmatched supabaseRequest url: ' + url);
  };
}

// Every ccPlan call touches 4 tables regardless of scenario; this helper
// supplies "nothing exists yet" defaults for whichever ones a given test
// doesn't care about, and lets the test override just the ones it does.
function defaultRoutes(overrides) {
  const base = [
    { test: 'marketing_platform_connections', rows: [] },
    { test: 'marketing_consent_ledger', rows: [] },
    { test: 'campaign_recipients', rows: [] },
    { test: 'marketing_plan_assumptions?select=', rows: [] },
    { test: 'jobs?select=total', rows: [] },
  ];
  return [...(overrides || []), ...base];
}

function makeSandbox(routes, emailConfigured, emailSendEnabled) {
  const sandbox = {
    console, Error, Object, String, Number, Math, Map, Set, Promise, Array, JSON,
    supabaseRequest: makeMockSupabase(routes),
    isEmailConfigured: () => !!emailConfigured,
    isEmailSendEnabled: () => !!emailSendEnabled,
  };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  return sandbox;
}

// ---------- Real forecast gating ----------

check('real invocation: no paid channel connected -> real "blocked_no_channel" forecast, with the real message', async () => {
  const sandbox = makeSandbox(defaultRoutes([]), false, false);
  const result = await sandbox.ccPlan(500000);
  assert.equal(result.budgetCents, 500000);
  assert.equal(result.forecast.status, 'blocked_no_channel');
  assert.match(result.forecast.message, /No paid channel \(Google Ads or Meta\) is launch-ready yet/);
});

check('real invocation: a ready paid channel but no assumptions row -> real "blocked_assumptions" forecast', async () => {
  const sandbox = makeSandbox(defaultRoutes([
    { test: 'marketing_platform_connections', rows: [{ platform: 'google_ads', state: 'launch_enabled', note: 'Live campaigns running.' }] },
  ]), false, false);
  const result = await sandbox.ccPlan(500000);
  assert.equal(result.forecast.status, 'blocked_assumptions');
  assert.match(result.forecast.message, /Set your planning assumptions/);
});

// ---------- Real forecast math, including the real max-jobs clamp ----------

check('real invocation: a ready channel + real assumptions produce a real "ready" forecast with correctly computed bands, including the real per-band max-jobs clamp', async () => {
  const sandbox = makeSandbox(defaultRoutes([
    { test: 'marketing_platform_connections', rows: [{ platform: 'google_ads', state: 'launch_enabled', note: 'Live campaigns running.' }] },
    { test: 'marketing_plan_assumptions?select=', rows: [{
      gross_margin_pct: 50,
      qualified_lead_rate_per_100: 1,
      close_rate_pct: 20,
      max_new_jobs_per_month: 15,
      avg_job_value_cents: 500000,
      risk_posture: 'balanced',
    }] },
  ]), false, false);
  const result = await sandbox.ccPlan(1000000); // $10,000 budget
  assert.equal(result.forecast.status, 'ready');
  assert.equal(result.forecast.headlineBand, 'expected');
  // bands.* objects are constructed inside computeForecast, which runs
  // via vm.runInContext -- they carry the sandbox realm's Object
  // prototype, so assert.deepEqual against a main-realm literal would
  // fail on prototype identity alone (same gotcha documented in the
  // handleAssumptionsPost slice). Spreading into a fresh {...} object
  // here rebuilds it with the main realm's Object prototype first.
  // conservative: 100 leads * 0.65 = 65 qualified leads; 65 * 20% = 13 sold jobs (no clamp, cap is 15)
  assert.deepEqual({ ...result.forecast.bands.conservative }, { qualifiedLeads: 65, soldJobs: 13, revenueCents: 6500000, grossProfitCents: 3250000 });
  // expected: 100 qualified leads; 100 * 20% = 20 sold jobs -> clamped to the real cap of 15
  assert.deepEqual({ ...result.forecast.bands.expected }, { qualifiedLeads: 100, soldJobs: 15, revenueCents: 7500000, grossProfitCents: 3750000 });
  // upside: 135 qualified leads; 135 * 20% = 27 sold jobs -> also clamped to 15
  assert.deepEqual({ ...result.forecast.bands.upside }, { qualifiedLeads: 135, soldJobs: 15, revenueCents: 7500000, grossProfitCents: 3750000 });
  assert.match(result.forecast.methodology, /google_ads/);
});

// ---------- Real channel array shape ----------

check('real invocation: the email channel status reflects real consent-ledger and sent counts, not a placeholder', async () => {
  const sandbox = makeSandbox(defaultRoutes([
    { test: 'marketing_consent_ledger', rows: [
      { channel: 'email', status: 'granted' }, { channel: 'email', status: 'granted' }, { channel: 'sms', status: 'granted' },
    ] },
    { test: 'campaign_recipients', rows: [{ sent_at: '2026-01-01T00:00:00Z' }, { sent_at: '2026-01-02T00:00:00Z' }] },
  ]), false, false);
  const result = await sandbox.ccPlan(0);
  const emailChannel = result.channels.find((c) => c.key === 'email');
  assert.equal(emailChannel.ready, true);
  assert.equal(emailChannel.status, '2 customers ready -- 2 sends completed, 1 SMS-eligible');
});

check('real invocation: a non-connected channel reports the real honest "Not connected." note; a connected-but-not-ready channel reports its real stored note', async () => {
  const sandbox = makeSandbox(defaultRoutes([
    { test: 'marketing_platform_connections', rows: [
      { platform: 'meta_ads', state: 'pending_review', note: 'Meta account under review -- typically clears in 24-48h.' },
    ] },
  ]), false, false);
  const result = await sandbox.ccPlan(0);
  const websiteChannel = result.channels.find((c) => c.key === 'website_cms');
  assert.equal(websiteChannel.ready, false);
  assert.equal(websiteChannel.status, 'Not connected.');
  const metaChannel = result.channels.find((c) => c.key === 'meta_ads');
  assert.equal(metaChannel.ready, false); // pending_review is not in CC_READY_STATES
  assert.equal(metaChannel.status, 'Meta account under review -- typically clears in 24-48h.');
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
