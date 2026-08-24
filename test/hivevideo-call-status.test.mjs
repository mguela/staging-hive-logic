// test/hivevideo-call-status.test.mjs
//
// Chris, 2026-08-23, watching a recording of himself calling Allan through a
// DM: "its unclear if, I'm calling allan or if I needed to invite him to the
// call?"
//
// The window never said. Two things put together made the question
// unanswerable from the screen:
//
//   1. `$('hd-sub').textContent = 'live'` fired the instant LiveKit connected.
//      "live" described HIS socket, not the call. So the header read
//      "Allan Amit / live" while Allan had no idea anything was happening.
//   2. joinHuddle() opened the "Invite to this call" form whenever nobody else
//      was in the huddle yet -- which on a fresh DM call is always. An empty
//      invite form filling the window reads as an instruction, so the honest
//      reading of that screen was "you must now invite him".
//
// The fix derives the subtitle from the room instead of setting it once, and
// stops treating a DM (which has an implied callee) like an empty channel room.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../public/hiveconnect/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/hiveconnect/styles.css', import.meta.url), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > -1, `${signature} must exist`);
  let depth = 0, i = source.indexOf('{', start);
  do {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < source.length);
  return source.slice(start, i);
}

const ALLAN = { id: 'allan', display_name: 'Allan Amit' };
const DM = { id: 'dm-1', type: 'dm', dm_key: 'chris:allan' };
const CHAN = { id: 'ch-1', type: 'private', name: 'gh-scheduling' };

// Real stand-ins for the LiveKit room and the channel/profile maps, so these
// assert behaviour rather than the shape of the source.
function status({ channel = DM, remotes = [], connecting = false, state = 'connected', ringMs = 0 }) {
  const ctx = vm.createContext({
    me: { id: 'chris' },
    channels: new Map([[channel.id, channel]]),
    profiles: new Map([['allan', ALLAN]]),
    activeHuddle: channel.id,
    hudConnecting: connecting,
    lkRoom: { state, remoteParticipants: new Map(remotes.map((r, i) => [String(i), r])) },
    LivekitClient: { ConnectionState: { Reconnecting: 'reconnecting', Connected: 'connected' } },
    Date: { now: () => 1000 + ringMs },
    hudRingStart: 1000,
  });
  const code = [
    // the real constant, not a copy of it -- retuning the ring window in the
    // app must not quietly stop these tests from describing the app
    src.match(/^const HUD_RING_MS = .*$/m)[0],
    'function isGroupDM(c) { return false; }',
    'function dmOther(c) { return profiles.get("allan"); }',
    extractFunction(src, 'function hudCallTarget(cid)'),
    extractFunction(src, 'function hudRemoteCount()'),
    extractFunction(src, 'function hudStatus()'),
  ].join('\n');
  vm.runInContext(code, ctx);
  return vm.runInContext('hudStatus()', ctx);
}

test('calling one person by name says so, instead of "live"', () => {
  const s = status({});
  assert.equal(s.text, 'Calling Allan…');
  assert.equal(s.state, 'ringing');
});

test('"live" never appears while I am the only one in the call', () => {
  // The exact regression: a subtitle that described my socket, not the call.
  for (const s of [status({}), status({ channel: CHAN })]) {
    assert.doesNotMatch(s.text, /^live$/i);
    assert.notEqual(s.state, 'live');
  }
});

test('a call nobody picks up eventually says nobody picked up', () => {
  const s = status({ ringMs: 60000 });
  assert.equal(s.text, 'No answer from Allan');
  assert.equal(s.state, 'noanswer');
});

test('once they answer it names who is actually there', () => {
  const s = status({ remotes: [{ name: 'Allan Amit' }] });
  assert.equal(s.text, 'In call with Allan');
  assert.equal(s.state, 'live');
});

test('a group counts heads rather than naming one person', () => {
  const s = status({ remotes: [{ name: 'Allan Amit' }, { name: 'Scott' }] });
  assert.equal(s.text, '3 people in this call');
  assert.equal(s.state, 'live');
});

test('a channel huddle has no callee, so it waits rather than claiming to ring someone', () => {
  const s = status({ channel: CHAN });
  assert.equal(s.text, 'Waiting for others to join');
  assert.equal(s.state, 'waiting');
});

test('connecting and reconnecting are still distinct from ringing', () => {
  assert.equal(status({ connecting: true }).text, 'Connecting…');
  assert.equal(status({ state: 'reconnecting' }).text, 'Reconnecting…');
});

test('a group DM is not treated as a call to one named person', () => {
  const ctx = vm.createContext({
    channels: new Map([['g', { id: 'g', type: 'dm', dm_key: 'a:b:c' }]]),
    activeHuddle: 'g',
  });
  vm.runInContext('function isGroupDM(c) { return true; }\nfunction dmOther() { return { display_name: "Allan" }; }\n'
    + extractFunction(src, 'function hudCallTarget(cid)'), ctx);
  assert.equal(vm.runInContext('hudCallTarget()', ctx), null);
});

test('starting a DM call no longer opens the invite form unprompted', () => {
  const fn = extractFunction(src, 'async function joinHuddle(cid)');
  // The old line opened it whenever nobody else was there yet -- always true
  // for a fresh call, so the form was the first thing he ever saw.
  assert.doesNotMatch(fn, /if \(!othersHere\) openHvInvite\(\);/);
  assert.match(fn, /if \(!othersHere && !hudCallTarget\(cid\)\) openHvInvite\(\);/);
});

test('a channel huddle still offers the invite, because it has no implied callee', () => {
  const fn = extractFunction(src, 'async function joinHuddle(cid)');
  assert.match(fn, /openHvInvite\(\)/, 'the prompt is kept where it earns its place');
});

test('the subtitle is recomputed on arrival and departure, not set once at connect', () => {
  assert.doesNotMatch(src, /\$\('hd-sub'\)\.textContent = 'live'/,
    'the connect-time "live" assignment is what made the header lie');
  assert.match(src, /\.on\(RE\.ParticipantConnected, \(\) => \{[^}]*renderHuddleStatus\(\)/);
  assert.match(src, /\.on\(RE\.ParticipantDisconnected, \(\) => \{[^}]*renderHuddleStatus\(\)/);
});

test('leaving stops the ring clock and clears the pending tile', () => {
  const fn = extractFunction(src, 'function leaveHuddle(silent)');
  assert.match(fn, /stopRingClock\(\);/);
  assert.match(fn, /getElementById\('hd-pending'\)/);
});

test('the status dot carries the state too, so ringing cannot look connected', () => {
  for (const state of ['live', 'ringing', 'connecting', 'waiting', 'noanswer']) {
    assert.match(css, new RegExp(`\\.hd-live-dot\\[data-state="${state}"\\]`),
      `${state} needs its own dot colour`);
  }
  assert.match(extractFunction(src, 'function renderHuddleStatus()'), /dot\.dataset\.state = state/);
});

test('the person being called gets a tile, showing who and what is happening', () => {
  const fn = extractFunction(src, 'function hudPendingTile(grid, target, state)');
  assert.match(fn, /avatarEl\(target, 'avatar'\)/, 'their face');
  assert.match(fn, /target\.display_name/, 'their name');
  assert.match(fn, /'Calling… '/);
  assert.match(fn, /'No answer — '/);
});

test('the pending tile is a tile in the grid, not a panel above it', () => {
  // The first version gave the callee a centred hero and squeezed my own camera
  // into an 84px strip beneath it. Chris: "the caller and the called should
  // ahve the same size squares". Same grid, same class, same square.
  const fn = extractFunction(src, 'function hudPendingTile(grid, target, state)');
  assert.match(fn, /className = 'hd-tile hd-pending'/);
  assert.match(fn, /grid\.appendChild\(el\)/);
  const css = readFileSync(new URL('../public/hiveconnect/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.hd-calling/, 'the hero panel is gone');
  assert.doesNotMatch(css, /data-call-state="ringing"\] \.hd-grid \{/, 'and so is the 84px self-view strip');
});

test('the pending tile is torn down the moment it stops being true', () => {
  const fn = extractFunction(src, 'function hudPendingTile(grid, target, state)');
  assert.match(fn, /if \(!target\) \{ if \(el\) el\.remove\(\); return; \}/);
});

test('a person being rung counts toward the grid, so the squares stay equal', () => {
  const fn = extractFunction(src, 'function renderHuddleTiles()');
  assert.match(fn, /const count = parts\.length \+ \(pendingWho \? 1 : 0\);/);
  assert.match(fn, /Math\.ceil\(Math\.sqrt\(count\)\)/);
  assert.match(fn, /Math\.ceil\(count \/ cols\)/);
});

test('nobody is left pending once somebody actually answers', () => {
  const fn = extractFunction(src, 'function renderHuddleTiles()');
  assert.match(fn, /!lkRoom\.remoteParticipants\.size &&/);
});

// ---- what the video actually looks like ----
//
// Chris, 2026-08-23, on the call window: "the video should show a square for
// each caller or if its only the 1". One caller got a tile stretched to
// whatever shape the window happened to be -- measured at 366x261, a
// full-width letterbox with a face cropped into the middle of it.

// `.hd-tile {` also appears inside longer selectors earlier in the file, and
// the rule bodies carry comments naming the very declarations under test.
const cssText = readFileSync(new URL('../public/hiveconnect/styles.css', import.meta.url), 'utf8');
const rule = (name) => {
  const at = cssText.indexOf('\n' + name + ' {');
  assert.ok(at > -1, name + ' must be a top-level rule');
  return cssText.slice(at, cssText.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, '');
};

test('a tile is a square, sized by whichever cell dimension runs out first', () => {
  const tile = rule('.hd-tile');
  assert.match(tile, /aspect-ratio: 1 \/ 1;/);
  assert.match(tile, /width: min\(/, 'the smaller of the two dimensions wins');
  assert.match(tile, /100cqw/);
  assert.match(tile, /100cqh/);
  // The obvious-looking version does NOT work: max-height clamps the height and
  // leaves the width alone, so the tile goes straight back to a letterbox.
  assert.doesNotMatch(tile, /max-height: 100%/);
});

test('the grid is the container those cq units are measured against', () => {
  assert.match(rule('.hd-grid'), /container-type: size/);
});

test('a browser without container-query units gets a tile, not a collapsed one', () => {
  const tile = rule('.hd-tile');
  const widths = [...tile.matchAll(/^\s*width: /gm)];
  assert.equal(widths.length, 2, 'a plain fallback must precede the min()');
  assert.ok(tile.indexOf('width: 100%;') < tile.indexOf('width: min('));
});

test('both counts reach the CSS, because columns alone cannot say how tall a cell is', () => {
  const fn = extractFunction(src, 'function renderHuddleTiles()');
  assert.match(fn, /setProperty\('--cols', cols\)/);
  assert.match(fn, /setProperty\('--rows', Math\.max\(1, Math\.ceil\(count \/ cols\)\)\)/);
});

test('a shared screen is still allowed to be wide — it is not a face', () => {
  assert.match(cssText, /\.hd-grid\.hd-spotlight \.hd-tile \{ aspect-ratio: auto;/);
});

// ---- one writer for the status line ----

test('renderHuddleUI no longer writes its own subtitle over the status engine', () => {
  // It set "Waiting for others…" / "N people" on every presence sync, which
  // stamped over "Calling Allan…" and put back the exact ambiguity the status
  // engine exists to remove.
  // The comment left in its place quotes the removed line, so match on code.
  const fn = extractFunction(src, 'function renderHuddleUI()')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(fn, /Waiting for others…/);
  assert.doesNotMatch(fn, /sub\.textContent = /);
  assert.match(fn, /renderHuddleStatus\(\);/, 'it defers to the one writer instead');
});

test('a lone face is not shown as a participant strip next to the window controls', () => {
  const fn = extractFunction(src, 'function renderHuddleUI()');
  assert.match(fn, /if \(parts2\.length > 1\) hp\.appendChild\(partStrip/);
});

test('a tile is a square, sized by whichever cell dimension runs out first', () => {
  const tile = rule('.hd-tile');
  assert.match(tile, /aspect-ratio: 1 \/ 1;/);
  assert.match(tile, /width: min\(/, 'the smaller of the two dimensions wins');
  assert.match(tile, /100cqw/);
  assert.match(tile, /100cqh/);
  // The obvious-looking version does NOT work: max-height clamps the height and
  // leaves the width alone, so the tile goes straight back to a letterbox.
  assert.doesNotMatch(tile, /max-height: 100%/);
});

test('the grid is the container those cq units are measured against', () => {
  assert.match(rule('.hd-grid'), /container-type: size/);
});

test('a browser without container-query units gets a tile, not a collapsed one', () => {
  const tile = rule('.hd-tile');
  const widths = [...tile.matchAll(/^\s*width: /gm)];
  assert.equal(widths.length, 2, 'a plain fallback must precede the min()');
  assert.ok(tile.indexOf('width: 100%;') < tile.indexOf('width: min('));
});

test('both counts reach the CSS, because columns alone cannot say how tall a cell is', () => {
  const fn = extractFunction(src, 'function renderHuddleTiles()');
  assert.match(fn, /setProperty\('--cols', cols\)/);
  assert.match(fn, /setProperty\('--rows', Math\.max\(1, Math\.ceil\(count \/ cols\)\)\)/);
});

test('a shared screen is still allowed to be wide — it is not a face', () => {
  assert.match(cssText, /\.hd-grid\.hd-spotlight \.hd-tile \{ aspect-ratio: auto;/);
});

// ---- one writer for the status line ----

test('renderHuddleUI no longer writes its own subtitle over the status engine', () => {
  // It set "Waiting for others…" / "N people" on every presence sync, which
  // stamped over "Calling Allan…" and put back the exact ambiguity the status
  // engine exists to remove.
  // The comment left in its place quotes the removed line, so match on code.
  const fn = extractFunction(src, 'function renderHuddleUI()')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(fn, /Waiting for others…/);
  assert.doesNotMatch(fn, /sub\.textContent = /);
  assert.match(fn, /renderHuddleStatus\(\);/, 'it defers to the one writer instead');
});

test('a lone face is not shown as a participant strip next to the window controls', () => {
  const fn = extractFunction(src, 'function renderHuddleUI()');
  assert.match(fn, /if \(parts2\.length > 1\) hp\.appendChild\(partStrip/);
});
