// Phase 18 -- Lead/Revenue Attribution snapshot persistence. An explicit
// POST resource (attribution_snapshot) that computes and appends
// point-in-time rows to marketing_lead_attributions/marketing_revenue_attributions
// (sql/046). Deliberately independent of the still-unmerged resource=attribution
// live computation -- see the header comment above computeAttributionSnapshotRows
// in api/marketing.js for the full rationale.

import fs from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';

const apiPath = 'api/marketing.js';
const api = fs.readFileSync(apiPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function extractAttributionSnapshotSource() {
  const start = api.indexOf('// ---------- Lead/Revenue Attribution snapshot persistence');
  assert.ok(start > -1, 'expected the attribution snapshot section header to exist');
  const end = api.indexOf('export default async function handler(req, res) {', start);
  assert.ok(end > start, 'expected the exported handler to follow the attribution snapshot section');
  return api.slice(start, end);
}

function loadAttributionFns({ fetchAllRows, supabaseRequest }) {
  const sandbox = {
    fetchAllRows: fetchAllRows || (async () => { throw new Error('fetchAllRows not stubbed'); }),
    supabaseRequest: supabaseRequest || (async () => { throw new Error('supabaseRequest not stubbed'); }),
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(extractAttributionSnapshotSource(), sandbox);
  return {
    computeAttributionSnapshotRows: sandbox.computeAttributionSnapshotRows,
    insertRowsIfTableExists: sandbox.insertRowsIfTableExists,
    handleAttributionSnapshotPost: sandbox.handleAttributionSnapshotPost,
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

// vm.runInContext executes in a separate V8 realm, so plain objects/arrays it
// returns have a different Object/Array prototype identity than this file's --
// assert.deepStrictEqual treats that as inequality even when the structure
// matches exactly. A JSON round-trip strips the foreign realm's identity
// without changing any of these plain-data shapes (no functions/Dates/undefined
// anywhere in what these functions return).
function norm(v) { return JSON.parse(JSON.stringify(v)); }

// ---------- Structural / wiring checks ----------

check('resource=attribution_snapshot is wired into the dispatch chain', () => {
  // Loosened: sibling Phase 18 routes (lifecycle_candidates, schedule) now
  // sit between process_scheduled_sends and attribution_snapshot in the
  // dispatch chain once those branches reconciled -- only presence after
  // process_scheduled_sends matters, not exact adjacency.
  const idx = api.indexOf("resource === 'process_scheduled_sends' && req.method === 'GET')");
  assert.ok(idx > -1, 'expected the process_scheduled_sends GET dispatch to exist');
  const chunk = api.slice(idx);
  assert.match(chunk, /resource === 'attribution_snapshot' && req\.method === 'POST'/);
  assert.match(chunk, /return await handleAttributionSnapshotPost\(req, res\);/);
});

check('the resource-list error string documents attribution_snapshot (POST)', () => {
  // Loosened: sibling Phase 18 routes (lifecycle_candidates, schedule) now
  // sit between process_scheduled_sends and attribution_snapshot in the
  // enumeration once those branches reconciled -- only presence matters.
  assert.match(api, /attribution_snapshot \(POST\)/);
});

check('computeAttributionSnapshotRows does its own independent fetch (campaigns, campaign_recipients, jobs) rather than reusing the live attribution computation', () => {
  const fn = api.slice(api.indexOf('async function computeAttributionSnapshotRows'), api.indexOf('async function insertRowsIfTableExists'));
  assert.match(fn, /fetchAllRows\('campaigns'/);
  assert.match(fn, /fetchAllRows\('campaign_recipients'/);
  assert.match(fn, /fetchAllRows\('jobs'/);
});

check('insertRowsIfTableExists performs a plain POST insert (never upsert / never on_conflict)', () => {
  const fn = api.slice(api.indexOf('async function insertRowsIfTableExists'), api.indexOf('async function handleAttributionSnapshotPost'));
  assert.match(fn, /method: 'POST'/);
  assert.doesNotMatch(fn, /on_conflict/);
  assert.doesNotMatch(fn, /Prefer:.*resolution/i);
});

// ---------- computeAttributionSnapshotRows behavior ----------

const campaigns = [
  { id: 'c1', channel: 'email' },
  { id: 'c2', channel: 'sms' },
];

const recipients = [
  // clientA: two touches, c1 then c2 -- first=c1/email, last=c2/sms, no assisted
  { campaign_id: 'c1', client_id: 'clientA', sent_at: '2026-01-01T00:00:00Z' },
  { campaign_id: 'c2', client_id: 'clientA', sent_at: '2026-01-02T00:00:00Z' },
  // clientB: three touches, c1, c2, c1 -- first=c1, last=c1, assisted=[c2]
  { campaign_id: 'c1', client_id: 'clientB', sent_at: '2026-01-01T00:00:00Z' },
  { campaign_id: 'c2', client_id: 'clientB', sent_at: '2026-01-02T00:00:00Z' },
  { campaign_id: 'c1', client_id: 'clientB', sent_at: '2026-01-03T00:00:00Z' },
  // clientD: one touch, after the job it's attached to completes (tests priorTouches skip)
  { campaign_id: 'c1', client_id: 'clientD', sent_at: '2026-01-05T00:00:00Z' },
  // garbage rows that must be filtered out, not crash the aggregation
  { campaign_id: 'c1', client_id: null, sent_at: '2026-01-01T00:00:00Z' },
  { campaign_id: 'c1', client_id: 'clientA', sent_at: null },
];

const jobs = [
  { jobber_id: 'J1', client_id: 'clientA', total: '500', completed_at: '2026-01-10T00:00:00Z' },
  { jobber_id: 'J2', client_id: 'clientB', total: '750.50', completed_at: '2026-01-10T00:00:00Z' },
  { jobber_id: 'J3', client_id: null, total: '100', completed_at: '2026-01-10T00:00:00Z' }, // no client -> skip
  { jobber_id: 'J4', client_id: 'clientA', total: '0', completed_at: '2026-01-10T00:00:00Z' }, // unpriced -> skip
  { jobber_id: 'J5', client_id: 'clientC', total: '200', completed_at: '2026-01-10T00:00:00Z' }, // no touches at all -> skip
  { jobber_id: 'J6', client_id: 'clientD', total: '300', completed_at: '2026-01-01T00:00:00Z' }, // completed before its only touch -> skip
];

function stubFetchAllRows(table) {
  if (table === 'campaigns') return campaigns;
  if (table === 'campaign_recipients') return recipients;
  if (table === 'jobs') return jobs;
  throw new Error('unexpected table ' + table);
}

check('computeAttributionSnapshotRows builds one LeadAttribution row per real client with a real touch, with correct first/last/assisted', async () => {
  const { computeAttributionSnapshotRows } = loadAttributionFns({ fetchAllRows: async (t) => stubFetchAllRows(t) });
  const { leadRows } = await computeAttributionSnapshotRows();
  const byClient = Object.fromEntries(leadRows.map((r) => [r.client_id, r]));

  assert.strictEqual(leadRows.length, 3, 'clientA, clientB, clientD -- clientC has no touches at all');

  assert.strictEqual(byClient.clientA.first_touch_channel, 'email');
  assert.strictEqual(byClient.clientA.first_touch_campaign_id, 'c1');
  assert.strictEqual(byClient.clientA.last_touch_channel, 'sms');
  assert.strictEqual(byClient.clientA.last_touch_campaign_id, 'c2');
  assert.deepStrictEqual(norm(byClient.clientA.assisted_touches), []);

  assert.strictEqual(byClient.clientB.first_touch_campaign_id, 'c1');
  assert.strictEqual(byClient.clientB.last_touch_campaign_id, 'c1');
  assert.strictEqual(byClient.clientB.assisted_touches.length, 1);
  assert.strictEqual(byClient.clientB.assisted_touches[0].campaign_id, 'c2');

  assert.strictEqual(byClient.clientD.first_touch_campaign_id, 'c1');
  assert.strictEqual(byClient.clientD.last_touch_campaign_id, 'c1');
  assert.deepStrictEqual(norm(byClient.clientD.assisted_touches), []);
});

check('computeAttributionSnapshotRows builds one RevenueAttribution row per real completed+priced job with a prior touch, crediting first-touch, and honestly skips the rest', async () => {
  const { computeAttributionSnapshotRows } = loadAttributionFns({ fetchAllRows: async (t) => stubFetchAllRows(t) });
  const { revenueRows } = await computeAttributionSnapshotRows();
  const byJob = Object.fromEntries(revenueRows.map((r) => [r.job_id, r]));

  assert.strictEqual(revenueRows.length, 2, 'only J1 and J2 qualify; J3-J6 are honest skips');
  assert.strictEqual(byJob.J1.client_id, 'clientA');
  assert.strictEqual(byJob.J1.campaign_id, 'c1');
  assert.strictEqual(byJob.J1.sold_value_cents, 50000);
  assert.strictEqual(byJob.J1.attribution_model, 'first_touch');
  assert.strictEqual(byJob.J1.estimate_value_cents, null);
  assert.strictEqual(byJob.J1.gross_profit_cents, null);
  assert.strictEqual(byJob.J1.cost_allocated_cents, null);

  assert.strictEqual(byJob.J2.campaign_id, 'c1');
  assert.strictEqual(byJob.J2.sold_value_cents, 75050);

  assert.ok(!byJob.J3 && !byJob.J4 && !byJob.J5 && !byJob.J6, 'no-client, unpriced, no-touch, and completed-before-touch jobs must never produce a row');
});

// ---------- insertRowsIfTableExists behavior ----------

check('insertRowsIfTableExists skips the network call entirely for an empty row set', async () => {
  let called = false;
  const { insertRowsIfTableExists } = loadAttributionFns({ supabaseRequest: async () => { called = true; return { ok: true }; } });
  const result = await insertRowsIfTableExists('marketing_lead_attributions', []);
  assert.deepStrictEqual(norm(result), { inserted: 0, tableMissing: false });
  assert.strictEqual(called, false);
});

check('insertRowsIfTableExists reports rows inserted on success', async () => {
  const { insertRowsIfTableExists } = loadAttributionFns({ supabaseRequest: async () => ({ ok: true }) });
  const result = await insertRowsIfTableExists('marketing_lead_attributions', [{ a: 1 }, { a: 2 }]);
  assert.deepStrictEqual(norm(result), { inserted: 2, tableMissing: false });
});

check('insertRowsIfTableExists honestly degrades (tableMissing) when the table does not exist yet, instead of throwing', async () => {
  const { insertRowsIfTableExists } = loadAttributionFns({
    supabaseRequest: async () => ({ ok: false, text: async () => 'relation "marketing_lead_attributions" does not exist' }),
  });
  const result = await insertRowsIfTableExists('marketing_lead_attributions', [{ a: 1 }]);
  assert.deepStrictEqual(norm(result), { inserted: 0, tableMissing: true });
});

check('insertRowsIfTableExists throws on any other insert failure (never silently swallowed)', async () => {
  const { insertRowsIfTableExists } = loadAttributionFns({
    supabaseRequest: async () => ({ ok: false, text: async () => 'permission denied for table marketing_lead_attributions' }),
  });
  await assert.rejects(
    () => insertRowsIfTableExists('marketing_lead_attributions', [{ a: 1 }]),
    /Failed to insert into marketing_lead_attributions: permission denied/
  );
});

// ---------- handleAttributionSnapshotPost behavior ----------

check('handleAttributionSnapshotPost returns 200 with real inserted counts and no note when both tables exist', async () => {
  const { handleAttributionSnapshotPost } = loadAttributionFns({
    fetchAllRows: async (t) => stubFetchAllRows(t),
    supabaseRequest: async () => ({ ok: true }),
  });
  const res = makeRes();
  await handleAttributionSnapshotPost({}, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.leadAttributionRowsInserted, 3);
  assert.strictEqual(res.body.revenueAttributionRowsInserted, 2);
  assert.deepStrictEqual(norm(res.body.notSynced), []);
  assert.strictEqual(res.body.note, null);
});

check('handleAttributionSnapshotPost returns 200 with notSynced + a setup note when the target tables do not exist yet', async () => {
  const { handleAttributionSnapshotPost } = loadAttributionFns({
    fetchAllRows: async (t) => stubFetchAllRows(t),
    supabaseRequest: async () => ({ ok: false, text: async () => 'relation "marketing_lead_attributions" does not exist' }),
  });
  const res = makeRes();
  await handleAttributionSnapshotPost({}, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.leadAttributionRowsInserted, 0);
  assert.strictEqual(res.body.revenueAttributionRowsInserted, 0);
  assert.ok(res.body.notSynced.includes('marketing_lead_attributions'));
  assert.ok(res.body.notSynced.includes('marketing_revenue_attributions'));
  assert.match(res.body.note, /sql\/046_marketing_lead_revenue_attribution\.sql/);
});

check('handleAttributionSnapshotPost honestly degrades to a 200 no-op when the source tables (campaigns/recipients/jobs) are not synced, instead of a 500', async () => {
  const { handleAttributionSnapshotPost } = loadAttributionFns({
    fetchAllRows: async () => { const e = new Error('relation "campaigns" does not exist'); e.notSynced = true; throw e; },
  });
  const res = makeRes();
  await handleAttributionSnapshotPost({}, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.leadAttributionRowsInserted, 0);
  assert.strictEqual(res.body.revenueAttributionRowsInserted, 0);
  assert.deepStrictEqual(norm(res.body.notSynced), ['campaigns_or_campaign_recipients_or_jobs']);
});

check('handleAttributionSnapshotPost returns a real 500 for a genuine unexpected error (never swallowed as a fake success)', async () => {
  const { handleAttributionSnapshotPost } = loadAttributionFns({
    fetchAllRows: async () => { throw new Error('boom: unexpected database error'); },
  });
  const res = makeRes();
  await handleAttributionSnapshotPost({}, res);
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.ok, false);
  assert.match(res.body.error, /boom: unexpected database error/);
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
