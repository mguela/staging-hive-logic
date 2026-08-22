import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Two findings, one HIGH and one LOW, both confirmed live before fixing.
const src = readFileSync(new URL('../public/tools/selftest.js', import.meta.url), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > -1, `${signature} must exist`);
  let depth = 0, i = source.indexOf('{', start);
  do {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < source.length);
  assert.equal(depth, 0, 'braces must balance');
  return source.slice(start, i);
}

// ---- HIGH: HiveConnect's own Supabase project was blocked as "external",
// stubbing a GET into a non-array object. Live-confirmed: the exact error
// (contactsData.filter/find is not a function) reproduces with the OLD
// decide() logic against production, and disappears (Contacts renders 33
// real team members) with the fix. ----
const decideSrc = extractFunction(src, 'function decide(url, method, origin)');
const isSupabaseHostSrc = extractFunction(src, 'function isSupabaseHost(url)');
function runDecide(url, method, origin) {
  const ctx = vm.createContext({
    result: undefined,
    URL,
    location: { href: origin },
    EXTERNAL: /twilio|resend|sendgrid|mailgun|postmark|authorize\.?net|getjobber|jobber|graph\.microsoft|livekit|stripe|plaid|api\.openai|googleapis/i,
    sameOrigin: (u, o) => { try { return new URL(u, o).origin === o; } catch (e) { return true; } },
    mutating: (m) => /^(POST|PUT|PATCH|DELETE)$/i.test(m || 'GET'),
  });
  vm.runInContext(`${isSupabaseHostSrc}\n${decideSrc}\nresult = decide(${JSON.stringify(url)}, ${JSON.stringify(method)}, ${JSON.stringify(origin)});`, ctx);
  return ctx.result;
}

test('a GET to HiveConnect\'s own Supabase project passes through, not blocked-external', () => {
  assert.equal(runDecide('https://mzyngawgpxzpsxphswmc.supabase.co/rest/v1/contacts?select=*', 'GET', 'https://hivelogic-live.vercel.app'), 'pass');
});

test('a GET to the main app\'s own (different) Supabase project also passes through', () => {
  assert.equal(runDecide('https://sqhusuuhlmcmkeowdrga.supabase.co/rest/v1/profiles?select=*', 'GET', 'https://hivelogic-live.vercel.app'), 'pass');
});

test('a WRITE to a Supabase host is still stubbed, not sent for real -- this must not become a safety hole', () => {
  assert.equal(runDecide('https://mzyngawgpxzpsxphswmc.supabase.co/rest/v1/messages', 'POST', 'https://hivelogic-live.vercel.app'), 'stub-write');
  assert.equal(runDecide('https://mzyngawgpxzpsxphswmc.supabase.co/rest/v1/contacts?id=eq.1', 'PATCH', 'https://hivelogic-live.vercel.app'), 'stub-write');
  assert.equal(runDecide('https://mzyngawgpxzpsxphswmc.supabase.co/rest/v1/contacts?id=eq.1', 'DELETE', 'https://hivelogic-live.vercel.app'), 'stub-write');
});

test('a genuinely external, non-Supabase host is still blocked, unaffected', () => {
  assert.equal(runDecide('https://api.stripe.com/v1/charges', 'GET', 'https://hivelogic-live.vercel.app'), 'blocked-external');
  assert.equal(runDecide('https://random-third-party.example.com/data', 'GET', 'https://hivelogic-live.vercel.app'), 'blocked-external');
});

test('a service explicitly on the EXTERNAL blocklist is blocked even if it somehow used a supabase.co-style host', () => {
  // Defense in depth: EXTERNAL is checked before the Supabase-host carve-out.
  const line = src.split('\n').find((l) => l.includes('if (EXTERNAL.test(url)) return'));
  const decideBody = decideSrc;
  const externalIdx = decideBody.indexOf('EXTERNAL.test');
  const supabaseIdx = decideBody.indexOf('isSupabaseHost');
  assert.ok(externalIdx > -1 && supabaseIdx > -1 && externalIdx < supabaseIdx, 'EXTERNAL must still be checked first');
});

test('isSupabaseHost matches only the supabase.co domain, not a lookalike host', () => {
  const ctx = vm.createContext({ result: undefined, URL, location: { href: 'https://hivelogic-live.vercel.app' } });
  vm.runInContext(`${isSupabaseHostSrc}\nresult = JSON.stringify([isSupabaseHost('https://mzyngawgpxzpsxphswmc.supabase.co/rest/v1/x'), isSupabaseHost('https://notsupabase.co.evil.com/x'), isSupabaseHost('https://supabase.co.attacker.net/x')]);`, ctx);
  assert.equal(ctx.result, JSON.stringify([true, false, false]));
});

// ---- LOW: voice-input.js's global floating password-eye button sits at
// pointer-events:none/opacity:0 on any view with no password field (e.g.
// psx) -- a real user could never click it (clicks pass through to
// whatever's underneath), but it keeps a real 26x26 layout box, so the
// existing offsetHeight/offsetWidth check let it through anyway.
// Live-confirmed: getComputedStyle on the actual button in production
// reports pointerEvents:"none", opacity:"0", offsetHeight/Width:26. ----
const isReallyClickableSrc = extractFunction(src, 'function isReallyClickable(el)');
function runIsReallyClickable(pointerEvents) {
  const ctx = vm.createContext({ result: undefined, window: { getComputedStyle: () => ({ pointerEvents }) } });
  ctx.__el = { ownerDocument: { defaultView: null } };
  vm.runInContext(`${isReallyClickableSrc}\nresult = isReallyClickable(__el);`, ctx);
  return ctx.result;
}

test('an element with pointer-events:none is not really clickable', () => {
  assert.equal(runIsReallyClickable('none'), false);
});

test('a normal element (pointer-events: auto or unset) is still clickable', () => {
  assert.equal(runIsReallyClickable('auto'), true);
  assert.equal(runIsReallyClickable(''), true);
});

test('isReallyClickable is wired into the els filter alongside the existing offsetHeight/offsetWidth check', () => {
  assert.match(src, /var els = \[\]\.slice\.call\(scope\.querySelectorAll\('\*'\)\)\.filter\(function \(e\) \{ return isTestable\(e\) && e\.offsetHeight > 0 && e\.offsetWidth > 0 && isReallyClickable\(e\); \}\);/);
});
