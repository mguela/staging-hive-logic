// The seam nothing covered: reina-pilot-route.test.mjs proves the route's bootstrap
// is well-formed, and the login-brief tests prove the validator works on hand-written
// fixtures — but no test ever fed the REAL route response into the REAL validator.
//
// It shipped broken. The route sends count:null for its unavailable sources (mail,
// finance, weather), the validator demanded an integer for every category, so every
// live bootstrap was rejected and the panel showed "Reina's synthetic read-only
// preview is unavailable right now". That killed Voice too: no bootstrap means no
// session, and installVoice() will not start without one. Both sides passed their
// own tests the whole time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { createReinaPilotHandler } from '../api/reina-pilot.js';
import { AtomicMemoryStore } from './_reina-typed-atomic-store.mjs';

const require = createRequire(import.meta.url);
const brief = require('../public/reina-login-brief-controller.js');

const OWNER = 'owner-1';
const ENV = Object.freeze({
  NODE_ENV: 'test',
  REINA_PILOT_ENABLED: 'true',
  REINA_ACTING_CONTEXT_ENABLED: 'true',
  REINA_DURABLE_CONVERSATIONS_ENABLED: 'true',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_KEY: 'server-only-test-key',
});

function bootstrapFromRoute() {
  const now = () => '2026-08-03T14:00:00Z';
  const handler = createReinaPilotHandler({
    env: ENV,
    store: new AtomicMemoryStore({ now }),
    now,
    requireUserImpl: async () => ({ id: OWNER }),
    fetchImpl: async (url) => {
      if (url.includes('select=id,role,full_name')) {
        return { ok: true, json: async () => [{ id: OWNER, role: 'admin', full_name: 'Chris Kendall' }] };
      }
      if (url.includes('select=id,role')) {
        return { ok: true, json: async () => [{ id: OWNER, role: 'admin' }] };
      }
      throw new Error('unexpected URL ' + url);
    },
  });
  const res = {
    statusCode: null, body: null,
    setHeader() {},
    status(v) { this.statusCode = v; return this; },
    json(v) { this.body = v; return v; },
  };
  return handler({ method: 'GET', headers: { authorization: 'Bearer browser-session' } }, res)
    .then(() => res);
}

test('the login brief accepts the bootstrap the route actually sends', async () => {
  const res = await bootstrapFromRoute();
  assert.equal(res.statusCode, 200, 'the route must answer a bootstrap GET');

  const verdict = brief.validateBootstrap(res.body, res.body.sessionId);
  assert.equal(verdict.ok, true,
    `the client rejected its own server's bootstrap: ${verdict.reason}`);
});

test('an unavailable source carries a null count and is still accepted', async () => {
  const res = await bootstrapFromRoute();
  const unavailable = res.body.attention.categories.filter((c) => c.available === false);
  assert.ok(unavailable.length > 0, 'the pilot always ships some unavailable sources');
  unavailable.forEach((c) => {
    assert.equal(c.count, null, `${c.key} has nothing to count`);
    assert.equal(c.asOf, null, `${c.key} was never read, so it has no asOf`);
  });

  const verdict = brief.validateBootstrap(res.body, res.body.sessionId);
  assert.equal(verdict.ok, true, verdict.reason);
  // and the null survives validation rather than being coerced to 0, which would
  // read as "we checked your email and found nothing"
  const mail = verdict.data.categories.find((c) => c.key === 'mail');
  assert.equal(mail.count, null);
});

test('a count is still required where the source IS available', async () => {
  const res = await bootstrapFromRoute();
  const body = JSON.parse(JSON.stringify(res.body));
  const jobs = body.attention.categories.find((c) => c.key === 'jobs');
  assert.equal(jobs.available, true);
  jobs.count = null;   // available, but no count -> must be rejected
  const verdict = brief.validateBootstrap(body, body.sessionId);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'malformed_category_count');
});

// An explicit 0 on an unavailable source stays legal — existing callers already
// send it, and the total ignores unavailable sources either way.
test('an unavailable source may report null or zero', async () => {
  const res = await bootstrapFromRoute();
  const withZero = JSON.parse(JSON.stringify(res.body));
  withZero.attention.categories.find((c) => c.key === 'mail').count = 0;
  assert.equal(brief.validateBootstrap(withZero, withZero.sessionId).ok, true);
});

test('a junk count is still rejected on an unavailable source', async () => {
  const res = await bootstrapFromRoute();
  const body = JSON.parse(JSON.stringify(res.body));
  body.attention.categories.find((c) => c.key === 'mail').count = -3;
  const verdict = brief.validateBootstrap(body, body.sessionId);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'malformed_category_count');
});

test('an unavailable source never inflates the total', async () => {
  const res = await bootstrapFromRoute();
  const body = JSON.parse(JSON.stringify(res.body));
  body.attention.categories.find((c) => c.key === 'mail').count = 9;
  const verdict = brief.validateBootstrap(body, body.sessionId);
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.data.total, res.body.attention.total);
});
