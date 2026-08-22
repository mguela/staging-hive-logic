// Phase 4 pacing fields for marketing_channel_budgets: minimum viable
// spend, daily maximum, testing allowance, pause flag, approval threshold.
// The old plain-dollar-number channel input still works. See
// sql/045_marketing_channel_budget_pacing.sql and the plan doc.
//
// Extracts the real BUDGET_CHANNELS, setupBudgetShape, and
// handleSetupBudgetPost source out of api/marketing.js (never re-typed)
// and runs it in a vm sandbox with fetchAllRows/supabaseRequest replaced
// by in-memory fakes.

import fs from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';

const apiPath = 'api/marketing.js';
const api = fs.readFileSync(apiPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function slice(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start > -1, `start marker not found: ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `end marker not found after start: ${endMarker}`);
  return text.slice(start, end);
}

const budgetChannelsSrc = slice(api, 'const BUDGET_CHANNELS = [', '\n];') + '\n];';
const setupBudgetShapeSrc = slice(api, 'async function setupBudgetShape() {', '\nasync function setupAccountsShape');
const handleSetupBudgetPostSrc = slice(api, 'async function handleSetupBudgetPost(req, res) {', '\nasync function handleSetupAccountPost');

function makeFakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.body = obj; return res; };
  return res;
}

function runSandbox({ channelRows = [], totalRow = null, fail = null }) {
  const calls = { upsertBody: null, requests: [] };

  const fetchAllRows = async (table, query) => {
    calls.requests.push({ table, query });
    if (fail && fail.table === table) {
      const e = new Error(fail.message || 'boom');
      e.notSynced = !!fail.notSynced;
      throw e;
    }
    if (table === 'marketing_budget_settings') {
      return totalRow ? [totalRow] : [];
    }
    if (table === 'marketing_channel_budgets') {
      return channelRows;
    }
    return [];
  };

  const supabaseRequest = async (path, opts) => {
    calls.requests.push({ path, opts });
    if (path.startsWith('marketing_channel_budgets')) {
      calls.upsertBody = JSON.parse(opts.body);
    }
    return { ok: true, text: async () => '', json: async () => ([]) };
  };

  const sandbox = {
    fetchAllRows,
    supabaseRequest,
    console,
    Object,
    Math,
    Number,
    JSON,
    Date,
    Map,
    module: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(budgetChannelsSrc, sandbox);
  vm.runInContext(setupBudgetShapeSrc, sandbox);
  vm.runInContext(handleSetupBudgetPostSrc, sandbox);
  return { sandbox, calls };
}

check('handleSetupBudgetPost is still defined exactly once', () => {
  assert.strictEqual((api.match(/async function handleSetupBudgetPost\(req, res\) \{/g) || []).length, 1);
});

check('setupBudgetShape is still defined exactly once', () => {
  assert.strictEqual((api.match(/async function setupBudgetShape\(\) \{/g) || []).length, 1);
});

check('open/close brace count across the whole file is balanced', () => {
  assert.strictEqual((api.match(/\{/g) || []).length, (api.match(/\}/g) || []).length);
});

check('setupBudgetShape reports real pacing fields when a channel row has them set', async () => {
  const { sandbox } = runSandbox({
    channelRows: [
      { channel: 'google_ads', monthly_budget_cents: 50000, min_viable_spend_cents: 10000, daily_max_cents: 5000, testing_allowance_cents: 2000, paused: true, approval_threshold_cents: 100000 },
    ],
  });
  const shape = await sandbox.setupBudgetShape();
  const gads = shape.channels.find((c) => c.key === 'google_ads');
  assert.strictEqual(gads.minViableSpendCents, 10000);
  assert.strictEqual(gads.dailyMaxCents, 5000);
  assert.strictEqual(gads.testingAllowanceCents, 2000);
  assert.strictEqual(gads.paused, true);
  assert.strictEqual(gads.approvalThresholdCents, 100000);
});

check('setupBudgetShape defaults pacing fields to null/0/false for a channel with no row', async () => {
  const { sandbox } = runSandbox({ channelRows: [] });
  const shape = await sandbox.setupBudgetShape();
  for (const c of shape.channels) {
    assert.strictEqual(c.minViableSpendCents, null, `${c.key} minViableSpendCents`);
    assert.strictEqual(c.dailyMaxCents, null, `${c.key} dailyMaxCents`);
    assert.strictEqual(c.testingAllowanceCents, 0, `${c.key} testingAllowanceCents`);
    assert.strictEqual(c.paused, false, `${c.key} paused`);
    assert.strictEqual(c.approvalThresholdCents, null, `${c.key} approvalThresholdCents`);
  }
});

check('the old plain-dollar-number channel input still works', async () => {
  const { sandbox, calls } = runSandbox({ channelRows: [], totalRow: { monthly_budget_cents: 300000 } });
  const req = { body: { monthlyDollars: 3000, channels: { google_ads: 500, sms: 0 } } };
  const res = makeFakeRes();
  await sandbox.handleSetupBudgetPost(req, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  const gads = calls.upsertBody.find((r) => r.channel === 'google_ads');
  assert.strictEqual(gads.monthly_budget_cents, 50000);
  assert.strictEqual(gads.min_viable_spend_cents, null);
  assert.strictEqual(gads.testing_allowance_cents, 0);
  assert.strictEqual(gads.paused, false);
});

check('a plain-number update carries forward pacing fields a prior update had set', async () => {
  const { sandbox, calls } = runSandbox({
    channelRows: [
      { channel: 'google_ads', min_viable_spend_cents: 15000, daily_max_cents: 8000, testing_allowance_cents: 3000, paused: true, approval_threshold_cents: 200000 },
    ],
    totalRow: { monthly_budget_cents: 300000 },
  });
  const req = { body: { monthlyDollars: 3000, channels: { google_ads: 700 } } };
  const res = makeFakeRes();
  await sandbox.handleSetupBudgetPost(req, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  const gads = calls.upsertBody.find((r) => r.channel === 'google_ads');
  assert.strictEqual(gads.monthly_budget_cents, 70000, 'the monthly dollar figure must still update');
  assert.strictEqual(gads.min_viable_spend_cents, 15000, 'must carry forward unchanged');
  assert.strictEqual(gads.daily_max_cents, 8000, 'must carry forward unchanged');
  assert.strictEqual(gads.testing_allowance_cents, 3000, 'must carry forward unchanged');
  assert.strictEqual(gads.paused, true, 'must carry forward unchanged');
  assert.strictEqual(gads.approval_threshold_cents, 200000, 'must carry forward unchanged');
});

check('a channel input object can set new pacing fields', async () => {
  const { sandbox, calls } = runSandbox({ channelRows: [], totalRow: { monthly_budget_cents: 300000 } });
  const req = {
    body: {
      monthlyDollars: 3000,
      channels: {
        google_ads: {
          monthlyDollars: 500,
          minViableSpendDollars: 100,
          dailyMaxDollars: 50,
          testingAllowanceDollars: 20,
          paused: true,
          approvalThresholdDollars: 1000,
        },
      },
    },
  };
  const res = makeFakeRes();
  await sandbox.handleSetupBudgetPost(req, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  const gads = calls.upsertBody.find((r) => r.channel === 'google_ads');
  assert.strictEqual(gads.monthly_budget_cents, 50000);
  assert.strictEqual(gads.min_viable_spend_cents, 10000);
  assert.strictEqual(gads.daily_max_cents, 5000);
  assert.strictEqual(gads.testing_allowance_cents, 2000);
  assert.strictEqual(gads.paused, true);
  assert.strictEqual(gads.approval_threshold_cents, 100000);
});

check('a channel input object can update one field and carry the rest forward unchanged', async () => {
  const { sandbox, calls } = runSandbox({
    channelRows: [
      { channel: 'google_ads', min_viable_spend_cents: 15000, daily_max_cents: 8000, testing_allowance_cents: 3000, paused: true, approval_threshold_cents: 200000 },
    ],
    totalRow: { monthly_budget_cents: 300000 },
  });
  const req = {
    body: {
      monthlyDollars: 3000,
      channels: { google_ads: { monthlyDollars: 700, paused: false } },
    },
  };
  const res = makeFakeRes();
  await sandbox.handleSetupBudgetPost(req, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  const gads = calls.upsertBody.find((r) => r.channel === 'google_ads');
  assert.strictEqual(gads.paused, false, 'the field named in this update must change');
  assert.strictEqual(gads.min_viable_spend_cents, 15000, 'fields not named in this update carry forward');
  assert.strictEqual(gads.daily_max_cents, 8000, 'fields not named in this update carry forward');
  assert.strictEqual(gads.testing_allowance_cents, 3000, 'fields not named in this update carry forward');
  assert.strictEqual(gads.approval_threshold_cents, 200000, 'fields not named in this update carry forward');
});

check('a channel input object can set a pacing field back to null on purpose', async () => {
  const { sandbox, calls } = runSandbox({
    channelRows: [
      { channel: 'google_ads', min_viable_spend_cents: 15000, daily_max_cents: 8000, testing_allowance_cents: 3000, paused: false, approval_threshold_cents: 200000 },
    ],
    totalRow: { monthly_budget_cents: 300000 },
  });
  const req = {
    body: {
      monthlyDollars: 3000,
      channels: { google_ads: { monthlyDollars: 700, dailyMaxDollars: null } },
    },
  };
  const res = makeFakeRes();
  await sandbox.handleSetupBudgetPost(req, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  const gads = calls.upsertBody.find((r) => r.channel === 'google_ads');
  assert.strictEqual(gads.daily_max_cents, null, 'an explicit null value takes effect');
  assert.strictEqual(gads.min_viable_spend_cents, 15000, 'other fields still carry forward');
});

check('a negative pacing dollar value is rejected with a 400', async () => {
  const { sandbox } = runSandbox({ channelRows: [], totalRow: { monthly_budget_cents: 300000 } });
  const req = { body: { monthlyDollars: 3000, channels: { google_ads: { monthlyDollars: 500, dailyMaxDollars: -10 } } } };
  const res = makeFakeRes();
  await sandbox.handleSetupBudgetPost(req, res);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /daily maximum must be \$0 or more/);
});

check('a non-numeric pacing dollar value is rejected with a 400', async () => {
  const { sandbox } = runSandbox({ channelRows: [], totalRow: { monthly_budget_cents: 300000 } });
  const req = { body: { monthlyDollars: 3000, channels: { google_ads: { monthlyDollars: 500, minViableSpendDollars: 'lots' } } } };
  const res = makeFakeRes();
  await sandbox.handleSetupBudgetPost(req, res);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /minimum viable spend must be a number/);
});

check('a table-missing error on the pacing-columns select is a real 500', async () => {
  const { sandbox } = runSandbox({
    channelRows: [],
    totalRow: { monthly_budget_cents: 300000 },
    fail: { table: 'marketing_channel_budgets', message: 'column marketing_channel_budgets.min_viable_spend_cents does not exist', notSynced: false },
  });
  const req = { body: { monthlyDollars: 3000, channels: { google_ads: 500 } } };
  const res = makeFakeRes();
  await assert.rejects(() => sandbox.handleSetupBudgetPost(req, res));
});

check('the allocated-over-total-limit rejection still works unchanged', async () => {
  const { sandbox } = runSandbox({ channelRows: [], totalRow: { monthly_budget_cents: 300000 } });
  const req = { body: { monthlyDollars: 300, channels: { google_ads: 5000 } } };
  const res = makeFakeRes();
  await sandbox.handleSetupBudgetPost(req, res);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /over the \$2,500 monthly limit/);
});

check('missing monthlyDollars is still rejected with a 400 exactly as before', async () => {
  const { sandbox } = runSandbox({ channelRows: [], totalRow: null });
  const req = { body: { channels: {} } };
  const res = makeFakeRes();
  await sandbox.handleSetupBudgetPost(req, res);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /monthlyDollars is required/);
});

let pass = 0, fail = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  not ok  - ${name}\n    ${e.stack || e.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed (of ${checks.length})`);
process.exit(fail ? 1 : 0);
