// test/msmail-token-encryption.test.mjs
// hc_ms_tokens held Microsoft refresh/access tokens in plaintext (2026-08-06
// fix) -- api/_lib/secrets.js already encrypts the main `integrations`
// table's Jobber/QBO/TikTok tokens; this table was missed. Proves:
//   1. A new token save (OAuth callback) writes ENCRYPTED values.
//   2. Reading a fresh, encrypted row decrypts correctly and never leaks
//      ciphertext back to the caller as a "working" access token.
//   3. A refresh cycle sends the DECRYPTED refresh token to Microsoft (not
//      ciphertext) and re-encrypts the new tokens before the PATCH.
//   4. A pre-existing PLAINTEXT row (written before this fix) still works --
//      decryptSecret()'s documented passthrough behavior.
// Fully mocked -- no network, no DB, no real secret.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.MS_CLIENT_SECRET = 'test-ms-client-secret';
process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.TOKEN_ENC_KEY = crypto.randomBytes(32).toString('base64');
delete process.env.TOKEN_ENC_WRITE_VERSION;

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeIdToken(claims) {
  return `${b64url({ alg: 'none' })}.${b64url(claims)}.sig`;
}

function res() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
  };
}

// In-memory stand-in for the hc_ms_tokens row, mutated by dbFetch mocks below.
let storedRow = null;

function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

async function withMockedFetch({ msTokenResponse } = {}, fn) {
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1' });
    if (u.includes('login.microsoftonline.com')) {
      return jsonRes(msTokenResponse || { access_token: 'ms-access-1', refresh_token: 'ms-refresh-1', expires_in: 3600 });
    }
    if (u.includes('/rest/v1/hc_ms_tokens')) {
      const method = opts.method || 'GET';
      if (method === 'POST') {
        const body = JSON.parse(opts.body);
        storedRow = { ...(storedRow || {}), ...body[0] };
        return jsonRes(null, 204);
      }
      if (method === 'PATCH') {
        const body = JSON.parse(opts.body);
        storedRow = { ...(storedRow || {}), ...body };
        return jsonRes(null, 204);
      }
      // GET
      return jsonRes(storedRow ? [storedRow] : []);
    }
    if (u.includes('/rest/v1/hc_mailbox_links')) return jsonRes(null, 204);
    throw new Error('unexpected fetch: ' + u);
  };
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

async function callMsmail({ action, method = 'POST', body = {}, auth = 'Bearer usertoken' }) {
  const mod = await import('../api/msmail.js');
  const handler = mod.default;
  const req = { method, query: { action }, headers: { authorization: auth }, body };
  const r = res();
  await handler(req, r);
  return r;
}

test('OAuth callback (saveTokens) writes refresh_token/access_token ENCRYPTED, not plaintext', async () => {
  storedRow = null;
  const idToken = fakeIdToken({ oid: 'oid-1', tid: 'tid-1', preferred_username: 'a@b.com', name: 'A B' });
  await withMockedFetch({ msTokenResponse: { access_token: 'real-access-value', refresh_token: 'real-refresh-value', id_token: idToken, expires_in: 3600 } }, async () => {
    // Real 'start' -> real signed state -> real 'callback', so this exercises
    // the actual saveTokens() code path (not a hand-rolled stand-in).
    const startRes = await callMsmail({ action: 'start' });
    assert.equal(startRes.statusCode, 200);
    const state = new URL(startRes.body.url, 'https://x').searchParams.get('state');

    const mod = await import('../api/msmail.js');
    const req = { method: 'GET', query: { action: 'callback', code: 'auth-code-1', state }, headers: {} };
    const r = res();
    await mod.default(req, r);
    assert.equal(r.statusCode, 200);
  });

  assert.ok(storedRow, 'saveTokens should have written a row');
  assert.match(storedRow.refresh_token, /^enc:v1:/, 'reader-first rollout must preserve the deployed v1 write format');
  assert.match(storedRow.access_token, /^enc:v1:/, 'reader-first rollout must preserve the deployed v1 write format');
  assert.notEqual(storedRow.refresh_token, 'real-refresh-value');
  assert.notEqual(storedRow.access_token, 'real-access-value');
});

test('token action: a fresh encrypted row decrypts to the real access token, never returns ciphertext', async () => {
  const { encryptSecret } = await import('../api/_lib/secrets.js');
  storedRow = {
    owner_id: 'user-1',
    home_account_id: 'acct-1',
    username: 'a@b.com',
    name: 'A B',
    refresh_token: encryptSecret('real-refresh-value'),
    access_token: encryptSecret('real-access-value'),
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(), // still fresh -- no MS call needed
  };
  const r = await withMockedFetch({}, () => callMsmail({ action: 'token', body: { homeAccountId: 'acct-1' } }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.accessToken, 'real-access-value');
  assert.notEqual(r.body.accessToken, storedRow.access_token);
});

test('token action: refresh sends the DECRYPTED refresh token to Microsoft, and re-encrypts the new tokens on write', async () => {
  const { encryptSecret, isEncrypted } = await import('../api/_lib/secrets.js');
  storedRow = {
    owner_id: 'user-1',
    home_account_id: 'acct-1',
    username: 'a@b.com',
    name: 'A B',
    refresh_token: encryptSecret('real-refresh-value'),
    access_token: encryptSecret('stale-access-value'),
    expires_at: new Date(Date.now() - 1000).toISOString(), // expired -- forces a refresh
  };

  let sentRefreshToken = null;
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1' });
    if (u.includes('login.microsoftonline.com')) {
      sentRefreshToken = new URLSearchParams(opts.body).get('refresh_token');
      return jsonRes({ access_token: 'new-access-value', refresh_token: 'new-refresh-value', expires_in: 3600 });
    }
    if (u.includes('/rest/v1/hc_ms_tokens')) {
      const method = opts.method || 'GET';
      if (method === 'PATCH') { storedRow = { ...storedRow, ...JSON.parse(opts.body) }; return jsonRes(null, 204); }
      return jsonRes([storedRow]);
    }
    throw new Error('unexpected fetch: ' + u);
  };
  try {
    const r = await callMsmail({ action: 'token', body: { homeAccountId: 'acct-1' } });
    assert.equal(sentRefreshToken, 'real-refresh-value', 'Microsoft must receive the plaintext refresh token, not ciphertext');
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.accessToken, 'new-access-value');
    assert.ok(isEncrypted(storedRow.access_token), 'the newly-patched access_token must be stored encrypted');
    assert.ok(isEncrypted(storedRow.refresh_token), 'the newly-patched refresh_token must be stored encrypted');
  } finally {
    global.fetch = original;
  }
});

test('token action: a pre-existing PLAINTEXT row (written before this fix) still works', async () => {
  storedRow = {
    owner_id: 'user-1',
    home_account_id: 'acct-1',
    username: 'a@b.com',
    name: 'A B',
    refresh_token: 'legacy-plaintext-refresh',
    access_token: 'legacy-plaintext-access',
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
  };
  const r = await withMockedFetch({}, () => callMsmail({ action: 'token', body: { homeAccountId: 'acct-1' } }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.accessToken, 'legacy-plaintext-access');
});

test('diagnostics reject an anonymous caller before probing Microsoft', async () => {
  let calls = 0;
  const original = global.fetch;
  global.fetch = async () => { calls += 1; throw new Error('anonymous diagnostics must not call upstream'); };
  try {
    const r = await callMsmail({ action: 'diag', method: 'GET', auth: '' });
    assert.equal(r.statusCode, 401);
    assert.equal(calls, 0);
  } finally {
    global.fetch = original;
  }
});

test('authenticated diagnostics never return client-secret prefix or length metadata', async () => {
  const original = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) return jsonRes({ id: 'user-1' });
    if (String(url).includes('login.microsoftonline.com')) {
      return jsonRes({ error: 'invalid_grant', error_description: 'AADSTS70000: expected diagnostic rejection' }, 400);
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    const r = await callMsmail({ action: 'diag', method: 'GET' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.secretValid, true);
    assert.equal('secretPrefix' in r.body, false);
    assert.equal('secretLen' in r.body, false);
    assert.equal(JSON.stringify(r.body).includes('test-ms-client-secret'), false);
  } finally {
    global.fetch = original;
  }
});
