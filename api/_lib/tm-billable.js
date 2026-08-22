// api/_lib/tm-billable.js
// What the clock says a T&M job is worth.
//
// The field app records every leg of a day into job_time_entries -- travel,
// supplies runs, on-site work, lunch, breaks -- and the T&M invoice asked the
// tech to type the hours in by hand anyway. So the one number the customer is
// billed on was the one number nobody measured: a tech who tracked their time
// perfectly still had to remember what it added up to, and a typo became the
// invoice.
//
// This turns the entries into an hours figure, with the reasoning attached so a
// human can check it rather than trust it.
//
// BILLABLE, DELIBERATELY: travel, supplies and onsite. Lunch and break never,
// under any setting -- billing a customer for a lunch break is the kind of
// thing that ends a relationship, so it is not a policy flag, it is a rule.

const BILLABLE_KINDS = ['travel', 'supplies', 'onsite'];
const NEVER_BILLABLE = ['lunch', 'break'];

/** Hours between two instants, or null when the entry is still open. */
function entryHours(entry, now) {
  if (!entry || !entry.started_at) return null;
  const start = new Date(entry.started_at).getTime();
  if (!isFinite(start)) return null;
  if (!entry.ended_at) return null;              // still running -- see openEntries
  const end = new Date(entry.ended_at).getTime();
  if (!isFinite(end) || end <= start) return 0;
  return (end - start) / 3600000;
}

/**
 * Round to billing granularity. Quarter-hours by default, the trade norm.
 *
 * To NEAREST, not up: rounding up always favours the house, and a customer who
 * checks the arithmetic should find it fair.
 *
 * The one exception is real work that would round away to nothing -- six
 * minutes becoming a zero-hour invoice is the same silent-drop failure this
 * file exists to remove, so any billable time at all bills at least one
 * increment.
 */
export function roundHours(hours, granularity = 0.25) {
  if (!(hours > 0)) return 0;
  if (!(granularity > 0)) return Math.round(hours * 100) / 100;
  const rounded = Math.round(hours / granularity) * granularity;
  return rounded > 0 ? rounded : granularity;
}

/**
 * Total a job's time entries.
 *
 * Returns the billable figure AND everything needed to argue with it: the
 * per-kind breakdown, what was excluded, and anything still running. An open
 * entry is NOT counted as zero and quietly dropped -- someone is still on the
 * clock, and an invoice raised now will be short. It is reported so the person
 * raising the invoice can decide.
 */
export function summarizeBillable(entries, { now = Date.now(), granularity = 0.25 } = {}) {
  const rows = Array.isArray(entries) ? entries : [];
  const byKind = {};
  const openEntries = [];
  let billableRaw = 0;
  let excludedRaw = 0;

  for (const e of rows) {
    const kind = String(e.kind || 'onsite');
    if (!e.ended_at) {
      openEntries.push({
        id: e.id || null,
        kind,
        tech: e.tech_name || null,
        startedAt: e.started_at || null,
      });
      continue;
    }
    const h = entryHours(e, now);
    if (h == null) continue;
    byKind[kind] = Math.round(((byKind[kind] || 0) + h) * 100) / 100;
    if (NEVER_BILLABLE.includes(kind)) excludedRaw += h;
    else if (BILLABLE_KINDS.includes(kind)) billableRaw += h;
    // An unrecognised kind counts as neither, and shows up in byKind so it is
    // visible rather than silently folded into the bill.
  }

  return {
    hours: roundHours(billableRaw, granularity),
    rawHours: Math.round(billableRaw * 100) / 100,
    excludedHours: Math.round(excludedRaw * 100) / 100,
    byKind,
    billableKinds: BILLABLE_KINDS,
    openEntries,
    entryCount: rows.length,
  };
}

/**
 * Why a computed figure should not simply be trusted. Returns a list of plain
 * sentences, empty when there is nothing to say.
 */
export function billingWarnings(summary) {
  const out = [];
  if (!summary) return out;
  if (summary.entryCount === 0) {
    out.push('No time was recorded against this job, so there are no hours to bill from the clock.');
  }
  if (summary.openEntries.length) {
    const who = summary.openEntries.map((o) => o.tech || o.kind).join(', ');
    out.push(
      `${summary.openEntries.length} time ${summary.openEntries.length === 1 ? 'entry is' : 'entries are'} `
      + `still running (${who}) and are not included -- the total will be short if you invoice now.`,
    );
  }
  if (summary.entryCount > 0 && summary.hours === 0 && !summary.openEntries.length) {
    out.push('Every recorded entry was lunch or break, so nothing here is billable.');
  }
  return out;
}
