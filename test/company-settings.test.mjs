// test/company-settings.test.mjs
// Company Setup — the settings sections that had no backing table (sql/086).
// Covers the validators and the handler contract: auth gate, admin-only writes,
// section whitelist, defaults merge, and the pre-migration graceful path (the
// one that decides whether a fresh install shows a broken page or an honest
// one). Fully mocked — no network, no DB, no real secret.
// Run: node --experimental-test-module-mocks --test test/company-settings.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

const mod = await import('../api/settings.js');
const { SECTION_DEFAULTS, SECTIONS } = mod;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------
function res() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}
// PostgREST's shape when the relation is not in the schema cache, i.e. sql/086
// has not been applied. This is the exact payload the graceful path keys on.
function missingTableRes() {
  return {
    ok: false, status: 404,
    json: async () => ({ code: 'PGRST205', message: "Could not find the table 'public.company_settings' in the schema cache" }),
    text: async () => JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.company_settings' in the schema cache" }),
  };
}

async function withMockedFetch(scenario, fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: (opts && opts.method) || 'GET', body: opts && opts.body });
    if (u.includes('/auth/v1/user')) return scenario.noUser ? jsonRes({}, 401) : jsonRes({ id: 'user-1', email: 'chris@ghgrp.net' });
    if (u.includes('/rest/v1/company_members')) return jsonRes([{ company_id: 'gh-1', role: scenario.role || 'owner' }]);
    if (u.includes('/rest/v1/companies')) return jsonRes([{ id: 'gh-1', name: 'Greenwich Handyman' }]);
    if (u.includes('/rest/v1/company_settings')) {
      if (scenario.tableMissing) return missingTableRes();
      if ((opts && opts.method) === 'POST') return jsonRes([{ section: JSON.parse(opts.body).section, value: JSON.parse(opts.body).value, updated_at: '2026-08-17T12:00:00Z' }]);
      return jsonRes(scenario.rows || []);
    }
    return jsonRes({ error: 'unhandled ' + u }, 500);
  };
  try { return { result: await fn(), calls }; } finally { global.fetch = original; }
}

async function call({ method = 'GET', body, query = {}, auth = 'Bearer usertoken' } = {}, scenario = {}) {
  const req = { method, query, headers: auth ? { authorization: auth } : {}, body };
  const r = res();
  const { calls } = await withMockedFetch(scenario, () => mod.default(req, r));
  r.calls = calls;
  return r;
}

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------
test('SECTIONS covers exactly the four unbacked groups', () => {
  assert.deepEqual([...SECTIONS].sort(), ['automations', 'hours', 'numbering', 'payment_terms']);
});

test('default payment schedule totals 100%', () => {
  const total = SECTION_DEFAULTS.payment_terms.schedule.reduce((a, r) => a + r.pct, 0);
  assert.equal(total, 100);
});

test('every default numbering pattern carries a number token', () => {
  for (const [k, v] of Object.entries(SECTION_DEFAULTS.numbering)) {
    assert.match(v, /\{(n|seq)\}/, `${k} has no {n}/{seq}`);
  }
});

// ---------------------------------------------------------------------------
// auth + authorization
// ---------------------------------------------------------------------------
test('anonymous request 401s', async () => {
  const r = await call({ auth: null }, { noUser: true });
  assert.equal(r.statusCode, 401);
});

test('GET returns all four sections with defaults when nothing is saved', async () => {
  const r = await call({}, { rows: [] });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.table_missing, false);
  assert.deepEqual(Object.keys(r.body.sections).sort(), ['automations', 'hours', 'numbering', 'payment_terms']);
  assert.equal(r.body.meta.hours.saved, false);
  assert.deepEqual(r.body.saved_sections, []);
});

test('GET merges a stored section over defaults so new keys survive', async () => {
  // A row saved before `saturday_by_approval` existed.
  const r = await call({}, { rows: [{ section: 'hours', value: { notes: 'summer hours' }, updated_at: 'x', updated_by: 'u1' }] });
  assert.equal(r.body.sections.hours.notes, 'summer hours');
  assert.equal(r.body.sections.hours.saturday_by_approval, true, 'default key must survive a partial stored row');
  assert.equal(r.body.meta.hours.saved, true);
});

test('GET ?section= filters to one section, and rejects an unknown one', async () => {
  const ok = await call({ query: { section: 'numbering' } }, { rows: [] });
  assert.deepEqual(Object.keys(ok.body.sections), ['numbering']);
  const bad = await call({ query: { section: 'bogus' } }, { rows: [] });
  assert.equal(bad.statusCode, 400);
});

test('a member (non-admin) can read but cannot write', async () => {
  const read = await call({}, { role: 'member', rows: [] });
  assert.equal(read.statusCode, 200);
  assert.equal(read.body.can_edit, false);

  const write = await call({ method: 'POST', body: { section: 'hours', value: {} } }, { role: 'member' });
  assert.equal(write.statusCode, 403);
  assert.match(write.body.error, /owner or admin/i);
});

test('an admin can write', async () => {
  const r = await call({ method: 'POST', body: { section: 'numbering', value: { job: 'J-{n}' } } }, { role: 'admin' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
});

// ---------------------------------------------------------------------------
// validation — each of these would otherwise store a rule that breaks something
// ---------------------------------------------------------------------------
test('POST rejects an unknown section', async () => {
  const r = await call({ method: 'POST', body: { section: 'brands', value: {} } });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /section must be one of/);
});

test('POST rejects a payment schedule that does not total 100%', async () => {
  const r = await call({ method: 'POST', body: { section: 'payment_terms', value: { schedule: [{ label: 'Deposit', pct: 50 }, { label: 'Final', pct: 30 }] } } });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /total 100%/);
  assert.match(r.body.error, /80%/, 'the message should say what it actually totals');
});

test('POST accepts a schedule that totals 100% across thirds', async () => {
  const r = await call({ method: 'POST', body: { section: 'payment_terms', value: { schedule: [{ label: 'A', pct: 33.33 }, { label: 'B', pct: 33.33 }, { label: 'C', pct: 33.34 }] } } });
  assert.equal(r.statusCode, 200);
});

test('POST rejects a stage with no label', async () => {
  const r = await call({ method: 'POST', body: { section: 'payment_terms', value: { schedule: [{ label: '  ', pct: 100 }] } } });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /needs a label/);
});

test('POST rejects malformed opening hours and inverted days', async () => {
  const bad = await call({ method: 'POST', body: { section: 'hours', value: { days: { 1: { open: '7:30am', close: '5pm', closed: false } } } } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.error, /07:30/);

  const inverted = await call({ method: 'POST', body: { section: 'hours', value: { days: { 1: { open: '17:00', close: '07:30', closed: false } } } } });
  assert.equal(inverted.statusCode, 400);
  assert.match(inverted.body.error, /after opening/);
});

test('POST allows a closed day with no times', async () => {
  const r = await call({ method: 'POST', body: { section: 'hours', value: { days: { 0: { open: null, close: null, closed: true } } } } });
  assert.equal(r.statusCode, 200);
});

test('POST rejects a numbering pattern with no number token', async () => {
  const r = await call({ method: 'POST', body: { section: 'numbering', value: { invoice: 'INV-STATIC' } } });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /\{n\} or \{seq\}/);
});

test('POST rejects a non-object value', async () => {
  const r = await call({ method: 'POST', body: { section: 'automations', value: [1, 2, 3] } });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /JSON object/);
});

test('POST merges over defaults so a partial save never drops keys', async () => {
  const r = await call({ method: 'POST', body: { section: 'automations', value: { dormant_client_reengage: { enabled: true, months_dormant: 12 } } } });
  assert.equal(r.statusCode, 200);
  const sent = JSON.parse(r.calls.find((c) => c.url.includes('company_settings') && c.method === 'POST').body);
  assert.ok(sent.value.missed_call_textback, 'untouched default key must still be written');
  assert.equal(sent.value.dormant_client_reengage.enabled, true);
  assert.equal(sent.company_id, 'gh-1');
  assert.equal(sent.updated_by, 'user-1');
});

// ---------------------------------------------------------------------------
// pre-migration graceful path — the reason a fresh install is not a broken page
// ---------------------------------------------------------------------------
test('GET before sql/086 is applied returns defaults and says so, not a 500', async () => {
  const r = await call({}, { tableMissing: true });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.table_missing, true);
  assert.deepEqual(Object.keys(r.body.sections).sort(), ['automations', 'hours', 'numbering', 'payment_terms']);
  assert.match(r.body.note, /not set up yet/i);
});

test('POST before sql/086 is applied 503s and never claims a save', async () => {
  const r = await call({ method: 'POST', body: { section: 'hours', value: {} } }, { tableMissing: true });
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.table_missing, true);
  assert.match(r.body.error, /Nothing was saved/);
});

test('unsupported method 405s', async () => {
  const r = await call({ method: 'DELETE' });
  assert.equal(r.statusCode, 405);
});
