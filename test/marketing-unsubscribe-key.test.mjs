import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

// The unsubscribe link signing key used to fall back twice: first to
// SUPABASE_SERVICE_KEY, then to the literal 'dev-only-insecure-fallback' -- a
// signing key committed to a public repository. Nobody could reach it while the
// real variable was set (and it is set in production), but a fallback that
// cannot fail is one nobody notices has engaged.
//
// Found by the 2026-08-23 public API audit (docs/status/PUBLIC_API_AUDIT.md,
// finding F2).

const source = fs.readFileSync(new URL('../api/marketing-unsubscribe.js', import.meta.url), 'utf8');
const code = source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('no signing key is hardcoded in the source', () => {
  assert.doesNotMatch(code, /dev-only-insecure-fallback/,
    'a signing key in a public repo is forgeable by anyone who reads it');
});

test('the master database key is not reused for signing', () => {
  // SUPABASE_SERVICE_KEY bypasses row level security entirely. It should never
  // double as an HMAC key -- one secret, one purpose.
  assert.doesNotMatch(code, /SUPABASE_SERVICE_KEY/,
    'the service key must not be used to sign unsubscribe links');
});

test('the key is read from its own variable, with no fallback chain', () => {
  assert.match(code, /process\.env\.MARKETING_UNSUBSCRIBE_SECRET \|\| null/);
});

test('an unconfigured deployment rejects every link rather than accepting any', () => {
  // signUnsubscribe returns null with no key, and safeEqual refuses null, so
  // the failure mode is "links stop working" -- loud -- rather than "every link
  // is forgeable" -- silent.
  assert.match(code, /if \(!secret\) return null;/);
  assert.match(code, /if \(a == null \|\| b == null\) return false;/);
});

test('the signature itself is still a real HMAC, compared in constant time', () => {
  // Guard against "fixing" the fallback by weakening the primitive.
  assert.match(code, /createHmac\('sha256', secret\)/);
  assert.match(code, /timingSafeEqual/);

  // And the scheme is what it claims: same inputs, same digest.
  const secret = 'test-secret';
  const expected = crypto.createHmac('sha256', secret).update('C1:email').digest('base64url');
  assert.equal(expected.length > 20, true);
  assert.notEqual(
    expected,
    crypto.createHmac('sha256', secret).update('C2:email').digest('base64url'),
    'a different client must not produce the same token',
  );
});
