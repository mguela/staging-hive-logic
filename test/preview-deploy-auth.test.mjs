// test/preview-deploy-auth.test.mjs
// 2026-08-15 — "Reina chat doesn't authenticate on Vercel preview deployments."
//
// Two independent defects, both covered here:
//   1. api/_lib/auth.js resolved exactly SUPABASE_URL + SUPABASE_SERVICE_KEY,
//      with no fallbacks, while api/_lib/guard.js already resolved three URL
//      names and four key names and preferred the ANON key. A deployment
//      holding the anon key but not the service-role key — the ordinary shape
//      of a Vercel Preview environment — sailed through the edge middleware
//      and then 401'd in every handler.
//   2. Every failure collapsed to `null`, so "this deployment has no
//      credentials" was indistinguishable from "you are signed out". The user
//      was signed in; the server just could not check; the app said "Not
//      signed in."
//
// The security invariant these must never break: nothing fails OPEN. An
// unverifiable request is still refused — it is only described accurately.
//
// Fully mocked — no network, no real key. Run with:
//   node --test test/preview-deploy-auth.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  requireUser,
  verifyRequestUser,
  resolveSupabaseAuthConfig,
  isDeploymentAuthMisconfigured,
} from '../api/_lib/auth.js';

const USER = { id: 'user-uuid-1', email: 'chris@ghgrp.net' };
const TOKEN = 'a.real.looking.jwt';
const req = (auth) => ({ headers: auth === undefined ? {} : { authorization: auth } });

// A fetch that records the apikey it was called with and returns a user.
function okFetch(seen = {}) {
  return async (url, init) => {
    seen.url = url;
    seen.apikey = init?.headers?.apikey;
    seen.authorization = init?.headers?.Authorization;
    return { ok: true, status: 200, json: async () => USER };
  };
}
const failFetch = (status) => async () => ({ ok: false, status, json: async () => ({}) });
const throwFetch = () => { throw new Error('network down'); };
const neverFetch = () => { throw new Error('fetch must not be called'); };

function res() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// --- config resolution ------------------------------------------------------

test('config resolution mirrors guard.js: anon key preferred, service key last', () => {
  // The bug: only this pair was ever read.
  assert.equal(resolveSupabaseAuthConfig({ SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'svc' }).apiKey, 'svc');
  // Anon wins when both are present — least privilege for a JWT check.
  assert.equal(resolveSupabaseAuthConfig({ SUPABASE_URL: 'u', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_KEY: 'svc' }).apiKey, 'anon');
  // Alternate names resolve too.
  assert.equal(resolveSupabaseAuthConfig({ NEXT_PUBLIC_SUPABASE_URL: 'u2', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon2' }).url, 'u2');
  assert.equal(resolveSupabaseAuthConfig({ VITE_SUPABASE_URL: 'u3', VITE_SUPABASE_ANON_KEY: 'anon3' }).apiKey, 'anon3');
  // Neither half alone counts as configured.
  assert.equal(resolveSupabaseAuthConfig({ SUPABASE_URL: 'u' }).configured, false);
  assert.equal(resolveSupabaseAuthConfig({ SUPABASE_ANON_KEY: 'anon' }).configured, false);
  assert.equal(resolveSupabaseAuthConfig({}).configured, false);
});

// --- the actual regression --------------------------------------------------

test('THE BUG: an anon-key-only deployment (the Preview shape) now authenticates', async () => {
  const seen = {};
  const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_ANON_KEY: 'anon-key' };
  const r = await verifyRequestUser(req(`Bearer ${TOKEN}`), { env, fetchImpl: okFetch(seen) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.user, USER);
  assert.equal(r.reason, 'ok');
  // It used the anon key, and the user's own JWT is what authorizes.
  assert.equal(seen.apikey, 'anon-key');
  assert.equal(seen.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen.url, 'https://p.supabase.co/auth/v1/user');
  // ...and the legacy contract agrees.
  assert.deepEqual(await requireUser(req(`Bearer ${TOKEN}`), { env, fetchImpl: okFetch() }), USER);
});

test('production shape (service key only) is unchanged', async () => {
  const seen = {};
  const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_KEY: 'svc-key' };
  const r = await verifyRequestUser(req(`Bearer ${TOKEN}`), { env, fetchImpl: okFetch(seen) });
  assert.equal(r.ok, true);
  assert.equal(seen.apikey, 'svc-key');
});

// --- diagnosability ---------------------------------------------------------

test('a deployment with no Supabase config says so, and still refuses', async () => {
  // fetch must never be reached — there is nothing to call.
  const r = await verifyRequestUser(req(`Bearer ${TOKEN}`), { env: {}, fetchImpl: neverFetch });
  assert.equal(r.reason, 'auth-unconfigured');
  assert.equal(isDeploymentAuthMisconfigured(r.reason), true);
  // FAIL CLOSED. This is the invariant that must never regress.
  assert.equal(r.ok, false);
  assert.equal(r.user, null);
  assert.equal(await requireUser(req(`Bearer ${TOKEN}`), { env: {}, fetchImpl: neverFetch }), null);
});

test('failure reasons are distinguishable from one another', async () => {
  const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_ANON_KEY: 'anon' };
  const reason = async (header, fetchImpl = neverFetch, e = env) =>
    (await verifyRequestUser(req(header), { env: e, fetchImpl })).reason;

  assert.equal(await reason(undefined), 'no-token');
  assert.equal(await reason(''), 'no-token');
  assert.equal(await reason('Basic abc'), 'malformed-token');
  assert.equal(await reason('Bearer '), 'malformed-token');
  assert.equal(await reason(`Bearer ${TOKEN}`, failFetch(401)), 'rejected');
  assert.equal(await reason(`Bearer ${TOKEN}`, failFetch(403)), 'rejected');
  // Supabase itself broke — that is not the caller being signed out.
  assert.equal(await reason(`Bearer ${TOKEN}`, failFetch(500)), 'verify-failed');
  assert.equal(await reason(`Bearer ${TOKEN}`, throwFetch), 'verify-failed');
  // A junk token on an unconfigured deployment still reads as a token problem,
  // so we never blame the config for something the caller got wrong.
  assert.equal(await reason('Basic abc', neverFetch, {}), 'malformed-token');
});

test('header hardening is preserved (injection + length bounds)', async () => {
  const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_ANON_KEY: 'anon' };
  const reject = async (header) => {
    const r = await verifyRequestUser(req(header), { env, fetchImpl: neverFetch });
    assert.equal(r.ok, false, `${JSON.stringify(header.slice(0, 24))} must be rejected`);
  };
  await reject('Bearer abc\r\nX-Injected: 1');
  await reject('Bearer ' + 'x'.repeat(16_385));
  await reject('Bearer ' + 'x'.repeat(20_000));
  await reject('Bearer two words');
  // A malformed req object is refused, not thrown on.
  assert.equal((await verifyRequestUser(null, { env })).ok, false);
  assert.equal((await verifyRequestUser({}, { env })).ok, false);
  assert.equal((await verifyRequestUser({ headers: 'nope' }, { env })).ok, false);
});

test('every non-ok reason maps to null through the legacy requireUser contract', async () => {
  const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_ANON_KEY: 'anon' };
  assert.equal(await requireUser(req(undefined), { env, fetchImpl: neverFetch }), null);
  assert.equal(await requireUser(req('Basic x'), { env, fetchImpl: neverFetch }), null);
  assert.equal(await requireUser(req(`Bearer ${TOKEN}`), { env, fetchImpl: failFetch(401) }), null);
  assert.equal(await requireUser(req(`Bearer ${TOKEN}`), { env, fetchImpl: failFetch(500) }), null);
  assert.equal(await requireUser(req(`Bearer ${TOKEN}`), { env, fetchImpl: throwFetch }), null);
  assert.equal(await requireUser(req(`Bearer ${TOKEN}`), { env: {}, fetchImpl: neverFetch }), null);
});

// --- handler behaviour: api/reina-transcribe.js -----------------------------
// chat.js cannot be exercised here: it imports @anthropic-ai/sdk, which is not
// installed in this checkout (the same reason 7 suites fail on pristine main).
// reina-transcribe.js goes through the identical auth branch with no SDK.

async function transcribeWith(env, header) {
  const saved = { ...process.env };
  Object.assign(process.env, { REINA_VOICE_TRANSCRIPTION_ENABLED: 'true' });
  for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) delete process.env[k];
  Object.assign(process.env, env);
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const mod = await import('../api/reina-transcribe.js');
    const r = res();
    await mod.default({
      method: 'POST',
      headers: { 'content-type': 'audio/webm', ...(header ? { authorization: header } : {}) },
    }, r);
    return r;
  } finally {
    global.fetch = originalFetch;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test('transcribe: an unconfigured deployment reports auth_unconfigured, not auth_expired', async () => {
  const r = await transcribeWith({}, `Bearer ${TOKEN}`);
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.code, 'auth_unconfigured');
  assert.equal(r.body.ok, false);
});

test('transcribe: a genuinely signed-out caller still gets 401 auth_expired', async () => {
  const r = await transcribeWith({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_ANON_KEY: 'anon' }, undefined);
  assert.equal(r.statusCode, 401);
  assert.equal(r.body.code, 'auth_expired');
});

test('transcribe: never fails open — no config and no token is still refused', async () => {
  const r = await transcribeWith({}, undefined);
  assert.equal(r.statusCode, 401);
  assert.notEqual(r.statusCode, 200);
});
