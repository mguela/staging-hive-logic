// Explainable dispatch flags.
//
// The bar these have to clear is not "did it fire" but "would a dispatcher act
// on it". A flag with no concrete numbers is noise, and a flag that fires on a
// perfectly good day is worse than none at all -- it teaches people to ignore
// the whole feature.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../public/schedule-board/advisor.js', import.meta.url), 'utf8');
const root = {};
new Function('window', src)(root);
const { flagsForDay, milesBetween, driveMinutes } = root.HLAdvisor;

// Bedford NY area, roughly.
const A = { lat: 41.204, lng: -73.643 };
const FAR = { lat: 41.60, lng: -73.90 };   // ~30 miles away
const NEAR = { lat: 41.215, lng: -73.650 }; // ~1 mile away

const v = (o) => ({ id: 'v', s: 9, e: 11, lat: A.lat, lng: A.lng, client: 'Job', ...o });
const types = (f) => f.map((x) => x.type).sort();

test('a sensible day raises nothing', () => {
  const day = [
    v({ id: '1', s: 8, e: 10 }),
    v({ id: '2', s: 10.5, e: 12, lat: NEAR.lat, lng: NEAR.lng }),
  ];
  assert.deepEqual(flagsForDay(day, {}), []);
});

test('back-to-back jobs miles apart are flagged, with the numbers', () => {
  const day = [
    v({ id: '1', s: 8, e: 10, client: 'Henderson' }),
    v({ id: '2', s: 10.25, e: 12, lat: FAR.lat, lng: FAR.lng }),
  ];
  const f = flagsForDay(day, {});
  const gap = f.find((x) => x.type === 'travel_gap');
  assert.ok(gap, 'a 15-minute gap cannot absorb a 30-mile drive');
  assert.ok(gap.reasons.some((r) => /Henderson/.test(r)), 'names the job it is far from');
  assert.ok(gap.reasons.some((r) => /min drive/.test(r)), 'states the drive time');
  assert.ok(gap.shortfallMin > 0);
});

test('an overlapping schedule is high severity, not medium', () => {
  // Next job starts before the previous ends: no drive time exists at all.
  const day = [
    v({ id: '1', s: 8, e: 11 }),
    v({ id: '2', s: 10, e: 12, lat: FAR.lat, lng: FAR.lng }),
  ];
  const gap = flagsForDay(day, {}).find((x) => x.type === 'travel_gap');
  assert.equal(gap.severity, 'high');
});

test('a long day is flagged against the company threshold, not a hardcoded one', () => {
  const day = [v({ id: '1', s: 7, e: 9 }), v({ id: '2', s: 9.5, e: 17, lat: NEAR.lat, lng: NEAR.lng })];
  assert.ok(flagsForDay(day, { overtimeH: 8 }).some((x) => x.type === 'overtime'));
  // Same day, a company that runs 10-hour days: not their problem.
  assert.equal(flagsForDay(day, { overtimeH: 12 }).some((x) => x.type === 'overtime'), false);
});

test('no coordinates means no claim', () => {
  // A visit with no location cannot support a distance statement, and guessing
  // one is how an advisor loses a dispatcher's trust permanently.
  const day = [
    v({ id: '1', s: 8, e: 10, lat: null, lng: null }),
    v({ id: '2', s: 10.1, e: 12 }),
  ];
  assert.equal(types(flagsForDay(day, {})).includes('travel_gap'), false);
});

test('a far leg is called out even when the schedule allows for it', () => {
  const day = [
    v({ id: '1', s: 7, e: 9 }),
    v({ id: '2', s: 11, e: 13, lat: FAR.lat, lng: FAR.lng }),
  ];
  const f = flagsForDay(day, {});
  assert.ok(f.some((x) => x.type === 'geo_mismatch'), 'time to get there does not make the detour sensible');
  assert.equal(f.some((x) => x.type === 'travel_gap'), false, 'and it is not also a travel-gap complaint');
});

test('every flag carries at least two concrete reasons', () => {
  const day = [
    v({ id: '1', s: 7, e: 10 }),
    v({ id: '2', s: 10.1, e: 18, lat: FAR.lat, lng: FAR.lng }),
  ];
  const f = flagsForDay(day, {});
  assert.ok(f.length >= 2);
  for (const x of f) {
    assert.ok(x.reasons.length >= 2, `${x.type} must explain itself`);
    assert.ok(x.reasons.every((r) => /\d/.test(r)), `${x.type} reasons must contain real numbers`);
    assert.ok(x.title && x.severity && x.visitId);
  }
});

test('an empty or single-visit day is handled', () => {
  assert.deepEqual(flagsForDay([], {}), []);
  assert.deepEqual(flagsForDay([v({ id: '1', s: 9, e: 10 })], {}), []);
});

test('visits out of order are sorted before analysis', () => {
  const late = v({ id: '2', s: 10.25, e: 12, lat: FAR.lat, lng: FAR.lng });
  const early = v({ id: '1', s: 8, e: 10 });
  assert.deepEqual(
    flagsForDay([late, early], {}).map((x) => x.type),
    flagsForDay([early, late], {}).map((x) => x.type),
  );
});

test('distance and drive-time helpers are sane', () => {
  assert.equal(milesBetween(A, A), 0);
  assert.equal(milesBetween(A, null), null);
  assert.ok(milesBetween(A, FAR) > 25 && milesBetween(A, FAR) < 40);
  assert.equal(driveMinutes(null), null);
  assert.ok(driveMinutes(32) >= 55 && driveMinutes(32) <= 65);
});

// --- board integration -----------------------------------------------------

const board = fs.readFileSync(new URL('../public/schedule-board/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/schedule-board/index.html', import.meta.url), 'utf8');

test('advisor.js is actually loaded by the board', () => {
  // A module nothing loads is a module that does not exist. app.js is not in
  // the HTML at all -- data.js loads it after its fetches -- so the ordering
  // that matters is advisor.js before data.js, which makes window.HLAdvisor
  // present by the time app.js runs.
  assert.ok(html.includes('advisor.js'), 'the board must load advisor.js');
  // Compare the script TAGS, not bare filenames -- a comment above them
  // mentions data.js first, which made an earlier version of this assertion
  // fail on correct markup.
  assert.ok(
    html.indexOf('src="./advisor.js"') < html.indexOf('src="./data.js"'),
    'advisor must load before the adapter that boots app.js',
  );
});

test('the board renders the flags', () => {
  assert.match(board, /renderAdvisor/);
  assert.match(board, /advbanner/);
});

test('the advisor never mutates a visit', () => {
  // Design law 1: advisory-first. Extract the function and check it contains no
  // write path -- no post, no move, no assignment back onto a visit.
  const start = board.indexOf('function renderAdvisor');
  const body = board.slice(start, board.indexOf('function renderWeatherBanner'));
  for (const forbidden of ['hlPost', 'move_appointment', 'fetch(']) {
    assert.equal(body.includes(forbidden), false, `renderAdvisor must not ${forbidden}`);
  }
});

test('the board degrades if the advisor fails to load', () => {
  const start = board.indexOf('function renderAdvisor');
  const body = board.slice(start, board.indexOf('function renderWeatherBanner'));
  assert.match(body, /if\(!adv/, 'must guard on window.HLAdvisor being absent');
});
