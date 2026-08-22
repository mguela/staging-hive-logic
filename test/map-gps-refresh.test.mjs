// On-demand refresh for the truck positions on both staff maps.
//
// WHY THE BUTTON IS HONEST-BY-CONSTRUCTION, AND WHY THAT NEEDS TESTS
//
// The freshest GPS this app has arrives when FleetSharp PUSHES a fix to
// /api/jobber/sync-extended?resource=fleetsharp_push, on the vendor's own
// schedule. There is no outbound call anywhere in api/ that asks FleetSharp for
// a position, and the Jobber path that does pull one
// (Vehicle.liveState.currentPosition) is the one that went days stale and
// caused the direct push to be added in the first place.
//
// So a button labelled "refresh" can only re-read the vehicles table. It picks
// up whatever has landed since the last poll -- genuinely useful, because the
// 60s poll pauses while the tab is hidden or the user is on another view, so a
// dispatcher coming back can be looking at positions far staler than a minute.
// What it cannot do is make a 20-minute-old fix any newer than 20 minutes.
//
// The failure mode to guard against is therefore NOT "the button doesn't work".
// It is the button working perfectly and the UI then implying the trucks just
// reported. Both maps already carry an age label; the tests below pin that the
// refresh path never overwrites it with reassurance.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const indexHtml = read('public', 'index.html');
const boardJs = read('public', 'schedule-board', 'app.js');
const boardHtml = read('public', 'schedule-board', 'index.html');

// --- the premise the whole design rests on ----------------------------------

test('nothing in the API can ask a truck for a fresh fix', () => {
  // If this ever stops being true -- someone adds a FleetSharp pull -- the
  // button should DO that instead of only re-reading, and the copy that says it
  // cannot becomes a lie. Failing here is the signal to revisit both.
  const apiDir = path.join(root, 'api');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.js') ? [full] : []);
  });
  const outbound = walk(apiDir).filter((f) => {
    const src = fs.readFileSync(f, 'utf8');
    // an outbound HTTP call whose target names the GPS vendor
    return /fetch\([^)]*fleetsharp/i.test(src) || /https?:\/\/[^'"`\s]*fleetsharp/i.test(src);
  });
  assert.deepEqual(outbound, [],
    'a FleetSharp pull now exists -- the refresh button should use it, and the '
    + '"cannot make a stale fix newer" copy needs revisiting');
});

// --- the Command Center map --------------------------------------------------
//
// A note on which map this is, because the first attempt got it wrong and the
// browser proved it: index.html contains TWO map implementations. SCHEDMAP is
// dead -- its footer element id="sched-map-foot" appears zero times in the
// markup and nothing outside its own block references it. The live Service Area
// Map is window._ccMap, built by loadMapLive() and fed by loadTechLocationsLive().
// Wiring the button to SCHEDMAP passed every source-level assertion and fetched
// nothing at all.

test('the refresh drives the LIVE map, not the dead SCHEDMAP implementation', () => {
  assert.match(indexHtml, /id="cc-map-refresh"[^>]*onclick="ccMapRefreshTechs\(this\)"/,
    'the button must be wired to the handler that drives window._ccMap');
  const open = indexHtml.indexOf('function ccMapRefreshTechs(btn){');
  assert.ok(open > -1, 'ccMapRefreshTechs must exist');
  const body = indexHtml.slice(open, indexHtml.indexOf('\nwindow.ccMapRefreshTechs', open));
  assert.match(body, /window\._ccMap/, 'it must read the live map object');
  assert.match(body, /loadTechLocationsLive\(map\)/,
    'it must reuse the loader the periodic refresh uses, not a second copy of the fetch');
  assert.doesNotMatch(body, /SCHEDMAP/, 'SCHEDMAP is dead code and must not be revived here');
});

test('the handler is reachable from the inline onclick', () => {
  // It is declared inside an IIFE, so a bare function declaration is invisible
  // to onclick. This was the second thing the browser caught: the button
  // rendered, looked perfect, and did nothing because the handler was not global.
  assert.match(indexHtml, /^window\.ccMapRefreshTechs = ccMapRefreshTechs;$/m,
    'without the window export the button is inert');
});

test('the loader returns its promise so pending state is real', () => {
  const open = indexHtml.indexOf('function loadTechLocationsLive(map){');
  assert.ok(open > -1);
  const body = indexHtml.slice(open, indexHtml.indexOf('\nfunction ', open + 40));
  assert.match(body, /return ccBundleFetch\('crew_schedule'\)/,
    'loadTechLocationsLive must return its chain, or the spinner is a fixed-length lie');
});

test('the re-entrancy guard is the first thing the handler does', () => {
  // Comment lines are allowed between; executable statements are not. The guard
  // has to run before anything mutates button state, or a second entry can
  // disable the button and schedule a settle that re-enables it early.
  const open = indexHtml.indexOf('function ccMapRefreshTechs(btn){');
  assert.ok(open > -1, 'ccMapRefreshTechs must exist');
  const body = indexHtml.slice(open, indexHtml.indexOf('\nwindow.ccMapRefreshTechs', open));
  const firstStatement = body.split('\n').slice(1)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('//'));
  assert.equal(firstStatement, 'if(window._ccTechRefreshing) return;',
    'the guard must come before any other statement in the handler');
});

test('the button is found again when the read settles', () => {
  const open = indexHtml.indexOf('function ccMapRefreshTechs(btn){');
  const body = indexHtml.slice(open, indexHtml.indexOf('\nwindow.ccMapRefreshTechs', open));
  assert.match(body, /document\.getElementById\('cc-map-refresh'\)/,
    're-query on settle rather than trusting a possibly-detached reference');
});

// --- the schedule board map --------------------------------------------------

test('board: the button re-reads through loadLiveGps, which already returns a promise', () => {
  assert.match(boardJs, /id="map-gps-refresh"[^`]*onclick="refreshLiveGps\(this\)"/);
  assert.match(boardJs, /function refreshLiveGps\(btn\)\{[\s\S]*?loadLiveGps\(\)\.finally\(/);
  assert.match(boardJs, /window\.refreshLiveGps = refreshLiveGps;/,
    'the inline onclick needs it on window -- app.js runs inside a closure');
});

test('board: the button is found again after the control bar re-renders', () => {
  // mapPeriodCtlHTML() rewrites .mapctl wholesale, so the element the click
  // started on can be detached by the time the fetch settles. Re-enabling the
  // stale reference would leave the live button disabled and spinning forever.
  assert.match(boardJs, /const now = document\.getElementById\('map-gps-refresh'\);/,
    'the settle handler must re-query rather than trust the original element');
});

test('board: a second click while in flight is ignored', () => {
  assert.match(boardJs, /function refreshLiveGps\(btn\)\{\s*if\(gpsRefreshing\) return;/);
});

// --- what the UI is allowed to claim ----------------------------------------

test('neither refresh path overwrites the age label with reassurance', () => {
  // The age label is the only thing on screen that tells the truth about how
  // old the data is. A refresh that set it to "just now" would turn a working
  // button into a lying one -- the exact failure this app has been bitten by
  // elsewhere (hardcoded CONNECTED badges, a green dot on dead monitoring).
  const ccRefresh = indexHtml.slice(
    indexHtml.indexOf('function ccMapRefreshTechs(btn){'),
    indexHtml.indexOf('\nwindow.ccMapRefreshTechs'));
  assert.ok(ccRefresh.length > 100, 'ccMapRefreshTechs must exist to be checked');
  assert.doesNotMatch(ccRefresh, /just now|up to date|current as of|refreshed/i,
    'the refresh handler must not author freshness claims; the footer reports real age');

  const boardRefresh = boardJs.slice(
    boardJs.indexOf('function refreshLiveGps(btn){'),
    boardJs.indexOf('window.refreshLiveGps'));
  assert.ok(boardRefresh.length > 50, 'refreshLiveGps must exist to be checked');
  assert.doesNotMatch(boardRefresh, /just now|up to date|current as of/i,
    'the legend keeps reporting age via gpsAgoLabel(); the button must not override it');
});

test('the age label still derives from the data, not from when the button was clicked', () => {
  // gpsAgoLabel measures from LIVEGPS.at, which applyLiveGps sets from the
  // payload. If a refresh stamped it from Date.now() regardless of payload, a
  // failed or empty read would read as fresh.
  assert.match(boardJs, /function gpsAgoLabel\(\)\{[\s\S]*?if\(!LIVEGPS\.at\) return 'GPS loading…';/,
    'no timestamp must mean "loading", never "just now"');
  assert.match(boardJs, /if\(LIVEGPS\.error\) return 'GPS unavailable/,
    'an error must surface as unavailable rather than a stale-but-confident age');
});

test('the button copy says what it does, not what a user might hope', () => {
  for (const src of [indexHtml, boardJs]) {
    assert.match(src, /Trucks report on their own schedule/,
      'the tooltip must say the truck was not contacted');
    assert.match(src, /cannot make a stale fix newer/,
      'the tooltip must state the limit plainly rather than implying freshness');
  }
});

// --- accessibility and motion ------------------------------------------------

test('the spinner respects a reduced-motion preference on both maps', () => {
  assert.match(indexHtml, /@media \(prefers-reduced-motion:reduce\)\{\.map-expand\.spinning\{animation:none/);
  assert.match(boardHtml, /@media \(prefers-reduced-motion:reduce\)\{\.mapctl button\.spinning\{animation:none/);
});

test('the glyph-only buttons carry an accessible name', () => {
  // Both are a bare ↻ -- without a label a screen reader announces nothing useful.
  assert.match(indexHtml, /id="cc-map-refresh"[^>]*aria-label="Refresh truck positions"/);
  assert.match(boardJs, /id="map-gps-refresh"[^`]*aria-label="Refresh truck positions"/);
});
