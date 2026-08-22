// Verifies api/jobs.js (jobs_enriched view rework, 2026-07-30) preserves the
// NOTE: run with  node --experimental-test-module-mocks --test test/jobs-view-shape.test.mjs
// exact pre-view response shapes, using module mocking so no network/env is
// needed. Fixture rows mirror real jobs_enriched output (incl. a job with no
// geocoded location and a null-name edge).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const FIXTURE = [
  { jobber_id: 'J1', client_id: 'C1', job_number: 101, title: 'Deck rebuild',
    job_status: 'active', job_type: 'ONE_OFF', total: 4200, start_at: '2026-07-01T12:00:00Z',
    end_at: null, completed_at: null, jobber_web_uri: 'https://x/j1',
    client_name: 'Jane Doe', gps_lat: 41.02, gps_lng: -73.62, loc_city: 'Greenwich', loc_province: 'CT' },
  { jobber_id: 'J2', client_id: 'C2', job_number: 102, title: 'Fence',
    job_status: 'archived', job_type: 'ONE_OFF', total: 900, start_at: null,
    end_at: null, completed_at: '2026-06-01T12:00:00Z', jobber_web_uri: 'https://x/j2',
    client_name: null, gps_lat: null, gps_lng: null, loc_city: null, loc_province: null },
];

let lastPath = null;
mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path) => {
      lastPath = path;
      const single = /jobber_id=eq\./.test(path);
      const rows = single ? [FIXTURE[0]] : FIXTURE;
      return {
        ok: true,
        json: async () => rows,
        headers: { get: (h) => (h === 'content-range' ? '0-1/2740' : null) },
      };
    },
  },
});

const { getJobsListData, getJobByIdData } = await import('../api/jobs.js');

test('list: exact legacy shape, one request, view path', async () => {
  const d = await getJobsListData({ limit: 500 });
  assert.match(lastPath, /^jobs_enriched\?/);
  assert.equal(d.totalCount, 2740);
  assert.equal(d.returned, 2);
  // This list guards against a field being DROPPED or RENAMED by a refactor --
  // that was the point when the jobs_enriched rework landed. Adding one is
  // additive and safe, so the list grows when a field is deliberately added:
  // projectSeq/projectRef/divisionCode arrived with project numbering
  // (2026-08-17); createdAt arrived with the Active Jobs list, which sorts and
  // displays when a job was raised (2026-08-18). Every original key must still
  // be present, spelled the same.
  assert.deepEqual(Object.keys(d.jobs[0]), [
    'id','title','clientId','clientName','jobNumber',
    'projectSeq','projectRef','divisionCode',
    'status','type','total',
    'startAt','endAt','completedAt','createdAt','jobberUrl','gpsLat','gpsLng','city','province',
  ]);
  // These fixtures are Jobber-synced jobs, so they carry jobNumber and no
  // project number -- a job has one or the other, never both.
  assert.equal(d.jobs[0].projectSeq, null);
  assert.equal(d.jobs[0].projectRef, null);
  assert.equal(d.jobs[0].jobNumber, 101);
  assert.equal(d.jobs[0].clientName, 'Jane Doe');
  assert.equal(d.jobs[0].gpsLat, 41.02);
  // null-name + no-location job: nulls, not undefined/empty
  assert.equal(d.jobs[1].clientName, null);
  assert.equal(d.jobs[1].gpsLat, null);
  assert.equal(d.jobs[1].city, null);
});

test('list: status filters build the legacy PostgREST filters', async () => {
  await getJobsListData({ status: 'active', limit: 1000 });
  assert.match(lastPath, /job_status=neq\.archived/);
  await getJobsListData({ status: 'requires_invoicing' });
  assert.match(lastPath, /job_status=eq\.requires_invoicing/);
});

test('single job: exact legacy shape (no clientName/city/province)', async () => {
  const j = await getJobByIdData('J1');
  assert.deepEqual(Object.keys(j), [
    'id','title','clientId','jobNumber',
    'projectSeq','projectRef','divisionCode',
    'status','type','total',
    'startAt','endAt','completedAt','jobberUrl','gpsLat','gpsLng',
  ]);
  assert.equal(j.id, 'J1');
  assert.equal(j.gpsLng, -73.62);
});
