import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Command Center's vehicle layer rebuilt every truck marker on every poll, so a
// truck moving at road speed sat perfectly still for 30 seconds and then
// teleported a third of a mile. This covers the client-side smoothing that
// replaced that: markers are kept and moved, a fresh fix is glided onto rather
// than jumped to, and a truck the feed calls moving is dead-reckoned forward
// between fixes along the bearing of its last two real fixes.
//
// Driven by running the real engine against a stubbed clock and a stubbed
// requestAnimationFrame rather than by matching source text, so these fail on
// behaviour rather than on wording.
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
  assert.ok(depth === 0, 'braces must balance');
  return src.slice(start, i);
}

function extractEngine(src) {
  const start = src.indexOf('var CC_TRUCK_GLIDE_MS');
  assert.ok(start > -1, 'the truck-motion constants must exist');
  const last = extractFunction(src, 'function ccTruckApplyFix(st, lat, lng, fixKey, moving, speedMph, now){');
  return src.slice(start, src.indexOf(last) + last.length);
}

const ENGINE = extractEngine(html);
const LOADER = [
  ENGINE,
  extractFunction(html, 'function ccMapMarker(gl, map, lngLat, html, popupHtml){'),
  extractFunction(html, 'function ccSetMarkersVisible(markers, on){'),
  extractFunction(html, 'function loadTechLocationsLive(map){'),
].join('\n');

const MINUTE = 60 * 1000;

/**
 * A context with a clock and a frame pump we drive by hand. `raf` collects the
 * callbacks the engine asks for; pump(ms) advances the clock and runs one frame,
 * which is how a real browser would deliver them.
 */
function harness({ withRaf = true } = {}) {
  let clock = 1_700_000_000_000;
  let pending = null, nextId = 1, cancelled = [];
  const ctx = {
    Math, String, Object, Number, JSON, console, Promise, Infinity,
    Date: { now: () => clock },
  };
  if (withRaf) {
    ctx.requestAnimationFrame = (fn) => { pending = fn; return nextId++; };
    ctx.cancelAnimationFrame = (id) => { cancelled.push(id); pending = null; };
  }
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(ENGINE, ctx);
  return {
    ctx,
    cancelled,
    now: () => clock,
    advance: (ms) => { clock += ms; },
    /** Advance the clock and deliver one animation frame, if one was requested. */
    pump(ms) {
      clock += ms;
      const fn = pending;
      pending = null;
      if (fn) fn();
      return !!fn;
    },
    framePending: () => !!pending,
    /** Advance and deliver a frame, restarting the loop the way each poll does. */
    frame(ms) { clock += ms; if (ctx.ccTruckAnimStart) ctx.ccTruckAnimStart(); const fn = pending; pending = null; if (fn) fn(); },
  };
}

/** A marker stub that records every position it is moved to. */
function fakeMarker(lngLat) {
  return {
    positions: lngLat ? [lngLat] : [],
    removed: false,
    setLngLat(ll) { this.positions.push(ll); return this; },
    remove() { this.removed = true; },
    getElement() { return this.el || (this.el = { style: {}, innerHTML: '' }); },
    getPopup() { return this.popup || (this.popup = { html: null, setHTML(h) { this.html = h; return this; } }); },
    at() { const p = this.positions[this.positions.length - 1]; return p ? [p[0], p[1]] : p; },
  };
}

/** Register a truck with the engine and feed it its first fix. */
function addTruck(h, { lat, lng, key = 'fix-1', moving = false, mph = 0 } = {}) {
  const marker = fakeMarker();
  const st = h.ctx.ccTruckEngine().byKey['TRUCK'] = { marker };
  h.ctx.ccTruckApplyFix(st, lat, lng, key, moving, mph, h.now());
  return { st, marker };
}

const distM = (h, a, b) => h.ctx.ccTruckDistM(a[1], a[0], b[1], b[0]);

// --- geometry -------------------------------------------------------------

test('the distance helper agrees with a known real-world separation', () => {
  const h = harness();
  // Greenwich CT shop to Stamford, roughly 9.4km apart.
  const d = h.ctx.ccTruckDistM(41.0262, -73.6282, 41.0534, -73.5387);
  assert.ok(d > 8_000 && d < 11_000, `expected ~9.4km, got ${Math.round(d)}m`);
});

test('projecting along a bearing lands the reported distance away, on that bearing', () => {
  const h = harness();
  const [lat, lng] = h.ctx.ccTruckProject(41.0262, -73.6282, 90, 1000);
  const back = h.ctx.ccTruckDistM(41.0262, -73.6282, lat, lng);
  assert.ok(Math.abs(back - 1000) < 1, `expected 1000m, got ${back.toFixed(1)}m`);
  assert.ok(Math.abs(lat - 41.0262) < 1e-4, 'due east should barely change latitude');
  assert.ok(lng > -73.6282, 'due east should increase longitude');
});

// --- gliding onto a fresh fix --------------------------------------------

test('a fresh fix is glided onto over time instead of being jumped to', () => {
  const h = harness();
  const { st, marker } = addTruck(h, { lat: 41.0262, lng: -73.6282 });
  const from = marker.at();

  h.advance(30 * 1000);
  // ~450m north: normal 30s of driving, well inside the jump threshold.
  h.ctx.ccTruckApplyFix(st, 41.0303, -73.6282, 'fix-2', false, 0, h.now());
  const target = [-73.6282, 41.0303];

  assert.deepEqual(marker.at(), from, 'the new fix must not be applied instantly');

  h.frame(600);
  const mid = marker.at();
  assert.notDeepEqual(mid, from, 'the marker should have started moving');
  assert.notDeepEqual(mid, target, 'and should not be there yet');
  assert.ok(distM(h, mid, target) < distM(h, from, target), 'it must be closing on the fix');

  h.frame(3000); // past the ~2.5s glide
  assert.ok(distM(h, marker.at(), target) < 0.5, 'the glide must land exactly on the real fix');
});

test('the glide is smooth: many intermediate positions, none of them a jump', () => {
  const h = harness();
  const { st, marker } = addTruck(h, { lat: 41.0262, lng: -73.6282 });
  h.advance(30 * 1000);
  h.ctx.ccTruckApplyFix(st, 41.0303, -73.6282, 'fix-2', false, 0, h.now());

  const before = marker.positions.length;
  for (let i = 0; i < 40; i++) h.frame(60); // ~2.4s at 60fps
  const steps = marker.positions.slice(before);
  assert.ok(steps.length > 20, `expected a frame-by-frame glide, got ${steps.length} moves`);

  let prev = marker.positions[before - 1];
  for (const p of steps) {
    assert.ok(distM(h, prev, p) < 60, 'no single frame may cover a visible jump');
    prev = p;
  }
});

test('a gap too large to be driving is placed instantly rather than flown across', () => {
  const h = harness();
  const { st, marker } = addTruck(h, { lat: 41.0262, lng: -73.6282 });
  h.advance(30 * 1000);
  h.ctx.ccTruckApplyFix(st, 42.3601, -71.0589, 'fix-2', false, 0, h.now()); // Boston
  assert.deepEqual(marker.at(), [-71.0589, 42.3601], 'a 300km gap is a data gap, not motion');
});

// --- dead reckoning between fixes ----------------------------------------

test('a moving truck keeps moving between fixes, along its last known bearing', () => {
  const h = harness();
  const { st, marker } = addTruck(h, { lat: 41.0262, lng: -73.6282 });
  h.advance(30 * 1000);
  // Second fix due east, fast enough and far enough to establish a bearing.
  h.ctx.ccTruckApplyFix(st, 41.0262, -73.6082, 'fix-2', true, 40, h.now());
  h.frame(3000); // finish the glide onto fix-2
  const landed = marker.at();
  assert.ok(distM(h, landed, [-73.6082, 41.0262]) < 1, 'glide lands on the real fix first');

  h.frame(10_000);
  const predicted = marker.at();
  const travelled = distM(h, landed, predicted);
  // 40mph for 10s is ~179m.
  assert.ok(travelled > 150 && travelled < 210, `expected ~179m of prediction, got ${Math.round(travelled)}m`);
  assert.ok(predicted[0] > landed[0], 'it must be predicted east, the way it was actually going');
  assert.ok(Math.abs(predicted[1] - landed[1]) < 1e-4, 'and not drift north or south');
});

test('a parked truck sits perfectly still -- no jitter, no invented creep', () => {
  const h = harness();
  const { st, marker } = addTruck(h, { lat: 41.0262, lng: -73.6282 });
  h.advance(30 * 1000);
  h.ctx.ccTruckApplyFix(st, 41.0262, -73.6082, 'fix-2', false, 0, h.now()); // STOPPED
  h.frame(3000);
  const parked = marker.at();
  for (let i = 0; i < 30; i++) h.frame(1000);
  assert.deepEqual(marker.at(), parked, 'a stopped truck must not move a pixel');
});

test('a truck with only one fix is never predicted -- there is no bearing to predict along', () => {
  const h = harness();
  const { marker } = addTruck(h, { lat: 41.0262, lng: -73.6282, moving: true, mph: 45 });
  const placed = marker.at();
  for (let i = 0; i < 20; i++) h.frame(1000);
  assert.deepEqual(marker.at(), placed, 'no second fix means no heading, so nothing to extrapolate');
});

test('GPS jitter between two fixes does not become a bearing', () => {
  const h = harness();
  const { st, marker } = addTruck(h, { lat: 41.0262, lng: -73.6282 });
  h.advance(30 * 1000);
  // ~5m of receiver noise, under the 20m floor.
  h.ctx.ccTruckApplyFix(st, 41.02624, -73.62824, 'fix-2', true, 45, h.now());
  h.frame(3000);
  const settled = marker.at();
  for (let i = 0; i < 20; i++) h.frame(1000);
  assert.deepEqual(marker.at(), settled, 'noise must not be read as a heading and driven along');
});

test('prediction stops at 90 seconds instead of running away', () => {
  const h = harness();
  const { st, marker } = addTruck(h, { lat: 41.0262, lng: -73.6282 });
  h.advance(30 * 1000);
  h.ctx.ccTruckApplyFix(st, 41.0262, -73.6082, 'fix-2', true, 60, h.now());
  h.frame(3000); // land on the fix, prediction starts here
  const landed = marker.at();

  for (let i = 0; i < 100; i++) h.frame(1000); // 100s of silence from the feed
  const capped = marker.at();
  const travelled = distM(h, landed, capped);
  // 60mph for the 90s cap is ~2414m; anything materially past that is a runaway.
  assert.ok(travelled < 2600, `prediction must be capped, got ${Math.round(travelled)}m`);

  for (let i = 0; i < 20; i++) h.frame(1000);
  assert.deepEqual(marker.at(), capped, 'past the cap the marker holds still');
});

test('a new fix discards the prediction and corrects course onto the real position', () => {
  const h = harness();
  const { st, marker } = addTruck(h, { lat: 41.0262, lng: -73.6282 });
  h.advance(30 * 1000);
  h.ctx.ccTruckApplyFix(st, 41.0262, -73.6082, 'fix-2', true, 45, h.now());
  h.frame(3000);
  for (let i = 0; i < 20; i++) h.frame(1000); // predicted well east of the last fix
  const predicted = marker.at();
  assert.ok(predicted[0] > -73.6082, 'the prediction has run east of the fix');

  // The truck actually turned and is south of where we guessed.
  const real = [-73.6000, 41.0180];
  assert.ok(distM(h, predicted, real) > 500, 'the guess and the truth are far apart, so this is a real correction');
  h.ctx.ccTruckApplyFix(st, 41.0180, -73.6000, 'fix-3', true, 45, h.now());
  let closest = Infinity;
  for (let i = 0; i < 60; i++) { h.frame(60); closest = Math.min(closest, distM(h, marker.at(), real)); }
  // Reckoning resumes once the correction lands, so the marker does not stay on
  // the fix -- but it must pass exactly through it, not stop short at a blend of
  // the guess and the truth.
  assert.ok(closest < 1, `the correction must reach the real fix; closest approach was ${closest.toFixed(1)}m`);
});

// --- the animation loop ---------------------------------------------------

test('there is exactly one animation loop no matter how many times it is started', () => {
  const h = harness();
  const { st } = addTruck(h, { lat: 41.0262, lng: -73.6282 });
  h.advance(30 * 1000);
  h.ctx.ccTruckApplyFix(st, 41.0303, -73.6282, 'fix-2', false, 0, h.now());

  h.ctx.ccTruckAnimStart();
  const eng = h.ctx.ccTruckEngine();
  const firstFrame = eng.frame;
  h.ctx.ccTruckAnimStart();
  h.ctx.ccTruckAnimStart();
  h.ctx.ccTruckAnimStart();
  assert.equal(eng.frame, firstFrame, 'repeat starts must not queue extra loops');
  assert.equal(eng.running, true);
});

test('the loop retires itself once nothing is moving, and restarts on the next poll', () => {
  const h = harness();
  const { st } = addTruck(h, { lat: 41.0262, lng: -73.6282 });
  h.advance(30 * 1000);
  h.ctx.ccTruckApplyFix(st, 41.0303, -73.6282, 'fix-2', false, 0, h.now());
  h.ctx.ccTruckAnimStart();

  for (let i = 0; i < 80 && h.framePending(); i++) h.pump(60);
  assert.equal(h.framePending(), false, 'the glide finished, so no further frame was requested');
  assert.equal(h.ctx.ccTruckEngine().running, false, 'and the loop marked itself stopped');

  h.advance(30 * 1000);
  h.ctx.ccTruckApplyFix(st, 41.0344, -73.6282, 'fix-3', false, 0, h.now());
  h.ctx.ccTruckAnimStart();
  assert.equal(h.framePending(), true, 'the next poll brings the loop back');
});

test('a moving truck keeps the loop alive, a stopped one does not', () => {
  const moving = harness();
  const m = addTruck(moving, { lat: 41.0262, lng: -73.6282 });
  moving.advance(30 * 1000);
  moving.ctx.ccTruckApplyFix(m.st, 41.0262, -73.6082, 'fix-2', true, 45, moving.now());
  moving.ctx.ccTruckAnimStart();
  for (let i = 0; i < 200 && moving.framePending(); i++) moving.pump(60);
  assert.equal(moving.framePending(), true, 'dead reckoning needs frames, so the loop stays up');

  const parked = harness();
  const p = addTruck(parked, { lat: 41.0262, lng: -73.6282 });
  parked.advance(30 * 1000);
  parked.ctx.ccTruckApplyFix(p.st, 41.0262, -73.6082, 'fix-2', false, 0, parked.now());
  parked.ctx.ccTruckAnimStart();
  for (let i = 0; i < 200 && parked.framePending(); i++) parked.pump(60);
  assert.equal(parked.framePending(), false, 'a parked fleet must not hold a frame loop open');
});

test('stopping the loop cancels its outstanding frame', () => {
  const h = harness();
  const { st } = addTruck(h, { lat: 41.0262, lng: -73.6282 });
  h.advance(30 * 1000);
  h.ctx.ccTruckApplyFix(st, 41.0303, -73.6282, 'fix-2', false, 0, h.now());
  h.ctx.ccTruckAnimStart();
  const id = h.ctx.ccTruckEngine().frame;
  h.ctx.ccTruckAnimStop();
  assert.deepEqual(h.cancelled, [id], 'the frame that was outstanding must be the one cancelled');
  assert.equal(h.ctx.ccTruckEngine().running, false);
});

test('with no requestAnimationFrame at all, fixes are still applied -- just without the glide', () => {
  const h = harness({ withRaf: false });
  const { st, marker } = addTruck(h, { lat: 41.0262, lng: -73.6282 });
  h.advance(30 * 1000);
  h.ctx.ccTruckApplyFix(st, 41.0303, -73.6282, 'fix-2', true, 45, h.now());
  assert.deepEqual(marker.at(), [-73.6282, 41.0303], 'the truck is where the feed says it is');
  h.ctx.ccTruckAnimStart();
  assert.equal(h.ctx.ccTruckEngine().running, false, 'and no loop is claimed to be running');
});

// --- how the loader uses it ----------------------------------------------

/** Run the real loader over a sequence of polls and report what it did. */
function poll(vehicleSets) {
  let clock = 1_700_000_000_000;
  const created = [];
  const ctx = {
    Math, String, Object, Number, JSON, console, Promise, Infinity,
    Date: { now: () => clock },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    maplibregl: {
      Popup: class { setHTML(h) { this.html = h; return this; } },
      Marker: class {
        constructor(opts) { this.el = opts.element; this.positions = []; this.removed = false; }
        setLngLat(ll) { this.positions.push(ll); this.lngLat = ll; return this; }
        setPopup(p) { this.popup = p; return this; }
        addTo() { created.push(this); return this; }
        getElement() { return this.el; }
        getPopup() { return this.popup; }
        remove() { this.removed = true; }
      },
    },
    hlTimeAgo: () => '2 min ago',
    document: {
      getElementById: () => null,
      createElement: () => ({ style: { cssText: '', display: '' }, innerHTML: '' }),
    },
  };
  let queue = vehicleSets.slice();
  ctx.ccBundleFetch = async () => ({ ok: true, vehicles: queue.shift() || [], vehicleAssignments: [] });
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(LOADER, ctx);
  return {
    created, ctx,
    async tick(advanceMs = 30_000) {
      vm.runInContext('loadTechLocationsLive({});', ctx);
      await new Promise((r) => setImmediate(r));
      clock += advanceMs;
    },
  };
}

const live = (over) => ({
  name: '2021 PROMASTER', lat: 41.0262, lng: -73.6282,
  status: 'DRIVING', speed: 42, iconColor: null,
  updatedAt: '2026-08-20T12:00:00.000Z', source: 'fleetsharp', stale: false, ageMs: 2 * MINUTE,
  ...over,
});

test('polling twice moves the one marker instead of building a second one', async () => {
  const run = poll([[live()], [live({ lat: 41.0303, updatedAt: '2026-08-20T12:00:30.000Z' })]]);
  await run.tick();
  await run.tick();
  assert.equal(run.created.length, 1, 'the marker is kept across polls, not rebuilt');
  assert.equal(run.created[0].removed, false, 'and never torn down');
  assert.equal(window_markers(run).length, 1, 'exactly one marker is published to the view toggle');
});

function window_markers(run) { return run.ctx.window._ccTechMarkers || []; }

test('a vehicle that drops out of the feed loses its marker and its motion state', async () => {
  const run = poll([[live(), live({ name: 'F-250', lat: 41.05 })], [live()]]);
  await run.tick();
  assert.equal(run.created.length, 2);
  await run.tick();
  const gone = run.created.find((m) => m.el.innerHTML !== undefined && m.removed);
  assert.ok(gone, 'the vanished truck must have had its marker removed');
  assert.equal(Object.keys(run.ctx.ccTruckEngine().byKey).length, 1, 'and its state deleted with it');
});

test('a stale fix is never dead-reckoned, however fast it claims to be going', async () => {
  const eighteenDays = 18 * 24 * 60 * MINUTE;
  const frozen = (over) => live({
    status: 'DRIVING', speed: 91.73, source: 'jobber', stale: true, ageMs: eighteenDays, ...over,
  });
  const run = poll([[frozen()], [frozen({ lat: 41.0303, updatedAt: '2026-07-28T12:00:30.000Z' })]]);
  await run.tick();
  await run.tick();
  assert.equal(run.ctx.ccTruckEngine().byKey['2021 PROMASTER'].moving, false,
    'a three-week-old DRIVING reading must not be extrapolated as live motion');
});

test('a repeated fix does not restart the glide, so a quiet feed does not stutter', async () => {
  const same = live();
  const run = poll([[same], [{ ...same }], [{ ...same }]]);
  await run.tick();
  await run.tick();
  const st = run.ctx.ccTruckEngine().byKey['2021 PROMASTER'];
  assert.equal(st.glideEnd, 0, 'nothing changed, so there is nothing to animate');
  const moves = run.created[0].positions.length;
  await run.tick();
  assert.equal(run.created[0].positions.length, moves, 'and the marker is not touched again');
});
