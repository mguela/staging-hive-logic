// api/_lib/workday.js
//
// Timezone-parameterized version of the "today, in a real IANA zone"
// technique api/track1.js's todayRangeET() already used (Command Center's
// "Today's Schedule"). That one is hardcoded to America/New_York because
// everything reading it -- Jobber visits -- IS an America/New_York
// business. Workforce/Monitor timing is not: an employee can be anywhere,
// and 2026-08-26 surfaced three places that assumed America/New_York
// regardless (see the migration file / commit message this ships with for
// the investigation). This is the one place that logic now lives, so it
// cannot drift out of step across call sites again.
//
// Uses Intl.DateTimeFormat's real per-date offset resolution -- correct
// through DST transitions -- rather than a fixed UTC-offset constant, same
// as todayRangeET() already relied on.

// Today's calendar date + midnight-to-midnight UTC range, in `tz`.
// Mirrors todayRangeET()'s shape (dateStr/startISO/endISO/nowMs) so callers
// that already destructure that shape can switch with a one-line change.
export function todayRangeInTz(tz) {
  const now = new Date();
  const offsetStr = tzOffsetStringFor(now, tz);
  const { y, mo, d } = tzDatePartsFor(now, tz);
  return {
    dateStr: `${y}-${mo}-${d}`,
    startISO: `${y}-${mo}-${d}T00:00:00${offsetStr}`,
    endISO: `${y}-${mo}-${d}T23:59:59${offsetStr}`,
    nowMs: now.getTime(),
  };
}

// Today's shift window [start, end) in `tz`, as real UTC instants -- the
// one shared wall-clock schedule (7:00 AM-3:30 PM, api/track1.js's
// workforce_settings), resolved into whichever timezone the employee is
// actually in. Wall-clock hours/minutes in, real Date objects out.
export function workdayWindowInTz(tz, startHour, startMinute, endHour, endMinute) {
  const { dateStr } = todayRangeInTz(tz);
  const startUtc = wallClockToUtc(dateStr, startHour, startMinute, tz);
  const endUtc = wallClockToUtc(dateStr, endHour, endMinute, tz);
  return { startUtc, endUtc, dateStr };
}

// A safe fallback for anyone whose timezone has not been detected yet
// (profiles.timezone is NULL until a heartbeat/status poll reports one).
// Matches the workday anchor's original assumption, so existing
// America/New_York-based staff see no behavior change on day one.
export const DEFAULT_TIMEZONE = 'America/New_York';

// Guards against a garbled/forged value reaching Intl and throwing --
// Intl.DateTimeFormat throws RangeError on an unknown zone, and a heartbeat
// body is client-supplied input.
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

// --- internals --------------------------------------------------------

function tzDatePartsFor(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return { y: get('year'), mo: get('month'), d: get('day') };
}

// The GMT offset Intl resolves for THIS specific date in `tz` -- correct
// across a DST transition, unlike a fixed offset constant.
function tzOffsetStringFor(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', timeZoneName: 'shortOffset',
  }).formatToParts(date);
  const offsetPart = (parts.find((p) => p.type === 'timeZoneName') || {}).value || 'GMT+0';
  const m = offsetPart.match(/GMT([+-]\d+)(?::(\d+))?/);
  const offsetHours = m ? parseInt(m[1], 10) : 0;
  const offsetMinutes = m && m[2] ? parseInt(m[2], 10) : 0;
  const sign = offsetHours < 0 || Object.is(offsetHours, -0) ? '-' : '+';
  return `${sign}${String(Math.abs(offsetHours)).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;
}

// Converts a wall-clock time on a given calendar date IN `tz` to a real UTC
// Date. Resolves the offset from a same-day probe (noon on that date, to
// stay clear of any DST transition that lands near midnight) rather than
// from "now," so this is correct for the date being asked about even if
// "now" is a different day.
function wallClockToUtc(dateStr, hour, minute, tz) {
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const offsetStr = tzOffsetStringFor(probe, tz);
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return new Date(`${dateStr}T${hh}:${mm}:00${offsetStr}`);
}
