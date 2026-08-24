// api/_lib/ops-detectors.js
//
// The detectors behind the operational event feed. Chris, 2026-08-22: "AI should
// never let you miss an opportunity for efficiency and also follow ups."
//
// EVERY FUNCTION HERE IS PURE. Rows in, events out, no database and no clock of
// its own -- `now` is always passed. That is what makes it possible to test "a
// job finished four days ago and was never invoiced" without a job, an invoice,
// or four days. api/ops-events.js does all the reading and writing.
//
// THREE RULES EVERY DETECTOR FOLLOWS.
//
// 1. A stable dedupe key. These run on a schedule and will re-find the same
//    uninvoiced job every hour until somebody invoices it. The key must be
//    stable for "this fact, about this thing, at this stage" and must never
//    contain a timestamp -- otherwise the feed produces a fresh copy every run
//    and the reader learns to ignore it, which is the one outcome that makes
//    the whole feature worthless.
//
// 2. Severity earns its interrupt. 'interrupt' is for money at risk or a person
//    waiting. Truck movement is 'digest'. If everything interrupts, nothing does.
//
// 3. Say what to do about it. An event with no action is a complaint. Every
//    detector that can name a follow-up attaches it as a proposal -- and it is
//    only ever a proposal. Nothing here sends or writes anything.
//
// WHAT IS DELIBERATELY NOT HERE, and why:
//   * Fleet transitions, speeding, not-moving-when-it-should-be. `fleet_events`
//     is empty -- nothing records that a truck's status CHANGED, only what it is
//     now. Needs a status-change recorder first.
//   * Running late / early. Needs a routing ETA to compare against the window.
//   * Materials, extra-time and change-order requests from the mobile app.
//     The Field App asks these questions; where the answers land needs
//     confirming before a detector can claim to read them.
//   * Job-readiness. There is no readiness checklist to be incomplete.
//   * Timer overrun. `job_time_entries` holds 2 rows in all of production, so
//     "over the allotted timer" is measured against the SCHEDULED VISIT WINDOW
//     here, which is real for 4,738 visits. Same intent, honest source.

export const DOMAINS = ['job', 'money', 'schedule', 'client', 'sales', 'fleet', 'crew', 'message', 'compliance'];

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function ev(e) {
  return {
    severity: 'digest',
    actions: [],
    facts: {},
    detail: null,
    client_id: null, client_name: null,
    job_id: null, job_title: null,
    visit_id: null, vehicle_name: null, entity_url: null,
    ...e,
    domain: e.kind.split('.')[0],
  };
}

const money = (n) => {
  const v = Math.round(Number(n) || 0);
  return v >= 1000 ? `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}K` : `$${v}`;
};

const days = (ms) => Math.floor(ms / DAY);

// Jobber visit titles are routinely "Anna Maria DeSalva - HOME RENOVATION", so
// naming the client and then printing the title gives you the client twice.
// Seen on the first production sweep. Strips a leading client-name prefix so
// the sentence reads like something a person wrote.
export function jobLabel(title, clientName) {
  const t = String(title || "").trim();
  const c = String(clientName || "").trim();
  if (!t || !c) return t;
  const lead = t.slice(0, c.length).toLowerCase();
  if (lead !== c.toLowerCase()) return t;
  // A SEPARATOR has to follow the name, or this is not a prefix at all -- it is
  // a longer word that merely starts the same way. Without this, client "Smith"
  // turns "Smithfield Roofing" into "field Roofing".
  const tail = t.slice(c.length);
  const m = /^\s*[-–—:]\s*/.exec(tail);
  if (!m) return t;
  const rest = tail.slice(m[0].length).trim();
  return rest || t;
}

const nameOf = (c) => (c && (c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name)) || null;

// ---------------------------------------------------------------------------
// MONEY
// ---------------------------------------------------------------------------

// The one with a real price tag. A visit completed, the work is done, and no
// invoice exists against that job -- so the business has spent the labour and
// not asked for the money. Left alone this is how a job quietly never gets
// billed.
//
// Grace period on purpose: an invoice raised the same afternoon is normal, and
// alerting the moment a crew closes out would fire on every single job.
export function finishedNotInvoiced({ visits, invoices, clients, now, graceMs = 2 * DAY }) {
  const invoicedJobs = new Set((invoices || []).map((i) => i.job_id).filter(Boolean));
  const clientById = new Map((clients || []).map((c) => [c.jobber_id, c]));
  const out = [];
  const seenJobs = new Set();

  for (const v of visits || []) {
    if (!v.completed_at || !v.job_id) continue;
    if (invoicedJobs.has(v.job_id)) continue;
    if (seenJobs.has(v.job_id)) continue; // one event per job, not per visit
    const age = now - new Date(v.completed_at).getTime();
    if (!(age >= graceMs)) continue;
    seenJobs.add(v.job_id);

    const client = clientById.get(v.client_id);
    const d = days(age);
    out.push(ev({
      kind: 'money.finished_not_invoiced',
      // Stable while the job stays uninvoiced. Deliberately no date in it.
      dedupe_key: `money.finished_not_invoiced:${v.job_id}`,
      severity: 'interrupt',
      title: `${nameOf(client) || 'A client'} — ${jobLabel(v.title, nameOf(client)) || 'job'} finished, but no invoice was created`,
      detail: `Completed ${d} day${d === 1 ? '' : 's'} ago. Nothing has been billed for it.`,
      client_id: v.client_id, client_name: nameOf(client),
      job_id: v.job_id, job_title: v.title, visit_id: v.jobber_id,
      entity_url: v.jobber_web_uri || null,
      actions: [
        { action: 'create_invoice', label: 'Create the invoice now' },
        { action: 'snooze_7d', label: 'Not yet — remind me in a week' },
      ],
      facts: { completed_at: v.completed_at, days_since: d },
    }));
  }
  return out;
}

// An invoice that exists but was never sent is the same lost money as one that
// was never raised, and it is easier to miss because the job looks billed.
export function invoicedNotSent({ invoices, clients, now, graceMs = 1 * DAY }) {
  const clientById = new Map((clients || []).map((c) => [c.jobber_id, c]));
  const out = [];
  for (const inv of invoices || []) {
    const status = String(inv.invoice_status || '').toLowerCase();
    if (status !== 'draft') continue;
    const created = inv.jobber_created_at ? new Date(inv.jobber_created_at).getTime() : null;
    if (!created || now - created < graceMs) continue;
    const client = clientById.get(inv.client_id);
    const d = days(now - created);
    out.push(ev({
      kind: 'money.invoiced_not_sent',
      dedupe_key: `money.invoiced_not_sent:${inv.jobber_id}`,
      severity: 'interrupt',
      title: `Invoice ${inv.invoice_number ? `#${inv.invoice_number}` : ''} for ${nameOf(client) || 'a client'} is still a draft`,
      detail: `${money(inv.total)} raised ${d} day${d === 1 ? '' : 's'} ago and never sent.`,
      client_id: inv.client_id, client_name: nameOf(client),
      job_id: inv.job_id || null,
      entity_url: inv.jobber_web_uri || null,
      actions: [
        { action: 'send_invoice', label: 'Send it now' },
        { action: 'snooze_7d', label: 'Remind me in a week' },
      ],
      facts: { total: Number(inv.total) || 0, days_since: d },
    }));
  }
  return out;
}

// Booking work for somebody who already owes money. The point is to catch it
// BEFORE the crew rolls, which is why it keys on the upcoming visit.
export function appointmentWithDelinquentClient({ visits, clients, now, horizonMs = 3 * DAY, minBalance = 1 }) {
  const clientById = new Map((clients || []).map((c) => [c.jobber_id, c]));
  const out = [];
  for (const v of visits || []) {
    if (v.completed_at || !v.start_at) continue;
    const start = new Date(v.start_at).getTime();
    if (start < now || start - now > horizonMs) continue;
    const client = clientById.get(v.client_id);
    const balance = Number(client && client.balance) || 0;
    if (balance < minBalance) continue;
    out.push(ev({
      kind: 'money.appointment_with_delinquent_client',
      // Per visit: a different appointment for the same debtor is a new decision.
      dedupe_key: `money.appointment_with_delinquent_client:${v.jobber_id}`,
      severity: 'interrupt',
      title: `${nameOf(client)} owes ${money(balance)} and has work booked`,
      detail: `${v.title || 'A visit'} is scheduled for ${new Date(v.start_at).toISOString().slice(0, 10)}.`,
      client_id: v.client_id, client_name: nameOf(client),
      job_id: v.job_id, job_title: v.title, visit_id: v.jobber_id,
      actions: [
        { action: 'open_client', label: 'Open the client' },
        { action: 'collect_first', label: 'Ask for payment before the visit' },
        { action: 'dismiss', label: 'Go ahead anyway' },
      ],
      facts: { balance, start_at: v.start_at },
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// JOBS
// ---------------------------------------------------------------------------

// The crew is still on site well past the window. Measured against the
// SCHEDULED VISIT WINDOW rather than the job timer -- see the header note.
export function overScheduledWindow({ visits, clients, now, overrunMs = 90 * 60 * 1000 }) {
  const clientById = new Map((clients || []).map((c) => [c.jobber_id, c]));
  const out = [];
  for (const v of visits || []) {
    if (v.completed_at || !v.end_at || v.is_all_day) continue;
    const end = new Date(v.end_at).getTime();
    const over = now - end;
    if (over < overrunMs) continue;
    // Past a day it is not "running over", it is "never closed out" -- a
    // different fact with a different fix, caught by notStartedWindowClosed.
    if (over > 1 * DAY) continue;
    const client = clientById.get(v.client_id);
    const hrs = Math.floor(over / HOUR);
    out.push(ev({
      kind: 'job.over_scheduled_window',
      dedupe_key: `job.over_scheduled_window:${v.jobber_id}`,
      severity: 'interrupt',
      title: `${crewNames(v) || 'The crew'} is running over at ${nameOf(client) || 'a job'}`,
      detail: `${v.title || 'The visit'} was due to finish ${hrs >= 1 ? `${hrs}h` : 'under an hour'} ago and is not closed out.`,
      client_id: v.client_id, client_name: nameOf(client),
      job_id: v.job_id, job_title: v.title, visit_id: v.jobber_id,
      actions: [
        { action: 'chirp_lead', label: 'Chirp the lead for a status check' },
        { action: 'open_job', label: 'Open the job' },
      ],
      facts: { end_at: v.end_at, over_minutes: Math.round(over / 60000), crew: crewList(v) },
    }));
  }
  return out;
}

// The window opened and closed and nobody ever marked it done. Either it did not
// happen or it happened and was not recorded; both need a person.
export function notStartedWindowClosed({ visits, clients, now, graceMs = 1 * DAY }) {
  const clientById = new Map((clients || []).map((c) => [c.jobber_id, c]));
  const out = [];
  for (const v of visits || []) {
    if (v.completed_at || !v.end_at) continue;
    const over = now - new Date(v.end_at).getTime();
    if (over <= graceMs) continue;
    if (over > 30 * DAY) continue; // ancient history is a data-cleanup job, not an alert
    const client = clientById.get(v.client_id);
    const d = days(over);
    out.push(ev({
      kind: 'job.window_closed_not_completed',
      dedupe_key: `job.window_closed_not_completed:${v.jobber_id}`,
      severity: 'digest',
      title: `${jobLabel(v.title, nameOf(client)) || 'A visit'} for ${nameOf(client) || 'a client'} was never closed out`,
      detail: `Its window ended ${d} day${d === 1 ? '' : 's'} ago and it is still open.`,
      client_id: v.client_id, client_name: nameOf(client),
      job_id: v.job_id, job_title: v.title, visit_id: v.jobber_id,
      actions: [
        { action: 'open_job', label: 'Open the job' },
        { action: 'mark_complete', label: 'Mark it complete' },
        { action: 'reschedule', label: 'Reschedule it' },
      ],
      facts: { end_at: v.end_at, days_since: d },
    }));
  }
  return out;
}

// Work closed out with nothing to show for it. Photos are the evidence a job was
// done to standard, and the moment to notice they are missing is now, not when a
// client disputes it in three months.
export function finishedWithoutPhotos({ visits, mediaCountByJob, clients, now, graceMs = 4 * HOUR }) {
  const clientById = new Map((clients || []).map((c) => [c.jobber_id, c]));
  const counts = mediaCountByJob || {};
  const out = [];
  const seen = new Set();
  for (const v of visits || []) {
    if (!v.completed_at || !v.job_id || seen.has(v.job_id)) continue;
    const age = now - new Date(v.completed_at).getTime();
    if (age < graceMs || age > 14 * DAY) continue;
    if ((counts[v.job_id] || 0) > 0) continue;
    seen.add(v.job_id);
    const client = clientById.get(v.client_id);
    out.push(ev({
      kind: 'job.finished_without_photos',
      dedupe_key: `job.finished_without_photos:${v.job_id}`,
      severity: 'digest',
      title: `${jobLabel(v.title, nameOf(client)) || 'A job'} for ${nameOf(client) || 'a client'} was closed out with no photos`,
      detail: 'No photos are attached to this job at all.',
      client_id: v.client_id, client_name: nameOf(client),
      job_id: v.job_id, job_title: v.title, visit_id: v.jobber_id,
      actions: [
        { action: 'chirp_lead', label: 'Ask the crew for photos' },
        { action: 'dismiss', label: 'Not needed on this one' },
      ],
      facts: { completed_at: v.completed_at },
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLIENT FLAGS
// ---------------------------------------------------------------------------

// A client somebody deliberately marked as not-to-be-worked-for has an
// appointment on the calendar. This is the one that has to shout: the cost of
// missing it is a crew turning up somewhere they were told not to go.
export function noWorkClientBooked({ visits, clients, flags, now, horizonMs = 7 * DAY }) {
  const clientById = new Map((clients || []).map((c) => [c.jobber_id, c]));
  const flagged = new Map((flags || []).filter((f) => f.flag === 'no_work').map((f) => [f.client_id, f]));
  const out = [];
  for (const v of visits || []) {
    if (v.completed_at || !v.start_at) continue;
    const start = new Date(v.start_at).getTime();
    if (start < now || start - now > horizonMs) continue;
    const flag = flagged.get(v.client_id);
    if (!flag) continue;
    const client = clientById.get(v.client_id);
    out.push(ev({
      kind: 'client.no_work_client_booked',
      dedupe_key: `client.no_work_client_booked:${v.jobber_id}`,
      severity: 'interrupt',
      title: `${nameOf(client) || 'A client'} is flagged "no work" and has a visit booked`,
      detail: flag.reason ? `Reason on file: ${flag.reason}` : 'A "no work" flag is on this client record.',
      client_id: v.client_id, client_name: nameOf(client),
      job_id: v.job_id, job_title: v.title, visit_id: v.jobber_id,
      actions: [
        { action: 'cancel_visit', label: 'Cancel the visit' },
        { action: 'open_client', label: 'Open the client' },
        { action: 'clear_flag', label: 'Clear the flag — this is fine now' },
      ],
      facts: { reason: flag.reason || null, start_at: v.start_at },
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// SALES
// ---------------------------------------------------------------------------

// Won the work and never put it on the calendar. Money already agreed, sitting
// still.
export function approvedNotScheduled({ quotes, visitsByClient, now, graceMs = 2 * DAY }) {
  const scheduled = visitsByClient || {};
  const out = [];
  for (const q of quotes || []) {
    const status = String(q.quote_status || '').toLowerCase();
    if (!['approved', 'accepted', 'converted'].includes(status)) continue;
    const at = q.jobber_updated_at ? new Date(q.jobber_updated_at).getTime() : null;
    if (!at || now - at < graceMs) continue;
    if ((scheduled[q.client_id] || 0) > 0) continue;
    const d = days(now - at);
    out.push(ev({
      kind: 'sales.approved_not_scheduled',
      dedupe_key: `sales.approved_not_scheduled:${q.jobber_id}`,
      severity: 'interrupt',
      title: `${q.client_name || 'A client'} approved ${money(q.total)} of work that is not on the calendar`,
      detail: `Quote ${q.quote_number ? `#${q.quote_number}` : ''} approved ${d} day${d === 1 ? '' : 's'} ago with nothing scheduled.`,
      client_id: q.client_id, client_name: q.client_name || null,
      entity_url: q.jobber_web_uri || null,
      actions: [
        { action: 'schedule_work', label: 'Schedule it' },
        { action: 'snooze_7d', label: 'Remind me in a week' },
      ],
      facts: { total: Number(q.total) || 0, days_since: d },
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// SCHEDULE
// ---------------------------------------------------------------------------

// Tomorrow has work with nobody on it. Catch it tonight, not at 7am.
export function unassignedVisitSoon({ visits, clients, now, horizonMs = 36 * HOUR }) {
  const clientById = new Map((clients || []).map((c) => [c.jobber_id, c]));
  const out = [];
  for (const v of visits || []) {
    if (v.completed_at || !v.start_at) continue;
    const start = new Date(v.start_at).getTime();
    if (start < now || start - now > horizonMs) continue;
    if (crewList(v).length) continue;
    const client = clientById.get(v.client_id);
    out.push(ev({
      kind: 'schedule.unassigned_visit_soon',
      dedupe_key: `schedule.unassigned_visit_soon:${v.jobber_id}`,
      severity: 'interrupt',
      title: `${jobLabel(v.title, nameOf(client)) || 'A visit'} for ${nameOf(client) || 'a client'} has nobody assigned`,
      detail: `It starts ${new Date(v.start_at).toISOString().slice(0, 16).replace('T', ' ')} and has no crew.`,
      client_id: v.client_id, client_name: nameOf(client),
      job_id: v.job_id, job_title: v.title, visit_id: v.jobber_id,
      actions: [
        { action: 'assign_crew', label: 'Assign a crew' },
        { action: 'reschedule', label: 'Move it' },
      ],
      facts: { start_at: v.start_at },
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// FLEET (arrival / departure only -- see the header note on what is missing)
// ---------------------------------------------------------------------------

// A truck reached a job site. Informational by design: ten trucks arriving and
// leaving all day is dozens of events, and if these interrupt then the ones that
// matter get buried. Digest.
export function arrivedOnSite({ presence, clients, now, windowMs = 2 * HOUR }) {
  const clientById = new Map((clients || []).map((c) => [c.jobber_id, c]));
  const out = [];
  for (const p of presence || []) {
    if (!p.arrived_at) continue;
    if (now - new Date(p.arrived_at).getTime() > windowMs) continue;
    const client = clientById.get(p.client_id);
    out.push(ev({
      kind: 'fleet.arrived_on_site',
      // One arrival per presence interval, not per sweep.
      dedupe_key: `fleet.arrived_on_site:${p.id}`,
      severity: 'digest',
      title: `${p.vehicle_name || 'A truck'} arrived at ${nameOf(client) || p.job_title || 'a job'}`,
      detail: p.job_title || null,
      client_id: p.client_id || null, client_name: nameOf(client),
      job_id: p.job_id || null, job_title: p.job_title || null,
      vehicle_name: p.vehicle_name || null,
      actions: [{ action: 'open_job', label: 'Open the job' }],
      facts: { arrived_at: p.arrived_at },
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function crewList(visit) {
  let assigned = visit && visit.assigned_users;
  if (typeof assigned === 'string') {
    try { assigned = JSON.parse(assigned); } catch (e) { assigned = []; }
  }
  return (assigned || []).map((u) => u && u.name).filter(Boolean);
}

function crewNames(visit) {
  const names = crewList(visit);
  if (!names.length) return null;
  return names.length === 1 ? names[0] : `${names[0]} + ${names.length - 1}`;
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

// A mute silences a kind, optionally narrowed to one client, job or vehicle.
// The narrower rule and the blanket rule both apply; there is no precedence to
// get wrong because either one matching means silence.
export function isMuted(event, mutes) {
  for (const m of mutes || []) {
    if (m.kind !== event.kind) continue;
    if (m.client_id && m.client_id !== event.client_id) continue;
    if (m.job_id && m.job_id !== event.job_id) continue;
    if (m.vehicle_name && m.vehicle_name !== event.vehicle_name) continue;
    return true;
  }
  return false;
}

// Whether this event is allowed to interrupt right now.
//
// Quiet hours suppress the INTERRUPT, never the event -- it still lands in the
// feed and still shows in the morning. Losing an observation because it happened
// at 10pm is exactly the silence this system must not invent.
export function shouldInterrupt(event, { hourLocal, quietFrom = 20, quietTo = 6 } = {}) {
  if (event.severity !== 'interrupt') return false;
  if (hourLocal == null) return true;
  const quiet = quietFrom > quietTo
    ? (hourLocal >= quietFrom || hourLocal < quietTo)
    : (hourLocal >= quietFrom && hourLocal < quietTo);
  return !quiet;
}

// Everything a scheduled sweep produces, in one call, so the runner does not
// have to know the detector list.
export function runAll(data) {
  const now = data.now;
  const groups = [
    ['finishedNotInvoiced', () => finishedNotInvoiced(data)],
    ['invoicedNotSent', () => invoicedNotSent(data)],
    ['appointmentWithDelinquentClient', () => appointmentWithDelinquentClient(data)],
    ['overScheduledWindow', () => overScheduledWindow(data)],
    ['notStartedWindowClosed', () => notStartedWindowClosed(data)],
    ['finishedWithoutPhotos', () => finishedWithoutPhotos(data)],
    ['noWorkClientBooked', () => noWorkClientBooked(data)],
    ['approvedNotScheduled', () => approvedNotScheduled(data)],
    ['unassignedVisitSoon', () => unassignedVisitSoon(data)],
    ['arrivedOnSite', () => arrivedOnSite(data)],
  ];
  const results = [];
  for (const [name, fn] of groups) {
    // One detector throwing must not take the whole sweep down with it -- the
    // other nine still have something worth saying.
    try {
      results.push({ detector: name, events: fn() || [], error: null });
    } catch (e) {
      results.push({ detector: name, events: [], error: e.message });
    }
  }
  void now;
  return results;
}
