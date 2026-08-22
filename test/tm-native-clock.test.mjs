// A job scheduled and worked on the native board used to invoice for zero hours.
//
// There are two clocks. The field app writes job_time_entries, which is what a
// T&M invoice reads. The schedule board writes hl_clock, keyed to an
// hl_appointment rather than to a job. Nothing joined them.
//
// So the whole native path -- create_appointment, clock the chained crew in,
// clock out, raise the invoice -- ended at a 400: "No billable time is recorded
// against this job yet." The hours existed. They were in the other table.
//
// Verified against production on 2026-08-21: hl_clock 0 rows,
// job_time_entries 2 rows (both junk -- job_ref '__qa_test__' and null), and
// the single T&M-flagged job HL-JOB-10000 at $225/h is itself a NATIVE job.
// So the one job set up to be billed this way was the one the invoice could
// not see hours for.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  summarizeBillable, hlClockToEntries, nativeClockWarnings,
} from '../api/_lib/tm-billable.js';
import { billableEntriesForJob } from '../api/fieldops.js';

const at = (h) => new Date(Date.UTC(2026, 7, 20, h, 0, 0)).toISOString();

/** A fake `sb` that answers by path prefix and records what was asked. */
function fakeSb(routes) {
  const asked = [];
  const fn = async (path) => {
    asked.push(path);
    for (const [prefix, answer] of Object.entries(routes)) {
      if (path.startsWith(prefix)) {
        if (answer instanceof Error) throw answer;
        return answer;
      }
    }
    return [];
  };
  fn.asked = asked;
  return fn;
}

// --- the adapter -------------------------------------------------------------

test('an hl_clock row becomes an entry the biller understands', () => {
  const [e] = hlClockToEntries([{
    id: 'c1', employee_jid: 'jid-7', target_id: 'appt-1',
    clock_in: at(9), clock_out: at(12), label: null,
  }], { apptTitleById: { 'appt-1': 'Deck repair' } });

  assert.equal(e.kind, 'onsite', 'the native clock records only that the crew was on the job');
  assert.equal(e.started_at, at(9));
  assert.equal(e.ended_at, at(12));
  assert.equal(e.source, 'hl_clock', 'provenance must survive so a total can be broken down');
  assert.equal(e.tech_name, 'jid-7');
  assert.equal(e.label, 'Deck repair', 'falls back to the appointment title when unlabelled');
});

test('an open native shift is reported, not counted as zero', () => {
  const entries = hlClockToEntries([{ id: 'c1', employee_jid: 'j', clock_in: at(9), clock_out: null }]);
  const s = summarizeBillable(entries);
  assert.equal(s.hours, 0);
  assert.equal(s.openEntries.length, 1,
    'someone still on the clock must surface, or the invoice is silently short');
});

test('native clock time is actually billable once closed', () => {
  const s = summarizeBillable(hlClockToEntries([
    { id: 'c1', employee_jid: 'a', clock_in: at(9), clock_out: at(12) },
    { id: 'c2', employee_jid: 'b', clock_in: at(9), clock_out: at(12) },
  ]));
  // Two people, three hours each. Payroll pays people, so does the customer.
  assert.equal(s.hours, 6);
});

// --- the honesty requirement -------------------------------------------------

test('billing native-clock time says out loud that it cannot see breaks', () => {
  const entries = hlClockToEntries([{ id: 'c1', employee_jid: 'a', clock_in: at(9), clock_out: at(17) }]);
  const w = nativeClockWarnings(entries);
  assert.equal(w.length, 1);
  assert.match(w[0], /no lunch or break kind/i,
    'hl_clock has no kind column -- an unclocked break bills as worked time and the '
    + 'person sending the invoice has to be told');
  assert.match(w[0], /schedule board/i, 'it must say WHICH clock, or the warning is unactionable');
});

test('a job worked entirely in the field app gets no extra noise', () => {
  const fieldOnly = [{ id: 'e1', kind: 'onsite', started_at: at(9), ended_at: at(12) }];
  assert.deepEqual(nativeClockWarnings(fieldOnly), [],
    'the warning is about hl_clock specifically; it must not fire on every invoice');
});

test('lunch recorded in the FIELD app is still never billable', () => {
  // The native clock cannot express lunch. That must not weaken the rule where
  // the field app can.
  const s = summarizeBillable([
    { id: 'e1', kind: 'onsite', started_at: at(9), ended_at: at(12) },
    { id: 'e2', kind: 'lunch', started_at: at(12), ended_at: at(13) },
    ...hlClockToEntries([{ id: 'c1', employee_jid: 'a', clock_in: at(13), clock_out: at(15) }]),
  ]);
  assert.equal(s.hours, 5, '3h field + 2h board; the lunch hour is excluded');
  assert.equal(s.excludedHours, 1);
});

// --- the join ----------------------------------------------------------------

test('the invoice now reads BOTH clocks for one job', async () => {
  const sb = fakeSb({
    'job_time_entries': [{ id: 'e1', kind: 'travel', started_at: at(8), ended_at: at(9) }],
    'hl_appointments': [{ id: 'appt-1', title: 'Deck repair' }],
    'hl_clock': [{ id: 'c1', employee_jid: 'a', target_id: 'appt-1', clock_in: at(9), clock_out: at(12) }],
  });
  const entries = await billableEntriesForJob(sb, 'HL-JOB-10000');
  assert.equal(entries.length, 2, 'one entry from each clock');
  assert.equal(summarizeBillable(entries).hours, 4, '1h travel + 3h on the board clock');

  // It must scope the board clock to THIS job's appointments, not read every
  // hl_clock row in the table.
  const clockQuery = sb.asked.find((p) => p.startsWith('hl_clock'));
  assert.match(clockQuery, /target_id=in\.\("appt-1"\)/,
    'the board clock must be filtered to this job\'s appointments');
  assert.match(clockQuery, /target_kind=eq\.hl_appointment/,
    'jobber_visit rows belong to the other path and must not be swept in');
});

test('a cancelled appointment contributes no hours', async () => {
  const sb = fakeSb({ 'job_time_entries': [], 'hl_appointments': [], 'hl_clock': [] });
  await billableEntriesForJob(sb, 'HL-JOB-10000');
  const apptQuery = sb.asked.find((p) => p.startsWith('hl_appointments'));
  assert.match(apptQuery, /canceled=eq\.false/,
    'a cancelled appointment is not work; its clock rows must not reach the bill');
});

test('a board-clock outage still bills what the field app recorded', async () => {
  // Best-effort by design. The native side is an addition; it must never take
  // away an invoice that was already raisable.
  const sb = fakeSb({
    'job_time_entries': [{ id: 'e1', kind: 'onsite', started_at: at(9), ended_at: at(12) }],
    'hl_appointments': new Error('Supabase error on hl_appointments: 500'),
  });
  const entries = await billableEntriesForJob(sb, 'HL-JOB-10000');
  assert.equal(entries.length, 1);
  assert.equal(summarizeBillable(entries).hours, 3);
});

test('entries from both clocks come back in time order', async () => {
  const sb = fakeSb({
    'job_time_entries': [{ id: 'e1', kind: 'onsite', started_at: at(14), ended_at: at(16) }],
    'hl_appointments': [{ id: 'appt-1', title: null }],
    'hl_clock': [{ id: 'c1', employee_jid: 'a', target_id: 'appt-1', clock_in: at(8), clock_out: at(10) }],
  });
  const entries = await billableEntriesForJob(sb, 'J');
  assert.deepEqual(entries.map((e) => e.started_at), [at(8), at(14)],
    'a receipt a human reads has to run down the day in order');
});

// --- the thing that made this bug possible -----------------------------------

test('the preview and the invoice read through the same function', () => {
  // They used to each build their own query. Two queries that must agree and
  // are maintained separately eventually stop agreeing, and the number the
  // customer is billed is the one nobody previewed.
  const src = fs.readFileSync(new URL('../api/fieldops.js', import.meta.url), 'utf8');
  const prefill = src.slice(src.indexOf("action === 'tm_invoice_prefill'"), src.indexOf("action === 'tm_invoice_create'"));
  const create = src.slice(src.indexOf("action === 'tm_invoice_create'"));
  assert.match(prefill, /billableEntriesForJob\(sb, jobRef\)/, 'the preview must use the shared reader');
  assert.match(create.slice(0, 4000), /billableEntriesForJob\(sb, jobRef\)/, 'so must the invoice');
  assert.doesNotMatch(prefill, /job_time_entries\?job_ref=/,
    'no hand-rolled second copy of the query');
});
