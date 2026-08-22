// test/service-area.test.mjs
// The geometry behind per-division service areas.
//
// Pinned with real coordinates rather than round numbers, because every bug
// this file guards against is one that looks fine at the equator and is wrong
// in Connecticut.
// Run: node --test test/service-area.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  distanceMiles, isUsable, normalize, boundsOf, zoomForRadius,
  containsPoint, divisionsCovering, companyCamera, defaultCamera,
} from '../api/_lib/service-area.js';

// The shop coordinate hardcoded in public/schedule-board/data.js today.
const SHOP = { lat: 41.14435668781, lng: -73.641778856887 };
const area = (over = {}) => ({
  id: 'd1', name: 'Greenwich Handyman', is_primary: true,
  service_center_lat: SHOP.lat, service_center_lng: SHOP.lng,
  service_radius_miles: 15, service_center_label: 'Greenwich, CT', ...over,
});
const near = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} not within ${eps} of ${b}`);

// --------------------------------------------------------------------------
// distance
// --------------------------------------------------------------------------
test('distance between two known points is right to within a mile', () => {
  // Greenwich CT shop -> White Plains NY. ~9.9 miles as the crow flies; the
  // ~13 you get from a maps app is the ROAD distance, which is not what a
  // service radius measures.
  near(distanceMiles(SHOP, { lat: 41.0340, lng: -73.7629 }), 9.9, 0.4);
});

test('distance to itself is zero, and missing coordinates give null not NaN', () => {
  assert.equal(distanceMiles(SHOP, SHOP), 0);
  assert.equal(distanceMiles(SHOP, null), null);
  assert.equal(distanceMiles(SHOP, { lat: 1 }), null);
  assert.equal(distanceMiles(null, SHOP), null);
});

// --------------------------------------------------------------------------
// usability -- a half-configured area must never masquerade as a real one
// --------------------------------------------------------------------------
test('an area is usable only with a centre AND a positive radius', () => {
  assert.equal(isUsable(area()), true);
  assert.equal(isUsable(area({ service_center_lat: null })), false);
  assert.equal(isUsable(area({ service_center_lng: null })), false);
  assert.equal(isUsable(area({ service_radius_miles: null })), false);
  assert.equal(isUsable(area({ service_radius_miles: 0 })), false, 'a zero radius is not an area');
  assert.equal(isUsable(null), false);
});

test('a latitude of 0 is a real place, not a missing value', () => {
  // The falsy-zero trap: lat 0 is the Gulf of Guinea, but it is still a centre.
  assert.equal(isUsable(area({ service_center_lat: 0, service_center_lng: 0 })), true);
  assert.equal(normalize(area({ service_center_lat: 0, service_center_lng: 0 })).lat, 0);
});

// --------------------------------------------------------------------------
// bounds -- the longitude-compression bug
// --------------------------------------------------------------------------
test('the bounding box is wider in longitude than in latitude at this latitude', () => {
  const b = boundsOf(area({ service_radius_miles: 15 }));
  const latSpan = b.north - b.south;
  const lngSpan = b.east - b.west;
  assert.ok(lngSpan > latSpan * 1.2,
    `at 41N a degree of longitude is ~0.75 of a degree of latitude, so the box must be visibly wider (lat ${latSpan}, lng ${lngSpan})`);
});

test('the box actually contains the circle it frames', () => {
  const r = 15;
  const b = boundsOf(area({ service_radius_miles: r }));
  const eastEdge = { lat: SHOP.lat, lng: SHOP.lng + (r / (69.0 * Math.cos((SHOP.lat * Math.PI) / 180))) };
  assert.ok(eastEdge.lng <= b.east + 1e-9, 'the circle must not spill out of its own bounding box');
  near(distanceMiles(SHOP, eastEdge), r, 0.2);
});

test('bounds of an unusable area is null, not a box around nowhere', () => {
  assert.equal(boundsOf(area({ service_center_lat: null })), null);
});

// --------------------------------------------------------------------------
// zoom
// --------------------------------------------------------------------------
test('a bigger radius always zooms further out', () => {
  const z5 = zoomForRadius(5);
  const z15 = zoomForRadius(15);
  const z50 = zoomForRadius(50);
  assert.ok(z5 > z15 && z15 > z50, `zoom must decrease as radius grows (${z5}, ${z15}, ${z50})`);
});

test('a 15-mile radius lands in the range the maps already hardcode', () => {
  // The board opens at 12.6 and the Command Center at 10.4 today, both guesses.
  // A 15-mile area should land between them rather than somewhere absurd.
  const z = zoomForRadius(15);
  assert.ok(z > 9 && z < 12.5, `expected a townwide zoom for 15 miles, got ${z}`);
});

test('absurd radii still produce a usable screen', () => {
  assert.equal(zoomForRadius(0.05), 16, 'clamped in, not zoomed to the atom');
  assert.equal(zoomForRadius(9000), 3, 'clamped out, not zoomed past the globe');
});

test('a missing or nonsense radius gives null so the caller keeps its own default', () => {
  assert.equal(zoomForRadius(0), null);
  assert.equal(zoomForRadius(-5), null);
  assert.equal(zoomForRadius(null), null);
  assert.equal(zoomForRadius('abc'), null);
});

// --------------------------------------------------------------------------
// containment -- lead triage
// --------------------------------------------------------------------------
test('a point just inside the radius is in, just outside is out', () => {
  const a = area({ service_radius_miles: 12 });
  // Due north, 11 and 13 miles out (1 degree of latitude ~ 69 miles).
  assert.equal(containsPoint(a, { lat: SHOP.lat + 11 / 69, lng: SHOP.lng }), true);
  assert.equal(containsPoint(a, { lat: SHOP.lat + 13 / 69, lng: SHOP.lng }), false);
});

test('containment is null, never false, when it cannot be judged', () => {
  // Reporting "out of area" for an unconfigured division would wrongly reject
  // real leads, so the honest answer is "cannot tell".
  assert.equal(containsPoint(area({ service_radius_miles: null }), SHOP), null);
  assert.equal(containsPoint(area(), null), null);
  assert.equal(containsPoint(area(), { lat: null, lng: null }), null);
});

test('divisionsCovering returns only the ones that cover, nearest first', () => {
  const divisions = [
    area({ id: 'far', name: 'Far', service_center_lat: SHOP.lat + 1.5, service_radius_miles: 10 }),
    area({ id: 'wide', name: 'Wide', service_radius_miles: 40 }),
    area({ id: 'tight', name: 'Tight', service_radius_miles: 5 }),
    area({ id: 'unset', name: 'Unset', service_center_lat: null, service_center_lng: null }),
  ];
  const hits = divisionsCovering(divisions, { lat: SHOP.lat + 3 / 69, lng: SHOP.lng });
  // 'wide' and 'tight' share a centre, so they are exactly equidistant and the
  // order is decided by the tie-break: the tighter radius is the more specific
  // claim on the work. Without it the winner is whatever order the rows arrived
  // in, which is not an answer you can act on.
  assert.deepEqual(hits.map((h) => h.id), ['tight', 'wide']);
  assert.ok(hits.every((h) => h.covers));
});

test('a point nobody covers returns an empty list, not a nearest-anyway guess', () => {
  const hits = divisionsCovering([area({ service_radius_miles: 5 })], { lat: SHOP.lat + 2, lng: SHOP.lng });
  assert.deepEqual(hits, []);
});

// --------------------------------------------------------------------------
// company-wide view -- the mean-of-centres trap
// --------------------------------------------------------------------------
test('two distant areas frame BOTH rather than centring on the sea between them', () => {
  const greenwich = area({ id: 'ct', service_radius_miles: 15 });
  const boca = area({
    id: 'fl', is_primary: false,
    service_center_lat: 26.3683, service_center_lng: -80.1289, service_radius_miles: 25,
  });
  const cam = companyCamera([greenwich, boca]);

  assert.ok(cam.zoom <= 6, `both coasts must fit on screen, got zoom ${cam.zoom}`);
  assert.ok(cam.center.lat < greenwich.service_center_lat && cam.center.lat > boca.service_center_lat,
    'the centre must lie between the two areas');
  assert.match(cam.label, /2 service areas/);
});

test('one usable area gives that area exactly, not a degenerate union', () => {
  const cam = companyCamera([area(), area({ id: 'x', service_center_lat: null, service_center_lng: null })]);
  assert.equal(cam.center.lat, SHOP.lat);
  assert.equal(cam.radiusMiles, 15);
});

// --------------------------------------------------------------------------
// defaultCamera -- the fallback ladder every map uses
// --------------------------------------------------------------------------
test('defaultCamera prefers the asked-for division', () => {
  const divisions = [
    area({ id: 'a', is_primary: true }),
    area({ id: 'b', is_primary: false, service_radius_miles: 40 }),
  ];
  assert.equal(defaultCamera(divisions, { divisionId: 'b' }).radiusMiles, 40);
});

test('defaultCamera falls back to the primary division, then to everything', () => {
  const primary = area({ id: 'a', is_primary: true, service_radius_miles: 15 });
  const other = area({ id: 'b', is_primary: false, service_radius_miles: 40 });
  assert.equal(defaultCamera([primary, other], { divisionId: 'missing' }).radiusMiles, 15);

  const noPrimary = [area({ id: 'b', is_primary: false, service_radius_miles: 40 })];
  assert.equal(defaultCamera(noPrimary).radiusMiles, 40);
});

test('defaultCamera returns null when nothing is configured, so maps keep their own default', () => {
  assert.equal(defaultCamera([]), null);
  assert.equal(defaultCamera(null), null);
  assert.equal(defaultCamera([area({ service_center_lat: null, service_center_lng: null })]), null);
});
