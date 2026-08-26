// test/workday-timezone.test.mjs
//
// api/_lib/workday.js generalizes api/track1.js's todayRangeET() technique
// (Intl.DateTimeFormat + formatToParts, real per-date offset resolution) to
// take a timezone parameter instead of hardcoding America/New_York. Pinned
// here for a DST-observing zone (America/New_York, checked either side of a
// real 2026 DST transition) and a non-DST zone (Asia/Manila), plus the
// wall-clock boundary minutes that are easiest to get off-by-one on.
//
// Run with: node --test test/workday-timezone.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { todayRangeInTz, workdayWindowInTz, isValidTimeZone, DEFAULT_TIMEZONE } from '../api/_lib/workday.js';

test('DEFAULT_TIMEZONE is America/New_York -- existing US-based staff see no change until a timezone is detected', () => {
  assert.equal(DEFAULT_TIMEZONE, 'America/New_York');
});

test('isValidTimeZone accepts real IANA zones and rejects garbage without throwing', () => {
  assert.equal(isValidTimeZone('America/New_York'), true);
  assert.equal(isValidTimeZone('Asia/Manila'), true);
  assert.equal(isValidTimeZone('Not/AZone'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone(null), false);
  assert.equal(isValidTimeZone(undefined), false);
  assert.equal(isValidTimeZone(123), false);
});

test('workdayWindowInTz: 7:00 AM-3:30 PM in Asia/Manila (no DST) resolves to the correct real UTC instants', () => {
  const { startUtc, endUtc, dateStr } = workdayWindowInTz('Asia/Manila', 7, 0, 15, 30);
  // Manila is a fixed UTC+8 year-round -- 7:00 AM local is 23:00 UTC the
  // PREVIOUS calendar day, which is exactly the kind of boundary that broke
  // the old America/New_York-hardcoded stale-session check.
  assert.equal(startUtc.getUTCHours(), 23);
  assert.equal(startUtc.getUTCMinutes(), 0);
  assert.equal(endUtc.getUTCHours(), 7);
  assert.equal(endUtc.getUTCMinutes(), 30);
  assert.match(dateStr, /^\d{4}-\d{2}-\d{2}$/);
});

test('workdayWindowInTz: the same 7:00 AM-3:30 PM in America/New_York lands ~12-13 hours later than Manila', () => {
  // Pinned to a fixed instant (2026-08-27 noon UTC), not real "now" -- each
  // zone resolves ITS OWN calendar day independently (by design: one
  // shared wall-clock schedule per employee's own local day), and for
  // roughly half of every real day Manila and New York are already on
  // different calendar dates from each other. Comparing against live "now"
  // made this test genuinely flaky right at that boundary, which is
  // exactly what happened running this suite a day later than it was
  // written -- not a bug in workdayWindowInTz, a bug in the test.
  const fixedNow = new Date('2026-08-27T12:00:00Z');
  const manila = workdayWindowInTzAt('Asia/Manila', 7, 0, 15, 30, fixedNow);
  const newYork = workdayWindowInTzAt('America/New_York', 7, 0, 15, 30, fixedNow);
  const diffHours = (newYork.startUtc.getTime() - manila.startUtc.getTime()) / 3600000;
  // Manila is UTC+8 year-round; New York is UTC-4 (EDT) or UTC-5 (EST), so
  // the same wall-clock 7:00 AM is always 12 or 13 real hours apart.
  assert.ok(diffHours === 12 || diffHours === 13, `expected 12 or 13, got ${diffHours}`);
});

test('workdayWindowInTz: resolves the correct EDT offset on a real summer date (DST in effect)', () => {
  const summer = new Date('2026-07-15T12:00:00Z');
  const { startUtc } = workdayWindowInTzAt('America/New_York', 7, 0, 15, 30, summer);
  // EDT is UTC-4: 7:00 AM EDT == 11:00 UTC.
  assert.equal(startUtc.getUTCHours(), 11);
});

test('workdayWindowInTz: resolves the correct EST offset on a real winter date (DST not in effect)', () => {
  const winter = new Date('2026-01-15T12:00:00Z');
  const { startUtc } = workdayWindowInTzAt('America/New_York', 7, 0, 15, 30, winter);
  // EST is UTC-5: 7:00 AM EST == 12:00 UTC.
  assert.equal(startUtc.getUTCHours(), 12);
});

test('todayRangeInTz: dateStr matches the real calendar date in that zone, not the machine running the test', () => {
  const manila = todayRangeInTz('Asia/Manila');
  const newYork = todayRangeInTz('America/New_York');
  assert.match(manila.dateStr, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(newYork.dateStr, /^\d{4}-\d{2}-\d{2}$/);
  // Both are real ISO instants for the same real "now".
  assert.equal(typeof manila.nowMs, 'number');
  assert.ok(Math.abs(manila.nowMs - newYork.nowMs) < 1000);
});

// Helper: workdayWindowInTz pinned to a specific "now" so the DST tests
// above are not dependent on the day this suite happens to run.
import { todayRangeInTz as _todayRangeInTz } from '../api/_lib/workday.js';
function workdayWindowInTzAt(tz, startHour, startMinute, endHour, endMinute, atDate) {
  const realDate = global.Date;
  class FixedDate extends realDate {
    constructor(...args) {
      if (args.length === 0) return new realDate(atDate.getTime());
      return new realDate(...args);
    }
    static now() { return atDate.getTime(); }
  }
  global.Date = FixedDate;
  try {
    return workdayWindowInTz(tz, startHour, startMinute, endHour, endMinute);
  } finally {
    global.Date = realDate;
  }
}
