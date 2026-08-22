// test/webhook-secrets.test.mjs
// Item 6 (2026-08-01): secrets no longer travel in URLs.
//   - Resend webhook now verifies a real Svix signature over the RAW body
//     (was a ?secret= query param).
//   - Cron endpoints accept CRON_SECRET only via the Authorization header,
//     timing-safe, fail-closed (was ?key= too).
// Fully local; no network. Run: node --test test/webhook-secrets.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { verifySvixSignature } from '../api/resend-webhook.js';
import resendHandler from '../api/resend-webhook.js';
import { checkCronSecret } from '../api/_lib/guard.js';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'svc';

// Build a valid Svix signature for a body with a given secret + timestamp.
const SECRET = 'whsec_' + Buffer.from('a-32-byte-ish-signing-secret!!').toString('base64');
function sign(body, { ts = Math.floor(Date.now() / 1000), id = 'msg_test' } = {}) {
  const keyBytes = Buffer.from(SECRET.slice('whsec_'.length), 'base64');
  const signed = `${id}.${ts}.${body}`;
  const sig = crypto.createHmac('sha256', keyBytes).update(signed).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': 'v1,' + sig };
}

// ---- Svix verification (pure) ----

test('valid Svix signature verifies', () => {
  const body = JSON.stringify({ type: 'email.bounced', data: { to: ['x@y.com'] } });
  assert.equal(verifySvixSignature(Buffer.from(body), sign(body), SECRET), true);
});

test('a tampered body fails verification', () => {
  const body = JSON.stringify({ type: 'email.bounced' });
  const headers = sign(body);
  assert.equal(verifySvixSignature(Buffer.from(body + 'x'), headers, SECRET), false);
});

test('a wrong signature fails', () => {
  const body = 'hello';
  const headers = sign(body);
  headers['svix-signature'] = 'v1,' + Buffer.from('nope').toString('base64');
  assert.equal(verifySvixSignature(Buffer.from(body), headers, SECRET), false);
});

test('missing svix headers fail', () => {
  assert.equal(verifySvixSignature(Buffer.from('x'), {}, SECRET), false);
});

test('an expired timestamp (>5 min) is rejected (replay guard)', () => {
  const body = 'x';
  const old = Math.floor(Date.now() / 1000) - 600;
  assert.equal(verifySvixSignature(Buffer.from(body), sign(body, { ts: old }), SECRET), false);
});

// ---- Resend handler ----

function mockReq({ method = 'POST', headers = {}, body = '' }) {
  return {
    method,
    headers,
    on(evt, cb) {
      if (evt === 'data' && body) cb(Buffer.from(body));
      if (evt === 'end') cb();
      return this;
    },
  };
}
function res() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

test('resend handler FAILS CLOSED (503) when RESEND_WEBHOOK_SECRET is unset', async () => {
  delete process.env.RESEND_WEBHOOK_SECRET;
  const r = res();
  await resendHandler(mockReq({ body: '{}' }), r);
  assert.equal(r.statusCode, 503);
});

test('resend handler rejects a request signed with nothing (401)', async () => {
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  const r = res();
  await resendHandler(mockReq({ headers: {}, body: '{"type":"email.bounced"}' }), r);
  assert.equal(r.statusCode, 401);
});

test('resend handler no longer honors a ?secret= style bypass (401 without a valid signature)', async () => {
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  const r = res();
  // Even if an attacker knew the secret and put it in the query/body, without
  // a valid Svix signature over the raw body the request is rejected.
  const req = mockReq({ headers: { 'x-secret': SECRET }, body: '{"type":"email.bounced"}' });
  req.query = { secret: SECRET };
  await resendHandler(req, r);
  assert.equal(r.statusCode, 401);
});

test('resend handler accepts a correctly Svix-signed bounce', async () => {
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  const body = JSON.stringify({ type: 'email.delivered', data: { to: ['x@y.com'] } });
  const r = res();
  await resendHandler(mockReq({ headers: sign(body), body }), r);
  assert.equal(r.statusCode, 200); // delivered -> acknowledged/ignored, but authenticated
  assert.equal(r.body.ok, true);
});

// ---- Cron header-only auth ----

test('checkCronSecret accepts the header and ignores any query string', () => {
  process.env.CRON_SECRET = 'cron-xyz';
  assert.equal(checkCronSecret('Bearer cron-xyz'), true);
  assert.equal(checkCronSecret('Bearer wrong'), false);
  assert.equal(checkCronSecret(''), false); // no header -> reject (a ?key= would land here as empty)
  delete process.env.CRON_SECRET;
  assert.equal(checkCronSecret('Bearer cron-xyz'), false); // fail closed when unset
});

test('jobber sync rejects a ?key= query secret (header required)', async () => {
  process.env.CRON_SECRET = 'cron-xyz';
  const original = global.fetch;
  global.fetch = async () => { throw new Error('must not reach upstream'); };
  try {
    const { default: syncHandler } = await import('../api/jobber/sync.js');
    // query carries the secret, but there is NO Authorization header:
    const r = res();
    await syncHandler({ query: { resource: 'clients', key: 'cron-xyz' }, headers: {} }, r);
    assert.equal(r.statusCode, 401, 'a secret in the query string must not authenticate');
  } finally {
    global.fetch = original;
    delete process.env.CRON_SECRET;
  }
});
