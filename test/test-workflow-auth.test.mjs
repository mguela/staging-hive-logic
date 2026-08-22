// test/test-workflow-auth.test.mjs
// Item 2 (2026-08-01): the workflow runner's secret was hard-coded in source
// and accepted via ?key= in the query string. These tests prove the fix:
//   - no secret in the query string is ever accepted
//   - the secret comes only from env (TEST_WORKFLOW_SECRET), via the
//     Authorization: Bearer header
//   - a missing env var FAILS CLOSED (500), never open
//   - a wrong/absent secret is rejected 401
// Run with: node --test test/test-workflow-auth.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

const SECRET = 'unit-test-runner-secret-value';

// Import with SUPABASE_URL unset so an AUTHORIZED request stops at the
// "Supabase env not configured" 500 — that 500 (vs a 401) is our proof that
// the auth gate passed. SB/KEY are read at module load, so set env first.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
const { default: handler } = await import('../api/test-workflow.js');

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('fails CLOSED with 500 when TEST_WORKFLOW_SECRET is unset', async () => {
  delete process.env.TEST_WORKFLOW_SECRET;
  const r = res();
  await handler({ query: {}, headers: { authorization: 'Bearer anything' } }, r);
  assert.equal(r.statusCode, 500);
  assert.match(r.body.error, /not configured/i);
});

test('rejects a request with no Authorization header (401)', async () => {
  process.env.TEST_WORKFLOW_SECRET = SECRET;
  const r = res();
  await handler({ query: {}, headers: {} }, r);
  assert.equal(r.statusCode, 401);
});

test('does NOT accept the secret via the ?key= query string', async () => {
  process.env.TEST_WORKFLOW_SECRET = SECRET;
  const r = res();
  await handler({ query: { key: SECRET }, headers: {} }, r);
  assert.equal(r.statusCode, 401, 'query-string secret must be rejected');
});

test('rejects a wrong bearer secret (401)', async () => {
  process.env.TEST_WORKFLOW_SECRET = SECRET;
  const r = res();
  await handler({ query: {}, headers: { authorization: 'Bearer not-the-secret' } }, r);
  assert.equal(r.statusCode, 401);
});

test('accepts the correct bearer secret (passes the auth gate)', async () => {
  process.env.TEST_WORKFLOW_SECRET = SECRET;
  const r = res();
  await handler({ query: {}, headers: { authorization: `Bearer ${SECRET}` } }, r);
  // Auth passed; it now stops at the (deliberately unconfigured) Supabase env.
  assert.notEqual(r.statusCode, 401, 'correct secret must not 401');
  assert.equal(r.statusCode, 500);
  assert.match(r.body.error, /supabase env/i);
});

test('no hard-coded secret literal remains in the source', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/test-workflow.js', import.meta.url), 'utf8');
  assert.ok(!/b317e6851efe57001f49bba19ce1332f72787f0ce13edaf3/.test(src), 'old committed secret must be gone');
  assert.ok(!/const RUN_SECRET\s*=/.test(src), 'no RUN_SECRET constant');
});
