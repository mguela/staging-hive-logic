// test/hiveconnect-bridge-handoff.test.mjs
//
// Chris, 2026-08-23: "it flashes Hiveconnect, then immediately goes to the
// sign in screen and then loads hiveconnect".
//
// The sign-in screen he was seeing is HiveConnect's OWN, and it should never
// have been reachable from inside HiveLogic. The hand-off was:
//
//     await sb.auth.setSession(bridged).catch(function(){});
//     boot();
//
// A swallowed catch. When setSession failed, boot() found no session and
// revealed the login screen; onAuthStateChange fired a moment later and loaded
// the app over the top of it. That is the whole flicker.
//
// And the screen is worse than ugly. HiveConnect is a SEPARATE Supabase
// project (mzyngawgpxzpsxphswmc, against HiveLogic's sqhusuuhlmcmkeowdrga), so
// his HiveLogic email and password are not credentials there. A login box he
// cannot log into is a dead end, not a fallback.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const HC = fs.readFileSync(new URL('../public/hiveconnect/app.js', import.meta.url), 'utf8');
const MOUNT = fs.readFileSync(new URL('../public/hiveconnect-mount.js', import.meta.url), 'utf8');
const CONFIG = fs.readFileSync(new URL('../public/hiveconnect/config.js', import.meta.url), 'utf8');

test('the two apps really are different Supabase projects', () => {
  // The reason a login box here cannot help him.
  assert.match(CONFIG, /mzyngawgpxzpsxphswmc/);
  const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(index, /sqhusuuhlmcmkeowdrga/);
});

test('the hand-off failure is no longer swallowed', () => {
  assert.ok(!/setSession\(window\.__hiveconnectBridgedSession\)\.catch\(function\(\)\{\}\)/.test(HC),
    'the empty catch is what hid this');
  assert.match(HC, /window\.__hiveconnectBridgeError = /,
    'the reason is kept, so the notice can say what went wrong');
});

test('setSession resolving is not taken as proof of a session', () => {
  // It can resolve having set nothing usable; the client is asked afterwards.
  assert.match(HC, /var check = await sb\.auth\.getSession\(\)/);
  assert.match(HC, /if \(check && check\.data && check\.data\.session\) return true;/);
});

test('one retry, because the failure is a timing one', () => {
  // Single-use magic-link token: one that has just been spent or just aged out
  // fails once and works on a fresh read. Retrying forever would be guessing.
  assert.match(HC, /for \(var attempt = 0; attempt < 2; attempt\+\+\)/);
  assert.match(HC, /setTimeout\(r, 400\)/);
});

test('the login screen is never shown to a bridged user', () => {
  const boot = HC.slice(HC.indexOf('async function boot()'));
  assert.match(boot.slice(0, 1600),
    /if \(!window\.__hiveconnectBridging && !window\.__hiveconnectBridgedSession\) \{\s*\n\s*authScreen\.classList\.remove\('hidden'\);/,
    'mid-hand-off and post-hand-off are both not an invitation to log in');
});

test('standalone HiveConnect still behaves exactly as it did', () => {
  // No bridged session means this file was loaded on its own, where the login
  // screen IS the right answer.
  assert.match(HC, /if \(!bridged\) \{ boot\(\); return; \}/);
});

test('a failed hand-off says so, and says the HiveLogic session is fine', () => {
  assert.match(HC, /HiveConnect could not open/);
  assert.match(HC, /Your HiveLogic session is fine/);
  assert.match(HC, /function bridgeFailureNotice\(\)/);
  assert.match(HC, /escapeHtml\(why\)/, 'the error text is escaped before it reaches innerHTML');
});

test('the mount still never touches HiveLogic\'s own session', () => {
  // The property that makes all of the above safe to do.
  assert.match(MOUNT, /never touch HiveLogic's own session/);
});

// ---- the sign-in flash, actually explained ---------------------------------
//
// I first blamed the bridge hand-off. The screen recording said otherwise: the
// form he was seeing is HIVELOGIC's own login, and the whole SPA was cold
// booting. The cause was one line in the sidebar.
//
//     function openHiveConnectNewTab(){
//       window.open(location.origin + '/#/hiveconnect', '_blank');
//     }
//
// A new browser tab is a cold boot. Every click reloaded HiveLogic, showed the
// sign-in form while hlTrySilentLogin() restored the session, and only then
// landed on HiveConnect -- and left another HiveLogic tab behind. His recording
// had eight of them open.

const INDEX = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('the sidebar no longer spawns a browser tab to reach HiveConnect', () => {
  // The comment above the function quotes the line it replaced, so match only
  // lines that are actual code -- not ones commented out.
  assert.ok(!/^\s*window\.open\(location\.origin \+ '\/#\/hiveconnect'/m.test(INDEX),
    'a new tab is a cold boot, and a cold boot shows the login screen');
  assert.match(INDEX, /function openHiveConnectNewTab\(\)\{\s*\n\s*openHiveConnect\(\);/);
});

test('#/hiveconnect is still a real route', () => {
  // A bookmarked or pasted link must still land straight on HiveConnect; only
  // the sidebar's route to it changed.
  assert.match(INDEX, /HL_ROUTE_VIEWS = \[[^\]]*'hiveconnect'/);
  assert.match(INDEX, /function openHiveConnect\(\)\{\s*\n\s*showView\('hiveconnect'\);/);
});
