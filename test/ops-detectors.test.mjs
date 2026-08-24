import test from 'node:test';
import assert from 'node:assert/strict';
import {
  finishedNotInvoiced, invoicedNotSent, appointmentWithDelinquentClient,
  overScheduledWindow, notStartedWindowClosed, finishedWithoutPhotos,
  noWorkClientBooked, approvedNotScheduled, unassignedVisitSoon, arrivedOnSite,
  crewList, isMuted, shouldInterrupt, runAll,
} from '../api/_lib/ops-detectors.js';

// The detectors behind the operational event feed.
//
// They are pure on purpose -- rows in, events out, `now` passed in -- so "a job
// finished four days ago and was never invoiced" is testable without a job, an
// invoice, or four days.
//
// Two things are asserted everywhere, because they are what decides whether the
// feed is useful or noise:
//   * the dedupe key is stable across runs and carries no timestamp
//   * only things worth stopping for are allowed to interrupt

const NOW = Date.parse('2026-08-22T15:00:00Z');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(NOW - ms).toISOString();
const ahead = (ms) => new Date(NOW + ms).toISOString();

const CLIENTS = [
  { jobber_id: 'C1', name: 'John Smith', balance: 0 },
  { jobber_id: 'C2', name: 'Joan Jones', balance: 0 },
  { jobber_id: 'C3', name: 'Willy Williams', balance: 4200 },
];

const visit = (o = {}) => ({
  jobber_id: 'V1', title: 'Bathroom Remodel', client_id: 'C1', job_id: 'J1',
  start_at: ago(6 * HOUR), end_at: ago(2 * HOUR), completed_at: null,
  assigned_users: [{ name: 'Team 2' }], is_all_day: false, ...o,
});

// ---------------------------------------------------------------------------
// money.finished_not_invoiced -- the one with a real price tag
// ---------------------------------------------------------------------------

test('a job finished days ago with no invoice is raised, and it interrupts', () => {
  const [e] = finishedNotInvoiced({
    visits: [visit({ completed_at: ago(4 * DAY) })],
    invoices: [], clients: CLIENTS, now: NOW,
  });
  assert.equal(e.kind, 'money.finished_not_invoiced');
  assert.equal(e.severity, 'interrupt', 'unbilled work is money at risk');
  assert.match(e.title, /John Smith/);
  assert.match(e.title, /no invoice/i);
  assert.match(e.detail, /4 days ago/);
  assert.equal(e.domain, 'money');
});

test('a job invoiced already is not raised', () => {
  const out = finishedNotInvoiced({
    visits: [visit({ completed_at: ago(4 * DAY) })],
    invoices: [{ jobber_id: 'I1', job_id: 'J1' }], clients: CLIENTS, now: NOW,
  });
  assert.deepEqual(out, []);
});

test('a job finished an hour ago is inside the grace period', () => {
  // Alerting the moment a crew closes out would fire on every single job.
  const out = finishedNotInvoiced({
    visits: [visit({ completed_at: ago(1 * HOUR) })], invoices: [], clients: CLIENTS, now: NOW,
  });
  assert.deepEqual(out, []);
});

test('two visits on one job produce one event, not two', () => {
  const out = finishedNotInvoiced({
    visits: [
      visit({ jobber_id: 'V1', completed_at: ago(4 * DAY) }),
      visit({ jobber_id: 'V2', completed_at: ago(3 * DAY) }),
    ],
    invoices: [], clients: CLIENTS, now: NOW,
  });
  assert.equal(out.length, 1, 'the fact is about the job, not each visit');
});

test('the dedupe key is stable across runs and holds no timestamp', () => {
  // The whole design rests on this. A key that changes each sweep produces a
  // fresh notification every hour, which trains the reader to ignore the feed.
  const run = (now) => finishedNotInvoiced({
    visits: [visit({ completed_at: ago(4 * DAY) })], invoices: [], clients: CLIENTS, now,
  })[0].dedupe_key;
  const a = run(NOW);
  const b = run(NOW + 6 * HOUR);
  assert.equal(a, b, 'the same unbilled job must produce the same key six hours later');
  assert.equal(a, 'money.finished_not_invoiced:J1');
  assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}|\d{10,}/, 'no date and no epoch in the key');
});

test('it says what to do about it, not just that it happened', () => {
  const [e] = finishedNotInvoiced({
    visits: [visit({ completed_at: ago(4 * DAY) })], invoices: [], clients: CLIENTS, now: NOW,
  });
  assert.ok(e.actions.length, 'an event with no action is a complaint');
  assert.ok(e.actions.some((a) => a.action === 'create_invoice'));
});

// ---------------------------------------------------------------------------
// money.invoiced_not_sent
// ---------------------------------------------------------------------------

test('a draft invoice left sitting is raised', () => {
  const [e] = invoicedNotSent({
    invoices: [{ jobber_id: 'I1', client_id: 'C1', invoice_number: 1042, invoice_status: 'draft', total: 3400, jobber_created_at: ago(3 * DAY) }],
    clients: CLIENTS, now: NOW,
  });
  assert.match(e.title, /#1042/);
  assert.match(e.title, /still a draft/);
  assert.match(e.detail, /\$3\.4K/, 'the amount is stated, so the size of the miss is visible');
  assert.equal(e.severity, 'interrupt');
});

test('a sent invoice is not a draft and is left alone', () => {
  const out = invoicedNotSent({
    invoices: [{ jobber_id: 'I1', invoice_status: 'sent', jobber_created_at: ago(3 * DAY) }],
    clients: CLIENTS, now: NOW,
  });
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------------------
// money.appointment_with_delinquent_client
// ---------------------------------------------------------------------------

test('booking work for somebody who owes money is caught before the crew rolls', () => {
  const [e] = appointmentWithDelinquentClient({
    visits: [visit({ client_id: 'C3', start_at: ahead(1 * DAY), end_at: ahead(1 * DAY + 2 * HOUR), completed_at: null })],
    clients: CLIENTS, now: NOW,
  });
  assert.match(e.title, /Willy Williams owes \$4\.2K/);
  assert.equal(e.severity, 'interrupt');
  assert.ok(e.actions.some((a) => a.action === 'collect_first'));
});

test('a client with no balance booking work is not an alert', () => {
  const out = appointmentWithDelinquentClient({
    visits: [visit({ client_id: 'C1', start_at: ahead(1 * DAY), completed_at: null })],
    clients: CLIENTS, now: NOW,
  });
  assert.deepEqual(out, []);
});

test('a debt with no upcoming visit is not this alert', () => {
  // The point is the appointment. Chasing the debt itself is a different job.
  const out = appointmentWithDelinquentClient({
    visits: [visit({ client_id: 'C3', start_at: ahead(30 * DAY) })], clients: CLIENTS, now: NOW,
  });
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------------------
// job.over_scheduled_window
// ---------------------------------------------------------------------------

test('a crew running well over the window is raised, with the crew named', () => {
  const [e] = overScheduledWindow({
    visits: [visit({ end_at: ago(3 * HOUR), assigned_users: [{ name: 'Team 4' }] })],
    clients: CLIENTS, now: NOW,
  });
  assert.match(e.title, /Team 4 is running over/);
  assert.equal(e.severity, 'interrupt');
  assert.ok(e.actions.some((a) => a.action === 'chirp_lead'), 'the proposed follow-up is to check in');
});

test('a few minutes over is not "running over"', () => {
  const out = overScheduledWindow({ visits: [visit({ end_at: ago(20 * 60 * 1000) })], clients: CLIENTS, now: NOW });
  assert.deepEqual(out, []);
});

test('a day past the window is a different fact, and this detector leaves it alone', () => {
  // Over-running is a today problem you chirp about; never-closed-out is a
  // bookkeeping problem. Two facts, two detectors, no double-reporting.
  const stale = [visit({ end_at: ago(3 * DAY) })];
  assert.deepEqual(overScheduledWindow({ visits: stale, clients: CLIENTS, now: NOW }), []);
  assert.equal(notStartedWindowClosed({ visits: stale, clients: CLIENTS, now: NOW }).length, 1);
});

test('a multi-name crew is summarised rather than listed in full', () => {
  const [e] = overScheduledWindow({
    visits: [visit({ end_at: ago(3 * HOUR), assigned_users: [{ name: 'Mark' }, { name: 'Dave' }, { name: 'Sue' }] })],
    clients: CLIENTS, now: NOW,
  });
  assert.match(e.title, /Mark \+ 2/);
});

// ---------------------------------------------------------------------------
// job.window_closed_not_completed
// ---------------------------------------------------------------------------

test('a visit whose window closed and was never completed is raised as digest', () => {
  const [e] = notStartedWindowClosed({ visits: [visit({ end_at: ago(3 * DAY) })], clients: CLIENTS, now: NOW });
  assert.equal(e.severity, 'digest', 'worth knowing, not worth stopping for');
  assert.match(e.title, /never closed out/);
});

test('very old open visits are a data-cleanup job, not an alert', () => {
  const out = notStartedWindowClosed({ visits: [visit({ end_at: ago(60 * DAY) })], clients: CLIENTS, now: NOW });
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------------------
// job.finished_without_photos
// ---------------------------------------------------------------------------

test('a job closed out with no photos at all is raised', () => {
  const [e] = finishedWithoutPhotos({
    visits: [visit({ completed_at: ago(1 * DAY) })], mediaCountByJob: {}, clients: CLIENTS, now: NOW,
  });
  assert.match(e.title, /no photos/);
  assert.equal(e.severity, 'digest');
});

test('a job with photos is not raised', () => {
  const out = finishedWithoutPhotos({
    visits: [visit({ completed_at: ago(1 * DAY) })], mediaCountByJob: { J1: 12 }, clients: CLIENTS, now: NOW,
  });
  assert.deepEqual(out, []);
});

test('photos are not chased in the first few hours after close-out', () => {
  const out = finishedWithoutPhotos({
    visits: [visit({ completed_at: ago(1 * HOUR) })], mediaCountByJob: {}, clients: CLIENTS, now: NOW,
  });
  assert.deepEqual(out, [], 'uploads lag; alerting instantly would fire on every job');
});

// ---------------------------------------------------------------------------
// client.no_work_client_booked -- the one that has to shout
// ---------------------------------------------------------------------------

test('a "no work" client with a booked visit interrupts, and carries the reason', () => {
  const [e] = noWorkClientBooked({
    visits: [visit({ client_id: 'C2', start_at: ahead(2 * DAY) })],
    clients: CLIENTS,
    flags: [{ client_id: 'C2', flag: 'no_work', reason: 'Prior bad experience — do not schedule' }],
    now: NOW,
  });
  assert.equal(e.severity, 'interrupt', 'a crew turning up here is the expensive mistake');
  assert.match(e.title, /flagged "no work"/);
  assert.match(e.detail, /Prior bad experience/, 'the reason on file is shown, not just the flag');
  assert.ok(e.actions.some((a) => a.action === 'cancel_visit'));
});

test('an unflagged client booking work is silent', () => {
  const out = noWorkClientBooked({
    visits: [visit({ client_id: 'C1', start_at: ahead(2 * DAY) })],
    clients: CLIENTS, flags: [{ client_id: 'C2', flag: 'no_work' }], now: NOW,
  });
  assert.deepEqual(out, []);
});

test('a flag of some other kind does not trigger the no-work alert', () => {
  const out = noWorkClientBooked({
    visits: [visit({ client_id: 'C2', start_at: ahead(2 * DAY) })],
    clients: CLIENTS, flags: [{ client_id: 'C2', flag: 'vip' }], now: NOW,
  });
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------------------
// sales.approved_not_scheduled
// ---------------------------------------------------------------------------

test('approved work with nothing on the calendar is raised', () => {
  const [e] = approvedNotScheduled({
    quotes: [{ jobber_id: 'Q1', quote_number: 88, quote_status: 'approved', total: 12500, client_id: 'C1', client_name: 'John Smith', jobber_updated_at: ago(5 * DAY) }],
    visitsByClient: {}, now: NOW,
  });
  assert.match(e.title, /approved \$12\.5K of work that is not on the calendar/);
  assert.equal(e.severity, 'interrupt');
});

test('approved work that IS scheduled is left alone', () => {
  const out = approvedNotScheduled({
    quotes: [{ jobber_id: 'Q1', quote_status: 'approved', total: 100, client_id: 'C1', jobber_updated_at: ago(5 * DAY) }],
    visitsByClient: { C1: 2 }, now: NOW,
  });
  assert.deepEqual(out, []);
});

test('a quote still out for decision is not this alert', () => {
  const out = approvedNotScheduled({
    quotes: [{ jobber_id: 'Q1', quote_status: 'awaiting_response', client_id: 'C1', jobber_updated_at: ago(5 * DAY) }],
    visitsByClient: {}, now: NOW,
  });
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------------------
// schedule.unassigned_visit_soon
// ---------------------------------------------------------------------------

test('tomorrow\'s work with nobody on it is caught tonight', () => {
  const [e] = unassignedVisitSoon({
    visits: [visit({ start_at: ahead(20 * HOUR), completed_at: null, assigned_users: [] })],
    clients: CLIENTS, now: NOW,
  });
  assert.match(e.title, /nobody assigned/);
  assert.equal(e.severity, 'interrupt');
  assert.ok(e.actions.some((a) => a.action === 'assign_crew'));
});

test('an assigned visit is silent', () => {
  const out = unassignedVisitSoon({
    visits: [visit({ start_at: ahead(20 * HOUR), assigned_users: [{ name: 'Team 1' }] })],
    clients: CLIENTS, now: NOW,
  });
  assert.deepEqual(out, []);
});

test('assigned_users arriving as a JSON string still counts as assigned', () => {
  // Jobber-synced rows have shown up both ways.
  assert.deepEqual(crewList({ assigned_users: '[{"name":"Team 9"}]' }), ['Team 9']);
  assert.deepEqual(crewList({ assigned_users: 'not json' }), []);
  assert.deepEqual(crewList({}), []);
});

// ---------------------------------------------------------------------------
// fleet.arrived_on_site
// ---------------------------------------------------------------------------

test('an arrival is recorded as digest, not an interrupt', () => {
  // Ten trucks arriving and leaving all day is dozens of events. If these
  // interrupt, the ones that matter get buried.
  const [e] = arrivedOnSite({
    presence: [{ id: 'P1', vehicle_name: 'Truck #1', client_id: 'C3', job_id: 'J9', job_title: 'Deck repair', arrived_at: ago(20 * 60 * 1000) }],
    clients: CLIENTS, now: NOW,
  });
  assert.equal(e.severity, 'digest');
  assert.match(e.title, /Truck #1 arrived at Willy Williams/);
  assert.equal(e.dedupe_key, 'fleet.arrived_on_site:P1', 'one event per presence interval, not per sweep');
});

test('an arrival from this morning is not re-announced this afternoon', () => {
  const out = arrivedOnSite({
    presence: [{ id: 'P1', arrived_at: ago(9 * HOUR) }], clients: CLIENTS, now: NOW,
  });
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------------------
// muting -- silence only ever comes from something somebody pressed
// ---------------------------------------------------------------------------

test('a blanket mute silences that kind everywhere', () => {
  const e = { kind: 'fleet.arrived_on_site', client_id: 'C1', job_id: 'J1', vehicle_name: 'Truck #1' };
  assert.equal(isMuted(e, [{ kind: 'fleet.arrived_on_site' }]), true);
});

test('a scoped mute silences one client without silencing the rest', () => {
  const mutes = [{ kind: 'job.finished_without_photos', client_id: 'C1' }];
  assert.equal(isMuted({ kind: 'job.finished_without_photos', client_id: 'C1' }, mutes), true);
  assert.equal(isMuted({ kind: 'job.finished_without_photos', client_id: 'C2' }, mutes), false);
});

test('a mute for a different kind does not bleed across', () => {
  assert.equal(isMuted({ kind: 'money.finished_not_invoiced' }, [{ kind: 'fleet.arrived_on_site' }]), false);
});

test('no mutes means nothing is silenced', () => {
  assert.equal(isMuted({ kind: 'anything' }, []), false);
  assert.equal(isMuted({ kind: 'anything' }, null), false);
});

// ---------------------------------------------------------------------------
// interrupting
// ---------------------------------------------------------------------------

test('only interrupt-severity events can interrupt', () => {
  assert.equal(shouldInterrupt({ severity: 'digest' }, { hourLocal: 10 }), false);
  assert.equal(shouldInterrupt({ severity: 'log' }, { hourLocal: 10 }), false);
  assert.equal(shouldInterrupt({ severity: 'interrupt' }, { hourLocal: 10 }), true);
});

test('quiet hours hold the interrupt but never the event', () => {
  // The event is still recorded and still shows in the morning. Losing an
  // observation because it happened at 10pm is the silence this must not invent.
  assert.equal(shouldInterrupt({ severity: 'interrupt' }, { hourLocal: 22 }), false);
  assert.equal(shouldInterrupt({ severity: 'interrupt' }, { hourLocal: 3 }), false);
  assert.equal(shouldInterrupt({ severity: 'interrupt' }, { hourLocal: 7 }), true);
});

test('with no local hour known, an interrupt is allowed rather than swallowed', () => {
  assert.equal(shouldInterrupt({ severity: 'interrupt' }, {}), true);
});

// ---------------------------------------------------------------------------
// the sweep
// ---------------------------------------------------------------------------

test('runAll returns a result per detector, named', () => {
  const out = runAll({ visits: [], invoices: [], clients: [], quotes: [], presence: [], now: NOW });
  assert.equal(out.length, 10);
  assert.ok(out.every((r) => typeof r.detector === 'string' && Array.isArray(r.events)));
});

test('one detector throwing does not take the sweep down with it', () => {
  // The other nine still have something worth saying.
  const out = runAll({
    visits: null, invoices: null, clients: null, quotes: null, presence: null,
    get mediaCountByJob() { throw new Error('boom'); },
    now: NOW,
  });
  assert.ok(out.some((r) => r.error), 'the failure is reported');
  assert.ok(out.every((r) => Array.isArray(r.events)), 'and every detector still returns a list');
});

test('a full sweep over a realistic day produces exactly the expected events', () => {
  const data = {
    now: NOW,
    clients: CLIENTS,
    visits: [
      visit({ jobber_id: 'V1', job_id: 'J1', client_id: 'C1', completed_at: ago(4 * DAY) }),      // not invoiced
      visit({ jobber_id: 'V2', job_id: 'J2', client_id: 'C2', end_at: ago(3 * HOUR) }),           // running over
      visit({ jobber_id: 'V3', job_id: 'J3', client_id: 'C3', start_at: ahead(1 * DAY), end_at: ahead(1 * DAY + HOUR), assigned_users: [] }), // unassigned + delinquent
    ],
    invoices: [],
    quotes: [],
    visitsByClient: {},
    mediaCountByJob: { J1: 3 },
    presence: [],
    flags: [],
  };
  const kinds = runAll(data).flatMap((r) => r.events).map((e) => e.kind).sort();
  assert.deepEqual(kinds, [
    'job.over_scheduled_window',
    'money.appointment_with_delinquent_client',
    'money.finished_not_invoiced',
    'schedule.unassigned_visit_soon',
  ]);
});

test('every event a sweep produces is well formed', () => {
  const events = runAll({
    now: NOW, clients: CLIENTS,
    visits: [visit({ completed_at: ago(4 * DAY) })],
    invoices: [], quotes: [], visitsByClient: {}, mediaCountByJob: {}, presence: [], flags: [],
  }).flatMap((r) => r.events);
  assert.ok(events.length);
  const keys = new Set();
  for (const e of events) {
    assert.ok(e.kind && e.dedupe_key && e.title, 'kind, key and title are mandatory');
    assert.equal(e.domain, e.kind.split('.')[0], 'domain is derived from the kind, never set by hand');
    assert.ok(['interrupt', 'digest', 'log'].includes(e.severity));
    assert.ok(Array.isArray(e.actions));
    assert.equal(keys.has(e.dedupe_key), false, 'one sweep must not emit the same key twice');
    keys.add(e.dedupe_key);
  }
});

// ---------------------------------------------------------------------------
// jobLabel -- found on the first production sweep, 2026-08-23
// ---------------------------------------------------------------------------

test('a Jobber title that repeats the client name is not printed twice', async () => {
  // The real titles that exposed this. Naming the client and then printing
  // "Anna Maria DeSalva - HOME RENOVATION" gives you the client twice in one
  // sentence.
  const { jobLabel } = await import('../api/_lib/ops-detectors.js');
  assert.equal(jobLabel('Anna Maria DeSalva - HOME RENOVATION', 'Anna Maria DeSalva'), 'HOME RENOVATION');
  assert.equal(jobLabel('Kevin McCabe - Primary Bathroom', 'Kevin McCabe'), 'Primary Bathroom');
  assert.equal(jobLabel('Robert Fitzsimmons - Punch List', 'Robert Fitzsimmons'), 'Punch List');
});

test('a title that does not start with the client name is left alone', async () => {
  const { jobLabel } = await import('../api/_lib/ops-detectors.js');
  assert.equal(jobLabel('Bathroom Remodel', 'John Smith'), 'Bathroom Remodel');
  assert.equal(jobLabel('Smithfield Roofing', 'Smith'), 'Smithfield Roofing', 'a name that is merely a prefix of a word must not be stripped');
});

test('stripping never leaves an empty label', async () => {
  const { jobLabel } = await import('../api/_lib/ops-detectors.js');
  assert.equal(jobLabel('John Smith', 'John Smith'), 'John Smith', 'better the client name twice than a blank');
  assert.equal(jobLabel('', 'John Smith'), '');
  assert.equal(jobLabel('Roof', null), 'Roof');
});

test('the finished-not-invoiced sentence reads cleanly with a real Jobber title', async () => {
  const [e] = finishedNotInvoiced({
    visits: [visit({ title: 'Kevin McCabe - Primary Bathroom', client_id: 'C4', completed_at: ago(4 * DAY) })],
    invoices: [],
    clients: [{ jobber_id: 'C4', name: 'Kevin McCabe' }],
    now: NOW,
  });
  assert.equal(e.title, 'Kevin McCabe — Primary Bathroom finished, but no invoice was created');
  assert.equal(e.job_title, 'Kevin McCabe - Primary Bathroom', 'the stored title stays exactly as Jobber has it');
});
