// Verifies the api-smoke-test.js rewrite actually behaves as documented --
// not just that it parses, but that running its real code produces the
// right pass/fail outcome in three scenarios: anonymous run against a
// correctly-gated API (should all pass by detecting the 401s), an
// authenticated run with SMOKE_TEST_TOKEN set (should all pass by
// exercising the real per-route logic), and an anonymous run against a
// deliberately mis-configured API where one gated route wrongly allows
// anonymous access (should FAIL that one check -- proving this is a real
// regression test, not just a renamed skip).
//
// Runs the smoke test's REAL source inside a vm sandbox with a fake
// `fetch` standing in for the network (same vm-sandbox technique used
// elsewhere in this codebase's tests to exercise real handler code
// without a live server) -- no real sockets, no subprocess, no
// network-availability dependency in this sandboxed environment.

import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

const smokeTestPath = 'test/api-smoke-test.js';
const src = fs.readFileSync(smokeTestPath, 'utf8');
const REAL_TOKEN = 'fake-test-token-not-a-real-secret';

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('node --check passes on the rewritten smoke test', () => {
  execFileSync(process.execPath, ['--check', smokeTestPath]);
});

check('smoke test still documents the no-fabrication/no-write guarantee and the new auth mode', () => {
  assert.match(src, /SMOKE_TEST_TOKEN/);
  assert.match(src, /requireUser\(\)/);
  assert.match(src, /No writes are\s*\r?\n\/\/ ever made/);
});

// A fake API implementing the same real gating rules as the live routes
// (requireUser() before any resource logic on clients/jobs/invoices/
// snapshot/chat/visual-intel; track1/health stay public. sync-extended is
// separately protected by CRON_SECRET and must fail closed without it).
// `brokenGate` simulates a route that accidentally lost its auth check.
function fakeRoute(url, opts, { brokenGate }) {
  const authed = opts.headers && opts.headers.Authorization === `Bearer ${REAL_TOKEN}`;
  const status = (code, body) => ({ status: code, json: async () => body });
  const gate = () => authed || (brokenGate && url.pathname === '/api/snapshot');

  if (url.pathname === '/api/health') return status(200, { api_key_configured: true });
  if (url.pathname === '/api/snapshot') {
    if (!gate()) return status(401, { ok: false, error: 'Not signed in.' });
    return status(200, { ok: true, snapshot: { counts: { clients: 5 } } });
  }
  if (url.pathname === '/api/clients') {
    if (!authed) return status(401, { ok: false, error: 'Not signed in.' });
    return status(200, { ok: true, returned: 10000, totalCount: 10000 });
  }
  if (url.pathname === '/api/jobs') {
    if (!authed) return status(401, { ok: false, error: 'Not signed in.' });
    if (url.searchParams.get('id') === 'nonexistent-job-id') return status(404, { ok: false, error: 'Job not found' });
    return status(200, { ok: true, jobs: [] });
  }
  if (url.pathname === '/api/invoices') {
    if (!authed) return status(401, { ok: false, error: 'Not signed in.' });
    return status(200, { ok: true, invoices: [] });
  }
  if (url.pathname === '/api/chat') {
    if (opts.method !== 'POST') return status(405, { ok: false, error: 'POST only' });
    if (!authed) return status(401, { ok: false, error: 'Not signed in.' });
    const b = JSON.parse(opts.body || '{}');
    if (!Array.isArray(b.messages) || !b.messages.length) return status(400, { ok: false, error: 'messages array required' });
    return status(200, { ok: true });
  }
  if (url.pathname === '/api/track1') {
    if (url.searchParams.get('resource') === 'maplocations') return status(200, { ok: true, locations: [] });
    return status(200, { ok: true, rows: [] });
  }
  if (url.pathname === '/api/jobber/sync-extended') {
    return status(401, { ok: false, error: 'Unauthorized' });
  }
  if (url.pathname === '/api/visual-intel') {
    if (!authed) return status(401, { ok: false, error: 'Not signed in.' });
    const resource = url.searchParams.get('resource');
    if (resource === 'media' && !url.searchParams.get('jobId')) return status(400, { ok: false, error: 'jobId required' });
    if (resource === 'bogus') return status(400, { ok: false, error: 'Unknown or unreadable resource: bogus' });
    if (!resource) return status(400, { ok: false, error: 'Unknown or unreadable resource: undefined' });
    return status(200, { ok: true });
  }
  return status(404, { ok: false, error: 'not found in fake router' });
}

// Runs the real test/api-smoke-test.js source in a vm sandbox: its own
// get()/post() helpers call the sandbox's `fetch`, which we point at
// fakeRoute() instead of the network. process.exit()/console.log() are
// captured so we can assert on the real exit code and real output text.
function runSmokeTest({ authToken, brokenGate }) {
  return new Promise((resolve, reject) => {
    const logs = [];
    const fakeProcess = {
      argv: ['node', smokeTestPath, 'http://fake-base'],
      env: authToken ? { SMOKE_TEST_TOKEN: authToken } : {},
      exit(code) { resolve({ exitCode: code, out: logs.join('\n') }); },
    };
    const fakeConsole = { log: (...args) => logs.push(args.join(' ')) };
    const fakeFetch = async (url, opts) => {
      try {
        return fakeRoute(new URL(url), opts || {}, { brokenGate: !!brokenGate });
      } catch (e) {
        reject(e);
        throw e;
      }
    };
    const ctx = vm.createContext({
      process: fakeProcess,
      console: fakeConsole,
      fetch: fakeFetch,
      URL,
      URLSearchParams,
    });
    try {
      new vm.Script(src, { filename: smokeTestPath }).runInContext(ctx);
    } catch (e) {
      reject(e);
    }
  });
}

check('anonymous run against a correctly-gated fake API: every check passes by detecting the real 401s', async () => {
  const { exitCode, out } = await runSmokeTest({ authToken: null, brokenGate: false });
  assert.strictEqual(exitCode, 0, `expected all-pass, got:\n${out}`);
  assert.match(out, /anonymous -- set SMOKE_TEST_TOKEN/);
  assert.doesNotMatch(out, /FAIL/);
});

check('authenticated run (SMOKE_TEST_TOKEN set) against the fake API: every check passes by exercising the real per-route logic', async () => {
  const { exitCode, out } = await runSmokeTest({ authToken: REAL_TOKEN, brokenGate: false });
  assert.strictEqual(exitCode, 0, `expected all-pass, got:\n${out}`);
  assert.match(out, /, authenticated\)/);
  assert.doesNotMatch(out, /FAIL/);
});

check("anonymous run against an API that accidentally dropped a route's auth gate: the smoke test catches it as a real failure", async () => {
  const { exitCode, out } = await runSmokeTest({ authToken: null, brokenGate: true });
  assert.strictEqual(exitCode, 1, `expected a failure to be caught, got:\n${out}`);
  assert.match(out, /FAIL - GET \/api\/snapshot returns real counts.*expected 401/);
});

check('no scratch/temp files leaked into the tracked source', () => {
  assert.doesNotMatch(src, /scratch_/);
});

let pass = 0, fail = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  not ok  - ${name}\n    ${e.stack || e.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed (of ${checks.length})`);
process.exit(fail ? 1 : 0);
