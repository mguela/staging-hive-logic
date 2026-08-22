// test/hl-shared-auth.test.mjs
// Marketing Suite Phase 2 -- behavioral tests for the new shared browser
// auth helper (public/hl-shared-auth.js), the canonical replacement for the
// hlTokenSync() logic that used to be duplicated between public/index.html
// and public/marketing-command-center/index.html. This file has no
// auto-executing side effects (unlike marketing-command-center's own inline
// script, which fetches real data immediately on load), so it can be fully
// executed here in a sandboxed vm context with stubbed localStorage/fetch --
// a real behavioral test, not just a structural one.
//
// Run with:
//
//   node test/hl-shared-auth.test.mjs
//
// Exit code 0 if every check passes, 1 if anything fails.

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, '..', 'public', 'hl-shared-auth.js');
const source = readFileSync(FILE, 'utf8');

function makeLocalStorage(seed) {
  const store = Object.create(null);
  Object.assign(store, seed || {});
  Object.defineProperty(store, 'getItem', { value: (k) => (k in store ? store[k] : null), enumerable: false });
  Object.defineProperty(store, 'setItem', { value: (k, v) => { store[k] = String(v); }, enumerable: false });
  Object.defineProperty(store, 'removeItem', { value: (k) => { delete store[k]; }, enumerable: false });
  return store;
}

function loadFreshHlAuth(storageSeed) {
  const store = makeLocalStorage(storageSeed);
  const fetchCalls = [];
  const sandboxFetch = async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true, json: async () => ({ mocked: true }) }; };
  const sandbox = { localStorage: store, fetch: sandboxFetch, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'hl-shared-auth.js' });
  return { HL_AUTH: sandbox.HL_AUTH, fetchCalls };
}

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('exposes window.HL_AUTH with both functions', () => {
  const { HL_AUTH } = loadFreshHlAuth({});
  assert.equal(typeof HL_AUTH.hlTokenSync, 'function');
  assert.equal(typeof HL_AUTH.hlFetchJSON, 'function');
});

check('hlTokenSync returns the access_token from a matching sb-...-auth-token key', () => {
  const { HL_AUTH } = loadFreshHlAuth({
    'sb-sqhusuuhlmcmkeowdrga-auth-token': JSON.stringify({ access_token: 'real-token-abc' }),
  });
  assert.equal(HL_AUTH.hlTokenSync(), 'real-token-abc');
});

check('prefers the project-prefixed key over an unrelated auth-token key', () => {
  const { HL_AUTH } = loadFreshHlAuth({
    'some-other-app-auth-token': JSON.stringify({ access_token: 'wrong-app-token' }),
    'sb-sqhusuuhlmcmkeowdrga-auth-token': JSON.stringify({ access_token: 'right-token' }),
  });
  assert.equal(HL_AUTH.hlTokenSync(), 'right-token');
});

check('supports the currentSession.access_token shape as a fallback', () => {
  const { HL_AUTH } = loadFreshHlAuth({
    'sb-sqhusuuhlmcmkeowdrga-auth-token': JSON.stringify({ currentSession: { access_token: 'nested-token' } }),
  });
  assert.equal(HL_AUTH.hlTokenSync(), 'nested-token');
});

check('returns null when no auth-token key exists at all (missing case)', () => {
  const { HL_AUTH } = loadFreshHlAuth({ unrelated_key: 'x' });
  assert.equal(HL_AUTH.hlTokenSync(), null);
});

check('returns null (never throws) when the stored value is malformed JSON', () => {
  const { HL_AUTH } = loadFreshHlAuth({ 'sb-sqhusuuhlmcmkeowdrga-auth-token': '{not valid json' });
  assert.equal(HL_AUTH.hlTokenSync(), null);
});

check('hlFetchJSON attaches a Bearer Authorization header from the real token', async () => {
  const { HL_AUTH, fetchCalls } = loadFreshHlAuth({
    'sb-sqhusuuhlmcmkeowdrga-auth-token': JSON.stringify({ access_token: 'tok-123' }),
  });
  await HL_AUTH.hlFetchJSON('/api/marketing?resource=config', {});
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].opts.headers.Authorization, 'Bearer tok-123');
});

check('hlFetchJSON never overrides an Authorization header the caller already set (e.g. a cron-secret call)', async () => {
  const { HL_AUTH, fetchCalls } = loadFreshHlAuth({
    'sb-sqhusuuhlmcmkeowdrga-auth-token': JSON.stringify({ access_token: 'session-token' }),
  });
  await HL_AUTH.hlFetchJSON('/api/marketing?resource=process_scheduled_sends', { headers: { Authorization: 'Bearer cron-secret-value' } });
  assert.equal(fetchCalls[0].opts.headers.Authorization, 'Bearer cron-secret-value', 'must not clobber an explicit auth header with the session token');
});

check('hlFetchJSON sets Content-Type: application/json only when a body is present', async () => {
  const { HL_AUTH, fetchCalls } = loadFreshHlAuth({});
  await HL_AUTH.hlFetchJSON('/api/marketing?resource=campaigns', { method: 'POST', body: JSON.stringify({ name: 'x' }) });
  assert.equal(fetchCalls[0].opts.headers['Content-Type'], 'application/json');
});

check('hlFetchJSON with no token and no explicit header sends no Authorization at all (unauthenticated probe)', async () => {
  const { HL_AUTH, fetchCalls } = loadFreshHlAuth({});
  await HL_AUTH.hlFetchJSON('/api/marketing?resource=config', {});
  assert.equal(fetchCalls[0].opts.headers.Authorization, undefined);
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
