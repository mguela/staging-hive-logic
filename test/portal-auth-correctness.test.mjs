// test/portal-auth-correctness.test.mjs
// Portal auth correctness (2026-08-02). Proves three fixes, each fully mocked
// (no network, no real DB, no real secret). Run with:
//   node --experimental-test-module-mocks --test test/portal-auth-correctness.test.mjs
//
//   1. ATOMIC magic-link redemption (client + sub). Redeem consumes the link
//      with ONE conditional UPDATE guarded on `used_at IS NULL`; only an
//      affected-row count of exactly 1 mints a session. Two simultaneous
//      redemptions of the same link therefore create exactly ONE session —
//      the loser sees 0 rows and is rejected.
//
//   2. Banking reauth hash regression. reauth_start stores hashToken(token);
//      the banking endpoint now looks the grant up BY ITS HASH (it used to
//      query the raw token and never match), and consumes it single-use — a
//      second reuse of the same reauth token fails.
//
//   3. Rate-limit store failure now FAILS CLOSED (was fail-open): a configured
//      store that errors denies the request rather than dropping the throttle.
//
// The DB here is a tiny stateful PostgREST emulator: it honours the subset of
// filters the handlers use (eq / is.null / not.is.null / gt / gte) and, for
// PATCH, matches rows and mutates them SYNCHRONOUSLY inside a single fetch
// call — which is exactly the atomicity Postgres row-locking gives a
// conditional UPDATE. That is what makes the concurrency test meaningful.

import test from 'node:test';
import assert from 'node:assert/strict';

import clientHandler from '../api/clientportal.js';
import subHandler from '../api/subportal.js';
import { hashToken, genToken, checkRateLimit } from '../api/_lib/portal-auth.js';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key-test';
process.env.RESEND_API_KEY = 'resend-key-test';

// --- tiny PostgREST filter emulator ---------------------------------------

function decode(v) {
  try { return decodeURIComponent(v); } catch { return v; }
}

// Parse "col=op.value" query segments into predicates against a row.
function rowMatches(row, queryString) {
  const qs = queryString || '';
  for (const seg of qs.split('&')) {
    if (!seg || !seg.includes('=')) continue;
    const eq = seg.indexOf('=');
    const col = seg.slice(0, eq);
    const rhs = seg.slice(eq + 1);
    if (col === 'select' || col === 'order' || col === 'on_conflict') continue;
    const v = row[col];
    if (rhs === 'is.null') {
      if (v !== null && v !== undefined) return false;
    } else if (rhs === 'not.is.null') {
      if (v === null || v === undefined) return false;
    } else if (rhs.startsWith('eq.')) {
      if (String(v) !== decode(rhs.slice(3))) return false;
    } else if (rhs.startsWith('gte.')) {
      if (!(Date.parse(v) >= Date.parse(decode(rhs.slice(4))))) return false;
    } else if (rhs.startsWith('gt.')) {
      if (!(Date.parse(v) > Date.parse(decode(rhs.slice(3))))) return false;
    } else if (rhs.startsWith('lte.')) {
      if (!(Date.parse(v) <= Date.parse(decode(rhs.slice(4))))) return false;
    } else if (rhs.startsWith('lt.')) {
      if (!(Date.parse(v) < Date.parse(decode(rhs.slice(3))))) return false;
    } else {
      return false; // unknown operator -> conservatively no match
    }
  }
  return true;
}

// Build a stateful fetch over `db` (table -> array of row objects). `log`
// records every write so tests can count sessions minted, etc.
function makeDbFetch(db, log) {
  const resp = (data, headers) => ({
    ok: true,
    status: 200,
    headers: headers || { get: () => null },
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
  return async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();

    if (u.includes('/auth/v1/user')) return resp({ id: 'staff-1', email: 's@test' });
    if (u.startsWith('https://api.resend.com/')) return resp({ id: 'email_1' });

    if (u.includes('/rest/v1/')) {
      const path = u.split('/rest/v1/')[1];
      const table = path.split('?')[0];
      const query = path.includes('?') ? path.split('?')[1] : '';
      const body = opts.body ? JSON.parse(opts.body) : undefined;
      db[table] = db[table] || [];

      // RPC: emulate the transactional banking function in JS. Match-and-mutate
      // is synchronous (single JS turn), which models the DB row lock: two
      // "concurrent" callers cannot both consume the same grant. This proves
      // handler wiring + single-use; true rollback/atomicity is proven against
      // real Postgres in the integration suite.
      if (method === 'POST' && table === 'rpc/consume_sub_reauth_and_apply_banking') {
        const a = body || {};
        // Strict, hard-coded 10-minute window (no caller-controlled param), plus
        // used_at<=now and expires_at>now — mirroring the DB function.
        const nowMs = Date.now();
        const windowStartMs = nowMs - 10 * 60 * 1000;
        const link = (db.sub_auth_links || []).find((r) =>
          r.token === a.p_token_hash && r.sub_id === a.p_sub_id &&
          r.purpose === 'reauth' && r.used_at != null &&
          Date.parse(r.used_at) <= nowMs && Date.parse(r.used_at) >= windowStartMs &&
          r.expires_at != null && Date.parse(r.expires_at) > nowMs);
        if (!link) {
          log.writes.push({ table: 'sub_banking', method: 'RPC', consumed: false });
          return resp({ ok: false, reason: 'invalid_reauth' });
        }
        link.purpose = 'reauth_consumed'; // consume exactly once
        if (a.p_set_accepts_cc) {
          const s = (db.subs || []).find((x) => x.id === a.p_sub_id);
          if (s) s.accepts_cc = a.p_accepts_cc;
        }
        db.sub_banking = db.sub_banking || [];
        let bank = db.sub_banking.find((x) => x.sub_id === a.p_sub_id);
        if (!bank) { bank = { id: `sub_banking-${db.sub_banking.length + 1}`, sub_id: a.p_sub_id }; db.sub_banking.push(bank); }
        bank.accepts_ach = true;
        if (a.p_provider != null) bank.provider = a.p_provider;
        if (a.p_provider_ref != null) bank.provider_ref = a.p_provider_ref;
        if (a.p_masked_account != null) bank.masked_account = a.p_masked_account;
        bank.updated_at = new Date().toISOString();
        log.writes.push({ table: 'sub_banking', method: 'RPC', consumed: true });
        return resp({ ok: true, banking: bank });
      }

      // NOTE: everything below runs synchronously before the promise resolves,
      // so a match-and-mutate on a row is atomic across "concurrent" callers.
      if (method === 'GET') {
        const matched = db[table].filter((r) => rowMatches(r, query));
        return resp(matched);
      }
      if (method === 'POST') {
        // Upsert (merge-duplicates) or plain insert — both just yield a row
        // with an id here; tests only care that a row came back / was logged.
        const row = { id: `${table}-${db[table].length + 1}`, ...body };
        db[table].push(row);
        log.writes.push({ table, method: 'POST', payload: body });
        return resp([row]);
      }
      if (method === 'PATCH') {
        const matched = db[table].filter((r) => rowMatches(r, query));
        for (const r of matched) Object.assign(r, body); // atomic claim/mutate
        log.writes.push({ table, method: 'PATCH', query, payload: body, affected: matched.length });
        return resp(matched);
      }
      if (method === 'DELETE') {
        db[table] = db[table].filter((r) => !rowMatches(r, query));
        return resp([]);
      }
    }
    throw new Error('unexpected fetch to ' + u);
  };
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function withDb(db, fn) {
  return async () => {
    const original = global.fetch;
    const log = { writes: [] };
    global.fetch = makeDbFetch(db, log);
    try {
      return await fn({ db, log });
    } finally {
      global.fetch = original;
    }
  };
}

const future = (ms = 3600e3) => new Date(Date.now() + ms).toISOString();
const past = (ms = 60e3) => new Date(Date.now() - ms).toISOString();

// =====================================================================
// 1. Atomic redemption — two simultaneous redemptions => exactly one session
// =====================================================================

test('clientportal: two simultaneous redemptions of one link create exactly ONE session', withDb({}, async ({ db, log }) => {
  const raw = genToken(24);
  db.client_auth_links = [{
    id: 'link-1', client_ref: 'client-123', token: hashToken(raw),
    purpose: 'login', used_at: null, expires_at: future(),
  }];
  db.clients = [{ jobber_id: 'client-123', name: 'Real Client', email: 'c@example.com' }];

  // Fire both without awaiting between them, then settle together.
  const [rA, rB] = await Promise.all([
    (async () => { const res = fakeRes(); await clientHandler({ method: 'GET', query: { action: 'redeem', token: raw }, headers: {} }, res); return res; })(),
    (async () => { const res = fakeRes(); await clientHandler({ method: 'GET', query: { action: 'redeem', token: raw }, headers: {} }, res); return res; })(),
  ]);

  const oks = [rA, rB].filter((r) => r.statusCode === 200 && r.body && r.body.ok);
  const fails = [rA, rB].filter((r) => r.statusCode === 400);
  assert.equal(oks.length, 1, 'exactly one redemption succeeds');
  assert.equal(fails.length, 1, 'the other is rejected (link already used)');

  const sessions = log.writes.filter((w) => w.table === 'client_sessions' && w.method === 'POST');
  assert.equal(sessions.length, 1, 'exactly one session row was minted');

  // The winning PATCH affected exactly 1 row; the losing PATCH affected 0.
  const claims = log.writes.filter((w) => w.table === 'client_auth_links' && w.method === 'PATCH');
  const affected = claims.map((c) => c.affected).sort();
  assert.deepEqual(affected, [0, 1], 'one conditional UPDATE matched 1 row, the other matched 0');
  assert.equal(db.client_auth_links[0].used_at !== null, true, 'link is now marked used');
}));

test('subportal: two simultaneous redemptions of one link create exactly ONE session', withDb({}, async ({ db, log }) => {
  const raw = genToken(24);
  db.sub_auth_links = [{
    id: 'slink-1', sub_id: 'sub-1', token: hashToken(raw),
    purpose: 'login', used_at: null, expires_at: future(),
  }];
  db.subs = [{ id: 'sub-1', company_name: 'Real Sub', email: 's@example.com' }];

  const [rA, rB] = await Promise.all([
    (async () => { const res = fakeRes(); await subHandler({ method: 'GET', query: { action: 'redeem', token: raw }, headers: {} }, res); return res; })(),
    (async () => { const res = fakeRes(); await subHandler({ method: 'GET', query: { action: 'redeem', token: raw }, headers: {} }, res); return res; })(),
  ]);

  const oks = [rA, rB].filter((r) => r.statusCode === 200 && r.body && r.body.ok);
  assert.equal(oks.length, 1, 'exactly one redemption succeeds');
  assert.equal([rA, rB].filter((r) => r.statusCode === 400).length, 1, 'the other is rejected');
  const sessions = log.writes.filter((w) => w.table === 'sub_sessions' && w.method === 'POST');
  assert.equal(sessions.length, 1, 'exactly one session row was minted');
}));

test('clientportal: an expired link cannot be redeemed (guarded by expires_at > now)', withDb({}, async ({ db, log }) => {
  const raw = genToken(24);
  db.client_auth_links = [{
    id: 'link-x', client_ref: 'client-123', token: hashToken(raw),
    purpose: 'login', used_at: null, expires_at: past(), // already expired
  }];
  db.clients = [{ jobber_id: 'client-123', name: 'Real Client', email: 'c@example.com' }];
  const res = fakeRes();
  await clientHandler({ method: 'GET', query: { action: 'redeem', token: raw }, headers: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(log.writes.filter((w) => w.table === 'client_sessions').length, 0, 'no session minted');
  assert.equal(db.client_auth_links[0].used_at, null, 'expired link left untouched');
}));

// =====================================================================
// 2. Banking reauth — hashed lookup succeeds, and is single-use
// =====================================================================

// Seed a signed-in sub session + a REDEEMED reauth grant (used_at recent),
// stored HASHED exactly as reauth_start writes it.
function seedBankingDb(reauthRaw, sessionRaw) {
  return {
    sub_sessions: [{ id: 'sess-1', sub_id: 'sub-1', token: hashToken(sessionRaw), revoked_at: null }],
    subs: [{ id: 'sub-1', company_name: 'Real Sub', email: 's@example.com' }],
    sub_auth_links: [{
      id: 'reauth-1', sub_id: 'sub-1', token: hashToken(reauthRaw),
      purpose: 'reauth', used_at: past(30e3), // redeemed 30s ago, within 10m
      expires_at: future(5 * 60e3), // link still valid (not expired)
    }],
    sub_banking: [],
  };
}

const bankingReq = (reauthRaw, sessionRaw) => ({
  method: 'POST',
  query: { action: 'banking' },
  headers: { authorization: `Bearer ${sessionRaw}`, 'x-reauth-token': reauthRaw },
  body: { provider: 'ach', masked_account: '****1234' },
});

test('subportal banking: a reauth token stored HASHED is accepted when presented raw (regression fix)', async () => {
  const reauthRaw = genToken(24);
  const sessionRaw = genToken(32);
  const db = seedBankingDb(reauthRaw, sessionRaw);
  const log = { writes: [] };
  const original = global.fetch;
  global.fetch = makeDbFetch(db, log);
  try {
    const res = fakeRes();
    await subHandler(bankingReq(reauthRaw, sessionRaw), res);
    assert.equal(res.statusCode, 200, 'banking update accepted with the hashed-then-presented token');
    assert.equal(res.body.ok, true);
    assert.equal(log.writes.filter((w) => w.table === 'sub_banking' && w.consumed === true).length, 1, 'banking applied via transactional RPC');
    // The grant was consumed: purpose flipped away from 'reauth'.
    assert.equal(db.sub_auth_links[0].purpose, 'reauth_consumed', 'reauth grant consumed (single-use)');
  } finally {
    global.fetch = original;
  }
});

test('subportal banking: the SAME reauth token cannot be reused for a second change (single-use)', async () => {
  const reauthRaw = genToken(24);
  const sessionRaw = genToken(32);
  const db = seedBankingDb(reauthRaw, sessionRaw);
  const log = { writes: [] };
  const original = global.fetch;
  global.fetch = makeDbFetch(db, log);
  try {
    const first = fakeRes();
    await subHandler(bankingReq(reauthRaw, sessionRaw), first);
    assert.equal(first.statusCode, 200, 'first banking change succeeds');

    const second = fakeRes();
    await subHandler(bankingReq(reauthRaw, sessionRaw), second);
    assert.equal(second.statusCode, 401, 'second change with the same reauth token is rejected');
    assert.equal(second.body.ok, false);
    assert.equal(log.writes.filter((w) => w.table === 'sub_banking' && w.consumed === true).length, 1, 'banking applied exactly once');
  } finally {
    global.fetch = original;
  }
});

test('subportal banking: two simultaneous submits on one reauth grant apply exactly once', async () => {
  const reauthRaw = genToken(24);
  const sessionRaw = genToken(32);
  const db = seedBankingDb(reauthRaw, sessionRaw);
  const log = { writes: [] };
  const original = global.fetch;
  global.fetch = makeDbFetch(db, log);
  try {
    const [a, b] = await Promise.all([
      (async () => { const r = fakeRes(); await subHandler(bankingReq(reauthRaw, sessionRaw), r); return r; })(),
      (async () => { const r = fakeRes(); await subHandler(bankingReq(reauthRaw, sessionRaw), r); return r; })(),
    ]);
    assert.equal([a, b].filter((r) => r.statusCode === 200).length, 1, 'exactly one submit succeeds');
    assert.equal([a, b].filter((r) => r.statusCode === 401).length, 1, 'the other is rejected');
    assert.equal(log.writes.filter((w) => w.table === 'sub_banking' && w.consumed === true).length, 1, 'banking applied once');
  } finally {
    global.fetch = original;
  }
});

test('subportal banking: a forged reauth token (hash not on file) is rejected', async () => {
  const reauthRaw = genToken(24);
  const sessionRaw = genToken(32);
  const db = seedBankingDb(reauthRaw, sessionRaw);
  const log = { writes: [] };
  const original = global.fetch;
  global.fetch = makeDbFetch(db, log);
  try {
    const res = fakeRes();
    await subHandler(bankingReq('totally-forged-token', sessionRaw), res);
    assert.equal(res.statusCode, 401, 'forged reauth token rejected');
    assert.equal(log.writes.filter((w) => w.table === 'sub_banking' && w.consumed === true).length, 0, 'no banking applied');
    assert.equal(db.sub_auth_links[0].purpose, 'reauth', 'the real grant was not touched');
  } finally {
    global.fetch = original;
  }
});

test('subportal banking: invalid masked_account is rejected BEFORE the grant is consumed', async () => {
  // Codex review: input validation must happen before consuming the reauth, so
  // a bad value can never burn a valid grant. The RPC is never called.
  const reauthRaw = genToken(24);
  const sessionRaw = genToken(32);
  const db = seedBankingDb(reauthRaw, sessionRaw);
  const log = { writes: [] };
  const original = global.fetch;
  global.fetch = makeDbFetch(db, log);
  try {
    const res = fakeRes();
    await subHandler({
      method: 'POST', query: { action: 'banking' },
      headers: { authorization: `Bearer ${sessionRaw}`, 'x-reauth-token': reauthRaw },
      body: { provider: 'ach', masked_account: '123456789' }, // raw-looking, not masked
    }, res);
    assert.equal(res.statusCode, 400, 'invalid masked value rejected');
    assert.equal(log.writes.filter((w) => w.table === 'sub_banking').length, 0, 'RPC never called');
    assert.equal(db.sub_auth_links[0].purpose, 'reauth', 'grant NOT consumed by an invalid request');
  } finally {
    global.fetch = original;
  }
});

// A fetch that runs the normal stateful DB, but replaces the RPC response body
// with `rpcBody` — for exercising the handler's RPC-result validation.
function makeDbFetchWithRpc(db, log, rpcBody) {
  const base = makeDbFetch(db, log);
  return async (url, opts = {}) => {
    if (String(url).includes('/rest/v1/rpc/consume_sub_reauth_and_apply_banking')) {
      // Consume the grant like a "successful" call would, so we can prove the
      // handler STILL fails closed on a malformed/mismatched body.
      const a = JSON.parse(opts.body || '{}');
      const link = (db.sub_auth_links || []).find((r) => r.token === a.p_token_hash && r.purpose === 'reauth');
      if (link) link.purpose = 'reauth_consumed';
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => rpcBody, text: async () => JSON.stringify(rpcBody) };
    }
    return base(url, opts);
  };
}

for (const [label, rpcBody] of [
  ['null body', null],
  ['array body', [{ ok: true, banking: { id: 'x', sub_id: 'sub-1', accepts_ach: true } }]],
  ['ok not true', { ok: false, banking: { id: 'x', sub_id: 'sub-1', accepts_ach: true } }],
  ['missing banking', { ok: true }],
  ['empty banking id', { ok: true, banking: { id: '', sub_id: 'sub-1', accepts_ach: true } }],
  ['wrong sub_id', { ok: true, banking: { id: 'x', sub_id: 'sub-OTHER', accepts_ach: true } }],
  ['non-boolean accepts_ach', { ok: true, banking: { id: 'x', sub_id: 'sub-1', accepts_ach: 'yes' } }],
]) {
  test(`subportal banking: malformed RPC result (${label}) fails closed with no success audit`, async () => {
    const reauthRaw = genToken(24);
    const sessionRaw = genToken(32);
    const db = seedBankingDb(reauthRaw, sessionRaw);
    const log = { writes: [] };
    const original = global.fetch;
    global.fetch = makeDbFetchWithRpc(db, log, rpcBody);
    try {
      const res = fakeRes();
      await subHandler(bankingReq(reauthRaw, sessionRaw), res);
      assert.equal(res.statusCode, 401, `${label} must fail closed`);
      assert.equal(res.body.ok, false);
      assert.equal(log.writes.filter((w) => w.table === 'sub_audit_log' && /banking_updated/.test(JSON.stringify(w.payload || {}))).length, 0, 'no success audit written');
    } finally {
      global.fetch = original;
    }
  });
}

// =====================================================================
// 3. Rate-limit store failure — FAILS CLOSED
// =====================================================================

test('checkRateLimit fails CLOSED when the store INSERT errors', async () => {
  const supabaseRequest = async (path, opts) => {
    if ((opts && opts.method) === 'POST') return { ok: false, status: 500 };
    return { ok: true, headers: { get: () => null }, json: async () => [] };
  };
  const r = await checkRateLimit({ bucket: 'b', identifier: 'ip', deps: { supabaseRequest } });
  assert.equal(r.allowed, false, 'store insert failure denies the request');
  assert.equal(r.reason, 'store-error');
});

test('checkRateLimit fails CLOSED when the count SELECT errors', async () => {
  const supabaseRequest = async (path, opts) => {
    if ((opts && opts.method) === 'POST') return { ok: true };
    return { ok: false, status: 500 }; // the count GET fails
  };
  const r = await checkRateLimit({ bucket: 'b', identifier: 'ip', deps: { supabaseRequest } });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'store-error');
});

test('checkRateLimit fails CLOSED when the store THROWS', async () => {
  const supabaseRequest = async () => { throw new Error('connection refused'); };
  const r = await checkRateLimit({ bucket: 'b', identifier: 'ip', deps: { supabaseRequest } });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'store-exception');
});

test('checkRateLimit still ALLOWS under the limit when the store is healthy', async () => {
  let n = 0;
  const supabaseRequest = async (path, opts) => {
    if ((opts && opts.method) === 'POST') return { ok: true };
    n += 1;
    return { ok: true, headers: { get: (h) => (h === 'content-range' ? `0-0/${n}` : null) }, json: async () => [] };
  };
  const r = await checkRateLimit({ bucket: 'b', identifier: 'ip', limit: 5, deps: { supabaseRequest } });
  assert.equal(r.allowed, true);
});

test('clientportal login_link returns 429 when the rate-limit store fails (fail-closed, still non-enumerating)', withDb({}, async ({ db }) => {
  // Make ONLY the rate-limit store fail; everything else is healthy.
  const original = global.fetch;
  const baseFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/portal_rate_limits')) {
      return { ok: false, status: 500, headers: { get: () => null }, json: async () => [], text: async () => '[]' };
    }
    return baseFetch(url, opts);
  };
  try {
    const res = fakeRes();
    await clientHandler({ method: 'POST', query: { action: 'login_link' }, headers: { 'x-forwarded-for': '9.9.9.9' }, body: { email: 'victim@example.com' } }, res);
    assert.equal(res.statusCode, 429, 'store outage denies rather than dropping the throttle');
    assert.equal(res.body.ok, false);
  } finally {
    global.fetch = original;
  }
}));
