// test/timesheets.test.mjs
// jomell, 2026-08-26: "lets start with the timesheet. the screenshot is
// from jobber and we will copy it into our own... in the timesheets the
// user can click on their name and a table would appear and once clicked
// on an empty date, a window will popup its the 'create timesheet entry'."
//
// time_sheet_entries is a Jobber-synced table (api/jobber/sync-extended.js)
// with no notes/label column -- HiveLogic-created rows use their own
// HL-TSE-<uuid> id namespace (same convention as HL-INV-/HL-JOB-/HL-CO-)
// so the Jobber sync never touches or collides with one, and a new `note`
// column (20260826200000 migration) carries the Notes field Jobber's own
// sync never populates.
//
// Run with: node --experimental-test-module-mocks --test test/timesheets.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readSource = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8').replace(/\r\n/g, '\n');
const HTML = readSource('public', 'index.html');
const TRACK1_SRC = readSource('api', 'track1.js');

function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  if (start === -1) throw new Error('not found: ' + decl);
  let depth = 1, i = start + decl.length;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

let entriesFixture = [];
let jobsFixture = [];
let calls = [];
let insertedEntry = null;
let insertFails = null;

const { mock } = await import('node:test');

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path, opts = {}) => {
      const method = opts.method || 'GET';
      const p = String(path);
      calls.push({ method, path: p });

      if (p.startsWith('time_sheet_entries')) {
        if (method === 'POST') {
          if (insertFails) return { ok: false, text: async () => insertFails };
          insertedEntry = JSON.parse(opts.body);
          return { ok: true, json: async () => [{ ...insertedEntry }], text: async () => '' };
        }
        return { ok: true, json: async () => entriesFixture, text: async () => '' };
      }
      if (p.startsWith('jobs')) return { ok: true, json: async () => jobsFixture, text: async () => '' };
      return { ok: true, json: async () => [], text: async () => '' };
    },
    jobberGraphQL: async () => ({}),
  },
});

global.fetch = async (url) => {
  if (String(url).includes('/auth/v1/user')) {
    return { ok: true, json: async () => ({ id: 'user-1', email: 'chris@ghgrp.net' }) };
  }
  throw new Error('unexpected fetch in test: ' + url);
};

const trackMod = await import('../api/track1.js');

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function reset() {
  entriesFixture = [];
  jobsFixture = [];
  calls = [];
  insertedEntry = null;
  insertFails = null;
}

// ---------------------------------------------------------- timesheet_week

test('timesheet_week requires both startAt and endAt', async () => {
  reset();
  const r = res();
  await trackMod.default(
    { method: 'GET', query: { resource: 'timesheet_week', startAt: '2026-08-24T04:00:00.000Z' }, headers: { authorization: 'Bearer t' } },
    r
  );
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.ok, false);
});

test('timesheet_week filters entries by start_at within the given range', async () => {
  reset();
  const r = res();
  await trackMod.default(
    {
      method: 'GET',
      query: { resource: 'timesheet_week', startAt: '2026-08-24T04:00:00.000Z', endAt: '2026-08-31T04:00:00.000Z' },
      headers: { authorization: 'Bearer t' },
    },
    r
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const call = calls.find((c) => c.path.startsWith('time_sheet_entries') && c.method === 'GET');
  assert.match(call.path, /start_at=gte\.2026-08-24T04%3A00%3A00\.000Z/);
  assert.match(call.path, /start_at=lt\.2026-08-31T04%3A00%3A00\.000Z/);
});

test('an entry with no job resolves to "General"; an entry with a job gets the real title', async () => {
  reset();
  entriesFixture = [
    { jobber_id: 'HL-TSE-1', start_at: '2026-08-24T13:00:00.000Z', end_at: '2026-08-24T21:30:00.000Z', final_duration: 30600, user_id: 'u-1', job_id: null, note: null },
    { jobber_id: 'HL-TSE-2', start_at: '2026-08-25T13:00:00.000Z', end_at: '2026-08-25T21:00:00.000Z', final_duration: 28800, user_id: 'u-1', job_id: 'HL-JOB-10001', note: 'Framing' },
  ];
  jobsFixture = [{ jobber_id: 'HL-JOB-10001', title: 'Kitchen remodel' }];
  const r = res();
  await trackMod.default(
    { method: 'GET', query: { resource: 'timesheet_week', startAt: '2026-08-24T04:00:00.000Z', endAt: '2026-08-31T04:00:00.000Z' }, headers: { authorization: 'Bearer t' } },
    r
  );
  assert.equal(r.body.entries.length, 2);
  assert.equal(r.body.entries[0].jobLabel, 'General');
  assert.equal(r.body.entries[1].jobLabel, 'Kitchen remodel');
  assert.equal(r.body.entries[1].note, 'Framing');
});

test('the job title lookup only queries the jobs actually referenced this week', async () => {
  reset();
  entriesFixture = [{ jobber_id: 'HL-TSE-1', start_at: '2026-08-24T13:00:00.000Z', end_at: '2026-08-24T21:00:00.000Z', final_duration: 28800, user_id: 'u-1', job_id: 'HL-JOB-10001', note: null }];
  jobsFixture = [{ jobber_id: 'HL-JOB-10001', title: 'Kitchen remodel' }];
  const r = res();
  await trackMod.default(
    { method: 'GET', query: { resource: 'timesheet_week', startAt: '2026-08-24T04:00:00.000Z', endAt: '2026-08-31T04:00:00.000Z' }, headers: { authorization: 'Bearer t' } },
    r
  );
  const jobCall = calls.find((c) => c.path.startsWith('jobs'));
  assert.ok(jobCall, 'expected a jobs lookup');
  assert.match(jobCall.path, /jobber_id=in\.\(HL-JOB-10001\)/);
});

test('duration is derived from start/end when final_duration is missing or zero', async () => {
  reset();
  entriesFixture = [{ jobber_id: 'HL-TSE-1', start_at: '2026-08-24T13:00:00.000Z', end_at: '2026-08-24T21:00:00.000Z', final_duration: null, user_id: 'u-1', job_id: null, note: null }];
  const r = res();
  await trackMod.default(
    { method: 'GET', query: { resource: 'timesheet_week', startAt: '2026-08-24T04:00:00.000Z', endAt: '2026-08-31T04:00:00.000Z' }, headers: { authorization: 'Bearer t' } },
    r
  );
  assert.equal(r.body.entries[0].durationSeconds, 8 * 3600);
});

// ------------------------------------------------------ create_timesheet_entry

test('creating an entry requires an employee, a start, and an end', async () => {
  reset();
  const r = res();
  await trackMod.default(
    { method: 'POST', query: { resource: 'create_timesheet_entry' }, headers: { authorization: 'Bearer t' }, body: { startAt: '2026-08-26T13:00:00.000Z', endAt: '2026-08-26T21:00:00.000Z' } },
    r
  );
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /employee/i);
  assert.equal(insertedEntry, null);
});

test('end time must be after start time', async () => {
  reset();
  const r = res();
  await trackMod.default(
    {
      method: 'POST', query: { resource: 'create_timesheet_entry' }, headers: { authorization: 'Bearer t' },
      body: { userId: 'u-1', startAt: '2026-08-26T21:00:00.000Z', endAt: '2026-08-26T13:00:00.000Z' },
    },
    r
  );
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /after start/i);
  assert.equal(insertedEntry, null);
});

test('a General entry (no job) is created with a null job_id and job_uuid', async () => {
  reset();
  const r = res();
  await trackMod.default(
    {
      method: 'POST', query: { resource: 'create_timesheet_entry' }, headers: { authorization: 'Bearer t' },
      body: { userId: 'u-1', startAt: '2026-08-26T13:00:00.000Z', endAt: '2026-08-26T21:30:00.000Z', note: 'Shop cleanup' },
    },
    r
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.match(insertedEntry.jobber_id, /^HL-TSE-/);
  assert.equal(insertedEntry.job_id, null);
  assert.equal(insertedEntry.job_uuid, null);
  assert.equal(insertedEntry.user_id, 'u-1');
  assert.equal(insertedEntry.note, 'Shop cleanup');
  assert.equal(insertedEntry.final_duration, 8.5 * 3600, 'duration must be derived from the real time range, not trusted from the client');
});

test('a job-linked entry resolves and stores the real job_uuid', async () => {
  reset();
  jobsFixture = [{ jobber_id: 'HL-JOB-10001', uuid_id: 'job-uuid-1', title: 'Kitchen remodel' }];
  const r = res();
  await trackMod.default(
    {
      method: 'POST', query: { resource: 'create_timesheet_entry' }, headers: { authorization: 'Bearer t' },
      body: { userId: 'u-1', jobId: 'HL-JOB-10001', startAt: '2026-08-26T13:00:00.000Z', endAt: '2026-08-26T21:00:00.000Z' },
    },
    r
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(insertedEntry.job_id, 'HL-JOB-10001');
  assert.equal(insertedEntry.job_uuid, 'job-uuid-1');
  assert.equal(r.body.entry.jobLabel, 'Kitchen remodel');
});

test('an unknown job id still creates the entry, just without a resolved job_uuid', async () => {
  reset();
  jobsFixture = [];
  const r = res();
  await trackMod.default(
    {
      method: 'POST', query: { resource: 'create_timesheet_entry' }, headers: { authorization: 'Bearer t' },
      body: { userId: 'u-1', jobId: 'HL-JOB-nope', startAt: '2026-08-26T13:00:00.000Z', endAt: '2026-08-26T21:00:00.000Z' },
    },
    r
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(insertedEntry.job_id, 'HL-JOB-nope');
  assert.equal(insertedEntry.job_uuid, null);
});

test('an insert failure is surfaced, not swallowed', async () => {
  reset();
  insertFails = 'db is down';
  const r = res();
  await trackMod.default(
    {
      method: 'POST', query: { resource: 'create_timesheet_entry' }, headers: { authorization: 'Bearer t' },
      body: { userId: 'u-1', startAt: '2026-08-26T13:00:00.000Z', endAt: '2026-08-26T21:00:00.000Z' },
    },
    r
  );
  assert.equal(r.statusCode, 500);
  assert.match(r.body.error, /db is down/);
});

test('the route stays POST-only', async () => {
  reset();
  const r = res();
  await trackMod.default({ method: 'GET', query: { resource: 'create_timesheet_entry' }, headers: { authorization: 'Bearer t' }, body: {} }, r);
  assert.equal(r.statusCode, 405);
});

// ---------------------------------------------------------------- dispatch

test('both resources are actually wired into the dispatch table', () => {
  assert.match(TRACK1_SRC, /resource === 'timesheet_week'/);
  assert.match(TRACK1_SRC, /handleTimesheetWeek\(req, res\)/);
  assert.match(TRACK1_SRC, /resource === 'create_timesheet_entry'/);
  assert.match(TRACK1_SRC, /handleCreateTimesheetEntry\(req, res\)/);
});

// --------------------------------------------------------------- frontend
// jomell: "lets put it in 'time & timesheets' tab. for now lets not add
// the 'approve timesheets' and 'confirm payroll' tab."

test('the Timesheets card lives inside the Time & Timesheets (ttx) view, not a new one', () => {
  const wfStart = HTML.indexOf('<div id="workforce">');
  const tsCard = HTML.indexOf('id="ts-card"', wfStart);
  const wfEnd = HTML.indexOf('\n</div>\n\n<div id="view-gpux"', wfStart);
  assert.ok(wfStart > -1 && tsCard > wfStart, 'the Timesheets card should be inside #workforce');
  assert.ok(wfEnd > tsCard, 'the Timesheets card should close before #workforce does');
});

test('Approve timesheets and Confirm payroll are not built yet, on purpose', () => {
  assert.doesNotMatch(HTML, /Approve timesheets/);
  assert.doesNotMatch(HTML, /Confirm payroll/);
});

test('the Timesheets card is hidden by default and only workforceRefresh can reveal it, to owners only', () => {
  assert.match(HTML, /<div class="card" id="ts-card" style="margin-bottom:16px;display:none">/);
  const fn = extractFunction(HTML, 'async function workforceRefresh(){');
  assert.match(fn, /tsCard\.style\.display = isOwner \? 'block' : 'none';/);
  assert.match(fn, /if \(isOwner && typeof window\.tsLoad === 'function'\) window\.tsLoad\(\);/);
});

test('clicking an empty date cell opens the create modal; a filled cell just shows the value', () => {
  const fn = extractFunction(HTML, 'function tsRender() {');
  assert.match(fn, /onclick="event\.stopPropagation\(\);tsOpenCreateModal\(/);
  // A filled day renders a plain, non-interactive box -- only the empty
  // ones are click targets, matching "once clicked on an empty date."
  const filledCellIdx = fn.indexOf('if (dayEntries.length) {');
  const filledCellBlock = fn.slice(filledCellIdx, fn.indexOf('} else {', filledCellIdx));
  assert.doesNotMatch(filledCellBlock, /onclick/);
});

test('week/day totals are derived from the per-day buckets actually shown, not a raw sum over every entry the user has', () => {
  // 2026-08-26 fix: switching weeks left stale totals on screen because the
  // row/category total was summed straight from `mine`/`cat.entries`
  // (every entry for that user, not just the ones in the visible week).
  const fn = extractFunction(HTML, 'function tsRender() {');
  assert.match(fn, /var weekTotal = perDay\.reduce\(function \(s, v\) \{ return s \+ v; \}, 0\);/);
  assert.doesNotMatch(fn, /var weekTotal = mine\.reduce/);
  assert.match(fn, /catTotal \+= secs;/);
  assert.doesNotMatch(fn, /var catTotal = cat\.entries\.reduce/);
});

test('no onclick argument is built with JSON.stringify -- it would break the surrounding double-quoted attribute', () => {
  // JSON.stringify("abc") is the 5-character string "abc" (quote chars
  // included) -- concatenated into onclick="fn(...)" it closes the
  // attribute early. tsJsArg is the fix; this pins that nothing in the
  // Timesheets block regressed back to the broken pattern.
  const start = HTML.indexOf("// ---- Timesheets (2026-08-26, jomell) ----");
  const end = HTML.indexOf('</script>', start);
  assert.ok(start > -1 && end > start, 'the Timesheets script block should still be findable');
  const block = HTML.slice(start, end);
  assert.doesNotMatch(block, /onclick="[^"]*JSON\.stringify/);
});

test('tsJsArg quotes a real value and passes bare null through, never a quoted "null" string', () => {
  const fn = extractFunction(HTML, 'function tsJsArg(v) {');
  assert.match(fn, /v === null \|\| v === undefined \? 'null'/);
});

test('duration on the create popup is derived from the time range, never trusted as free-typed hours/minutes', () => {
  const fn = extractFunction(HTML, 'function tsRecalcDuration() {');
  assert.match(fn, /parseInt\(e\[0\], 10\) \* 60 \+ parseInt\(e\[1\], 10\)/);
  const submitFn = extractFunction(HTML, 'function tsOpenCreateModal(userId, jobId, ymd) {');
  assert.match(submitFn, /hlApiPost\('create_timesheet_entry', \{ userId: emp, jobId: jid, startAt: startAt\.toISOString\(\), endAt: endAt\.toISOString\(\), note: notes \}\)/);
});

test('the migration backing the Notes field exists and is replay-safe', () => {
  const migPath = path.join(__dirname, '..', 'supabase', 'migrations', '20260826200000_time_sheet_entries_note.sql');
  assert.ok(fs.existsSync(migPath), 'expected the time_sheet_entries.note migration to exist');
  const sql = fs.readFileSync(migPath, 'utf-8');
  assert.match(sql, /alter table public\.time_sheet_entries add column if not exists note text;/);
});
