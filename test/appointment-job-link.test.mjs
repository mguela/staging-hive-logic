// test/appointment-job-link.test.mjs
// Phase 0, item 4 (2026-08-17) — scheduling a specific job.
//
// hl_appointments, the create/move/cancel actions and the crew board's
// rendering of native appointments all already existed and all already worked
// without touching Jobber. The one thing missing was the link: `job_no` was
// free text a dispatcher typed, so nothing connected a scheduled visit back to
// a job record. A typo produced a visit belonging to nothing — no project
// number on the board, and nothing for job costing to attribute the time to.
//
// What these tests pin:
//   - given a job, the JOB record is the authority for its own number, title
//     and division; the client never gets to send those
//   - a HiveLogic job shows as J-10001, a Jobber-synced one keeps its own
//     bare number
//   - appointments with no job still work (shop days, callbacks, estimates)
//   - a job that no longer exists is refused rather than half-linked
//
// Run with: node --experimental-test-module-mocks --test test/appointment-job-link.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

let jobRows = [];
let insertedAppointment = null;

// hl.js's own sb() wrapper reads responses with .text(), so the stub must speak
// that shape rather than .json().
function reply(rows) {
  return { ok: true, status: 200, text: async () => JSON.stringify(rows), json: async () => rows };
}

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path, opts = {}) => {
      if (path.startsWith('jobs?')) return reply(jobRows);
      if (path.startsWith('hl_appointments') && opts.method === 'POST') {
        insertedAppointment = JSON.parse(opts.body);
        return reply([{ id: 'appt-1', ...insertedAppointment }]);
      }
      if (path.startsWith('profiles')) return reply([{ id: 'u1', email: 'chris@ghgrp.net', role: 'admin' }]);
      return reply([]);
    },
    jobberGraphQL: async () => ({}),
  },
});

globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'u1', email: 'chris@ghgrp.net' }) });

const handler = (await import('../api/schedule/hl.js')).default;

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function createAppointment(appointment) {
  insertedAppointment = null;
  const r = res();
  await handler({
    method: 'POST',
    query: {},
    headers: { authorization: 'Bearer tok' },
    body: { action: 'create_appointment', appointment },
  }, r);
  return r;
}

const TIMES = { start_at: '2026-08-20T13:00:00Z', end_at: '2026-08-20T17:00:00Z' };

// --------------------------------------------------- linking to a job

test('scheduling a HiveLogic job stamps its project number on the appointment', async () => {
  jobRows = [{ jobber_id: 'HL-JOB-10001', project_seq: 10001, job_number: null, title: 'Kitchen remodel', client_id: 'c1', division_code: 'GH-DB' }];
  const r = await createAppointment({ ...TIMES, job_ref: 'HL-JOB-10001' });
  assert.equal(r.statusCode, 200);
  assert.equal(insertedAppointment.job_ref, 'HL-JOB-10001');
  assert.equal(insertedAppointment.job_no, 'J-10001');
});

test('scheduling a Jobber-synced job keeps that job\'s own number', async () => {
  // A synced job is called "2418" everywhere else, including in Jobber. Showing
  // it as J-2418 on the board would invent a number it does not have.
  jobRows = [{ jobber_id: 'Z2lkOi8vSm9iYmVy', project_seq: null, job_number: 2418, title: 'Deck repair', client_id: 'c2', division_code: null }];
  const r = await createAppointment({ ...TIMES, job_ref: 'Z2lkOi8vSm9iYmVy' });
  assert.equal(r.statusCode, 200);
  assert.equal(insertedAppointment.job_no, '2418');
  assert.equal(insertedAppointment.job_ref, 'Z2lkOi8vSm9iYmVy');
});

test('the job record is the authority for its number, not the caller', async () => {
  // The board sends what its dropdown displayed. If that ever disagrees with
  // the job record -- a stale page, a tampered request -- the record wins.
  jobRows = [{ jobber_id: 'HL-JOB-10001', project_seq: 10001, job_number: null, title: 'Kitchen remodel', client_id: 'c1', division_code: 'GH-DB' }];
  await createAppointment({ ...TIMES, job_ref: 'HL-JOB-10001', job_no: 'J-99999' });
  assert.equal(insertedAppointment.job_no, 'J-10001', 'the caller\'s number must be ignored');
});

test('title and division are taken from the job when not given', async () => {
  jobRows = [{ jobber_id: 'HL-JOB-10001', project_seq: 10001, job_number: null, title: 'Kitchen remodel', client_id: 'c1', division_code: 'GH-DB' }];
  await createAppointment({ ...TIMES, job_ref: 'HL-JOB-10001' });
  assert.equal(insertedAppointment.title, 'Kitchen remodel');
  assert.equal(insertedAppointment.division, 'GH-DB');
});

test('an explicit title still wins — a visit is not always the whole job', async () => {
  jobRows = [{ jobber_id: 'HL-JOB-10001', project_seq: 10001, job_number: null, title: 'Kitchen remodel', client_id: 'c1', division_code: 'GH-DB' }];
  await createAppointment({ ...TIMES, job_ref: 'HL-JOB-10001', title: 'Rough-in inspection' });
  assert.equal(insertedAppointment.title, 'Rough-in inspection');
});

// --------------------------------------------------- no job is still valid

test('an appointment with no job still works', async () => {
  // Shop days, callbacks and in-person estimates have no job, and always will.
  jobRows = [];
  const r = await createAppointment({ ...TIMES, kind: 'internal', title: 'Shop day' });
  assert.equal(r.statusCode, 200);
  assert.equal(insertedAppointment.job_ref, null);
  assert.equal(insertedAppointment.job_no, null);
  assert.equal(insertedAppointment.title, 'Shop day');
});

// --------------------------------------------------- guards

test('a job that no longer exists is refused, not half-linked', async () => {
  jobRows = [];
  const r = await createAppointment({ ...TIMES, job_ref: 'HL-JOB-99999' });
  assert.equal(r.statusCode, 404);
  assert.equal(r.body.ok, false);
  assert.equal(insertedAppointment, null, 'nothing may be written');
});

test('times are still required', async () => {
  jobRows = [];
  const r = await createAppointment({ job_ref: null });
  assert.equal(r.statusCode, 400);
  assert.equal(insertedAppointment, null);
});

test('nothing about scheduling reaches Jobber', async () => {
  // The whole point of hl_appointments: HiveLogic owns its own schedule.
  jobRows = [{ jobber_id: 'HL-JOB-10001', project_seq: 10001, job_number: null, title: 'Kitchen remodel', client_id: 'c1', division_code: 'GH-DB' }];
  await createAppointment({ ...TIMES, job_ref: 'HL-JOB-10001' });
  assert.ok(!('jobber_web_uri' in insertedAppointment), 'no Jobber identity is invented for a native appointment');
  assert.equal(insertedAppointment.status, 'scheduled');
});
