// test/self-origin.test.mjs
// 2026-08-15. api/health-cron.js and api/test-workflow.js call this app's own
// HTTP API. Both pinned the production origin, so on a preview deployment:
//   - the CI runner exercised production's functions, never the preview build
//     it was deployed to verify, and
//   - because that runner WRITES (create_job, create_invoice, ...), the
//     fixtures were created by production's functions under production's env.
//
// The invariant that matters most here: production behaviour must be
// byte-for-byte unchanged. Only non-production deployments may retarget.
//
// Run with: node --test test/self-origin.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selfOrigin,
  isNonProductionDeployment,
  protectionBypassHeaders,
  selfFetchInit,
} from '../api/_lib/self-origin.js';

const PROD = 'https://hivelogic-live.vercel.app';

test('production is unchanged — always the stable custom domain', () => {
  // The exact value the old hardcoded constant held.
  assert.equal(selfOrigin({ VERCEL_ENV: 'production' }), PROD);
  // Even when a per-deployment hashed URL is present, production ignores it:
  // cron/self-probes should hit the domain users hit, not the build alias.
  assert.equal(selfOrigin({ VERCEL_ENV: 'production', VERCEL_URL: 'hivelogic-live-abc123.vercel.app' }), PROD);
  assert.equal(selfOrigin({ VERCEL_ENV: 'production', VERCEL_BRANCH_URL: 'hivelogic-live-git-main.vercel.app' }), PROD);
  // Off Vercel entirely (local, CI box) also falls back to production.
  assert.equal(selfOrigin({}), PROD);
  assert.equal(selfOrigin({ VERCEL_URL: 'hivelogic-live-abc123.vercel.app' }), PROD);
});

test('THE BUG: a preview deployment targets itself, not production', () => {
  assert.equal(
    selfOrigin({ VERCEL_ENV: 'preview', VERCEL_URL: 'hivelogic-live-abc123.vercel.app' }),
    'https://hivelogic-live-abc123.vercel.app',
  );
  // The stable per-branch alias is preferred over the per-deployment one.
  assert.equal(
    selfOrigin({ VERCEL_ENV: 'preview', VERCEL_URL: 'hivelogic-live-abc123.vercel.app', VERCEL_BRANCH_URL: 'hivelogic-live-git-fix-x.vercel.app' }),
    'https://hivelogic-live-git-fix-x.vercel.app',
  );
  assert.equal(
    selfOrigin({ VERCEL_ENV: 'development', VERCEL_URL: 'hivelogic-live-dev.vercel.app' }),
    'https://hivelogic-live-dev.vercel.app',
  );
});

test('a preview with no deployment URL falls back rather than producing a broken origin', () => {
  // Better to probe production than to build "https://undefined".
  assert.equal(selfOrigin({ VERCEL_ENV: 'preview' }), PROD);
});

test('HIVELOGIC_SELF_ORIGIN overrides, and origins are normalized', () => {
  assert.equal(selfOrigin({ HIVELOGIC_SELF_ORIGIN: 'https://staging.example.com' }), 'https://staging.example.com');
  // Wins even on production.
  assert.equal(selfOrigin({ VERCEL_ENV: 'production', HIVELOGIC_SELF_ORIGIN: 'https://staging.example.com' }), 'https://staging.example.com');
  // Scheme optional, trailing slashes stripped, http upgraded to https.
  assert.equal(selfOrigin({ HIVELOGIC_SELF_ORIGIN: 'staging.example.com' }), 'https://staging.example.com');
  assert.equal(selfOrigin({ HIVELOGIC_SELF_ORIGIN: 'https://staging.example.com/' }), 'https://staging.example.com');
  assert.equal(selfOrigin({ HIVELOGIC_SELF_ORIGIN: 'http://staging.example.com//' }), 'https://staging.example.com');
  assert.equal(selfOrigin({ VERCEL_ENV: 'preview', VERCEL_URL: 'https://x.vercel.app/' }), 'https://x.vercel.app');
});

test('a resolved origin is always a well-formed https URL with no trailing slash', () => {
  for (const env of [
    { VERCEL_ENV: 'production' },
    { VERCEL_ENV: 'preview', VERCEL_URL: 'x.vercel.app' },
    { VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'y.vercel.app/' },
    { HIVELOGIC_SELF_ORIGIN: 'http://z.example.com/' },
    {},
  ]) {
    const origin = selfOrigin(env);
    assert.match(origin, /^https:\/\/[^/]+$/, `${JSON.stringify(env)} -> ${origin}`);
    // Concatenating a path (how both call sites use it) yields a valid URL.
    assert.doesNotThrow(() => new URL(origin + '/api/health'));
  }
});

test('isNonProductionDeployment only reports true off production', () => {
  assert.equal(isNonProductionDeployment({ VERCEL_ENV: 'preview' }), true);
  assert.equal(isNonProductionDeployment({ VERCEL_ENV: 'development' }), true);
  assert.equal(isNonProductionDeployment({ VERCEL_ENV: 'production' }), false);
  assert.equal(isNonProductionDeployment({}), false);
});

// --- Deployment Protection, outbound only -----------------------------------
// Preview URLs are behind Vercel Deployment Protection, so a self-call cannot
// reach its own deployment even once it targets the right origin. These pin
// the two properties that matter: it is inert unless a secret is configured
// (so production is untouched), and it never disturbs the caller's own init.

const HDR = 'x-vercel-protection-bypass';

test('inert with no secret configured — production is unaffected', () => {
  assert.deepEqual(protectionBypassHeaders({}), {});
  assert.deepEqual(protectionBypassHeaders({ VERCEL_ENV: 'production' }), {});
  assert.deepEqual(protectionBypassHeaders({ VERCEL_AUTOMATION_BYPASS_SECRET: '' }), {});
  // selfFetchInit returns the caller's init untouched — same object, so an
  // unconfigured deployment behaves exactly as it did before this existed.
  const init = { signal: 'sig', headers: { a: '1' } };
  assert.equal(selfFetchInit(init, {}), init);
  assert.deepEqual(selfFetchInit({}, {}), {});
});

test('sends the header only when a secret is configured', () => {
  const h = protectionBypassHeaders({ VERCEL_AUTOMATION_BYPASS_SECRET: 's3cret' });
  assert.equal(h[HDR], 's3cret');
  // Request-scoped: no bypass cookie persisted.
  assert.equal(h['x-vercel-set-bypass-cookie'], 'false');
});

test('selfFetchInit preserves everything the caller set', () => {
  const env = { VERCEL_AUTOMATION_BYPASS_SECRET: 's3cret' };
  const init = selfFetchInit({
    method: 'POST',
    headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
    body: '{"a":1}',
    signal: 'sig',
  }, env);
  assert.equal(init.method, 'POST');
  assert.equal(init.body, '{"a":1}');
  assert.equal(init.signal, 'sig');
  // Caller's auth header survives alongside the new one.
  assert.equal(init.headers.Authorization, 'Bearer tok');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers[HDR], 's3cret');
  // An init with no headers at all still works.
  assert.equal(selfFetchInit({ signal: 'sig' }, env).headers[HDR], 's3cret');
});

test('a caller-supplied header wins over the injected one', () => {
  const init = selfFetchInit({ headers: { [HDR]: 'caller-value' } }, { VERCEL_AUTOMATION_BYPASS_SECRET: 's3cret' });
  assert.equal(init.headers[HDR], 'caller-value');
});
