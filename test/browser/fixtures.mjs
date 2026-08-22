// Fixture data for the browser harness.
//
// Deliberately not "happy path only" — each row exists because a real bug hid
// behind it:
//   * a roster long enough that the board actually overflows its scroll box
//     (an early scroll test passed vacuously against 3 crews, proving nothing)
//   * a crew with no vehicle, which must be drawn with NO truck rather than a
//     guessed one
//   * a stale vehicle fix, which must render greyed and never "moving"
//   * one badly geocoded visit, which must not drag the map zoom out
//   * visits spread across the week, so Day and Week frame different sets
//   * a TWO-PERSON visit, because every other visit here has exactly one tech —
//     so the crew-grouping path (job renders on the lead's row, secondary gets a
//     chained marker) was invisible to this harness and passed vacuously

import { EXPECTED_AGENT_VERSION } from '../../api/_lib/agent-version.js';

const CREW = [
  { id: 'u1', name: 'Marco Diaz', vehicleName: '2021 PROMASTER' },
  { id: 'u2', name: 'Sami Kaur', vehicleName: '2018 Silverado' },
  { id: 'u3', name: 'Danny Roche', vehicleName: null },
  ...['Alex Reed', 'Steve Novak', 'Einer Paz', 'Gerry Hall', 'Joseph Lin', 'Jeffrey Ure',
    'Sandro Gil', 'Walter Cruz', 'Dionisio Cabo', 'Diego Vela', 'David Stern']
    .map((n, i) => ({ id: 'p' + i, name: n, vehicleName: null })),
];

// The shop yard — 23 Bedford-Banksville Rd, Bedford NY 10506. Kept here so a
// test can assert the map centres on it without reaching into the app.
export const SHOP = { lat: 41.14435668781, lng: -73.641778856887 };

// Monday-relative so the fixture always lands in "this week" whenever it runs.
//
// "This week" HAS TO MEAN the same thing here as it does in the app, and the app
// runs on the business's calendar: America/New_York (hlDayKey, index.html). The
// first version of this used the RUNNER's clock, which is UTC in CI -- so for the
// four hours between 00:00 and 04:00 UTC on a Monday (Sunday evening in Bedford)
// it generated NEXT week's visits while the board was still showing THIS week,
// and "the pins are the period's jobs" failed with zero pins. That went red on
// main at 02:03 UTC on 2026-08-17 and stayed red, looking exactly like whichever
// commit happened to land inside the window.
//
// So every timestamp below is anchored to the Monday of the America/New_York
// week, at America/New_York wall-clock hours, and DST is resolved by asking the
// zone rather than assuming an offset.

const ET = 'America/New_York';

// The 'YYYY-MM-DD' the business is currently on.
export function etDayKey(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));
}

// How far ahead of UTC the zone is, in minutes, at a given instant (negative for ET).
function etOffsetMinutes(instant) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const at = (type) => Number(parts.find((p) => p.type === type).value);
  const wall = Date.UTC(at('year'), at('month') - 1, at('day'), at('hour') % 24, at('minute'), at('second'));
  return (wall - Math.floor(instant.getTime() / 1000) * 1000) / 60000;
}

// The instant at which the ET wall clock reads the given date and hour. Applied
// twice so a date whose offset differs from the first guess (the DST changeover)
// still settles on the right answer.
function etInstant(y, m, d, hour) {
  let ts = Date.UTC(y, m - 1, d, hour);
  for (let i = 0; i < 2; i++) {
    ts = Date.UTC(y, m - 1, d, hour) - etOffsetMinutes(new Date(ts)) * 60000;
  }
  return new Date(ts);
}

// `now` is injectable so the week logic can be tested at the boundary that broke
// it, rather than only at whatever time the suite happens to run.
export function isoAt(dayOffset, hour, now = Date.now()) {
  const [y, m, d] = etDayKey(now).split('-').map(Number);
  // Midday UTC on the ET calendar date: far enough from either edge that the
  // weekday is the ET weekday, whatever the offset.
  const cursor = new Date(Date.UTC(y, m - 1, d, 12));
  const dow = (cursor.getUTCDay() + 6) % 7;              // Monday = 0
  cursor.setUTCDate(cursor.getUTCDate() - dow + dayOffset);
  return etInstant(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate(), hour).toISOString();
}

// The ET instant for a given hour TODAY. isoAt() is relative to Monday of the
// current week, which is the right model for the week fixtures but wrong for
// anything that has to appear on the day the board opens to.
export function isoToday(hour, now = Date.now()) {
  const [y, m, d] = etDayKey(now).split('-').map(Number);
  return etInstant(y, m, d, hour).toISOString();
}

const VISITS = [
  { d: 0, h: 9, lat: 41.0262, lng: -73.6282, who: 'u1', client: 'Whitby House', title: 'Electric rough-in' },
  { d: 0, h: 13, lat: 41.0451, lng: -73.5387, who: 'u2', client: 'Stamford Loft', title: 'Plumbing repair' },
  { d: 2, h: 10, lat: 41.1443, lng: -73.6418, who: 'u1', client: 'Shop Yard', title: 'Shop maintenance' },
  { d: 4, h: 8, lat: 41.0331, lng: -73.5247, who: 'u3', client: 'Cove Road', title: 'HVAC service' },
  { d: 4, h: 15, lat: 34.0500, lng: -118.240, who: 'u2', client: 'BAD GEOCODE', title: 'Outlier job' },
  { d: 6, h: 11, lat: 41.0998, lng: -73.6100, who: 'u1', client: 'Round Hill', title: 'Trim carpentry' },
  // Marco (u1, flagged is_lead) leads; Danny (u3) is chained to him.
  { d: 0, h: 16, lat: 41.0300, lng: -73.6000, who: 'u1', crew: ['u1', 'u3'], client: 'Byram Two-Hander', title: 'Deck rebuild' },
];

// The lead and the secondary on that two-person job, so a test can name them
// without re-deriving the fixture's own conventions.
export const CREW_JOB = { client: 'Byram Two-Hander', leadId: 'u1', leadName: 'Marco', secondaryId: 'u3', secondaryName: 'Danny' };

export const MONDAY_VISIT_COUNT = VISITS.filter((v) => v.d === 0).length;
export const WEEK_VISIT_COUNT = VISITS.length;
// the LA job is excluded from any fit, so it is the one pin allowed off-screen
export const WEEK_MAPPABLE_COUNT = VISITS.filter((v) => v.client !== 'BAD GEOCODE').length;

// A subcontractor with one job today, so the Subs layer has something real to
// render. Kept to ONE sub on purpose: the layer's whole claim is that sub rows
// appear only for subs with work, which needs a sub who has some.
export const SUB = { id: '11111111-2222-3333-4444-555555555555', name: 'Alpine Electric' };

export function buildFixtures(nowMs = Date.now()) {
  const roster = CREW.map((c, i) => ({
    jobberId: c.id, name: c.name,
    email: c.name.toLowerCase().replace(/\W+/g, '.') + '@gh.test',
    lens: 'crew', division: 'Handyman', crewLabel: 'Team ' + (i + 1),
    hasVehicle: !!c.vehicleName, vehicleName: c.vehicleName, permissionRoles: [],
    // Exactly one flagged lead, so lead election is decided by the flag rather
    // than by crew ordering — which is what the shipped board actually does.
    isLead: c.id === CREW_JOB.leadId,
  }));

  const visits = VISITS.map((v, i) => ({
    visitId: 'v' + i, jobberId: 'j' + i, jobNumber: 2400 + i,
    title: v.title, clientName: v.client,
    startAt: isoAt(v.d, v.h, nowMs), endAt: isoAt(v.d, v.h + 2, nowMs),
    arrivalWindowStart: null, arrivalWindowEnd: null,
    status: 'scheduled', lat: v.lat, lng: v.lng, city: 'Greenwich',
    assignedTechs: (v.crew || [v.who]).map((id) => ({ name: CREW.find((c) => c.id === id).name, jobberId: id })),
  }));

  const vehicles = [
    { name: '2021 PROMASTER', lat: 41.1441, lng: -73.6421, status: 'DRIVING', speed: 31,
      updatedAt: new Date(nowMs - 2 * 60 * 1000).toISOString() },
    // 45 minutes old: past the 30-minute threshold, so it must read as stale
    { name: '2018 Silverado', lat: 41.0487, lng: -73.5345, status: 'DRIVING', speed: 0,
      updatedAt: new Date(nowMs - 45 * 60 * 1000).toISOString() },
    { name: 'Spare Van', lat: 41.30, lng: -73.72, status: 'STOPPED', speed: 0,
      updatedAt: new Date(nowMs - 60 * 1000).toISOString() },
  ];

  const vehicleAssignments = [
    { vehicleName: '2021 PROMASTER', techName: 'Marco Diaz' },
    { vehicleName: '2018 Silverado', techName: 'Sami Kaur' },
  ];

  const subAppointments = [{
    id: 'appt-sub-1', kind: 'sub', title: 'Panel swap', client: 'Alpine Electric',
    crew_jids: [], lead_jid: null, sub_id: SUB.id,
    start_at: isoToday(9, nowMs), end_at: isoToday(12, nowMs),
    status: 'scheduled', canceled: false, confirm_state: 'unconfirmed',
    job_no: '2499', lat: 41.03, lng: -73.62, details: {},
  }];

  return { roster, visits, vehicles, vehicleAssignments, subAppointments, subs: [SUB] };
}

// ---------------------------------------------------------------------------
// Command Center "Pulse" gauges
// ---------------------------------------------------------------------------
// Real-shaped numbers, not placeholders. A widget full of "Loading…" is the
// easiest thing in the world to lay out; every interesting failure in this
// panel — a value too wide for its dial, a label colliding with the number —
// only exists once real content is in it. These are the figures from the
// screenshot Chris sent, so the harness reproduces exactly what he saw.
// The Monitor roster, covering all three version states at once.
//
// The expected version is IMPORTED, never typed: a fixture that hardcoded
// "1.2.4" would keep passing after the next agent release while the badge it
// claims to prove had quietly turned amber for everyone. The stale and unknown
// rows are not decoration -- "unknown" is the state the whole agent-version
// mechanism exists to keep separate from "stale", and a fixture with only a
// current agent could not tell the two apart.
export const MONITOR_ROSTER = [
  { employeeId: 'm1', name: 'Current Machine', deviceName: 'Fractal', platform: 'win32',
    status: 'active', lastSeenAt: new Date(Date.now() - 30 * 1000).toISOString(),
    agentVersion: EXPECTED_AGENT_VERSION, agentVersionState: 'current',
    monitoringEnabled: true, monitoringRequired: true },
  { employeeId: 'm2', name: 'Behind Machine', deviceName: 'Old Laptop', platform: 'win32',
    status: 'active', lastSeenAt: new Date(Date.now() - 45 * 1000).toISOString(),
    agentVersion: '1.0.0', agentVersionState: 'stale',
    monitoringEnabled: true, monitoringRequired: true },
  // Heartbeating right now, reporting no version: the shape of a machine
  // running a build from before version reporting existed. This is the state
  // Chris's own agent was in on 2026-08-18, and it is NOT the same as a machine
  // that has never run an agent at all -- which is the row below.
  { employeeId: 'm3', name: 'Silent Machine', deviceName: 'Shop PC', platform: 'darwin',
    status: 'active', lastSeenAt: new Date(Date.now() - 20 * 1000).toISOString(),
    agentVersion: null, agentVersionState: 'unknown',
    monitoringEnabled: true, monitoringRequired: false },
  // Never paired, never seen. There is no agent here to have a version.
  { employeeId: 'm4', name: 'Never Paired', deviceName: null, platform: null,
    status: 'inactive', lastSeenAt: null,
    agentVersion: null, agentVersionState: 'unknown',
    monitoringEnabled: true, monitoringRequired: true },
];

export const PULSE = {
  dailybrief: {
    ok: true,
    cash: { bankBalance: 31000 },
    cashRunway: { runwayWeeks: 0.8 },
    pastDueInvoices: { sum: 154000, count: 35 },
  },
  // gross margin 42.1% of income
  qboSummary: { pnl_ytd: { total_income: 1000000, gross_profit: 421000 } },
  snapshot: { ok: true, snapshot: { ar: { outstanding: 134000, overdueCount: 35 } } },
  // 25 open quotes totalling $440K
  quotes: {
    ok: true,
    quotes: Array.from({ length: 25 }, (_, i) => ({ id: `q${i}`, status: 'awaiting_response', total: 17600 })),
  },
  // 110 unpaid vendor bills, $383K outstanding
  bills: { bills: Array.from({ length: 110 }, (_, i) => ({ id: `b${i}` })), total_balance: 383000 },
  watchingUnscheduled: { ok: true, count: 7 },
  jobs: { ok: true, totalCount: 2774, jobs: [] },
};
