// test/board-fixture-week.test.mjs
//
// The browser board fixture has to put its visits in the week the board is
// actually showing, and the board shows the business's week: America/New_York.
//
// It did not. The first version read the RUNNER's clock, which is UTC in CI. For
// the four hours between 00:00 and 04:00 UTC on a Monday -- Sunday evening in
// Bedford -- it generated NEXT week's visits while the board still showed THIS
// week, so "the pins are the period's jobs" found zero pins. main went red at
// 02:03 UTC on 2026-08-17 inside that window and stayed red, which read exactly
// like "whatever merged at 02:03 broke the map". It had nothing to do with it.
//
// A four-hour-a-week failure is the worst shape a test can have: rare enough to
// look like flake, reliable enough to block a Monday morning. These tests run in
// the fast suite against a FIXED clock, so the boundary is checked on every run
// instead of once a week by accident.

import test from 'node:test';
import assert from 'node:assert/strict';

const { isoAt, etDayKey, buildFixtures, WEEK_VISIT_COUNT } = await import('./browser/fixtures.mjs');

// 'YYYY-MM-DD' of an instant, on the business calendar.
const day = (iso) => etDayKey(new Date(iso).getTime());

// The Monday..Sunday span the board would be showing at `now`.
function shownWeek(now) {
  const [y, m, d] = etDayKey(now).split('-').map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d, 12));
  const dow = (cursor.getUTCDay() + 6) % 7;
  cursor.setUTCDate(cursor.getUTCDate() - dow);
  const monday = cursor.toISOString().slice(0, 10);
  cursor.setUTCDate(cursor.getUTCDate() + 6);
  return [monday, cursor.toISOString().slice(0, 10)];
}

function assertVisitsAreInTheShownWeek(now, label) {
  const [monday, sunday] = shownWeek(now);
  const { visits } = buildFixtures(new Date(now).getTime());
  assert.equal(visits.length, WEEK_VISIT_COUNT, 'sanity: the fixture built its visits');
  for (const v of visits) {
    const d = day(v.startAt);
    assert.ok(
      d >= monday && d <= sunday,
      `${label}: visit lands ${d}, but the board is showing ${monday}..${sunday} -- this is the zero-pins failure`
    );
  }
}

test('the exact instant that broke it: Monday 02:03 UTC, still Sunday evening in Bedford', () => {
  // The real failure. Before the fix the visits landed 2026-08-17..08-23 while
  // the board showed 2026-08-10..08-16.
  assert.equal(etDayKey(Date.parse('2026-08-17T02:03:00Z')), '2026-08-16',
    'sanity: this instant is Sunday on the business calendar, Monday in UTC');
  assertVisitsAreInTheShownWeek('2026-08-17T02:03:00Z', 'the boundary');
});

test('every hour of the UTC-Monday / ET-Sunday window is safe, not just the one we hit', () => {
  for (let h = 0; h < 4; h++) {
    const now = `2026-08-17T0${h}:30:00Z`;
    assert.equal(etDayKey(Date.parse(now)), '2026-08-16', `sanity: ${now} is still Sunday in ET`);
    assertVisitsAreInTheShownWeek(now, now);
  }
});

test('the fixture lands in the shown week at every hour of a whole week', () => {
  // Not just the known-bad window -- the fix must not have moved the problem to
  // a different hour. 168 hours, every one checked.
  const start = Date.parse('2026-08-10T00:00:00Z');
  for (let h = 0; h < 24 * 7; h++) {
    assertVisitsAreInTheShownWeek(new Date(start + h * 3600e3).toISOString(), `hour ${h}`);
  }
});

test('it survives both DST changeovers', () => {
  // US DST 2026: forward Sun 8 Mar, back Sun 1 Nov. A week anchored across a
  // changeover has days on both offsets, so a fixed -5/-4 assumption breaks.
  for (const now of ['2026-03-08T02:30:00Z', '2026-03-09T03:30:00Z',
                     '2026-11-01T02:30:00Z', '2026-11-02T03:30:00Z']) {
    assertVisitsAreInTheShownWeek(now, now);
  }
});

test('the wall-clock hour is the ET hour the fixture asked for', () => {
  // The visits exist to sit at believable times on the board. If they drifted by
  // the UTC offset they would land at 4am and the week test could still pass.
  const hourET = (iso) => Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit',
  }).format(new Date(iso)).replace(/\D/g, ''));

  for (const now of ['2026-08-17T02:03:00Z', '2026-01-15T12:00:00Z']) { // EDT and EST
    assert.equal(hourET(isoAt(0, 9, Date.parse(now))), 9, `${now}: 9am ET must be 9am ET`);
    assert.equal(hourET(isoAt(4, 15, Date.parse(now))), 15, `${now}: 3pm ET must be 3pm ET`);
  }
});

test('day offsets are Monday-based and land on consecutive days', () => {
  const now = Date.parse('2026-08-17T02:03:00Z');
  const days = [0, 1, 2, 3, 4, 5, 6].map((d) => day(isoAt(d, 9, now)));
  assert.deepEqual(days, ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
    '2026-08-14', '2026-08-15', '2026-08-16']);
});
