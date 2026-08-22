// test/marketing-auth-gate.test.mjs
// Marketing Suite Phase 2 -- backend regression tests for api/marketing.js's
// requireUser()/handler() auth gate. requireUser itself isn't exported (only
// the default handler is), so these are black-box tests against the real
// handler, matching the style already used in test/hiveconnect-bridge.test.mjs
// and test/clients-by-ids.test.mjs (mock fetch/env, no real network, no real
// secret, ever).
//
// This deployment has no multi-tenant/company_id concept in api/marketing.js
// (confirmed by reading requireUser() and the handler dispatch -- it's a
// single-tenant deployment per the project's own Ultimate Build Spec), so
// there is intentionally no 'wrong tenant' check here -- that would be
// testing a concept this codebase doesn't have, not a real gap.
//
// Run with:
//
//   node test/marketing-auth-gate.test.mjs
//
// Exit code 0 if every check passes, 1 if anything fails.

import assert from 'node:assert/strict';
import handler from '../api/marketing.js';

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function mkRes() {
  const res = { code: null, body: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

check('missing Authorization header is rejected with a clear 401', async () => {
  const req = { query: { resource: 'config' }, method: 'GET', headers: {} };
  const res = mkRes();
  await handler(req, res);
  assert.equal(res.code, 401);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /not authenticated/i);
});

check('an invalid/rejected token is treated the same as no token (fails closed)', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) return { ok: false, json: async () => ({}) };
    throw new Error('unexpected fetch in this check: ' + url);
  };
  try {
    const req = { query: { resource: 'config' }, method: 'GET', headers: { authorization: 'Bearer garbage-token' } };
    const res = mkRes();
    await handler(req, res);
    assert.equal(res.code, 401);
    assert.match(res.body.error, /not authenticated/i);
  } finally { globalThis.fetch = prevFetch; }
});

check('a network error verifying the token fails closed (401), never throws to the caller', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const req = { query: { resource: 'config' }, method: 'GET', headers: { authorization: 'Bearer whatever' } };
    const res = mkRes();
    await handler(req, res);
    assert.equal(res.code, 401);
  } finally { globalThis.fetch = prevFetch; }
});

check('a valid token clears the auth gate (req.hlUser set, proceeds past 401) even for an unrecognized resource', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'user-1', email: 'chris@ghgrp.net' }) };
    throw new Error('unexpected fetch in this check: ' + url);
  };
  try {
    const req = { query: { resource: '__phase2_test_probe__' }, method: 'GET', headers: { authorization: 'Bearer real-token' } };
    const res = mkRes();
    await handler(req, res);
    assert.notEqual(res.code, 401, 'must not be rejected once the token verifies, even for a resource name nothing handles');
    assert.equal(req.hlUser && req.hlUser.id, 'user-1', 'the verified user must be attached to the request as req.hlUser');
  } finally { globalThis.fetch = prevFetch; }
});

check('process_scheduled_sends with the correct CRON_SECRET bypasses the user auth gate entirely (no Supabase verify call made)', async () => {
  const prevFetch = globalThis.fetch;
  const prevSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-cron-secret';
  let verifyCalled = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) { verifyCalled = true; return { ok: false, json: async () => ({}) }; }
    throw new Error('downstream call (expected in this check, handler catches it): ' + url);
  };
  try {
    const req = { query: { resource: 'process_scheduled_sends' }, method: 'GET', headers: { authorization: 'Bearer test-cron-secret' } };
    const res = mkRes();
    await handler(req, res);
    assert.equal(verifyCalled, false, 'the CRON_SECRET path must never call Supabase auth verify');
    assert.notEqual(res.code, 401, 'a correct CRON_SECRET must not be rejected as unauthenticated');
  } finally { globalThis.fetch = prevFetch; process.env.CRON_SECRET = prevSecret; }
});

check('process_scheduled_sends WITHOUT a matching CRON_SECRET falls through to the normal user-auth gate (this was a real shipped bug once -- do not regress)', async () => {
  const prevFetch = globalThis.fetch;
  const prevSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'the-real-secret';
  globalThis.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) return { ok: false, json: async () => ({}) };
    throw new Error('unexpected fetch in this check: ' + url);
  };
  try {
    const req = { query: { resource: 'process_scheduled_sends' }, method: 'GET', headers: { authorization: 'Bearer wrong-secret' } };
    const res = mkRes();
    await handler(req, res);
    assert.equal(res.code, 401, 'without the right cron secret this must fail the normal auth gate, not silently run the cron job');
  } finally { globalThis.fetch = prevFetch; process.env.CRON_SECRET = prevSecret; }
});

// ---------- runner ----------
let pass = 0, fail = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log('  ok  -', name);
    pass++;
  } catch (e) {
    console.log('  FAIL -', name, '\n       ', e.message);
    fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed (of ${checks.length})`);
process.exit(fail ? 1 : 0);
