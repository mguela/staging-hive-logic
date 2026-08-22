// test/portal-login-bypass.test.mjs
// Item 1 (2026-08-01): proves the public portal recovery endpoints can no
// longer be used to take over an account by knowing someone else's email or
// phone. Every scenario is fully mocked — no real network, no real database,
// no real secret. Run with:  node --test test/portal-login-bypass.test.mjs
//
// The old hole: POST /api/clientportal?action=login_link with any known email
// returned a WORKING magic-link URL right in the JSON response (and 404'd for
// unknown emails, leaking who is/isn't a client). The sub portal did the same
// with email OR phone. These tests assert the fix:
//   - no link/token/sessionToken ever appears in the response body
//   - the response is byte-identical whether or not the account exists
//   - the link, when created, is EMAILED to the ON-FILE address (the real
//     owner), never the response and never an attacker-chosen address
//   - magic-link + session tokens are stored HASHED, so a redeem requires the
//     raw token (a leaked DB row is not a usable credential)

import test from 'node:test';
import assert from 'node:assert/strict';

import clientHandler from '../api/clientportal.js';
import subHandler from '../api/subportal.js';
import { genToken, hashToken, safeEqualHex, checkRateLimit, deliverLoginLink } from '../api/_lib/portal-auth.js';

// --- shared test env -------------------------------------------------------
process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key-test';
process.env.RESEND_API_KEY = 'resend-key-test'; // email "configured" so delivery is possible

const SUPA = 'https://supabase.test';

function fakeRes() {
  const calls = [];
  const res = {
    calls,
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; calls.push({ code }); return this; },
    json(body) { this.body = body; calls.push({ body }); return this; },
  };
  return res;
}

// A programmable fetch that records what it saw and answers by URL. `db`
// supplies rows for GET selects; `sent` captures Resend emails and any
// token-bearing writes so tests can inspect what got stored/sent.
function makeFetch({ rows = {}, onPatch, sent }) {
  return async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();

    // Resend email send
    if (u.startsWith('https://api.resend.com/')) {
      const payload = JSON.parse(opts.body || '{}');
      sent.emails.push(payload);
      return { ok: true, json: async () => ({ id: 'email_1' }), text: async () => '{"id":"email_1"}' };
    }

    // Supabase auth (not used by login_link/redeem, but keep it safe)
    if (u.includes('/auth/v1/user')) {
      return { ok: true, json: async () => ({ id: 'staff-1', email: 's@test' }) };
    }

    // Supabase REST
    if (u.includes('/rest/v1/')) {
      const path = u.split('/rest/v1/')[1];
      const table = path.split('?')[0];

      if (method === 'POST') {
        const payload = opts.body ? JSON.parse(opts.body) : {};
        sent.writes.push({ table, payload });
        // rate-limit counter insert -> ok
        return { ok: true, json: async () => [payload], text: async () => JSON.stringify([payload]) };
      }
      if (method === 'PATCH') {
        // Redeem now claims the auth link with a single conditional UPDATE
        // (used_at IS NULL guard) instead of select-then-PATCH, so PATCH must
        // model affected-row semantics: the handler decides which rows the
        // UPDATE matched. Default (no handler) = 1 empty row, preserving the
        // old "some row updated" behavior for tests that don't care.
        const body = opts.body ? JSON.parse(opts.body) : {};
        sent.writes.push({ table, path, method: 'PATCH', payload: body });
        const result = onPatch ? onPatch({ table, path, body }) : [{}];
        return { ok: true, headers: { get: () => null }, json: async () => result, text: async () => JSON.stringify(result) };
      }
      // GET
      if (table === 'portal_rate_limits') {
        // small count, under limit
        return {
          ok: true,
          headers: { get: (h) => (h === 'content-range' ? '0-0/1' : null) },
          json: async () => [{ id: 1 }],
          text: async () => '[{"id":1}]',
        };
      }
      const provider = rows[table];
      const data = typeof provider === 'function' ? provider(path) : (provider || []);
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => data,
        text: async () => JSON.stringify(data),
      };
    }

    throw new Error('unexpected fetch to ' + u);
  };
}

function withFetch(fn, cfg) {
  return async () => {
    const original = global.fetch;
    const sent = { emails: [], writes: [] };
    global.fetch = makeFetch({ ...cfg, sent });
    try {
      return await fn(sent);
    } finally {
      global.fetch = original;
    }
  };
}

// =====================================================================
// 1. Pure lib primitives
// =====================================================================

test('hashToken is deterministic, hex, and never equals the raw token', () => {
  const raw = genToken(24);
  const h = hashToken(raw);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(hashToken(raw), h);
  assert.notEqual(h, raw);
});

test('genToken returns a fresh high-entropy hex token each call', () => {
  const a = genToken(32);
  const b = genToken(32);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('safeEqualHex is true for equal hashes, false otherwise', () => {
  const h = hashToken('x');
  assert.equal(safeEqualHex(h, hashToken('x')), true);
  assert.equal(safeEqualHex(h, hashToken('y')), false);
  assert.equal(safeEqualHex('', ''), false);
});

test('checkRateLimit fails CLOSED when no store is provided (no opt-out)', async () => {
  // Corrected 2026-08-02 (Codex review of PR #43): a missing store used to
  // ALLOW, which left an auth-sensitive endpoint unthrottled. It now always
  // DENIES — the previous `allowMissingStore` opt-out has been removed, so no
  // caller (test or production) can turn throttling off by omitting the store.
  const r = await checkRateLimit({ bucket: 'b', identifier: 'ip', deps: {} });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'no-store');
});

test('checkRateLimit blocks once attempts exceed the limit', async () => {
  let n = 0;
  const supabaseRequest = async (path, opts) => {
    if ((opts && opts.method) === 'POST') return { ok: true };
    n += 1; // each count GET returns the running total
    return { ok: true, headers: { get: (h) => (h === 'content-range' ? `0-0/${n}` : null) }, json: async () => [] };
  };
  const call = () => checkRateLimit({ bucket: 'b', identifier: 'ip', limit: 3, deps: { supabaseRequest } });
  assert.equal((await call()).allowed, true);  // count 1
  assert.equal((await call()).allowed, true);  // count 2
  assert.equal((await call()).allowed, true);  // count 3
  assert.equal((await call()).allowed, false); // count 4 > 3
});

test('deliverLoginLink does not deliver when email is unavailable', async () => {
  const r = await deliverLoginLink({ email: null, url: 'https://x/y', deps: { isEmailConfigured: () => true, sendEmail: async () => ({ ok: true }) } });
  assert.equal(r.delivered, false);
});

test('deliverLoginLink does not deliver when email is not configured', async () => {
  const r = await deliverLoginLink({ email: 'a@b.com', url: 'https://x/y', deps: { isEmailConfigured: () => false, sendEmail: async () => ({ ok: true }) } });
  assert.equal(r.delivered, false);
});

// =====================================================================
// 2. Client portal — public login_link recovery
// =====================================================================

const CLIENT_ROW = { jobber_id: 'client-123', name: 'Real Client', email: 'victim@example.com', balance: 0 };

test('clientportal login_link never returns a link/token, even for a real email', withFetch(async (sent) => {
  const req = { method: 'POST', query: { action: 'login_link' }, headers: { 'x-forwarded-for': '9.9.9.9' }, body: { email: 'victim@example.com' } };
  const res = fakeRes();
  await clientHandler(req, res);

  assert.equal(res.statusCode, 200);
  const bodyStr = JSON.stringify(res.body);
  assert.equal(res.body.link, undefined, 'no link field');
  assert.equal(res.body.token, undefined, 'no token field');
  assert.equal(res.body.sessionToken, undefined, 'no sessionToken field');
  assert.ok(!/clientportal\/\?token=/.test(bodyStr), 'no magic-link URL anywhere in body');
  // The link WAS emailed to the on-file address (the real owner), not returned.
  assert.equal(sent.emails.length, 1);
  assert.equal(sent.emails[0].to[0], 'victim@example.com');
}, { rows: { clients: [CLIENT_ROW] } }));

test('clientportal login_link is non-enumerating: identical response for unknown email', withFetch(async (sent) => {
  const req = { method: 'POST', query: { action: 'login_link' }, headers: { 'x-forwarded-for': '9.9.9.9' }, body: { email: 'nobody@example.com' } };
  const res = fakeRes();
  await clientHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(sent.emails.length, 0, 'no email for a non-existent account');
  // Response is exactly the generic message — same as the real-email case.
  assert.deepEqual(res.body, {
    ok: true,
    message: 'If that email is on file, a sign-in link has been sent to it. Check your inbox, then come back here.',
  });
}, { rows: { clients: [] } }));

test('clientportal login_link stores the magic-link token HASHED, not raw', withFetch(async (sent) => {
  const req = { method: 'POST', query: { action: 'login_link' }, headers: { 'x-forwarded-for': '1.1.1.1' }, body: { email: 'victim@example.com' } };
  const res = fakeRes();
  await clientHandler(req, res);
  const write = sent.writes.find((w) => w.table === 'client_auth_links');
  assert.ok(write, 'a client_auth_links row was written');
  assert.match(write.payload.token, /^[0-9a-f]{64}$/, 'stored token is a sha256 hash');
  // And the emailed URL carries a raw token whose hash equals what was stored.
  const emailedUrl = sent.emails[0].text.match(/https?:\/\/\S+\?token=([0-9a-f]+)/)[1];
  assert.equal(hashToken(emailedUrl), write.payload.token, 'stored hash matches the emailed raw token');
}, { rows: { clients: [CLIENT_ROW] } }));

// =====================================================================
// 3. Client portal — redeem atomically claims the link by token HASH
// =====================================================================
//
// Redeem now consumes the magic link with a SINGLE conditional UPDATE guarded
// on `used_at IS NULL` (addressed by the token hash), and only an affected-row
// count of exactly 1 may mint a session. `singleUseClaim` models that at the
// DB boundary: the first matching PATCH returns 1 row; any later PATCH (row
// already used) returns 0 — the same guarantee Postgres row locking gives.

const REDEEM_RAW = genToken(24);

// A PATCH handler that grants a single-use claim on `table` for links whose
// query carries `expectHash` and the `used_at=is.null` guard. Returns the
// claimed row exactly once, then an empty set forever after.
function singleUseClaim(table, expectHash, row) {
  let claimed = false;
  return ({ table: t, path }) => {
    if (t !== table) return [{}];
    if (claimed) return [];
    if (!path.includes(`token=eq.${expectHash}`)) return [];
    if (!path.includes('used_at=is.null')) return [];
    claimed = true;
    return [{ ...row, used_at: new Date().toISOString() }];
  };
}

test('clientportal redeem atomically claims the link by hash and mints a hashed session', withFetch(async (sent) => {
  const req = { method: 'GET', query: { action: 'redeem', token: REDEEM_RAW }, headers: {} };
  const res = fakeRes();
  await clientHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.sessionToken, /^[0-9a-f]{64}$/, 'raw session token returned to the caller');
  const sess = sent.writes.find((w) => w.table === 'client_sessions');
  assert.equal(sess.payload.token, hashToken(res.body.sessionToken), 'session stored as hash of the returned raw token');
  // The redemption was a conditional UPDATE addressed by the token HASH and
  // guarded on used_at IS NULL — never a raw-token lookup, never a blind PATCH.
  const claim = sent.writes.find((w) => w.table === 'client_auth_links' && w.method === 'PATCH');
  assert.ok(claim, 'redeem issued a PATCH claim on client_auth_links');
  assert.ok(claim.path.includes(`token=eq.${hashToken(REDEEM_RAW)}`), 'claim addressed by token hash');
  assert.ok(claim.path.includes('used_at=is.null'), 'claim guarded on used_at IS NULL');
  assert.equal(claim.payload.used_at !== undefined, true, 'claim sets used_at');
}, {
  rows: { clients: [CLIENT_ROW] },
  onPatch: singleUseClaim('client_auth_links', hashToken(REDEEM_RAW), { id: 'link-1', client_ref: 'client-123', purpose: 'login' }),
}));

test('clientportal redeem rejects an unknown/forged token (claim matches 0 rows)', withFetch(async () => {
  const req = { method: 'GET', query: { action: 'redeem', token: 'forged-token-not-in-db' }, headers: {} };
  const res = fakeRes();
  await clientHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  // A forged token's hash matches no row, so the conditional UPDATE affects 0
  // rows and the handler refuses to mint.
}, { onPatch: () => [] }));

// =====================================================================
// 4. Sub portal — same guarantees (email OR phone lookup)
// =====================================================================

const SUB_ROW = { id: 'sub-1', company_name: 'Real Sub', email: 'sub-victim@example.com', phone: '5551234567' };

test('subportal login_link never returns a link/token for a real email', withFetch(async (sent) => {
  const req = { method: 'POST', query: { action: 'login_link' }, headers: { 'x-forwarded-for': '2.2.2.2' }, body: { phone_or_email: 'sub-victim@example.com' } };
  const res = fakeRes();
  await subHandler(req, res);
  assert.equal(res.statusCode, 200);
  const bodyStr = JSON.stringify(res.body);
  assert.equal(res.body.link, undefined);
  assert.ok(!/subportal\/\?token=/.test(bodyStr), 'no magic-link URL in body');
  assert.equal(sent.emails[0].to[0], 'sub-victim@example.com', 'emailed to on-file address');
}, { rows: { subs: [SUB_ROW] } }));

test('subportal login_link by PHONE reveals nothing and returns no link', withFetch(async (sent) => {
  const req = { method: 'POST', query: { action: 'login_link' }, headers: { 'x-forwarded-for': '2.2.2.2' }, body: { phone_or_email: '5551234567' } };
  const res = fakeRes();
  await subHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.link, undefined);
  // A match by phone still delivers to the on-file EMAIL, never the response.
  assert.equal(sent.emails.length, 1);
  assert.equal(sent.emails[0].to[0], 'sub-victim@example.com');
}, { rows: { subs: [SUB_ROW] } }));

test('subportal login_link is non-enumerating for an unknown contact', withFetch(async (sent) => {
  const req = { method: 'POST', query: { action: 'login_link' }, headers: { 'x-forwarded-for': '2.2.2.2' }, body: { phone_or_email: 'ghost@example.com' } };
  const res = fakeRes();
  await subHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(sent.emails.length, 0);
  assert.deepEqual(res.body, {
    ok: true,
    message: 'If that contact is on file, a sign-in link has been sent to the email we have for it. Check your inbox, then come back here.',
  });
}, { rows: { subs: [] } }));

// =====================================================================
// 5. Sub portal — reauth_start is OUT-OF-BAND (Codex review of PR #43)
// =====================================================================
// A signed-in sub requests a banking re-verification. The browser must NEVER
// receive the token/URL; the one-time challenge goes only to the SERVER-STORED
// email. A stolen session therefore cannot reauthenticate itself.

const SUB_SESSION_ROWS = {
  sub_sessions: [{ id: 'sess-1', sub_id: 'sub-1', revoked_at: null }],
  subs: [{ id: 'sub-1', company_name: 'Real Sub', email: 'sub-victim@example.com', phone: '5551234567' }],
};

test('subportal reauth_start delivers out-of-band to the on-file email and never returns the token/URL', withFetch(async (sent) => {
  const req = { method: 'POST', query: { action: 'reauth_start' }, headers: { authorization: 'Bearer sess-token', 'x-forwarded-for': '3.3.3.3' } };
  const res = fakeRes();
  await subHandler(req, res);
  assert.equal(res.statusCode, 200);
  const bodyStr = JSON.stringify(res.body);
  // The requesting browser NEVER receives a token or reauth URL.
  assert.equal(res.body.reauthUrl, undefined, 'no reauthUrl in body');
  assert.equal(res.body.token, undefined, 'no token field in body');
  assert.equal(res.body.sessionToken, undefined);
  assert.ok(!/token=/.test(bodyStr), 'no token anywhere in body');
  assert.ok(!/subportal\/\?/.test(bodyStr), 'no URL anywhere in body');
  // Delivered to the SERVER-STORED email, never a client-chosen address.
  assert.equal(sent.emails.length, 1);
  assert.equal(sent.emails[0].to[0], 'sub-victim@example.com');
  // The stored grant is a HASHED reauth token whose hash matches the emailed raw token.
  const write = sent.writes.find((w) => w.table === 'sub_auth_links');
  assert.ok(write, 'a reauth grant was stored');
  assert.equal(write.payload.purpose, 'reauth');
  assert.match(write.payload.token, /^[0-9a-f]{64}$/, 'stored token is a sha256 hash');
  const emailedToken = sent.emails[0].text.match(/token=([0-9a-f]+)/)[1];
  assert.equal(hashToken(emailedToken), write.payload.token, 'stored hash matches the emailed raw token');
}, { rows: SUB_SESSION_ROWS }));

test('subportal reauth_start stores NO grant and returns generic when delivery fails', withFetch(async (sent) => {
  const saved = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY; // email not configured -> not deliverable
  try {
    const req = { method: 'POST', query: { action: 'reauth_start' }, headers: { authorization: 'Bearer sess-token', 'x-forwarded-for': '3.3.3.3' } };
    const res = fakeRes();
    await subHandler(req, res);
    assert.equal(res.statusCode, 200, 'still generic on delivery failure');
    assert.equal(sent.emails.length, 0, 'nothing delivered');
    assert.equal(sent.writes.filter((w) => w.table === 'sub_auth_links').length, 0, 'NO reauth grant persisted on delivery failure');
    assert.ok(!/token=/.test(JSON.stringify(res.body)), 'no token fallback in the body');
  } finally {
    process.env.RESEND_API_KEY = saved;
  }
}, { rows: SUB_SESSION_ROWS }));

test('subportal reauth_start requires a signed-in sub session', withFetch(async () => {
  const req = { method: 'POST', query: { action: 'reauth_start' }, headers: {} }; // no bearer
  const res = fakeRes();
  await subHandler(req, res);
  assert.equal(res.statusCode, 401, 'no session -> 401, no challenge issued');
}, { rows: SUB_SESSION_ROWS }));
