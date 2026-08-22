// test/capacity-planning.test.mjs
// Capacity Planning, Phase 1 (2026-08-11) -- the page was 100% hardcoded
// mock (confirmed via investigation, zero fetch() calls anywhere in it).
// This covers the two new real resources: capacity_crew_hours (real
// scheduled hours per technician from the visits table, no fabricated
// "% of capacity" since no such setting exists anywhere) and
// capacity_backlog_by_month (real signed-job totals bucketed by start
// month). Fully mocked -- no network, no DB, no real secret.
// Run with: node --experimental-test-module-mocks --test test/capacity-planning.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

let visitsFixture = [];
let jobsFixture = [];
let lastJobsPath = null;

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path) => {
      if (String(path).startsWith('visits')) return { ok: true, json: async () => visitsFixture };
      if (String(path).startsWith('jobs')) { lastJobsPath = String(path); return { ok: true, json: async () => jobsFixture }; }
      return { ok: true, json: async () => [] };
    },
    jobberGraphQL: async () => ({}),
  },
});

const trackMod = await import('../api/track1.js');

function res() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function callResource(resource, extraQuery) {
  const req = {
    method: 'GET',
    query: Object.assign({ resource }, extraQuery || {}),
    headers: { authorization: 'Bearer test-cron-secret' },
  };
  const r = res();
  await trackMod.default(req, r);
  return r;
}

function iso(daysFromNow, hour) {
  const d = new Date(Date.now() + daysFromNow * 86400000);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

// ---------------------------------------------------- capacity_crew_hours

test('capacity_crew_hours: sums real visit hours per technician, sorted busiest first', async () => {
  visitsFixture = [
    { start_at: iso(2, 8), end_at: iso(2, 16), assigned_users: [{ id: 'u1', name: 'Einer' }] }, // 8h
    { start_at: iso(3, 8), end_at: iso(3, 12), assigned_users: [{ id: 'u1', name: 'Einer' }, { id: 'u2', name: 'Jeff' }] }, // 4h each
    { start_at: iso(5, 9), end_at: iso(5, 11), assigned_users: [{ id: 'u2', name: 'Jeff' }] }, // 2h
  ];
  const r = await callResource('capacity_crew_hours', { days: 30 });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.days, 30);
  assert.deepEqual(r.body.crew, [
    { name: 'Einer', hours: 12 },
    { name: 'Jeff', hours: 6 },
  ]);
});

test('capacity_crew_hours: no fabricated percent-of-capacity field anywhere in the response', async () => {
  visitsFixture = [{ start_at: iso(1, 8), end_at: iso(1, 12), assigned_users: [{ id: 'u1', name: 'Einer' }] }];
  const r = await callResource('capacity_crew_hours', { days: 30 });
  const json = JSON.stringify(r.body);
  assert.doesNotMatch(json, /percentOfCapacity|utilization|capacityPct/i);
  assert.match(r.body.note, /no.*expected hours per week.*setting/i);
});

test('capacity_crew_hours: a visit with no assigned_users, malformed JSON, or zero-length window is skipped, not crashed on', async () => {
  visitsFixture = [
    { start_at: iso(1, 8), end_at: iso(1, 10), assigned_users: [] },
    { start_at: iso(1, 8), end_at: iso(1, 10), assigned_users: 'not-json-or-array{{{' },
    { start_at: iso(1, 8), end_at: iso(1, 8), assigned_users: [{ id: 'u1', name: 'Einer' }] },
    { start_at: null, end_at: iso(1, 10), assigned_users: [{ id: 'u1', name: 'Einer' }] },
  ];
  const r = await callResource('capacity_crew_hours', { days: 30 });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.crew, []);
});

test('capacity_crew_hours: days param is clamped to a sane range', async () => {
  visitsFixture = [];
  const r1 = await callResource('capacity_crew_hours', { days: 999999 });
  assert.equal(r1.body.days, 180);
  const r2 = await callResource('capacity_crew_hours', { days: -5 });
  assert.equal(r2.body.days, 1);
});

// ---------------------------------------------------- capacity_backlog_by_month

test('capacity_backlog_by_month: buckets real job totals by start month, and asks Postgres to exclude archived jobs', async () => {
  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 15).toISOString();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 10).toISOString();
  // Archived jobs are excluded server-side via the job_status=neq.archived
  // filter in the actual Supabase query -- this fixture represents what
  // Postgres would already have filtered out, so it contains no archived
  // rows; the assertion on lastJobsPath below is what actually proves the
  // exclusion filter is present in the real query.
  jobsFixture = [
    { job_number: 1, total: 5000, start_at: thisMonth, job_status: 'active' },
    { job_number: 2, total: 3000, start_at: thisMonth, job_status: 'active' },
    { job_number: 4, total: 2000, start_at: nextMonth, job_status: 'unscheduled' },
  ];
  const r = await callResource('capacity_backlog_by_month', { months: 4 });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.months.length, 4);
  assert.equal(r.body.months[0].total, 8000);
  assert.equal(r.body.months[0].jobCount, 2);
  assert.equal(r.body.months[1].total, 2000);
  assert.equal(r.body.months[1].jobCount, 1);
  assert.match(lastJobsPath, /job_status=neq\.archived/);
});

test('capacity_backlog_by_month: jobs with no start_at are excluded from every month and counted in unscheduledSkipped', async () => {
  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 15).toISOString();
  jobsFixture = [
    { job_number: 1, total: 5000, start_at: thisMonth, job_status: 'active' },
    { job_number: 2, total: 7000, start_at: null, job_status: 'unscheduled' },
    { job_number: 3, total: 1000, start_at: undefined, job_status: 'unscheduled' },
  ];
  const r = await callResource('capacity_backlog_by_month', { months: 4 });
  assert.equal(r.body.months[0].total, 5000);
  assert.equal(r.body.unscheduledSkipped, 2);
});

test('capacity_backlog_by_month: months param is clamped and each bucket has a real month label', async () => {
  jobsFixture = [];
  const r = await callResource('capacity_backlog_by_month', { months: 999 });
  assert.equal(r.body.months.length, 12);
  const now = new Date();
  assert.equal(r.body.months[0].label, now.toLocaleString('en-US', { month: 'short' }).toUpperCase());
});
