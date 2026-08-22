// test/vi-app-hivesight-auth-patch.test.mjs
//
// HiveSight (public/vi-app/) is a separately-built Vite SPA embedded via
// <iframe src="/vi-app/">. Its real source is not in this repo, so the auth
// fix that makes it send the signed-in user's Supabase token (P0 security
// round 2, 2026-07-29 -- see claude/status.md) lives only in the compiled
// bundle, applied by claude/_patch_viapp_hivesight_auth.cjs. That script is
// documented as idempotent and safe to re-run, but nothing has ever forced
// anyone to actually run it after a HiveSight rebuild replaces the bundle.
//
// A rebuild silently reverting this patch would mean HiveSight goes back to
// calling /api/jobs, /api/clients, and /api/visual-intel with no Authorization
// header -- exactly the regression round 2 fixed -- and it would happen with
// no error, no failed request, nothing but quietly-401ing widgets until
// someone noticed. Found during the 8/17 Dev To-Do triage: this was flagged as
// known debt but nothing actually caught it if it happened.
//
// This test is that catch: it fails loudly, in CI, the moment the shipped
// bundle stops carrying the patch -- whether from a straight revert or a full
// rebuild that dropped in a fresh, unpatched file.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ASSETS_DIR = 'public/vi-app/assets';
const PATCH_SCRIPT = fs.readFileSync('claude/_patch_viapp_hivesight_auth.cjs', 'utf8');
const VI_INDEX = fs.readFileSync('public/vi-app/index.html', 'utf8');

function currentBundleFile() {
  const files = fs.readdirSync(ASSETS_DIR).filter((f) => /^index-.*\.js$/.test(f));
  assert.equal(
    files.length, 1,
    `expected exactly one HiveSight entry bundle in ${ASSETS_DIR}, found: ${files.join(', ') || '(none)'}`
  );
  return files[0];
}

test('the patch script targets the bundle that is actually shipped', () => {
  const file = currentBundleFile();
  const relMatch = PATCH_SCRIPT.match(/const REL = '([^']+)'/);
  assert.ok(relMatch, "expected to find the patch script's REL constant");
  assert.equal(
    relMatch[1], `${ASSETS_DIR}/${file}`,
    'HiveSight was rebuilt under a new bundle filename and claude/_patch_viapp_hivesight_auth.cjs was not updated ' +
    'to match -- update REL in that script, re-run it, and re-verify the auth header is present.'
  );
});

test('the shipped HiveSight bundle still carries the auth token helper', () => {
  const file = currentBundleFile();
  const src = fs.readFileSync(path.join(ASSETS_DIR, file), 'utf8');
  assert.match(
    src, /__hlViAuth\s*=\s*function/,
    "HiveSight's auth-token helper is missing from the shipped bundle -- it was rebuilt without the patch. " +
    'Run: node claude/_patch_viapp_hivesight_auth.cjs'
  );
});

test('the shipped bundle actually spreads the helper into its request headers', () => {
  const file = currentBundleFile();
  const src = fs.readFileSync(path.join(ASSETS_DIR, file), 'utf8');
  assert.match(
    src, /\.\.\.\(typeof __hlViAuth==="function"\?__hlViAuth\(\):\{\}\)/,
    'the auth helper exists in the bundle but is not wired into the fetch headers -- HiveSight would still call ' +
    '/api/jobs, /api/clients, and /api/visual-intel unauthenticated. Run: node claude/_patch_viapp_hivesight_auth.cjs'
  );
});

test('the patch script still documents this as build-artifact debt, so the risk stays visible', () => {
  assert.match(PATCH_SCRIPT, /BUILD ARTIFACT/i);
  assert.match(
    PATCH_SCRIPT, /Idempotent/i,
    'a second, safe-to-rerun invocation is what lets this be re-applied without anyone guessing at side effects'
  );
});

test('the real-source fetch shim decodes current base64url Supabase sessions', async () => {
  const marker = VI_INDEX.indexOf('// Permanent auth safety net');
  assert.notEqual(marker, -1, 'the real-source auth safety net must exist');
  const scriptStart = VI_INDEX.lastIndexOf('<script>', marker);
  const scriptEnd = VI_INDEX.indexOf('</script>', marker);
  assert.ok(scriptStart !== -1 && scriptEnd !== -1, 'the auth safety-net script must be extractable');
  const source = VI_INDEX.slice(scriptStart + '<script>'.length, scriptEnd);

  const authKey = 'sb-sqhusuuhlmcmkeowdrga-auth-token';
  const encoded = Buffer.from(JSON.stringify({ access_token: 'encoded-token' })).toString('base64url');
  const localStorage = {
    [authKey]: true,
    getItem(key) { return key === authKey ? `base64-${encoded}` : null; },
  };
  let capturedInit;
  const windowRef = {
    location: { origin: 'https://app.example.test' },
    fetch: async (_input, init) => { capturedInit = init; return { ok: true }; },
  };
  windowRef.parent = windowRef;
  vm.runInNewContext(source, {
    window: windowRef,
    localStorage,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    Object,
    Array,
    String,
    JSON,
  });

  await windowRef.fetch('/api/jobs', { headers: { Accept: 'application/json' } });
  assert.equal(capturedInit.headers.Authorization, 'Bearer encoded-token');
});
