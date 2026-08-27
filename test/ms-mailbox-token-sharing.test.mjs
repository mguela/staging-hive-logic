// test/ms-mailbox-token-sharing.test.mjs
//
// Two routes now mint Microsoft access tokens from the same hc_ms_tokens rows:
// /api/msmail (the HiveConnect Email UI's token endpoint) and /api/track1's
// "Emails awaiting reply" detection. Microsoft ROTATES refresh tokens -- each
// refresh returns a new one and kills the old -- so two implementations that
// drift apart do not fail loudly. They silently disconnect a mailbox and ask
// the user to sign in again, which is indistinguishable from "my email broke".
//
// api/_lib/ms-mailbox-tokens.js is the single implementation. These tests hold
// the two things a future edit could quietly break:
//   1. the refresh/rotation/freshness behaviour itself, and
//   2. the OAuth client constants, which msmail.js must keep its own copies of
//      (it is CommonJS and needs them synchronously for the authorize URL).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.MS_CLIENT_SECRET = 'test-ms-client-secret';

const mod = await import('../api/_lib/ms-mailbox-tokens.js');
const msmailSrc = readFileSync(new URL('../api/msmail.js', import.meta.url), 'utf-8');

function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}
async function withMockedFetch(handler, fn) {
  const original = global.fetch;
  global.fetch = handler;
  try { return await fn(); } finally { global.fetch = original; }
}
const identity = { encryptSecret: (v) => v, decryptSecret: (v) => v };
const future = (mins) => new Date(Date.now() + mins * 60000).toISOString();

// ---- constants must agree across the CJS/ESM boundary ------------------------

test('msmail.js and the shared module pin the SAME app registration (and the same env var override)', () => {
  assert.ok(/process\.env\.MS_MAILBOX_CLIENT_ID/.test(msmailSrc),
    'msmail.js must read the same override var as the shared module, or a staging deployment can only fix one of the two');
  const m = /\|\| '([0-9a-f-]+)'/.exec(msmailSrc);
  assert.ok(m, 'sanity: msmail.js declares a fallback CLIENT_ID');
  assert.equal(m[1], mod.msMailboxClientId(),
    'the tokens in hc_ms_tokens were issued to one app; refreshing them against another fails with AADSTS7000215');
});

test('msmail.js and the shared module request the SAME scopes', () => {
  const m = /const SCOPES = '([^']+)'/.exec(msmailSrc);
  assert.ok(m, 'sanity: msmail.js declares SCOPES');
  assert.equal(m[1], mod.MS_MAILBOX_SCOPES,
    'a refresh that asks for different scopes than the grant was issued with can be rejected outright');
});

test('msmail.js and the shared module resolve the same tenant and redirect URI', () => {
  assert.ok(/process\.env\.MS_TENANT \|\| 'organizations'/.test(msmailSrc));
  assert.equal(mod.msMailboxTenant(), 'organizations');
  assert.ok(/process\.env\.MS_REDIRECT_URI \|\| 'https:\/\/hivelogic-live\.vercel\.app\/api\/msmail'/.test(msmailSrc));
  assert.equal(mod.msMailboxRedirectUri(), 'https://hivelogic-live.vercel.app/api/msmail');
});

test('msmail.js delegates its refresh to the shared module rather than keeping a second copy', () => {
  assert.match(msmailSrc, /import\('\.\/_lib\/ms-mailbox-tokens\.js'\)/,
    'the token endpoint must go through the shared implementation');
  const tokenAction = msmailSrc.slice(msmailSrc.indexOf("if (action === 'token')"), msmailSrc.indexOf("if (action === 'disconnect')"));
  assert.ok(!/grant_type: 'refresh_token'/.test(tokenAction),
    'a second refresh implementation here is exactly the drift this module exists to prevent');
});

// ---- the behaviour itself ----------------------------------------------------

test('a token with plenty of life left is used as-is -- no call to Microsoft', async () => {
  const row = { access_token: 'live-access', refresh_token: 'r', expires_at: future(60) };
  const out = await withMockedFetch(
    async (u) => { throw new Error('must not call ' + u); },
    () => mod.mailboxAccessToken(row, identity)
  );
  assert.equal(out.accessToken, 'live-access');
  assert.equal(out.refreshed, false);
});

test('a token inside the 5-minute margin is refreshed BEFORE it expires', async () => {
  // Expiring in 2 minutes is still "valid", and still useless: a request that
  // starts now can finish after it dies.
  const row = { access_token: 'nearly-dead', refresh_token: 'r-1', expires_at: future(2) };
  let called = 0;
  const out = await withMockedFetch(
    async () => { called++; return jsonRes({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }); },
    () => mod.mailboxAccessToken(row, identity)
  );
  assert.equal(called, 1);
  assert.equal(out.accessToken, 'new-access');
  assert.equal(out.refreshed, true);
});

test('the rotated refresh token is handed to the caller to persist', async () => {
  const row = { access_token: 'stale', refresh_token: 'old-refresh', expires_at: future(-10) };
  const patches = [];
  const out = await withMockedFetch(
    async () => jsonRes({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
    () => mod.mailboxAccessToken(row, { ...identity, patchTokens: (p) => { patches.push(p); } })
  );
  assert.equal(patches.length, 1);
  assert.equal(patches[0].refresh_token, 'new-refresh', 'the OLD refresh token is dead the moment this succeeds');
  assert.equal(patches[0].access_token, 'new-access');
  assert.ok(patches[0].expires_at && patches[0].updated_at);
  assert.equal(out.accessToken, 'new-access');
});

test('a response with no new refresh token leaves the stored one alone', async () => {
  // Microsoft does not always rotate. Writing `undefined` over a working
  // refresh token would disconnect the mailbox for no reason.
  const row = { access_token: 'stale', refresh_token: 'keep-me', expires_at: future(-10) };
  const patches = [];
  await withMockedFetch(
    async () => jsonRes({ access_token: 'new-access', expires_in: 3600 }),
    () => mod.mailboxAccessToken(row, { ...identity, patchTokens: (p) => { patches.push(p); } })
  );
  assert.ok(!('refresh_token' in patches[0]), 'no rotation means no write to that column');
});

test('the decrypted refresh token is what goes to Microsoft, never the ciphertext', async () => {
  const row = { access_token: 'enc:v1:aaa', refresh_token: 'enc:v1:bbb', expires_at: future(-10) };
  let body = '';
  await withMockedFetch(
    async (url, opts) => { body = String(opts.body); return jsonRes({ access_token: 'a', refresh_token: 'b', expires_in: 3600 }); },
    () => mod.mailboxAccessToken(row, {
      encryptSecret: (v) => 'enc:v1:' + v,
      decryptSecret: (v) => String(v).replace(/^enc:v1:/, 'PLAIN-'),
    })
  );
  assert.match(body, /refresh_token=PLAIN-bbb/);
  assert.ok(!body.includes('enc%3Av1'), 'ciphertext must never be sent as a credential');
});

test('invalid_grant is reported as "needs re-authentication", not as a generic outage', async () => {
  const row = { access_token: 'stale', refresh_token: 'dead', expires_at: future(-10) };
  await assert.rejects(
    () => withMockedFetch(
      async () => jsonRes({ error: 'invalid_grant', error_description: 'token expired' }, 400),
      () => mod.mailboxAccessToken(row, identity)
    ),
    (e) => e.reauth === true && /token expired/.test(e.message)
  );
});

test('a Microsoft outage is NOT reported as needing re-authentication', async () => {
  // Telling someone to reconnect a mailbox that is fine sends them off to redo
  // an OAuth flow for nothing.
  const row = { access_token: 'stale', refresh_token: 'r', expires_at: future(-10) };
  await assert.rejects(
    () => withMockedFetch(
      async () => jsonRes({ error: 'temporarily_unavailable' }, 503),
      () => mod.mailboxAccessToken(row, identity)
    ),
    (e) => !e.reauth
  );
});

test('a row with no refresh token asks for re-authentication instead of calling Microsoft', async () => {
  const row = { access_token: null, refresh_token: null, expires_at: future(-10) };
  await assert.rejects(
    () => withMockedFetch(
      async (u) => { throw new Error('must not call ' + u); },
      () => mod.mailboxAccessToken(row, identity)
    ),
    (e) => e.reauth === true
  );
});
