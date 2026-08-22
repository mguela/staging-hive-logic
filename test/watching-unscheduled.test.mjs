// test/watching-unscheduled.test.mjs
// The Command Center "Watching" panel's unscheduled-work count.
//
// This resource used to filter on job_status = 'unscheduled', which is a strict
// SUBSET of the work it is meant to surface: on 2026-08-18, 7 of the 83 open
// jobs carried that status but 16 had no start date at all. The other 9 --
// 'action_required' jobs and HiveLogic-native 'active' jobs created without a
// date -- were on nobody's calendar and in nobody's count.
//
// The filter is the whole feature here, so it is pinned.
// Fully mocked -- no network, no DB, no real secret.
// Run with: node --experimental-test-module-mocks --test test/watching-unscheduled.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

let jobsFixture = [];
let clientsFixture = [];
let jobsPath = null;

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path) => {
      const p = String(path);
      if (p.startsWith('jobs')) { jobsPath = p; return { ok: true, json: async () => jobsFixture, text: async () => '' }; }
      if (p.startsWith('clients')) return { ok: true, json: async () => clientsFixture, text: async () => '' };
      return { ok: true, json: async () => [], text: async () => '' };
    },
    jobberGraphQL: async () => ({}),
  },
});

// This resource sits behind the shared API auth gate, which verifies the bearer
// token against Supabase auth with a bare fetch(). Same stub as
// job-line-items.test.mjs / crew-chaining.test.mjs.
global.fetch = async (url) => {
  if (String(url).includes('/auth/v1/user')) {
    return { ok: true, json: async () => ({ id: 'user-1', email: 'chris@ghgrp.net' }) };
  }
  throw new Error('unexpected fetch in test: ' + url);
};

const trackMod = await import('../api/track1.js');

function res() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function call() {
  const r = res();
  await trackMod.default({ method: 'GET', query: { resource: 'watching_unscheduled' }, headers: { authorization: 'Bearer t' } }, r);
  return r;
}

test('counts by "no start date", not by the unscheduled status', async () => {
  jobsFixture = [];
  clientsFixture = [];
  jobsPath = null;
  await call();

  assert.match(jobsPath, /start_at=is\.null/, 'must select on having no start date');
  assert.match(jobsPath, /job_status=neq\.archived/, 'archived jobs are not open work');
  assert.doesNotMatch(
    jobsPath,
    /job_status=eq\.unscheduled/,
    "must NOT narrow to Jobber's 'unscheduled' status -- that hid action_required and native active jobs"
  );
});

test('a finished job is not work waiting to be booked', async () => {
  jobsFixture = [];
  jobsPath = null;
  await call();
  assert.match(jobsPath, /completed_at=is\.null/);
});

test('reports the real mix of statuses rather than implying one', async () => {
  // The exact shape that motivated widening the filter.
  jobsFixture = [
    { jobber_id: 'J1', job_number: 1, title: 'A', total: 100, client_id: 'C1', job_status: 'unscheduled', jobber_created_at: '2026-08-01T00:00:00Z' },
    { jobber_id: 'J2', job_number: 2, title: 'B', total: 200, client_id: 'C1', job_status: 'action_required', jobber_created_at: '2026-08-02T00:00:00Z' },
    { jobber_id: 'J3', job_number: 3, title: 'C', total: 300, client_id: null, job_status: 'active', jobber_created_at: '2026-08-03T00:00:00Z' },
    { jobber_id: 'J4', job_number: 4, title: 'D', total: 400, client_id: 'C1', job_status: 'action_required', jobber_created_at: '2026-08-04T00:00:00Z' },
  ];
  clientsFixture = [{ jobber_id: 'C1', name: 'Jane Doe' }];

  const r = await call();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  // All four count -- under the old filter only J1 would have.
  assert.equal(r.body.count, 4);
  assert.deepEqual(r.body.byStatus, { unscheduled: 1, action_required: 2, active: 1 });
  assert.equal(r.body.jobs[0].status, 'unscheduled');
  assert.equal(r.body.jobs[0].clientName, 'Jane Doe');
  assert.equal(r.body.jobs[2].clientName, null, 'a job with no client resolves to null, not a crash');
  // The note must not claim this is Jobber's unscheduled status.
  assert.doesNotMatch(r.body.note, /^Jobber's unscheduled job status/);
});

test('no unbooked work reports a real zero, not an error', async () => {
  jobsFixture = [];
  clientsFixture = [];
  const r = await call();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.count, 0);
  assert.deepEqual(r.body.jobs, []);
  assert.deepEqual(r.body.byStatus, {});
});
