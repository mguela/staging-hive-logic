// test/user-settings.test.mjs
//
// Chris, 2026-08-23: "as a full HiveLogic Rule, settings changed should follow
// the user not the device. for every part of Hivelogic"
//
// Before this there was nowhere for a personal preference to live.
// company_settings, voice_settings and workforce_settings are all
// company-scoped -- putting a personal preference in one of those sets it for
// everybody -- so every preference in the app defaulted to localStorage, which
// is the device. That failure never gets reported: it does not look broken, it
// looks like the app forgot, and the person quietly sets it again.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  validateSettingsPatch, mergeSettings, MAX_KEYS, MAX_KEY_LENGTH, MAX_VALUE_BYTES,
} from '../api/user-settings.js';

const API = fs.readFileSync(new URL('../api/user-settings.js', import.meta.url), 'utf8');
const CLIENT = fs.readFileSync(new URL('../public/hl-user-settings.js', import.meta.url), 'utf8');

// ---- merge, never replace --------------------------------------------------

test('two tabs writing different preferences do not clobber each other', () => {
  // A whole-object PUT from either would silently drop the other's change.
  const current = { theme: 'dark', collapsed: true };
  assert.deepEqual(mergeSettings(current, { volume: 0.4 }),
    { theme: 'dark', collapsed: true, volume: 0.4 });
  assert.deepEqual(mergeSettings(current, { theme: 'light' }),
    { theme: 'light', collapsed: true });
});

test('null clears a key rather than storing null in it', () => {
  // "unset" and "set to nothing" are different states and read back
  // differently -- a stored null would satisfy hasOwnProperty and beat a
  // caller's fallback.
  assert.deepEqual(mergeSettings({ theme: 'dark' }, { theme: null }), {});
});

test('merging onto nothing is safe', () => {
  assert.deepEqual(mergeSettings(null, { a: 1 }), { a: 1 });
  assert.deepEqual(mergeSettings('not an object', { a: 1 }), { a: 1 });
  assert.deepEqual(mergeSettings([], { a: 1 }), { a: 1 });
});

// ---- what is allowed in ----------------------------------------------------

test('a preference can be any honest shape', () => {
  for (const value of ['dark', 42, true, false, { a: 1 }, [1, 2], null]) {
    assert.equal(validateSettingsPatch({ k: value }).valid, true, JSON.stringify(value));
  }
});

test('settings is not a place to stash a document', () => {
  const big = 'x'.repeat(MAX_VALUE_BYTES + 1);
  assert.equal(validateSettingsPatch({ k: big }).valid, false);
  assert.match(validateSettingsPatch({ k: big }).error, /too large/i);

  const many = {};
  for (let i = 0; i <= MAX_KEYS; i++) many['k' + i] = 1;
  assert.equal(validateSettingsPatch(many).valid, false);

  assert.equal(validateSettingsPatch({ ['k'.repeat(MAX_KEY_LENGTH + 1)]: 1 }).valid, false);
});

test('an empty or malformed patch is refused, not silently accepted', () => {
  assert.equal(validateSettingsPatch({}).valid, false);
  assert.equal(validateSettingsPatch(null).valid, false);
  assert.equal(validateSettingsPatch([1, 2]).valid, false);
  assert.equal(validateSettingsPatch({ k: undefined }).valid, false,
    'undefined is a mistake; null is how you clear one');
});

// ---- who it belongs to -----------------------------------------------------

test('the owner comes from the session, never the request', () => {
  assert.match(API, /const ownerId = auth\.user\.id;/);
  assert.ok(!/body\.(ownerId|owner_id|userId)/.test(API),
    'a page that could name its own owner could read and rewrite anyone\'s preferences');
});

test('settings are never cached by a proxy', () => {
  assert.match(API, /setHeader\('Cache-Control', 'no-store'\)/);
});

// ---- the client contract ---------------------------------------------------

test('the cache is read first, and the server still wins', () => {
  // Reading only the server means a flash of the wrong theme for as long as
  // the round trip takes. Reading only the cache is the bug being replaced.
  assert.match(CLIENT, /cache = readCache\(\);/, 'painted before the request goes out');
  assert.match(CLIENT, /cache = \(d && d\.settings\) \|\| \{\};/, 'and overwritten by the record');
});

test('a failed load keeps the last known state', () => {
  // Reverting his preferences to defaults in front of him because the network
  // blinked is worse than being briefly stale.
  const cat = CLIENT.slice(CLIENT.indexOf('function load()'));
  assert.match(cat.slice(0, 1200), /loaded = true;[\s\S]*?throw e;/);
});

test('a failed save is not swallowed', () => {
  // Silence here is exactly the mute bug: a setting that looks saved and is
  // not. set() returns the promise so the caller can see the failure.
  assert.match(CLIENT, /return request\('POST', \{ settings: patch \}\)/);
});

// ---- the rule itself -------------------------------------------------------

test('the three device-scoped exceptions are named where someone will read them', () => {
  assert.match(CLIENT, /NOT FOR: which microphone/);
  assert.match(CLIENT, /push\s*\n?\s*\*\s*subscriptions|push\n \* subscriptions|push subscriptions/);
  assert.match(API, /company-scoped/, 'and why the company tables are not the home for one');
});

test('the dismissals actually moved', () => {
  const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(index, /hlUserSettings\.set\('notifDismissed'/);
  assert.match(index, /function hlDismissedToday\(settingKey, legacyKey\)/);
  assert.match(index, /hlUserSettings\.set\(settingKey, today\)/);
  assert.match(index, /<script src="\/hl-user-settings\.js" defer><\/script>/);
});

// ---- hiveconnect ------------------------------------------------------------
//
// I first reported these as blocked, on the grounds that HiveConnect "mounts
// separately and needs its own session plumbing". That was wrong.
// hiveconnect-mount.js injects a <script> into the HiveLogic document -- there
// is no iframe anywhere in it -- so window.hlUserSettings was reachable the
// whole time. Worth stating, because the wrong half of that claim is the kind
// that turns into a permanent "can't do that".

const HC = fs.readFileSync(new URL('../public/hiveconnect/app.js', import.meta.url), 'utf8');
const MOUNT = fs.readFileSync(new URL('../public/hiveconnect-mount.js', import.meta.url), 'utf8');

test('hiveconnect really does share the page', () => {
  assert.ok(!/iframe/i.test(MOUNT), 'an iframe here would genuinely have blocked this');
  assert.match(MOUNT, /document\.body\.appendChild\(s\)/);
});

test('every hiveconnect preference now follows the user', () => {
  for (const [setting, legacy] of [
    ['hcTheme', 'hive_theme'],
    ['hcNotifs', 'hive_notifs'],
    ['hcCollapsed', 'hive_collapsed'],
    ['hcVolume', 'hive_vol'],
    ['hcEmailTemplates', 'hcEmailTpls'],
    ['chirpMode', 'chirpMode'],
    ['chirpClock', 'chirpClock'],
    ['chirpPeopleCollapsed', 'chirpPeopleCollapsed'],
  ]) {
    assert.ok(HC.includes(`'${setting}', '${legacy}'`), `${legacy} moved to ${setting}`);
  }
  assert.match(HC, /hcPrefSet\('order:' \+ storeKey/, 'dragged folder order too');
  assert.match(HC, /hcPref\('sig:' \+ evSigKey\(\)/, 'and the email signature');
});

test('the hardware choices deliberately did NOT move', () => {
  // Carrying these across would name a microphone that is not plugged into the
  // next machine. CLAUDE.md, exception 1.
  assert.match(HC, /mic: localStorage\.getItem\('hive_mic'\)/);
  assert.match(HC, /speaker: localStorage\.getItem\('hive_speaker'\)/);
  assert.ok(!/hcPref\([^)]*hive_mic/.test(HC));
  assert.ok(!/hcPref\([^)]*hive_speaker/.test(HC));
});

test('the legacy key is still written, so the first paint is not a default', () => {
  // Before the server answers, the cache is all there is. Dropping the legacy
  // write would flash a light theme at him every cold load.
  assert.match(HC, /function hcPrefSet\(key, legacyKey, value\) \{\s*\n\s*try \{ localStorage\.setItem\(legacyKey/);
});

test('the theme repaints when the record disagrees with the cache', () => {
  // He changed it on another machine. The cache painted the old one; the
  // server answer has to win, visibly.
  assert.match(HC, /hlUserSettings\.ready\(\(\) => applyTheme\(/);
});

test('a preference read falls back through cache to default, never throwing', () => {
  // This runs at module load inside a try-less call path; an exception here
  // takes the whole panel down rather than losing one preference.
  const fn = HC.slice(HC.indexOf('function hcPref(key, legacyKey, fallback)'));
  assert.match(fn.slice(0, 400), /catch \(e\) \{\}/);
  assert.match(fn.slice(0, 400), /return fallback;/);
});

// ---- the schedule board ----------------------------------------------------
//
// Reported twice as blocked because "that page has no hlRequireSession". True,
// and beside the point: it is a same-ORIGIN iframe that already asks its
// parent for an auth token and a theme by postMessage. window.parent
// .hlUserSettings was reachable the whole time, same as HiveConnect.
//
// Pasting a Mapbox or Google key used to set it up on one browser. Open the
// board on the laptop and the map is a grey box asking for a key he already
// gave it.

const BOARD = fs.readFileSync(new URL('../public/schedule-board/app.js', import.meta.url), 'utf8');
const BOARD_DATA = fs.readFileSync(new URL('../public/schedule-board/data.js', import.meta.url), 'utf8');

test('the board reaches the parent it already talks to', () => {
  assert.match(BOARD, /window\.parent\.hlUserSettings/);
  assert.match(BOARD_DATA, /hl-crewboard-token/, 'the postMessage channel it already used');
});

test('both map keys follow the user now', () => {
  assert.match(BOARD, /boardPref\('mapboxToken','hl_mapbox_token'\)/);
  assert.match(BOARD, /boardPrefSet\('mapboxToken','hl_mapbox_token',v\)/);
  assert.match(BOARD, /boardPref\('googleMapsKey','hl_google_key'\)/);
  assert.match(BOARD, /boardPrefSet\('googleMapsKey','hl_google_key',v\)/);
});

test('clearing a key clears it everywhere, not just here', () => {
  // Removing it locally while the record kept it would put it straight back
  // on the next load.
  assert.match(BOARD, /boardPrefSet\('mapboxToken','hl_mapbox_token',null\)/);
  assert.match(BOARD, /if\(value === null\) localStorage\.removeItem\(legacyKey\)/);
});

test('a cross-origin parent is handled rather than thrown from', () => {
  // Should not happen -- the iframe is same-origin -- but reading
  // window.parent across origins throws, and this runs on the map path.
  assert.match(BOARD, /catch\(e\)\{ return null; \}/);
});

test('sl_theme is left alone, and the reason is written down', () => {
  // Not a violation. The board's own toggle is hidden and the theme is pushed
  // down from HiveLogic; sl_theme only mirrors it so the board can paint
  // before the parent's message lands. The preference follows the user one
  // level up.
  assert.match(BOARD_DATA, /sl_theme is NOT a per-device setting/);
  const board = fs.readFileSync(new URL('../public/schedule-board/index.html', import.meta.url), 'utf8');
  assert.match(board, /#themeBtn\{display:none!important\}/);
});
