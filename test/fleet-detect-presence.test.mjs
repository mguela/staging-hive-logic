// test/fleet-detect-presence.test.mjs
// api/fleet/detect-presence.js re-derives arrival/departure intervals from
// scratch every run out of whatever position window it happened to fetch, so
// a still-open visit's computed arrived_at is not guaranteed identical run to
// run. The original write path merged on (vehicle_id, job_uuid, arrived_at),
// so any such drift silently inserted a brand-new row instead of extending
// the existing one -- confirmed live: ~9 near-duplicate fleet_job_presence
// rows for one continuous visit, all sharing the same final departed_at.
// Fixed by tracking the open interval by its row id (status='present') per
// (vehicle_id, job_uuid) and PATCHing it forward instead of re-inserting.
//
// Also covers a second, separate bug found the same day: candidate job
// selection used to filter on the parent JOB's own start_at/end_at, which
// spans the whole project (a multi-week renovation), not today's actual
// visit. Confirmed live: a job with a real, geocoded visit scheduled today
// had a job-level start_at/end_at from over a week earlier, so it was
// silently excluded from every run. Fixed by selecting candidates from
// visits.start_at/end_at instead.
//
// Fully mocked -- no network, no DB.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'cron-secret';
process.env.FLEET_ENABLED = 'true';

const JOB_LAT = 41.0;
const JOB_LNG = -73.0;
const FAR_LAT = 42.0; // well outside the 150m radius

function req() {
  return { headers: { authorization: 'Bearer cron-secret' } };
}

function res() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// Builds a fetch mock that answers the fixed lookup chain (visits,
// jobs_enriched geocode, jobs uuid map, fleet_vehicles) the same way every
// time, and hands per-test control over fleet_positions / fleet_job_presence
// (open-row lookup) / the writes actually issued.
function fetchMock({ positions, openRows, onWrite }) {
  const writes = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    const json = (data) => ({ ok: true, json: async () => data });
    if (u.includes('/visits')) {
      return json([{ job_id: 'job-1', start_at: '2026-08-20T08:00:00.000Z', end_at: '2026-08-20T20:00:00.000Z' }]);
    }
    if (u.includes('/jobs_enriched')) {
      return json([{ jobber_id: 'job-1', gps_lat: JOB_LAT, gps_lng: JOB_LNG }]);
    }
    if (u.includes('/jobs?')) return json([{ jobber_id: 'job-1', uuid_id: 'job-uuid-1' }]);
    if (u.includes('/fleet_vehicles')) return json([{ id: 'fv-1', company_id: 'company-1' }]);
    if (u.includes('/fleet_positions')) return json(positions);
    if (u.includes('/fleet_job_presence')) {
      if (opts.method === 'PATCH' || opts.method === 'POST') {
        writes.push({ method: opts.method, url: u, body: JSON.parse(opts.body) });
        if (onWrite) onWrite(writes[writes.length - 1]);
        return json([]);
      }
      // GET: the open-row lookup for this vehicle.
      return json(openRows);
    }
    throw new Error('unexpected fetch: ' + u);
  };
  fn.writes = writes;
  return fn;
}

async function run(mock) {
  const originalFetch = global.fetch;
  global.fetch = mock;
  try {
    const mod = await import('../api/fleet/detect-presence.js');
    const r = res();
    await mod.default(req(), r);
    return { r, writes: mock.writes };
  } finally { global.fetch = originalFetch; }
}

test('a continuing visit with an existing open row is extended, not duplicated', async () => {
  const positions = [
    { id: 'pos-1', device_time: '2026-08-20T11:25:00.000Z', latitude: JOB_LAT, longitude: JOB_LNG },
    { id: 'pos-2', device_time: '2026-08-20T12:25:00.000Z', latitude: JOB_LAT, longitude: JOB_LNG },
  ];
  const openRows = [{ id: 'presence-row-1', job_uuid: 'job-uuid-1' }];

  const { r, writes } = await run(fetchMock({ positions, openRows }));

  assert.equal(r.statusCode, 200);
  assert.equal(r.body.upserted, 1);
  assert.equal(writes.length, 1, 'exactly one write: extend the existing row');
  assert.equal(writes[0].method, 'PATCH');
  assert.match(writes[0].url, /fleet_job_presence\?id=eq\.presence-row-1/);
  assert.equal(writes[0].body.arrived_at, undefined, 'the original arrived_at must never be rewritten');
  assert.equal(writes[0].body.departed_at, '2026-08-20T12:25:00.000Z');
  assert.equal(writes[0].body.status, 'present', 'still the last position in the fetched window -- visit is ongoing');
});

test('a brand-new visit with no existing open row is inserted', async () => {
  const positions = [
    { id: 'pos-1', device_time: '2026-08-20T11:25:00.000Z', latitude: JOB_LAT, longitude: JOB_LNG },
  ];
  const { r, writes } = await run(fetchMock({ positions, openRows: [] }));

  assert.equal(r.statusCode, 200);
  assert.equal(r.body.upserted, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert.match(writes[0].url, /fleet_job_presence\?on_conflict=/);
  assert.equal(writes[0].body.arrived_at, '2026-08-20T11:25:00.000Z');
  assert.equal(writes[0].body.job_uuid, 'job-uuid-1');
});

test('a visit that has ended closes the open row with status=complete, still without touching arrived_at', async () => {
  const positions = [
    { id: 'pos-1', device_time: '2026-08-20T11:25:00.000Z', latitude: JOB_LAT, longitude: JOB_LNG },
    { id: 'pos-2', device_time: '2026-08-20T12:25:00.000Z', latitude: JOB_LAT, longitude: JOB_LNG },
    { id: 'pos-3', device_time: '2026-08-20T13:25:00.000Z', latitude: FAR_LAT, longitude: JOB_LNG }, // drove away
  ];
  const openRows = [{ id: 'presence-row-1', job_uuid: 'job-uuid-1' }];

  const { writes } = await run(fetchMock({ positions, openRows }));

  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH');
  assert.equal(writes[0].body.status, 'complete');
  assert.equal(writes[0].body.departed_at, '2026-08-20T12:25:00.000Z', 'departure is the last in-radius position, not the one that left');
  assert.ok(writes[0].body.departure_confidence != null, 'a closed visit must carry a departure confidence');
});

test('leaving and returning to the same job within one run closes the open row and starts a fresh one', async () => {
  const positions = [
    { id: 'pos-1', device_time: '2026-08-20T11:25:00.000Z', latitude: JOB_LAT, longitude: JOB_LNG },
    { id: 'pos-2', device_time: '2026-08-20T12:00:00.000Z', latitude: FAR_LAT, longitude: JOB_LNG }, // left
    { id: 'pos-3', device_time: '2026-08-20T13:00:00.000Z', latitude: JOB_LAT, longitude: JOB_LNG }, // came back
    { id: 'pos-4', device_time: '2026-08-20T14:00:00.000Z', latitude: JOB_LAT, longitude: JOB_LNG },
  ];
  const openRows = [{ id: 'presence-row-1', job_uuid: 'job-uuid-1' }];

  const { r, writes } = await run(fetchMock({ positions, openRows }));

  assert.equal(r.body.upserted, 2);
  assert.equal(writes.length, 2, 'the first leg closes the old row, the second leg is a genuinely new visit');

  const [first, second] = writes;
  assert.equal(first.method, 'PATCH', 'the first (now-historical) leg closes the pre-existing open row');
  assert.match(first.url, /id=eq\.presence-row-1/);
  assert.equal(first.body.status, 'complete');
  assert.equal(first.body.departed_at, '2026-08-20T11:25:00.000Z');

  assert.equal(second.method, 'POST', 'the second leg is a fresh arrival, not a reuse of the closed row');
  assert.equal(second.body.arrived_at, '2026-08-20T13:00:00.000Z');
  assert.equal(second.body.status, 'present');
});

test('a job whose own start_at/end_at is long past is still a candidate if a visit is scheduled today', async () => {
  const mock = fetchMock({
    positions: [{ id: 'pos-1', device_time: '2026-08-20T12:00:00.000Z', latitude: JOB_LAT, longitude: JOB_LNG }],
    openRows: [],
  });
  // Override the fixed /visits and /jobs_enriched answers this test's mock
  // gives by default, to reproduce the exact confirmed scenario: the job's
  // own span is over a week old, but today's visit is real and geocoded.
  const wrapped = async (url, opts) => {
    const u = String(url);
    const json = (data) => ({ ok: true, json: async () => data });
    if (u.includes('/visits')) {
      return json([{ job_id: 'old-project-job', start_at: '2026-08-20T08:00:00.000Z', end_at: '2026-08-20T20:00:00.000Z' }]);
    }
    if (u.includes('/jobs_enriched')) {
      return json([{ jobber_id: 'old-project-job', gps_lat: JOB_LAT, gps_lng: JOB_LNG }]);
    }
    if (u.includes('/jobs?')) return json([{ jobber_id: 'old-project-job', uuid_id: 'old-project-uuid' }]);
    return mock(url, opts);
  };
  wrapped.writes = mock.writes;

  const { r, writes } = await run(wrapped);

  assert.equal(r.body.candidateJobs, 1, 'the visit makes it a candidate regardless of the job\'s own (stale) start_at/end_at');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.job_uuid, 'old-project-uuid');
});

test('a visit today whose job has no geocoded address is skipped, not guessed', async () => {
  const mock = fetchMock({ positions: [], openRows: [] });
  const wrapped = async (url, opts) => {
    const u = String(url);
    const json = (data) => ({ ok: true, json: async () => data });
    if (u.includes('/visits')) {
      return json([{ job_id: 'ungeocoded-job', start_at: '2026-08-20T08:00:00.000Z', end_at: '2026-08-20T20:00:00.000Z' }]);
    }
    if (u.includes('/jobs_enriched')) return json([]); // gps_lat is null -> filtered out at the source
    if (u.includes('/jobs?')) return json([{ jobber_id: 'ungeocoded-job', uuid_id: 'ungeocoded-uuid' }]);
    return mock(url, opts);
  };
  wrapped.writes = mock.writes;

  const { r } = await run(wrapped);
  assert.equal(r.body.candidateJobs, 0);
  assert.equal(r.body.note, 'No scheduled visits in window have a geocoded job.');
});

test('the open-row lookup is scoped to this vehicle and to still-open visits, so a different truck can never steal a match', async () => {
  const positions = [
    { id: 'pos-1', device_time: '2026-08-20T11:25:00.000Z', latitude: JOB_LAT, longitude: JOB_LNG },
  ];
  let openLookupUrl = null;
  const mock = fetchMock({ positions, openRows: [] });
  const wrapped = async (url, opts) => {
    const u = String(url);
    if (u.includes('/fleet_job_presence') && (!opts || (opts.method !== 'PATCH' && opts.method !== 'POST'))) {
      openLookupUrl = u;
    }
    return mock(url, opts);
  };
  wrapped.writes = mock.writes;
  await run(wrapped);

  assert.match(openLookupUrl, /vehicle_id=eq\.fv-1/, 'must scope to this vehicle, not fleet-wide');
  assert.match(openLookupUrl, /status=eq\.present/, 'must only ever reuse a row that is still open');
});
