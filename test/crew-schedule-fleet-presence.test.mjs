// test/crew-schedule-fleet-presence.test.mjs
// Command Center's "Service Area Map" shows each vehicle's live position but
// had no idea whether it had actually arrived at or left a job site -- even
// though the geofence engine (api/fleet/detect-presence.js) has been
// computing exactly that into fleet_job_presence since Slice 6. This wires
// crew_schedule's vehicles array to that table, joined by VIN (fleet_vehicles
// and public.vehicles share no other link -- see
// supabase/migrations/20260814192951_fleet_slice1_schema.sql). Fully mocked
// -- no network, no DB.

import test from 'node:test';
import assert from 'node:assert/strict';

import { fleetJobPresenceByVin, handleCrewSchedule } from '../api/track1.js';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

function res() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function withFetch(handlerFn, run) {
  return async () => {
    const originalFetch = global.fetch;
    global.fetch = handlerFn;
    try { return await run(); } finally { global.fetch = originalFetch; }
  };
}

// ---------------------------------------------------- fleetJobPresenceByVin

test('fleetJobPresenceByVin: no vehicles have a VIN skips the network entirely', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => [] }; };
  try {
    const result = await fleetJobPresenceByVin([{ vin: null }, {}], new Date().toISOString());
    assert.deepEqual(result, {});
    assert.equal(fetchCalled, false);
  } finally { global.fetch = originalFetch; }
});

test('fleetJobPresenceByVin: a VIN with no matching fleet_vehicles row yields no presence', withFetch(
  async (url) => {
    const u = String(url);
    if (u.includes('/fleet_vehicles')) return { ok: true, json: async () => [] };
    throw new Error('unexpected fetch: ' + u);
  },
  async () => {
    const result = await fleetJobPresenceByVin([{ vin: 'NO-MATCH' }], new Date().toISOString());
    assert.deepEqual(result, {});
  }
));

test('fleetJobPresenceByVin: picks each vehicle\'s latest interval today and attaches its job number', withFetch(
  async (url) => {
    const u = String(url);
    if (u.includes('/fleet_vehicles')) {
      assert.match(u, /vin=in\.\("VIN-A"\)/);
      return { ok: true, json: async () => [{ id: 'fv-1', vin: 'VIN-A' }] };
    }
    if (u.includes('/fleet_job_presence')) {
      assert.match(u, /vehicle_id=in\.\(fv-1\)/);
      assert.match(u, /order=arrived_at\.desc/);
      // Newest first, as PostgREST would return it under that order.
      return {
        ok: true,
        json: async () => [
          { vehicle_id: 'fv-1', job_uuid: 'job-uuid-1', arrived_at: '2026-08-20T14:00:00.000Z', departed_at: null },
          { vehicle_id: 'fv-1', job_uuid: 'job-uuid-2', arrived_at: '2026-08-20T09:00:00.000Z', departed_at: '2026-08-20T10:30:00.000Z' },
        ],
      };
    }
    if (u.includes('/jobs?')) {
      assert.match(u, /uuid_id=in\.\(job-uuid-1\)/, 'only the latest interval\'s job should be looked up');
      return { ok: true, json: async () => [{ uuid_id: 'job-uuid-1', job_number: 'HL-100' }] };
    }
    throw new Error('unexpected fetch: ' + u);
  },
  async () => {
    const result = await fleetJobPresenceByVin([{ vin: 'VIN-A' }], '2026-08-20T00:00:00.000Z');
    assert.deepEqual(result, {
      'VIN-A': { arrivedAt: '2026-08-20T14:00:00.000Z', departedAt: null, jobNumber: 'HL-100' },
    });
  }
));

// ---------------------------------------------------- handleCrewSchedule wiring

const VEHICLES = [
  { jobber_id: 'veh-a', name: 'Truck A', make: 'RAM', model: 'Promaster', icon_color: null, vin: 'VIN-A', fleetsharp_latitude: 41, fleetsharp_longitude: -73, fleetsharp_speed: 0, fleetsharp_status: 'STOPPED', fleetsharp_updated_at: new Date().toISOString() },
  { jobber_id: 'veh-b', name: 'Truck B', make: 'Ford', model: 'Transit', icon_color: null, vin: 'VIN-B', fleetsharp_latitude: null, fleetsharp_longitude: null, fleetsharp_speed: null, fleetsharp_status: null, fleetsharp_updated_at: null },
  { jobber_id: 'veh-c', name: 'Truck C', make: 'Ford', model: 'F150', icon_color: null, vin: null, fleetsharp_latitude: null, fleetsharp_longitude: null, fleetsharp_speed: null, fleetsharp_status: null, fleetsharp_updated_at: null },
];

function fetchForCrewSchedule() {
  return async (url) => {
    const u = String(url);
    const json = (data) => ({ ok: true, json: async () => data });
    if (u.includes('/visits')) return json([]); // no scheduled visits today -- keeps clients/jobs lookups empty too
    if (u.includes('/users')) return json([]);
    if (u.includes('/vehicles')) return json(VEHICLES);
    if (u.includes('/fleet_vehicles')) return json([{ id: 'fv-a', vin: 'VIN-A' }]); // only Truck A links to a Fleet-slice vehicle
    if (u.includes('/fleet_job_presence')) {
      return json([{ vehicle_id: 'fv-a', job_uuid: 'job-uuid-1', arrived_at: '2026-08-20T14:00:00.000Z', departed_at: null }]);
    }
    if (u.includes('/jobs?')) return json([{ uuid_id: 'job-uuid-1', job_number: 'HL-100' }]);
    if (u.includes('/clients')) return json([]);
    throw new Error('unexpected fetch: ' + u);
  };
}

test('handleCrewSchedule: a vehicle linked to a Fleet-slice VIN carries its detected arrival/departure', withFetch(
  fetchForCrewSchedule(),
  async () => {
    const r = res();
    await handleCrewSchedule(r);
    assert.equal(r.statusCode, 200);
    const truckA = r.body.vehicles.find((v) => v.name === 'Truck A');
    assert.equal(truckA.arrivedAt, '2026-08-20T14:00:00.000Z');
    assert.equal(truckA.departedAt, null);
    assert.equal(truckA.presenceJobNumber, 'HL-100');
  }
));

test('handleCrewSchedule: a vehicle with no Fleet-slice VIN match carries no presence, not a stale one', withFetch(
  fetchForCrewSchedule(),
  async () => {
    const r = res();
    await handleCrewSchedule(r);
    const truckB = r.body.vehicles.find((v) => v.name === 'Truck B');
    assert.equal(truckB.arrivedAt, null);
    assert.equal(truckB.departedAt, null);
    assert.equal(truckB.presenceJobNumber, null);
  }
));

test('handleCrewSchedule: a vehicle with no VIN at all is never looked up against Fleet presence', withFetch(
  fetchForCrewSchedule(),
  async () => {
    const r = res();
    await handleCrewSchedule(r);
    const truckC = r.body.vehicles.find((v) => v.name === 'Truck C');
    assert.equal(truckC.arrivedAt, null);
    assert.equal(truckC.departedAt, null);
  }
));
