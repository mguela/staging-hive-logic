import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Command Center drew every vehicle at full strength regardless of the age of
// its fix. With Jobber's GPS feed frozen since 2026-07-28, that meant an
// eighteen-day-old position rendered identically to a live one -- and the popup
// for one truck read "DRIVING, 92 mph" for a vehicle that had not reported in
// weeks. The schedule board already greys stale fixes; this brings the two maps
// into agreement about what "live" means.
//
// Driven by running the real function against a stubbed Leaflet rather than by
// matching source text, so it fails on behaviour rather than on wording.
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start > -1, `${signature} must exist`);
  let depth = 0, i = src.indexOf('{', start);
  const open = i;
  do {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < src.length);
  assert.ok(depth === 0, 'braces must balance');
  return src.slice(start, i);
}

// The marker builder is pulled in alongside the loader rather than stubbed, so
// these assertions still run the real element-construction path after the
// 2026-08-17 swap from Leaflet to MapLibre.
// The truck-motion engine is pulled in alongside the loader for the same
// reason the marker builder is: the loader now keeps markers and moves them,
// so stubbing the engine out would leave these assertions exercising a code
// path the browser never runs.
function extractEngine(src) {
  const start = src.indexOf('var CC_TRUCK_GLIDE_MS');
  assert.ok(start > -1, 'the truck-motion constants must exist');
  const last = extractFunction(src, 'function ccTruckApplyFix(st, lat, lng, fixKey, moving, speedMph, now){');
  const end = src.indexOf(last) + last.length;
  assert.ok(end > start, 'the engine must be one contiguous block');
  return src.slice(start, end);
}

const SOURCE = [
  extractEngine(html),
  extractFunction(html, 'function ccMapMarker(gl, map, lngLat, html, popupHtml){'),
  extractFunction(html, 'function ccSetMarkersVisible(markers, on){'),
  extractFunction(html, 'function fmtVisitTime(iso){'),
  extractFunction(html, 'function loadTechLocationsLive(map){'),
].join('\n');

const MINUTE = 60 * 1000;

/** A DOM stand-in just deep enough for ccMapMarker to build its element. */
function fakeDocument() {
  return {
    getElementById: () => null,
    createElement: () => ({
      style: { cssText: '', display: '' },
      innerHTML: '',
    }),
  };
}

/** Run the real function over one vehicle and report what got drawn. */
async function draw(vehicle, { assignments = [] } = {}) {
  const drawn = [];
  const ctx = {
    Date, Math, String, Object, Number, JSON, console, Promise,
    maplibregl: {
      Popup: class { constructor() { this.html = null; } setHTML(h) { this.html = h; return this; } },
      Marker: class {
        constructor(opts) { this.el = opts.element; this.popup = null; }
        setLngLat(ll) { this.lngLat = ll; return this; }
        setPopup(p) { this.popup = p; return this; }
        addTo() { drawn.push(this); return this; }
        getElement() { return this.el; }
        remove() {}
      },
    },
    ccBundleFetch: async () => ({ ok: true, vehicles: [vehicle], vehicleAssignments: assignments }),
    hlTimeAgo: (iso) => {
      const min = Math.round((Date.now() - new Date(iso).getTime()) / MINUTE);
      return min < 60 ? `${min} min ago` : `${Math.round(min / 60)} hours ago`;
    },
    document: fakeDocument(),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${SOURCE}; loadTechLocationsLive({});`, ctx);
  await new Promise((r) => setImmediate(r));
  assert.equal(drawn.length, 1, 'exactly one vehicle should have been drawn');
  return { icon: drawn[0].el.innerHTML, popup: drawn[0].popup && drawn[0].popup.html };
}

const vehicle = (over) => ({
  name: '2021 PROMASTER', lat: 41.14, lng: -73.64,
  status: 'DRIVING', speed: 31, iconColor: null,
  updatedAt: new Date(Date.now() - 3 * MINUTE).toISOString(),
  source: 'fleetsharp', stale: false, ageMs: 3 * MINUTE,
  ...over,
});

test('a live fix is drawn at full strength and reads as current', async () => {
  const { icon, popup } = await draw(vehicle());
  assert.match(icon, /opacity:1/, 'a current position must not be dimmed');
  assert.match(icon, /#4bc47a/, 'a moving truck stays green');
  assert.doesNotMatch(popup, /Stale fix/);
  assert.doesNotMatch(popup, /Last known/);
  assert.match(popup, /DRIVING/);
});

// The exact 2026-08-15 situation: Jobber's frozen record for the 2025 Ram
// Promaster still said DRIVING at 91.73. Anything reading it uncritically shows
// a truck doing 91 down the road right now.
test('a long-stale fix is dimmed, greyed, and labelled as last-known', async () => {
  const eighteenDays = 18 * 24 * 60 * MINUTE;
  const { icon, popup } = await draw(vehicle({
    status: 'DRIVING', speed: 91.73, source: 'jobber', stale: true, ageMs: eighteenDays,
    updatedAt: new Date(Date.now() - eighteenDays).toISOString(),
  }));
  assert.match(icon, /opacity:\.55/, 'a stale position must be visibly receded');
  assert.match(icon, /#b6bfcc/, 'and grey, not the live green');
  assert.doesNotMatch(icon, /#4bc47a/, 'a frozen DRIVING status must not render as moving');
  assert.match(popup, /Last known: DRIVING/, 'the reading is historical, and must say so');
  assert.match(popup, /Stale fix/);
  assert.match(popup, /Jobber/, 'which feed produced it decides who to chase');
});

test('the feed that supplied the position is named', async () => {
  const { popup } = await draw(vehicle());
  assert.match(popup, /FleetSharp/);
});

// stale/ageMs arrived with the crew_schedule change; a response cached from
// before it must not be treated as fresh just because the field is absent.
test('a response with no staleness fields falls back to the timestamp', async () => {
  const old = await draw(vehicle({
    stale: undefined, ageMs: undefined,
    updatedAt: new Date(Date.now() - 45 * MINUTE).toISOString(),
  }));
  assert.match(old.icon, /opacity:\.55/, '45 minutes old is past the 30-minute threshold');
  assert.match(old.popup, /Stale fix/);

  const recent = await draw(vehicle({ stale: undefined, ageMs: undefined }));
  assert.match(recent.icon, /opacity:1/, 'three minutes old is still live');
});

test('a position with no timestamp at all counts as stale, not as fresh', async () => {
  const { icon, popup } = await draw(vehicle({ stale: undefined, ageMs: undefined, updatedAt: null }));
  assert.match(icon, /opacity:\.55/, 'unknown age is not evidence of freshness');
  assert.match(popup, /Stale fix/);
});

test('the threshold matches the schedule board, so the two maps agree', async () => {
  const boardSource = readFileSync(new URL('../public/schedule-board/app.js', import.meta.url), 'utf8');
  assert.match(boardSource, /GPS_STALE_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/, 'the board uses 30 minutes');
  assert.match(SOURCE, /CC_GPS_STALE_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/, 'Command Center must use the same');
});

// fleet_job_presence (the geofence engine, api/fleet/detect-presence.js) is
// joined into crew_schedule's vehicles array by VIN; this is the first place
// that data reaches the map, so the popup is the contract worth pinning down.
test('a vehicle still on site shows its arrival with no departure', async () => {
  const { popup } = await draw(vehicle({
    arrivedAt: new Date(Date.now() - 22 * MINUTE).toISOString(),
    departedAt: null,
    presenceJobNumber: '4821',
  }));
  assert.match(popup, /Arrived/);
  assert.match(popup, /Job #4821/);
  assert.match(popup, /Still on site/);
  assert.doesNotMatch(popup, /Departed/);
});

test('a vehicle that has left a job shows both arrival and departure', async () => {
  const { popup } = await draw(vehicle({
    arrivedAt: new Date(Date.now() - 90 * MINUTE).toISOString(),
    departedAt: new Date(Date.now() - 40 * MINUTE).toISOString(),
    presenceJobNumber: null,
  }));
  assert.match(popup, /Arrived/);
  assert.match(popup, /Departed/);
  assert.doesNotMatch(popup, /Still on site/);
  assert.doesNotMatch(popup, /Job #/, 'no job number was supplied, so none should be invented');
});

test('a vehicle with no detected presence today shows neither line', async () => {
  const { popup } = await draw(vehicle({ arrivedAt: null, departedAt: null }));
  assert.doesNotMatch(popup, /Arrived/);
  assert.doesNotMatch(popup, /Departed/);
  assert.doesNotMatch(popup, /Still on site/);
});

// Uses the same harness as every other case, on purpose. An earlier version of
// this test carried its own Leaflet stub; after the map moved to MapLibre that
// stub went unused, so the function could have drawn anything at all and the
// assertion would still have read zero. A "nothing was drawn" test is only
// worth having if the same harness is known to draw something.
test('a vehicle with no coordinates is skipped rather than drawn at null island', async () => {
  await assert.rejects(
    () => draw(vehicle({ lat: null, lng: null })),
    /exactly one vehicle should have been drawn/,
    'the harness draws for a normal vehicle, so zero markers here is a real skip'
  );
});
