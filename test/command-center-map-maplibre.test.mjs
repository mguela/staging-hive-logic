import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Command Center's map moved from Leaflet to MapLibre GL on 2026-08-17 so it
// gets the tilt/rotate camera the schedule board already had.
//
// The explicit ask was "MapLibre, but the techs and jobs stay bright and
// vibrant like the Leaflet map" -- which is the part an engine swap loses by
// accident. A vector basemap and MapLibre's default pin styling would both
// have been reasonable engineering choices and both would have thrown away the
// thing that was actually being asked for. So these tests assert the camera IS
// new AND the colours are NOT: same OSM raster tiles, same DIV_COLORS pins,
// same truck-green, same count badge.
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start > -1, `${signature} must exist`);
  let depth = 0, i = src.indexOf('{', start);
  do {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < src.length);
  assert.equal(depth, 0, 'braces must balance');
  return src.slice(start, i);
}

const SOURCE = [
  'function ccMapLoadLib(){',
  'function ccMapStyle(){',
  'function ccCirclePoly(lng, lat, miles){',
  'function ccAttrEsc(v){',
  'function ccMapMarker(gl, map, lngLat, html, popupHtml, opts){',
  'function ccSetMarkersVisible(markers, on){',
  'function ccAddBuildings(map){',
  'function ccTiltControl(gl, map){',
  'function ccRotateControl(gl, map){',
  'function ccHomeControl(gl, map, office){',
  'function loadMapLive(){',
].map((sig) => extractFunction(html, sig)).join('\n');

const OFFICE = { lat: 41.14435, lng: -73.64178, address: '23 Bedford-Banksville Rd' };

const POINTS = [
  { jobId: 'j1', clientId: 'c1', lat: 41.03, lng: -73.62, total: 9000, title: 'Electric rough-in', clientName: 'Whitby House', jobNumber: 2401, status: 'active' },
  { jobId: 'j2', clientId: 'c1', lat: 41.03, lng: -73.62, total: 4000, title: 'Panel swap', clientName: 'Whitby House', jobNumber: 2402, status: 'active' },
  { jobId: 'j3', clientId: 'c2', lat: 41.09, lng: -73.61, total: 1200, title: 'Trim carpentry', clientName: 'Round Hill', jobNumber: 2403, status: 'active' },
];

/** Build the map once and report everything the engine was asked to do. */
async function build({ points = POINTS, viewMode = 'jobs' } = {}) {
  const calls = { controls: [], sources: [], layers: [], rotationEnabled: false, fitted: null, ctor: null };
  const markers = [];
  // addEventListener is part of the stub because a job pin now wires hover and
  // click handlers onto its marker element. Without it ccMapMarker throws and
  // every pin assertion fails for a reason that has nothing to do with pins.
  const el = () => ({ style: { cssText: '', display: '' }, innerHTML: '', textContent: '', _on: {}, addEventListener(t, fn) { this._on[t] = fn; } });

  class Marker {
    constructor(opts) { this.el = opts.element; this.popup = null; }
    setLngLat(ll) { this.lngLat = ll; return this; }
    setPopup(p) { this.popup = p; return this; }
    addTo() { markers.push(this); return this; }
    getElement() { return this.el; }
    remove() {}
  }

  const ctx = {
    Date, Math, String, Object, Number, JSON, console, Promise, Array,
    maplibregl: {
      Map: class {
        constructor(opts) {
          calls.ctor = opts;
          this.touchZoomRotate = { enableRotation: () => { calls.rotationEnabled = true; } };
          this._on = {};
        }
        addControl(c) { calls.controls.push(c); }
        on(evt, fn) { this._on[evt] = fn; }
        fire(evt) { if (this._on[evt]) this._on[evt](); }
        addSource(id, s) { calls.sources.push({ id, s }); }
        getSource(id) { return calls.sources.find((x) => x.id === id); }
        addLayer(l) { calls.layers.push(l); }
        fitBounds(b, o) { calls.fitted = { b, o }; }
        getPitch() { return calls.ctor ? calls.ctor.pitch : 0; }
        getBearing() { return calls.ctor ? calls.ctor.bearing : 0; }
        easeTo(o) { calls.eased = o; }
        resize() {}
      },
      Marker,
      // As much of the real Popup surface as the map code uses. A hovered job
      // pin owns its popup outright (setLngLat/addTo/remove/on) rather than
      // being bound by setPopup, so a stub with only setHTML made loadMapLive
      // throw and every pin assertion below fail for the wrong reason.
      Popup: class {
        constructor(opts) { this.opts = opts; this.shown = false; }
        setLngLat(ll) { this.lngLat = ll; return this; }
        setHTML(h) { this.html = h; return this; }
        addTo() { this.shown = true; return this; }
        remove() { this.shown = false; return this; }
        on() { return this; }
        getElement() { return null; }
      },
      NavigationControl: class { constructor(o) { this.kind = 'nav'; this.opts = o; } },
      AttributionControl: class { constructor(o) { this.kind = 'attrib'; this.opts = o; } },
      LngLatBounds: class {
        constructor(a) { this.pts = [a]; }
        extend(p) { this.pts.push(p); return this; }
        isEmpty() { return this.pts.length === 0; }
      },
    },
    ccBundleFetch: async () => ({ ok: true, office: OFFICE, points, jobsWithLocation: points.length, geocodedClients: 10 }),
    DIV_COLORS: { Electrical: '#4b8fd6', Carpentry: '#d08b4c', Other: '#8A9BB4' },
    jobDivision: (t) => (/Electric|Panel/.test(t || '') ? 'Electrical' : 'Carpentry'),
    loadRealWeather: () => {},
    loadTechLocationsLive: () => {},
    document: {
      getElementById: () => el(),
      querySelector: () => el(),
      createElement: () => Object.assign(el(), {
        className: '', title: '', type: '',
        setAttribute() {}, appendChild() {}, onclick: null,
      }),
      head: { appendChild: () => {} },
    },
  };
  ctx.window = ctx;
  ctx.window._ccMapViewMode = viewMode;
  vm.createContext(ctx);
  vm.runInContext(`${SOURCE}; loadMapLive();`, ctx);
  // two ticks: ccMapLoadLib resolves, then the bundle promise
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const map = ctx.window._ccMap;
  if (map) map.fire('load');
  return { calls, markers, ctx, map };
}

test('the map is MapLibre with a tilted, rotated camera', async () => {
  const { calls } = await build();
  assert.ok(calls.ctor, 'a MapLibre Map must have been constructed');
  assert.ok(calls.ctor.pitch > 0, 'a flat pitch would be the Leaflet camera with extra steps');
  assert.equal(typeof calls.ctor.bearing, 'number');
  assert.ok(calls.rotationEnabled, 'touch rotation must be explicitly enabled');
});

// visualizePitch:true makes MapLibre's compass click call resetNorthPitch(),
// which zeroes pitch as well as bearing. The button is labelled "Reset bearing
// to north" and sits directly above a 2D/3D button that owns tilt, so flattening
// the map was it reaching into another control's job (2026-08-23: "turns the map
// 2D from 3D"). resetNorth() -- bearing only -- is the contract.
test('the compass resets bearing without flattening the map', async () => {
  const { calls } = await build();
  const nav = calls.controls.find((c) => c.kind === 'nav');
  assert.ok(nav, 'NavigationControl must be added -- without it there is no compass affordance');
  assert.equal(nav.opts.visualizePitch, false,
    'true makes the compass flatten the map out of 3D as a side effect of pointing north');
});

// MapLibre's cameraForBounds computes from `options.bearing || 0`, so a fitBounds
// with no bearing does not leave the camera alone -- it SETS bearing 0. This runs
// on every first load, and it silently threw away the bearing the map is
// constructed with, leaving the compass with nothing to correct.
test('framing the jobs keeps the camera bearing instead of re-northing it', async () => {
  const { calls } = await build();
  assert.ok(calls.fitted, 'the first load must frame the active jobs');
  assert.equal(calls.fitted.o.bearing, calls.ctor.bearing,
    'fitBounds without an explicit bearing resets the map to due north');
});

// The basemap is the half of "bright and vibrant" that is easiest to lose:
// swapping to a vector style is the default thing to do with MapLibre and it
// changes how the whole service area reads.
test('the basemap is still the same OpenStreetMap raster tiles', async () => {
  const { calls } = await build();
  const src = calls.ctor.style.sources.osm;
  assert.equal(src.type, 'raster', 'a vector basemap would change the look of the map');
  assert.ok(src.tiles.every((t) => /tile\.openstreetmap\.org/.test(t)), 'same tile server as Leaflet used');
  assert.equal(calls.ctor.style.layers[0].type, 'raster');
});

test('job pins keep their division colours rather than a default marker', async () => {
  const { markers } = await build();
  const html = markers.map((m) => m.el.innerHTML).join('\n');
  assert.match(html, /#4b8fd6/, 'the Electrical colour must survive the engine swap');
  assert.match(html, /#d08b4c/, 'and the Carpentry colour');
});

test('two jobs at one address stay a single pin with a count badge', async () => {
  const { markers } = await build();
  // office + grouped Whitby House (2 jobs) + Round Hill (1 job)
  assert.equal(markers.length, 3, 'the two same-address jobs must not draw as two pins');
  const badge = markers.find((m) => />2</.test(m.el.innerHTML));
  assert.ok(badge, 'the grouped pin must still show the job count');
  // A job pin owns its popup (__ccPopup) instead of being bound by setPopup,
  // because setPopup installs MapLibre's click-to-toggle and that would fight
  // click-to-open-the-job. The popup itself is unchanged.
  const pop = badge.popup || badge.__ccPopup;
  assert.ok(pop, 'the grouped pin must still carry a popup');
  assert.match(pop.html, /2 active jobs at this address/);
});

test('the 5/10/15 mile rings are still drawn around the shop', async () => {
  const { calls } = await build();
  const ring = calls.sources.find((s) => s.id === 'cc-rings');
  assert.ok(ring, 'the distance rings must survive');
  assert.equal(ring.s.data.features.length, 3);
  assert.ok(calls.layers.some((l) => l.id === 'cc-rings' && l.type === 'line'));
});

test('ccCirclePoly returns a closed ring near the requested radius', async () => {
  const ctx = { Math };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(html, 'function ccCirclePoly(lng, lat, miles){'), ctx);
  const ring = vm.runInContext('ccCirclePoly(-73.64, 41.14, 10)', ctx).geometry.coordinates[0];
  assert.deepEqual(ring[0], ring[ring.length - 1], 'the ring must close');
  // 10 miles north of the shop, in degrees of latitude
  const north = Math.max(...ring.map((p) => p[1])) - 41.14;
  assert.ok(Math.abs(north - 10 * 1.609344 / 110.574) < 0.005, `unexpected radius: ${north}`);
});

test('the view toggle hides pins instead of destroying them', async () => {
  const { markers, ctx } = await build({ viewMode: 'techs' });
  const jobPins = ctx.window._ccJobMarkers;
  assert.ok(jobPins.length, 'pins are still built while the techs view is active');
  assert.ok(jobPins.every((m) => m.getElement().style.display === 'none'), 'they are hidden, not removed');
  vm.runInContext('ccSetMarkersVisible(window._ccJobMarkers, true)', ctx);
  assert.ok(jobPins.every((m) => m.getElement().style.display === ''), 'and shown again without a rebuild');
});

// Self-test 2026-08-18: 5 unrelated Command Center controls (Tech Locations,
// fullscreen, weather reshuffle, legend, start my day) all THREW
// "InvalidStateError: The source image could not be decoded" within the same
// ~200ms burst of rapid clicks -- one real async tile decode hiccup,
// misattributed to whichever control the crawler happened to be clicking.
// MapLibre's Evented base class falls back to console.error() for an 'error'
// event with no listener, and the self-test's shield treats ANY
// console.error() during a click's observation window as that control's own
// failure -- so a transient, non-fatal tile failure masqueraded as five
// different buttons all being broken.
test('the map has an error listener so a transient tile failure never falls through to console.error', async () => {
  const { ctx } = await build();
  const map = ctx.window._ccMap;
  assert.equal(typeof map._on.error, 'function',
    'no listener means MapLibre itself falls back to console.error, which the self-test misreads as whatever control was clicked at that moment');
  const originalError = console.error;
  let calledError = false;
  console.error = () => { calledError = true; };
  try {
    map.fire('error');
  } finally {
    console.error = originalError;
  }
  assert.equal(calledError, false, 'the handler itself must not call console.error -- that would just move the false positive, not fix it');
});

test('nothing in the Command Center map path calls Leaflet any more', () => {
  assert.doesNotMatch(SOURCE, /\bL\.(map|marker|circle|divIcon|layerGroup|tileLayer)\b/);
  assert.doesNotMatch(SOURCE, /invalidateSize/);
});

// Self-test 2026-08-18: "Uncaught ReferenceError: ccSetMarkersVisible is not
// defined @:17029" clicking "All"/"Tech Locations". Same pre-existing bug
// class as openRealJob/openRealLead: mapView() calls this by bare name from
// global scope (~line 17027), but the definition lives inside the map IIFE
// further down the file and was never attached to window. The vm-based
// tests above evaluate an extracted slice of the source and so cannot catch
// this -- only a check against the real page's actual scoping does.
test('ccSetMarkersVisible is reachable from mapView(), which calls it from outside the map IIFE', () => {
  assert.match(html, /function ccSetMarkersVisible\(markers, on\)\{[\s\S]*?\r?\n\}\r?\nwindow\.ccSetMarkersVisible = ccSetMarkersVisible;/);
});

// Self-test 2026-08-18: "InvalidStateError: The source image could not be
// decoded", view devtodo, control "<- COMMAND CENTER". Every legacy back
// button returning to Command Center called showView('');go('snapshot') (or
// bare go('snapshot')) instead of showView('cc') -- skipping the exact
// _ccMap.resize() fix showView('cc') already applies for "map went gray/
// misaligned on nav back to Command Center -- a GL canvas sized while
// display:none comes back 0x0" (see showView's own comment above its resize
// call). A tile image decode racing that 0x0-sized canvas is a plausible
// concrete match for this exact browser error. Every one of these buttons
// must go through the same resize fix as the main nav link, not a legacy
// path that predates it.
test('every "<- COMMAND CENTER" back button goes through showView(\'cc\'), not the legacy pre-resize-fix path', () => {
  const buttons = [...html.matchAll(/<button class="back" onclick="([^"]*)">← COMMAND CENTER<\/button>/g)];
  // Was >= 8; the Monitor Module redesign (2026-08-25) deliberately dropped
  // its own back button (the left-rail "Command Center" nav item already
  // covers that navigation there) -- floor lowered to match, not to loosen
  // the check. Every remaining button still must go through showView('cc').
  assert.ok(buttons.length >= 7, 'expected to find every known "<- COMMAND CENTER" back button');
  for (const [, onclick] of buttons) {
    assert.equal(onclick, "showView('cc')", `found a legacy back button still bypassing the map resize fix: onclick="${onclick}"`);
  }
});

// --- Tilt recovery (reported from the first preview, 2026-08-17) ------------
// "i can hit tilt once, but cant get it to tilt back". NavigationControl's
// compass calls resetNorthPitch(), so it FLATTENS the map -- and MapLibre ships
// no button that tilts back up. The map was a one-way trip to flat unless you
// knew the ctrl+drag gesture.
const TILT_SRC = extractFunction(html, 'function ccTiltControl(gl, map){');

function tiltHarness(startPitch) {
  let pitch = startPitch;
  const handlers = {};
  const btn = { style: {}, textContent: '', title: '', setAttribute(k, v) { this[k] = v; }, onclick: null };
  const ctx = {
    Math, String, Object, console,
    document: {
      createElement: (tag) => (tag === 'button' ? btn : { className: '', appendChild() {} }),
    },
    map: {
      getPitch: () => pitch,
      easeTo(o) { pitch = o.pitch; (handlers.pitchend || (() => {}))(); },
      on(evt, fn) { handlers[evt] = fn; },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${TILT_SRC}; ccTiltControl({}, map).onAdd();`, ctx);
  return { btn, pitch: () => pitch };
}

test('the tilt control offers a way back up, not just down', () => {
  const flat = tiltHarness(0);
  flat.btn.onclick();
  assert.ok(flat.pitch() > 1, 'clicking it must actually tilt the map back up');
});

test('the tilt control flattens a tilted map', () => {
  const tilted = tiltHarness(55);
  tilted.btn.onclick();
  assert.equal(tilted.pitch(), 0);
});

// The label reports the state the map is IN. The first preview shipped it the
// other way round -- naming the state a click would switch to -- and it read as
// backwards next to every other status chip on the dashboard.
test('the label names the state the map is in, not the one a click would reach', () => {
  assert.equal(tiltHarness(55).btn.textContent, '3D', 'a tilted map reads 3D');
  assert.equal(tiltHarness(0).btn.textContent, '2D', 'a flat map reads 2D');
});

test('the tooltip carries the action, so the button is still discoverable', () => {
  assert.match(tiltHarness(55).btn.title, /Flatten/);
  assert.match(tiltHarness(0).btn.title, /Tilt/);
});

test('the tilt control is actually added to the map', async () => {
  const { calls } = await build();
  assert.equal(calls.controls.length >= 3, true, 'nav + attribution + tilt');
});

// --- Extruded buildings (reported 2026-08-17: "the buildings are flat in 3d")
// Raster tiles are pictures; tilting one tips it away from you and that is all
// it can do. Height needs geometry, which needs vector tiles -- added ONLY for
// extrusion, so the raster basemap and its colours are untouched.
test('tilting shows real building height, not a tipped-over picture', async () => {
  const { calls } = await build();
  const src = calls.sources.find((s) => s.id === 'cc-buildings');
  assert.ok(src, 'a vector source is required -- raster tiles cannot be extruded');
  assert.equal(src.s.type, 'vector');
  const layer = calls.layers.find((l) => l.id === 'cc-buildings');
  assert.ok(layer, 'the extrusion layer must be added');
  assert.equal(layer.type, 'fill-extrusion');
  assert.ok(layer.paint['fill-extrusion-height'], 'height must come from the data, not a constant');
});

test('the basemap is still raster even with buildings on top', async () => {
  const { calls } = await build();
  assert.equal(calls.ctor.style.sources.osm.type, 'raster', 'buildings must not have turned the basemap vector');
  assert.equal(calls.sources.filter((s) => s.id === 'cc-buildings').length, 1, 'added once, not per refresh');
});

test('an unreachable buildings source does not take the map down with it', () => {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(html, 'function ccAddBuildings(map){'), ctx);
  ctx.brokenMap = {
    getSource: () => null,
    addSource() { throw new Error('502 from the tile host'); },
    addLayer() { throw new Error('unreachable'); },
  };
  assert.doesNotThrow(() => vm.runInContext('ccAddBuildings(brokenMap)', ctx));
});

// --- Home button --------------------------------------------------------
// Pan away looking for a job and the yard leaves the screen with nothing
// pointing back at it. The compass only fixes bearing; zooming out to find the
// shop again loses your place.
test('the home button recentres on the shop', () => {
  const eased = [];
  const btn = { style: {}, textContent: '', title: '', setAttribute() {}, onclick: null };
  const ctx = {
    Math, String, Object, console,
    document: { createElement: (t) => (t === 'button' ? btn : { className: '', appendChild() {} }) },
    map: { easeTo(o) { eased.push(o); } },
    office: { lat: 41.14435, lng: -73.64178 },
  };
  vm.createContext(ctx);
  vm.runInContext(`${extractFunction(html, 'function ccHomeControl(gl, map, office){')}; ccHomeControl({}, map, office).onAdd();`, ctx);
  btn.onclick();
  assert.equal(eased.length, 1);
  // Element-wise: the array is built inside the vm, so its prototype is that
  // realm's Array and deepStrictEqual rejects it on identity alone.
  assert.equal(eased[0].center[0], -73.64178, 'longitude must be the office');
  assert.equal(eased[0].center[1], 41.14435, 'latitude must be the office');
  // Recentre, not reset: a camera someone deliberately tilted stays tilted.
  assert.equal(eased[0].pitch, undefined, 'the home button must not flatten the map');
  assert.equal(eased[0].bearing, undefined, 'nor spin it back to north');
});

test('the home button is wired to the real office from the payload', async () => {
  const { calls } = await build();
  assert.ok(calls.controls.length >= 4, 'nav + attribution + tilt + home');
});

// --- Rotation -----------------------------------------------------------
// MapLibre's compass snaps BACK to north; nothing in it turns the map TO an
// angle. Rotation was reachable only by ctrl+drag or a two-finger twist,
// neither of which the page advertises.
function rotateHarness(startBearing) {
  const eased = [];
  const buttons = [];
  let bearing = startBearing;
  const ctx = {
    Math, String, Object, console,
    document: {
      createElement: (t) => {
        if (t !== 'button') return { className: '', appendChild() {} };
        const b = { style: {}, textContent: '', title: '', setAttribute() {}, onclick: null };
        buttons.push(b);
        return b;
      },
    },
    map: { getBearing: () => bearing, easeTo(o) { eased.push(o); bearing = o.bearing; } },
  };
  vm.createContext(ctx);
  vm.runInContext(`${extractFunction(html, 'function ccRotateControl(gl, map){')}; ccRotateControl({}, map).onAdd();`, ctx);
  return { buttons, eased, bearing: () => bearing };
}

test('the map can be rotated both ways from a button', () => {
  const h = rotateHarness(0);
  assert.equal(h.buttons.length, 2, 'left and right, not just a reset');
  h.buttons[1].onclick();
  assert.equal(h.bearing(), 45, 'clockwise');
  h.buttons[0].onclick();
  assert.equal(h.bearing(), 0, 'and back');
  h.buttons[0].onclick();
  assert.equal(h.bearing(), -45, 'past north the other way');
});

test('rotating repeatedly wraps instead of winding up past 360', () => {
  const h = rotateHarness(0);
  for (let i = 0; i < 9; i++) h.buttons[1].onclick();
  assert.ok(Math.abs(h.bearing()) < 360, `bearing ran away to ${h.bearing()}`);
});

test('the rotate control is added to the map', async () => {
  const { calls } = await build();
  assert.ok(calls.controls.length >= 5, 'nav + attribution + tilt + rotate + home');
});
