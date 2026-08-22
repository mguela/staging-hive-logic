import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The crew board (public/schedule-board/) is the Schedule tab users actually
// see — public/index.html's inline board is hidden behind #crewboard-frame.
// These tests cover the board's own view-state persistence and map period
// filtering, extracting the real functions out of app.js into a vm sandbox
// (same approach as the other frontend tests in this repo).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_PATH = path.join(__dirname, '..', 'public', 'schedule-board', 'app.js');
const source = fs.readFileSync(APP_PATH, 'utf-8');

function extractFunction(src, declSnippet) {
  const declStart = src.indexOf(declSnippet);
  if (declStart === -1) throw new Error('function not found: ' + declSnippet);
  if (declSnippet[declSnippet.length - 1] !== '{') throw new Error('declSnippet must end with the opening brace: ' + declSnippet);
  const braceStart = declStart + declSnippet.length - 1;
  let depth = 1;
  let i = braceStart + 1;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(declStart, i);
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const FN_SRC = [
  'function parseYMD(s){',
  'function ymd(d){',
  'function addDays(s,n){',
  'function weekDaysOf(s){',
  'function mapPeriodRange(scope){',
  'function mapVisits(scope){',
  'function mapVisitIds(scope){',
  'function boardStateSnapshot(){',
  'function mapAutoResize(map, el){',
].map((d) => extractFunction(source, d)).join('\n');

const visit = (id, date, lat = 41.03, lng = -73.62) => ({ id, date, lat, lng });

function makeSandbox(overrides = {}) {
  const ctx = {
    console, Date, Math, Number, String, Object, Array, JSON,
    // Mon 2026-08-10 .. Sun 2026-08-16
    state: {
      view: 'map', date: '2026-08-13', mapPeriod: 'day',
      filter: 'all', division: 'all', scope: 'company', role: 'dispatcher',
      controlMode: 'mirror', filtersOpen: false, lensBarOpen: false, layersOpen: false,
      lenses: { materials: false, money: true, assets: false, compliance: false, weather: false },
      hidden: new Set(['sami']), mapBg: true,
      mbView: { map: null }, mlView: { map: null },
      undo: { some: 'thing' }, scenario: { changes: [1, 2] }, focusProject: 'p1',
      mapClock: 13.5, mapPlaying: true,
    },
    visits: [],
    BSTATE_BOOT: null,
    LAST_CAM: null,   // module-level in app.js: last camera seen, survives a map teardown
    ...overrides,
  };
  vm.createContext(ctx);
  vm.runInContext(FN_SRC, ctx);
  return ctx;
}

test('Day period plots only the day being viewed, and follows day nav', () => {
  const ctx = makeSandbox();
  ctx.visits = [visit('a', '2026-08-12'), visit('b', '2026-08-13'), visit('c', '2026-08-14')];
  assert.deepEqual(ctx.mapVisits().map((v) => v.id), ['b']);
  ctx.state.date = '2026-08-14';
  assert.deepEqual(ctx.mapVisits().map((v) => v.id), ['c']);
});

test('Week period plots the whole Mon–Sun week the viewed day falls in', () => {
  const ctx = makeSandbox();
  ctx.state.mapPeriod = 'week';
  ctx.visits = [
    visit('sunPrev', '2026-08-09'),
    visit('mon', '2026-08-10'),
    visit('thu', '2026-08-13'),
    visit('sun', '2026-08-16'),
    visit('monNext', '2026-08-17'),
  ];
  assert.deepEqual(ctx.mapVisits().map((v) => v.id), ['mon', 'thu', 'sun']);
  const r = ctx.mapPeriodRange();
  assert.equal(r.start, '2026-08-10');
  assert.equal(r.end, '2026-08-16');
});

test('visits with no coordinates are never plotted', () => {
  const ctx = makeSandbox();
  ctx.visits = [visit('ok', '2026-08-13'), { id: 'nogeo', date: '2026-08-13', lat: null, lng: null }];
  assert.deepEqual(ctx.mapVisits().map((v) => v.id), ['ok']);
});

// The backdrop behind the calendar follows the CALENDAR's period, not the Map
// tab's own toggle: Day board -> that day, Week board -> that week.
test("scope 'board' follows the calendar view, not the Map tab's toggle", () => {
  const ctx = makeSandbox();
  ctx.state.mapPeriod = 'week';          // Map tab is on Week...
  ctx.state.view = 'day';                // ...but the calendar is on Day
  ctx.visits = [visit('mon', '2026-08-10'), visit('thu', '2026-08-13')];
  assert.deepEqual(ctx.mapVisits().map((v) => v.id), ['mon', 'thu'], 'Map tab keeps its own period');
  assert.deepEqual(ctx.mapVisits('board').map((v) => v.id), ['thu'], 'backdrop follows the Day board');
  assert.deepEqual(Object.keys(ctx.mapVisitIds('board')), ['thu']);

  ctx.state.view = 'week';               // Week board -> the whole week
  assert.deepEqual(ctx.mapVisits('board').map((v) => v.id), ['mon', 'thu']);
});

test('the map layer is on by default and covers both calendar views', () => {
  const fn = stripComments(extractFunction(source, 'function renderMapBg(){'));
  assert.match(fn, /state\.view==='day'\s*\|\|\s*state\.view==='week'/, 'backdrop must cover Week too');
  assert.match(source, /mapBg:\s*true/, 'the map layer defaults to on');
  const poll = stripComments(extractFunction(source, 'function syncMapTimer(){'));
  assert.match(poll, /state\.view==='week'/, 'GPS polling must run while the Week backdrop is up');
});

// The bug behind "the map shows everywhere I've looked": mbAddJobs only ever
// added markers, so each day navigated through left its pins behind.
test('mbAddJobs removes markers that have left the period before adding new ones', () => {
  const fn = stripComments(extractFunction(source, 'function mbAddJobs(store, interactive){'));
  const wantIdx = fn.indexOf('mapVisitIds');
  const addIdx = fn.indexOf('.Marker(');   // engine-agnostic: store.gl is Mapbox or MapLibre
  assert.ok(wantIdx > -1, 'must compute the set of visits that belong in the period');
  assert.ok(fn.includes('.mk.remove()'), 'must remove markers, not only add them');
  assert.ok(fn.includes('delete store.jobMarkers[id]'), 'must forget removed markers');
  assert.ok(wantIdx < addIdx, 'the removal pass has to run before the add pass');
});

test('mbUpdate re-syncs the job layer so day nav moves the pins', () => {
  const fn = extractFunction(source, 'function mbUpdate(store){');
  assert.ok(fn.includes('mbAddJobs(store'), 'polling/refresh must reconcile pins with the period');
});

test('the board persists durable view state and no transient state', () => {
  const ctx = makeSandbox();
  const st = ctx.boardStateSnapshot();

  assert.equal(st.view, 'map');
  assert.equal(st.scope, 'company');
  assert.equal(st.role, 'dispatcher');
  assert.equal(st.mapPeriod, 'day');
  assert.equal(st.mapBg, true);
  assert.equal(st.lenses.money, true);
  assert.deepEqual(st.hidden, ['sami'], 'hidden is a Set in state and an array on disk');

  // transient state must never be written
  ['date', 'undo', 'scenario', 'focusProject', 'mapClock', 'mapPlaying'].forEach((k) => {
    assert.ok(!(k in st), k + ' is transient and must not be persisted');
  });
});

test('the camera survives a session where the map was never opened', () => {
  const cam = { lng: -73.64, lat: 41.14, zoom: 13, bearing: 40, pitch: 55 };
  const ctx = makeSandbox({ BSTATE_BOOT: { cam } });
  assert.deepEqual(ctx.boardStateSnapshot().cam, cam, 'falls back to the boot camera');
  // and once a map has been seen, that wins even after it is torn down
  ctx.LAST_CAM = { lng: -73.60, lat: 41.10, zoom: 15, bearing: 0, pitch: 30 };
  assert.deepEqual(ctx.boardStateSnapshot().cam, ctx.LAST_CAM, 'the last live camera outranks the boot one');
});

test('the camera is read off whichever map engine is live', () => {
  const fakeMap = {
    getCenter: () => ({ lng: -73.6412, lat: 41.1443219 }),
    getZoom: () => 12.345,
    getBearing: () => 30,
    getPitch: () => 62,
  };
  const ctx = makeSandbox();
  ctx.state.mlView.map = fakeMap; // MapLibre path, no Mapbox token present
  const st = ctx.boardStateSnapshot();
  assert.deepEqual(st.cam, { lng: -73.6412, lat: 41.144322, zoom: 12.35, bearing: 30, pitch: 62 });
});

test('restore runs before the first render, and saving hangs off render()', () => {
  assert.ok(
    /boardStateRestore\(\);[\s\S]{0,200}\n\s*render\(\);/.test(source),
    'boardStateRestore() must be called before the initial render()'
  );
  const render = extractFunction(source, 'function render(){');
  assert.ok(render.includes('boardStateSave()'), 'render() is the funnel every state change passes through');
  assert.ok(source.includes("addEventListener('pagehide'"), 'a pending debounced write must flush on pagehide');
});

test('day nav is available on the Map tab and steps by the map period', () => {
  const render = extractFunction(source, 'function render(){');
  assert.match(render, /daynav[\s\S]{0,120}state\.view==='map'/, 'the Map tab needs its date controls');
  const shift = source.slice(source.indexOf('window.shiftDay=(d)=>{'), source.indexOf('window.goToday='));
  assert.match(shift, /state\.view==='map'[\s\S]{0,120}mapPeriod==='week'\s*\?\s*d\*7\s*:\s*d/, 'map nav steps a week when plotting a week');
});

// --- Real vehicle GPS replacing the simulation ---
// truckPos() interpolated a position along the day's scheduled stops against a
// play clock: trucks visibly sliding around a screen labelled "live vehicle
// positions", with nothing observed behind the motion.

const GPS_FN_SRC = [
  'function applyLiveGps(d){',
  'function gpsCounts(){',
  'function liveTruckPos(id){',
  'function gpsAgoLabel(){',
].map((d) => extractFunction(source, d)).join('\n');

function gpsSandbox(techList, visibleIds) {
  const ctx = {
    console, Date, Math, Number, String, Object, Array, JSON, Infinity,
    GPS_STALE_MS: 30 * 60 * 1000,
    LIVEGPS: { byTech: {}, at: 0, error: null },
    techs: techList,
    visibleTechs: () => techList.filter((t) => !visibleIds || visibleIds.includes(t.id)),
    gpsNorm: (x) => String(x || '').trim().toLowerCase(),
  };
  vm.createContext(ctx);
  vm.runInContext(GPS_FN_SRC, ctx);
  return ctx;
}

const tech = (id, n, fullName, vehicleName) => ({ id, n, fullName, vehicleName });
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

test('a crew is matched to its vehicle by the roster vehicle name', () => {
  const ctx = gpsSandbox([tech('marco', 'Marco', 'Marco Diaz', '2021 PROMASTER')]);
  ctx.applyLiveGps({
    vehicles: [{ name: '2021 PROMASTER', lat: 41.14, lng: -73.64, status: 'DRIVING', updatedAt: iso(60000) }],
  });
  const p = ctx.liveTruckPos('marco');
  assert.equal(p.lat, 41.14);
  assert.equal(p.moving, true);
  assert.equal(p.stale, false);
});

test('a crew with no roster vehicle falls back to the crew_schedule assignment list', () => {
  const ctx = gpsSandbox([tech('dana', 'Dana', 'Dana Reyes', null)]);
  ctx.applyLiveGps({
    vehicles: [{ name: 'GH ELECTRIC #2', lat: 41.36, lng: -73.77, status: 'STOPPED', updatedAt: iso(60000) }],
    vehicleAssignments: [{ vehicleName: 'GH ELECTRIC #2', techName: 'Dana Reyes' }],
  });
  assert.equal(ctx.liveTruckPos('dana').lng, -73.77);
});

// The whole point: no position invented for a crew we cannot actually see.
test('a crew with no vehicle gets NO position — it is not parked at the shop', () => {
  const ctx = gpsSandbox([tech('nogps', 'Sam', 'Sam Lee', null)]);
  ctx.applyLiveGps({ vehicles: [{ name: 'Some Truck', lat: 41.1, lng: -73.6, updatedAt: iso(1000) }] });
  assert.equal(ctx.liveTruckPos('nogps'), null);
  assert.equal(ctx.gpsCounts().untracked, 1);
});

test('a vehicle with no coordinates yields no position', () => {
  const ctx = gpsSandbox([tech('a', 'A', 'A One', 'T1')]);
  ctx.applyLiveGps({ vehicles: [{ name: 'T1', lat: null, lng: null, updatedAt: iso(1000) }] });
  assert.equal(ctx.liveTruckPos('a'), null);
});

test('a fix older than 30 minutes is marked stale and never counted as moving', () => {
  const ctx = gpsSandbox([tech('a', 'A', 'A One', 'T1')]);
  ctx.applyLiveGps({ vehicles: [{ name: 'T1', lat: 41, lng: -73, status: 'DRIVING', updatedAt: iso(45 * 60 * 1000) }] });
  const p = ctx.liveTruckPos('a');
  assert.equal(p.stale, true);
  assert.equal(p.moving, false, 'a stale fix must not animate as if the truck were driving');
  assert.equal(ctx.gpsCounts().stale, 1);
  assert.equal(ctx.gpsCounts().live, 0);
});

test('a vehicle with no timestamp at all is treated as stale, not as current', () => {
  const ctx = gpsSandbox([tech('a', 'A', 'A One', 'T1')]);
  ctx.applyLiveGps({ vehicles: [{ name: 'T1', lat: 41, lng: -73, status: 'MOVING' }] });
  assert.equal(ctx.liveTruckPos('a').stale, true);
});

// Counts are taken over the crews on screen, at render time.
test('hiding a crew cannot leave the legend claiming more tracked crews than shown', () => {
  const all = [tech('a', 'A', 'A One', 'T1'), tech('b', 'B', 'B Two', 'T2')];
  const ctx = gpsSandbox(all, ['a']); // b is hidden
  ctx.applyLiveGps({
    vehicles: [
      { name: 'T1', lat: 41, lng: -73, status: 'MOVING', updatedAt: iso(1000) },
      { name: 'T2', lat: 41, lng: -73, status: 'MOVING', updatedAt: iso(1000) },
    ],
  });
  const c = ctx.gpsCounts();
  assert.equal(c.shown, 1);
  assert.equal(c.live, 1);
  assert.ok(c.live <= c.shown, 'never "2 of 1 crews tracked"');
});

test('a failed GPS fetch is reported, not silently blank', () => {
  const ctx = gpsSandbox([tech('a', 'A', 'A One', 'T1')]);
  ctx.LIVEGPS.error = 'HTTP 500';
  assert.match(ctx.gpsAgoLabel(), /GPS unavailable \(HTTP 500\)/);
});

test('the simulation is gone from every drawing path', () => {
  const body = stripComments(source);
  assert.ok(!/\btruckPos\s*\(/.test(body), 'no caller may still use the interpolated position');
  assert.ok(!body.includes('state.mapClock'), 'the play clock must not drive anything');
  assert.ok(!body.includes('mapPlaying'), 'the Play/Pause scrubber must be gone');
  // every truck drawn must first check for a real fix
  ['buildMapSVG', 'buildCitySVG'].forEach((fnName) => {
    const fn = stripComments(extractFunction(source, 'function ' + fnName + (fnName === 'buildMapSVG' ? '(fit){' : '(){')));
    assert.match(fn, /liveTruckPos\([^)]*\);\s*if\(!pos\)\s*return;/, fnName + ' must skip crews with no real position');
  });
});

test('the GPS poll runs at Command Center cadence and only while a map is on screen', () => {
  const fn = stripComments(extractFunction(source, 'function syncMapTimer(){'));
  assert.ok(fn.includes('loadLiveGps()'), 'the timer drives the GPS poll');
  assert.ok(fn.includes('60000'), '60s, matching Command Center');
  assert.ok(fn.includes('document.hidden'), 'polling pauses with the tab');
  assert.match(fn, /state\.view==='map'/, 'only polls when a map is actually visible');
});

test('markers are reconciled, so a crew that loses its fix loses its truck', () => {
  const fn = stripComments(extractFunction(source, 'function mbAddMarkers(store){'));
  assert.ok(fn.includes('liveTruckPos'), 'only crews with a real fix get a marker');
  assert.ok(fn.includes('delete store.markers[id]'), 'a lost fix must remove the marker, not freeze it');
  const upd = stripComments(extractFunction(source, 'function mbUpdate(store){'));
  assert.ok(upd.includes('setLngLat'), 'positions move in place rather than rebuilding the layer');
});

// --- Map engine: keyless fallback + controls ---
// A shared Mapbox token is baked into index.html, so this was never per-user
// setup. It is a single point of failure though: expiry, quota, or a URL
// restriction that doesn't cover a preview host. The old error handler removed
// the map and nulled the store, leaving an empty box and no explanation.

test('a Mapbox auth failure hands over to the keyless engine instead of blanking', () => {
  const build = stripComments(extractFunction(source, 'function mbBuild(store, containerId, interactive){'));
  assert.ok(!/store\.map=null;\s*store\.ready=false;\s*\}\s*\}\);/.test(build), 'must not silently null the store');
  assert.ok(build.includes('mapFallback('), 'an auth error must fall back, not give up');
  assert.match(build, /403|quota|rate limit/, 'quota and forbidden are auth-shaped failures too');

  const fb = stripComments(extractFunction(source, 'function mapFallback(why){'));
  assert.ok(fb.includes("MAPENGINE='maplibre'"), 'the fallback switches engine');
  assert.ok(fb.includes('render()'), 'and redraws so a map actually appears');
});

test('the keyless style needs no token or account', () => {
  const style = stripComments(extractFunction(source, 'function mlStyle(){'));
  assert.ok(style.includes('openstreetmap.org'), 'OSM raster tiles');
  assert.ok(!/access_?token|api_?key|pk\./i.test(style), 'no credentials of any kind');
  assert.ok(style.includes('attribution'), 'OSM requires attribution');
});

test('zoom, compass-rotate and tilt are available on both engines', () => {
  const ml = stripComments(extractFunction(source, 'function mlBuild(store, containerId, interactive){'));
  const mb = stripComments(extractFunction(source, 'function mbBuild(store, containerId, interactive){'));
  [['MapLibre', ml], ['Mapbox', mb]].forEach(([name, fn]) => {
    assert.ok(fn.includes('NavigationControl'), name + ' needs zoom + compass');
    assert.ok(fn.includes('showCompass:true'), name + ' compass must be shown');
    assert.ok(fn.includes('addTiltControl(map)'), name + ' needs the visible tilt control');
    assert.ok(fn.includes('mapWireCamera(map)'), name + ' must persist its camera');
  });
  const tilt = stripComments(extractFunction(source, 'function addTiltControl(map){'));
  assert.match(tilt, /easeTo\(\{pitch:v/, 'the slider drives pitch (via easeTo, so it can pivot on the shop)');
  assert.ok(tilt.includes("map.on('pitch'"), 'and follows the map when tilt changes elsewhere');
  assert.ok(tilt.includes('max="75"'), 'a real tilt range');
});

test('the Day backdrop no longer gates on a token', () => {
  const fn = stripComments(extractFunction(source, 'function renderMapBg(){'));
  assert.ok(!fn.includes('mbTokenPrompt'), 'the setup prompt must not block the backdrop');
  assert.ok(fn.includes('mapBuildInto'), 'it builds through the engine chooser');
});

test('a total library outage still shows something, not an empty tab', () => {
  const ml = stripComments(extractFunction(source, 'function mlBuild(store, containerId, interactive){'));
  assert.ok(ml.includes('mapSvgFallbackInto('), 'unreachable libraries fall through to the flat SVG');
  assert.ok(ml.includes('MAPNOTE='), 'and say why');
});

test('the fallback is disclosed in the legend rather than passed off as normal', () => {
  const fn = stripComments(extractFunction(source, 'function mapLegendHTML(){'));
  assert.ok(fn.includes('MAPNOTE'), 'the legend surfaces why the engine changed');
});

// The camera is set once at build time, so it has to be refit when the period
// changes: building the backdrop on a day with no jobs and then switching to
// Week left the week's pins outside the viewport — the map looked empty while
// holding every pin. It also has to be fit on the FIRST build, which it was not:
// the backdrop kept mapStartCamera()'s guess until the first day-nav.
test('the backdrop fits on first build as well as on a period change', () => {
  const fn = stripComments(extractFunction(source, 'function mbAddJobs(store, interactive){'));
  assert.ok(fn.includes('store.fitKey'), 'the period must be remembered between reconciles');
  assert.ok(fn.includes('periodChanged'), 'refit is gated on the period actually changing');
  assert.ok(fn.includes('mapFitStore(store, scope)'), 'and it refits after the markers are reconciled');
  assert.match(fn, /firstBuild\s*=\s*store\.fitKey === undefined/, 'a just-built map is recognised as such');
  assert.match(fn, /firstBuild\s*&&\s*!interactive/,
    'the backdrop fits itself on build; the Map tab must not, or it discards the restored camera');
});

test('the refit keeps a bad geocode from dragging the zoom out', () => {
  const fn = stripComments(extractFunction(source, 'function mapFitStore(store, scope){'));
  assert.ok(fn.includes('1.2') && fn.includes('1.5'), 'outlier window around the real HQ');
  assert.ok(fn.includes('maxZoom'), 'and a zoom ceiling');
  assert.ok(fn.includes('easeTo'), 'no pins in range still lands somewhere sane');
});

// --- Found by driving the board in a real browser (2026-08-15) ---

// The camera the user set on the Map tab was wiped the moment they left it:
// boardStateSnapshot() reads the live map, leaving the tab tears both engines
// down, and the fallback was the BOOT value — null on a fresh session.
test('the camera survives leaving the Map tab', () => {
  const snap = stripComments(extractFunction(source, 'function boardStateSnapshot(){'));
  assert.ok(snap.includes('LAST_CAM = cam'), 'a live camera must be remembered');
  assert.ok(snap.includes('else cam = LAST_CAM'), 'a torn-down map falls back to the last known camera');
  assert.match(snap, /cam\s*\|\|\s*LAST_CAM/, 'and the written value prefers it over the boot value');
  const restore = stripComments(extractFunction(source, 'function boardStateRestore(){'));
  assert.ok(restore.includes('LAST_CAM = b.cam'), 'a restored camera seeds it too');
});

// Opening the Map tab from the Week board landed on its own 'day' period, so on
// a day with nothing booked it read "0 mapped jobs" — the "active jobs don't
// show" report.
test('the Map tab opens on the period you were already looking at', () => {
  const fn = stripComments(source.slice(source.indexOf('window.setView=(v)=>{'), source.indexOf('window.shiftDay=')));
  assert.match(fn, /v==='map'/, 'entering the map is a special case');
  assert.match(fn, /state\.view==='week'\s*\)\s*\?\s*'week'\s*:\s*'day'/, 'week board -> week map, day board -> day map');
  // and it must only inherit when coming FROM a calendar view
  assert.match(fn, /state\.view==='day'\s*\|\|\s*state\.view==='week'/);
});

// Restoring straight into the Map tab left the map blank: the container had not
// been laid out when the map mounted, and the fixed 60/300ms nudges both fired
// too early. Confirmed in a real browser on the Mapbox path — the canvas sat
// blank with no tiles, pins or trucks for over a minute, and painted instantly
// (80 pins, 9 trucks) the moment a resize fired. So watch the container instead.
function resizeHarness({ connected = true, resizeThrows = false } = {}) {
  const calls = { resize: 0, disconnect: 0, observed: [] };
  const el = { get isConnected() { return connected; } };
  const map = { resize() { calls.resize++; if (resizeThrows) throw new Error('map removed'); } };
  let fire = null;
  class FakeResizeObserver {
    constructor(cb) { fire = cb; }
    observe(target) { calls.observed.push(target); }
    disconnect() { calls.disconnect++; }
  }
  const ctx = makeSandbox({ ResizeObserver: FakeResizeObserver });
  ctx.mapAutoResize(map, el);
  return { calls, fire: () => fire() };
}

test('the map resizes when its container actually gets a size', () => {
  const h = resizeHarness();
  assert.equal(h.calls.observed.length, 1, 'the container is observed');
  h.fire();
  assert.equal(h.calls.resize, 1);
  h.fire();
  assert.equal(h.calls.resize, 2, 'every real size change resizes, not just the first');
  assert.equal(h.calls.disconnect, 0);
});

test('a container dropped from the DOM stops being observed', () => {
  const h = resizeHarness({ connected: false });
  h.fire();
  assert.equal(h.calls.resize, 0, 'no resize against a detached container');
  assert.equal(h.calls.disconnect, 1);
});

// The store is replaced wholesale on teardown, so nothing is left holding the
// observer — it has to retire itself once the map underneath it is gone.
test('an observer outliving its map retires itself', () => {
  const h = resizeHarness({ resizeThrows: true });
  h.fire();
  assert.equal(h.calls.resize, 1, 'it tried');
  assert.equal(h.calls.disconnect, 1, 'and gave up rather than throwing every frame');
});

test('a browser without ResizeObserver still builds a map', () => {
  const ctx = makeSandbox();   // no ResizeObserver in the sandbox
  assert.doesNotThrow(() => ctx.mapAutoResize({ resize() { throw new Error('unused'); } }, {}));
});

// --- Backdrop usability, from Chris's feedback on the Week view ---

test('the background map has its own controls without stealing calendar clicks', () => {
  const fn = stripComments(extractFunction(source, 'function wireBackdropControls(map){'));
  ['zoomIn', 'zoomOut', 'bearing', 'pitch:0', 'mapFitStore'].forEach((a) => {
    assert.ok(fn.includes(a), 'backdrop controls need ' + a);
  });
  assert.ok(fn.includes('e.stopPropagation()'), 'a control click must not fall through to the board');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'schedule-board', 'index.html'), 'utf-8');
  assert.match(css, /#mapbg\{[^}]*pointer-events:none/, 'the map must never swallow a calendar click');
  assert.match(css, /#mapbgctl\{[^}]*pointer-events:auto/, 'but its controls must be clickable');
});

// The bug behind "I don't see the active jobs" on Week: the container changes
// height between Day and Week, and GL caches container size — so fitBounds
// picked a zoom for a container that no longer existed and pins landed off-map.
test('the backdrop map resizes when the board layout changes', () => {
  const fn = stripComments(extractFunction(source, 'function renderMapBg(){'));
  assert.ok(fn.includes('st.map.resize()'), 'a stale container size mis-projects every pin');
  // mapAutoResize() owns watching the container for both engines; what it cannot
  // know is that a resize also invalidates the FIT computed for the old size.
  assert.ok(fn.includes('__refit'), 'a refit is re-run once the new size has settled');
  const auto = stripComments(extractFunction(source, 'function mapAutoResize(map, el){'));
  assert.ok(auto.includes('ResizeObserver'), 'container watching lives in one place, not two');
});

// Contrast has to come from the surfaces that carry text being opaque, not from
// washing the map out. Dimming the layer AND scrimming every lane stacked two
// reductions on each other and left the map "barely visible" (Chris).
test('the calendar keeps contrast over the map layer', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'schedule-board', 'index.html'), 'utf-8');
  const op = css.match(/#mapbg\.on\{opacity:([\d.]+)\}/);
  assert.ok(op, 'the layer opacity must be declared in one place');
  const opacity = parseFloat(op[1]);
  assert.ok(opacity >= 0.6, `the map has to actually read as a map, was ${opacity}`);
  assert.ok(opacity <= 0.85, 'but it is a backdrop, not the subject');
  const lane = css.match(/body\.map-under \.lane\{background-color:color-mix\(in srgb,var\(--bg\) (\d+)%/);
  assert.ok(lane, 'the lane scrim must be declared');
  assert.ok(Number(lane[1]) <= 35,
    `the lane scrim multiplies with the layer opacity; ${lane[1]}% put the map back out of sight`);
  assert.match(css, /body\.map-under \.wkchip[^}]*box-shadow/, 'cards need lift over a busy background');
  assert.match(css, /body\.map-under \.wkrow\{border-bottom-color/, 'week row lines need to stay readable');
  const fn = stripComments(extractFunction(source, 'function renderMapBg(){'));
  assert.ok(fn.includes("classList.toggle('map-under'"), 'the contrast rules are scoped to when a map is actually under');
});

// --- Chris: header rows should not scroll with the crew lines ---
// The hour/day headers already had position:sticky, but the PAGE scrolled rather
// than the board, and sticky resolves against the nearest SCROLLING ancestor —
// .boardscroll only scrolled horizontally, so top:0 never engaged.
test('the board scrolls inside itself so the header rows can stick', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'schedule-board', 'index.html'), 'utf-8');
  assert.match(css, /\.boardscroll\{[^}]*overflow-y:auto/, 'the board must be its own vertical scroll container');
  assert.match(css, /\.boardscroll\{[^}]*max-height:var\(--board-h/, 'bounded, or it cannot scroll internally');
  ['.timehdr', '.wkhd', '.gthd'].forEach((sel) => {
    const rule = css.match(new RegExp('^\\' + sel + '\\{[^}]*', 'm'));
    assert.ok(rule && /position:sticky;top:0/.test(rule[0]), sel + ' must stick to the top of that box');
  });
  const fn = stripComments(extractFunction(source, 'function sizeBoardViewport(){'));
  assert.ok(fn.includes('getBoundingClientRect().top'), 'height is measured, not hardcoded');
  assert.ok(fn.includes("setProperty('--board-h'"), 'and published to the stylesheet');
  assert.ok(source.includes("addEventListener('resize', sizeBoardViewport)"), 'and kept correct on resize');
});

// --- Chris: make the shop the hinge (23 Bedford-Banksville Rd) ---
test('rotate and tilt pivot on the shop, not the viewport centre', () => {
  const shop = stripComments(extractFunction(source, 'function shopLngLat(){'));
  assert.ok(shop.includes('LAB.office'), 'the shop is the real office record, not a copied literal');
  const bg = stripComments(extractFunction(source, 'function wireBackdropControls(map){'));
  assert.ok(bg.includes('around:shopLngLat()'), 'rotate pivots on the shop');
  assert.match(bg, /pitch:v,\s*around:shopLngLat\(\)/, 'tilt pivots on the shop too');
  const tab = stripComments(extractFunction(source, 'function addTiltControl(map){'));
  assert.ok(tab.includes('around:shopLngLat()'), 'and the Map tab behaves the same way');
});

// --- PR review: a long blank first paint said nothing was happening ---
test('the map declares that it is loading, and stops when it is not', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'schedule-board', 'index.html'), 'utf-8');
  assert.match(css, /#maploading\{/, 'there is a loading state to show');
  assert.ok(source.includes('id="maploading"'), 'rendered with the Map tab, before any engine starts');
  const clear = stripComments(extractFunction(source, 'function clearMapLoading(){'));
  assert.ok(clear.includes('remove()'));
  // cleared on every terminal outcome: either engine painting, or the SVG fallback
  const ml = stripComments(extractFunction(source, 'function mlBuild(store, containerId, interactive){'));
  const mb = stripComments(extractFunction(source, 'function mbBuild(store, containerId, interactive){'));
  const svg = stripComments(extractFunction(source, 'function mapSvgFallbackInto(containerId){'));
  assert.ok(ml.includes('clearMapLoading()'), 'MapLibre clears it');
  assert.ok(mb.includes('clearMapLoading()'), 'Mapbox clears it');
  assert.ok(svg.includes('clearMapLoading()'), 'and so does the last-resort SVG');
});

// --- PR review: silent catches made "late" and "broken" indistinguishable ---
test('marker failures are reported instead of swallowed', () => {
  ['function mbAddMarkers(store){', 'function mbAddJobs(store, interactive){'].forEach((decl) => {
    const fn = extractFunction(source, decl);
    assert.match(fn, /catch\(e\)\{\s*console\.warn/, decl + ' must not swallow a marker failure');
  });
});

// --- Chris: controls overlapping the Unscheduled panel; one scrollbar too many ---

test('the map layer and its controls reserve the width of open side panels', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'schedule-board', 'index.html'), 'utf-8');
  // #unpanel / #layerspanel are siblings INSIDE .wrap, so anything positioned
  // against .wrap runs underneath them unless it reserves their width.
  assert.match(css, /#mapbg\{[^}]*right:var\(--side-w/, 'the map must stop at the panel edge');
  assert.match(css, /#mapbgctl\{[^}]*right:calc\(var\(--side-w/, 'so must the control cluster');
  assert.match(css, /#mapbgtilt\{[^}]*right:calc\(var\(--side-w/, 'and the tilt slider');

  const fn = stripComments(extractFunction(source, 'function sizeBoardViewport(){'));
  assert.ok(fn.includes("'unpanel', 'layerspanel'"), 'both right-hand panels count');
  assert.ok(fn.includes("cs.position === 'fixed'"), 'a mobile overlay panel floats above and must reserve nothing');
  assert.ok(fn.includes("setProperty('--side-w'"));
});

// Only the board should scroll. A document taller than the window adds a second,
// outer scrollbar on top of the board's own.
test('the board height subtracts whatever still sits below it in the page flow', () => {
  const fn = stripComments(extractFunction(source, 'function sizeBoardViewport(){'));
  assert.ok(fn.includes('w.nextElementSibling'), 'trailing content (the legend) must be measured');
  assert.match(fn, /below\s*\+=\s*el\.offsetHeight/);
  assert.match(fn, /innerHeight - top - below/, 'and subtracted from the board height');
  // overlays are not in flow and must not shrink the board
  assert.ok(fn.includes("cs.position === 'absolute'"));
});

test('the height is re-measured after the render has actually laid out', () => {
  // Measuring at the top of render() reads a board top from before the view
  // drew and a legend that does not exist yet — it came out ~37px too tall,
  // which is precisely the extra scrollbar.
  const q = stripComments(extractFunction(source, 'function queueBoardViewport(){'));
  assert.ok(q.includes('requestAnimationFrame'), 'the second pass waits for layout');
  assert.ok(q.includes('_sizeQueued'), 'and coalesces, so renders do not thrash it');
  const render = stripComments(extractFunction(source, 'function render(){'));
  assert.ok(render.includes('sizeBoardViewport()'), 'sized early so the board draws at a sane height');
  assert.ok(render.includes('queueBoardViewport()'), 'and re-measured once it has settled');
});

// Reserving the panel's width is only worth anything if it is recomputed when a
// panel actually opens. Clicking the "unscheduled" stat goes straight to
// renderUnassigned() without a render(), so --side-w stayed at 0 and the
// controls drew 272px over the open panel -- the overlap that was reported
// fixed and was not.
test('opening a panel outside a full render re-measures the reserved width', () => {
  const un = stripComments(extractFunction(source, 'function renderUnassigned(){'));
  assert.ok(un.includes("classList.toggle('open'"), 'this is the function that opens the panel');
  assert.ok(un.includes('queueBoardViewport()'), 'so it has to trigger a re-measure itself');

  // ...and closing the Layers panel takes its own shortcut past render() too.
  const close = source.slice(source.indexOf('window.LabUI.closeLayers='));
  const body = close.slice(0, close.indexOf('\n'));
  assert.ok(body.includes("classList.remove('open')"));
  assert.ok(body.includes('queueBoardViewport()'), 'closing must give the width back to the map');
});

test('the panels are watched, so a future open path cannot silently regress this', () => {
  const src = stripComments(source);
  const i = src.indexOf('new ResizeObserver');
  assert.ok(i > -1, 'a ResizeObserver is the backstop for paths not yet written');
  const block = src.slice(i, i + 400);
  assert.ok(block.includes('queueBoardViewport'), 'it re-measures');
  assert.match(block, /'unpanel'\s*,\s*'layerspanel'/, 'and watches both panels');
  assert.ok(src.includes('if(window.ResizeObserver)'), 'guarded, since it is a progressive enhancement');
});

// Chris: "the shop address is not the center of the map." It opened wherever the
// day's job coordinates happened to average out — unguarded, so one far-off
// geocode dragged the centre with it, and at zoom 13.2 the board opened on a
// neighbourhood miles from anywhere anyone works.
test('the map opens on the shop, not on the average of the day', () => {
  const fn = stripComments(extractFunction(source, 'function mapStartCamera(interactive){'));
  assert.ok(fn.includes('center:[off.lng, off.lat]'), 'the shop is the starting centre');
  assert.ok(!/pts\.reduce/.test(fn), 'the unguarded centroid must be gone, not merely bypassed');
});

// The shop is the pivot for rotate and tilt, so it has to be the point the fit
// preserves too, or the hinge sits off in a corner.
test('the fit stays centred on the shop while still framing the period', () => {
  const fn = stripComments(extractFunction(source, 'function mapFitStore(store, scope){'));
  // every pin is extended together with its mirror image through the shop, which
  // makes the bounds symmetric about it -- fitBounds then centres there exactly
  assert.match(fn, /2\*off\.lng\s*-\s*p\[0\]/, 'each pin is mirrored in longitude');
  assert.match(fn, /2\*off\.lat\s*-\s*p\[1\]/, 'and in latitude');
  assert.match(fn, /LngLatBounds\(\[off\.lng,off\.lat\], \[off\.lng,off\.lat\]\)/,
    'the bounds start at the shop, so an empty period still centres there');
  assert.ok(fn.includes('maxZoom'), 'and a zoom ceiling for a single-pin period');
});

// The two engines had drifted: the Mapbox path hardcoded pitch 62 / bearing -20
// and ignored the restored camera that the MapLibre path honoured.
test('both engines start from the same camera', () => {
  const fn = stripComments(extractFunction(source, 'function mbBuild(store, containerId, interactive){'));
  assert.ok(fn.includes('mapStartCamera(interactive)'), 'mapbox asks for the camera rather than inventing one');
  assert.ok(fn.includes('pitch:cam0.pitch') && fn.includes('bearing:cam0.bearing'),
    'including pitch and bearing, which a restored camera carries');
});
