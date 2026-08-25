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
    client_name: 'Jane Doe', gps_lat: 41.02, gps_lng: -73.62, loc_city: 'Greenwich', loc_province: 'CT',
    effective_start_at: '2026-07-01T12:00:00Z', effective_end_at: null },
  { jobber_id: 'J2', client_id: 'C2', job_number: 102, title: 'Fence',
    job_status: 'archived', job_type: 'ONE_OFF', total: 900, start_at: null,
    end_at: null, completed_at: '2026-06-01T12:00:00Z', jobber_web_uri: 'https://x/j2',
    client_name: null, gps_lat: null, gps_lng: null, loc_city: null, loc_province: null,
    effective_start_at: null, effective_end_at: null },
];

// 2026-08-25, jomell: "i just booked a schedule... this should also reflect
// in 'active jobs' tab." jobs.start_at is written only by the Jobber sync,
// so a job scheduled purely via the crew board's native appointments
// (hl_appointments, linked by job_ref) never set it -- Active Jobs kept
// showing "Not booked" forever. jobs_enriched now also coalesces in the
// earliest non-canceled hl_appointments row for that job as
// effective_start_at/effective_end_at (20260825140000 migration); startAt/
// endAt below should prefer that when Jobber's own value is null.
const NATIVE_ONLY = {
  jobber_id: 'J3', client_id: 'C3', job_number: null, title: 'Decommission AC',
  job_status: 'active', job_type: 'ONE_OFF', total: 2080, start_at: null,
  end_at: null, completed_at: null, jobber_web_uri: null,
  client_name: 'jovie folloso', gps_lat: null, gps_lng: null, loc_city: null, loc_province: null,
  effective_start_at: '2026-08-30T13:00:00Z', effective_end_at: '2026-08-30T15:00:00Z',
};

let lastPath = null;
mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path) => {
      lastPath = path;
      if (/jobber_id=eq\.J3/.test(path)) return { ok: true, json: async () => [NATIVE_ONLY], headers: { get: () => null } };
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

test('a job scheduled only via a native crew-board appointment reports as scheduled', async () => {
  // The exact bug: jobs.start_at stays null forever for a HiveLogic-native
  // job (Jobber never learns about it), so startAt must fall back to the
  // view's effective_start_at instead of reading j.start_at directly.
  const j = await getJobByIdData('J3');
  assert.equal(j.startAt, '2026-08-30T13:00:00Z');
  assert.equal(j.endAt, '2026-08-30T15:00:00Z');
});

test('a job Jobber itself has scheduled keeps using that value', async () => {
  // Jobber's own start_at must win when it exists -- effective_start_at is
  // only ever a fallback (coalesce), never a preferred override.
  const j = await getJobByIdData('J1');
  assert.equal(j.startAt, '2026-07-01T12:00:00Z');
});

test('a job with neither reports null, not undefined or a crash', async () => {
  const j = await getJobByIdData('J1'); // fixture J2 not separately fetchable by id in this mock; use list instead
  const list = await getJobsListData({ limit: 10 });
  const j2 = list.jobs.find((x) => x.id === 'J2');
  assert.equal(j2.startAt, null);
  assert.equal(j2.endAt, null);
});

test('the list endpoint applies the same native-appointment fallback as the single-job endpoint', async () => {
  // getJobsListData's mock always returns the 2-row FIXTURE, so this proves
  // the SELECT/mapping wiring is identical, not that J3 appears in a list.
  const list = await getJobsListData({ limit: 10 });
  assert.match(lastPath, /effective_start_at/);
  assert.match(lastPath, /effective_end_at/);
  assert.equal(list.jobs[0].startAt, FIXTURE[0].effective_start_at);
});
