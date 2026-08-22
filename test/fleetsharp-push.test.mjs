// test/fleetsharp-push.test.mjs
// FleetSharp Push API webhook (2026-08-11) -- the fix for vehicle GPS on the
// Command Center map / Fleet GPS card going days stale (Jobber's own
// upstream connection to FleetSharp had failed). FleetSharp POSTs live
// positions to api/jobber/sync-extended.js?resource=fleetsharp_push,
// authenticated by our own FLEETSHARP_PUSH_SECRET (not CRON_SECRET -- an
// external vendor calling in on its own schedule can never carry that).
// Covers: (A) the middleware allowlist entry that lets this one resource+
// method through without a Supabase session or cron secret, (B) the
// handler's own auth gate and VIN-matched upsert into vehicles.fleetsharp_*,
// (C) the read-side "freshest wins" merge in track1.js that makes FleetSharp
// primary and Jobber fallback. Fully mocked -- no network, no DB, no real
// secret.

import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';

import { isPublicResourcePath, decideAccess, checkBearerSecret } from '../api/_lib/guard.js';
import { vehicleGps, VEHICLE_GPS_COLUMNS } from '../api/track1.js';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'cron-secret';

function res() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// ---------------------------------------------------- A. middleware allowlist

test('isPublicResourcePath: fleetsharp_push is allowed only as POST on sync-extended, not GET, not other resources/paths', () => {
  assert.equal(isPublicResourcePath('/api/jobber/sync-extended', new URLSearchParams('resource=fleetsharp_push'), 'POST'), true);
  assert.equal(isPublicResourcePath('/api/jobber/sync-extended', new URLSearchParams('resource=fleetsharp_push'), 'GET'), false);
  assert.equal(isPublicResourcePath('/api/jobber/sync-extended', new URLSearchParams('resource=vehicles'), 'POST'), false);
  assert.equal(isPublicResourcePath('/api/track1', new URLSearchParams('resource=fleetsharp_push'), 'POST'), false);
});

test('decideAccess: an anonymous FleetSharp push (no user, no cron secret) is allowed in as POST only', () => {
  const allowed = decideAccess({ pathname: '/api/jobber/sync-extended', searchParams: new URLSearchParams('resource=fleetsharp_push'), hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'POST' });
  assert.equal(allowed.allow, true);
  assert.equal(allowed.reason, 'public-resource-allowlist');
  const wrongMethod = decideAccess({ pathname: '/api/jobber/sync-extended', searchParams: new URLSearchParams('resource=fleetsharp_push'), hasValidUser: false, hasValidCronSecret: false, cronSecretConfigured: true, method: 'GET' });
  assert.equal(wrongMethod.allow, false);
});

// ---------------------------------------------------- B. handler auth + upsert

test('checkBearerSecret: rejects when unset, empty, or mismatched; accepts exact match with or without Bearer prefix', () => {
  assert.equal(checkBearerSecret('Bearer abc', undefined), false);
  assert.equal(checkBearerSecret('', 'abc'), false);
  assert.equal(checkBearerSecret('Bearer wrong', 'abc'), false);
  assert.equal(checkBearerSecret('Bearer abc', 'abc'), true);
  assert.equal(checkBearerSecret('abc', 'abc'), true);
});

async function callFleetSharpPush({ headers = {}, body, method = 'POST' } = {}) {
  const mod = await import('../api/jobber/sync-extended.js');
  const req = { method, query: { resource: 'fleetsharp_push' }, headers, body };
  const r = res();
  await mod.default(req, r);
  return r;
}

test('fleetsharp_push: missing secret env var rejects everything (fails closed)', async () => {
  delete process.env.FLEETSHARP_PUSH_SECRET;
  const r = await callFleetSharpPush({ headers: { authentication: 'Bearer whatever' }, body: { pushType: 'POSITION', vin: '1WAHSBE44G3230973' } });
  assert.equal(r.statusCode, 401);
});

test('fleetsharp_push: wrong token is rejected 401, never reaches the DB write', async () => {
  process.env.FLEETSHARP_PUSH_SECRET = 'correct-secret';
  let fetchCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => [] }; };
  try {
    const r = await callFleetSharpPush({ headers: { authentication: 'Bearer nope' }, body: { pushType: 'POSITION', vin: '1WAHSBE44G3230973' } });
    assert.equal(r.statusCode, 401);
    assert.equal(fetchCalled, false);
  } finally { global.fetch = originalFetch; }
});

test('fleetsharp_push: accepts the token via either "Authentication" or "Authorization" header (PDF names the nonstandard one)', async () => {
  process.env.FLEETSHARP_PUSH_SECRET = 'correct-secret';
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => [] });
  try {
    const r1 = await callFleetSharpPush({ headers: { authentication: 'Bearer correct-secret' }, body: { pushType: 'POSITION', vin: '1WAHSBE44G3230973', latitude: 41.03, longitude: -73.63 } });
    assert.equal(r1.statusCode, 201);
    const r2 = await callFleetSharpPush({ headers: { authorization: 'Bearer correct-secret' }, body: { pushType: 'POSITION', vin: '1WAHSBE44G3230973', latitude: 41.03, longitude: -73.63 } });
    assert.equal(r2.statusCode, 201);
  } finally { global.fetch = originalFetch; }
});

test('fleetsharp_push: a POSITION with a VIN patches vehicles by vin=eq.<vin>, only fleetsharp_* columns', async () => {
  process.env.FLEETSHARP_PUSH_SECRET = 'correct-secret';
  let capturedUrl = null, capturedBody = null, capturedMethod = null;
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    capturedUrl = String(url); capturedMethod = opts.method; capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => [{ jobber_id: 'veh-1', vin: '1WAHSBE44G3230973' }] };
  };
  try {
    const r = await callFleetSharpPush({
      headers: { authentication: 'Bearer correct-secret' },
      body: { pushType: 'POSITION', vin: '1WAHSBE44G3230973', latitude: 38.67386, longitude: -90.5117, speed: 12, currentState: 'MOVING', date: 1442392916000 },
    });
    assert.equal(r.statusCode, 201);
    assert.equal(r.body.updated, 1);
    assert.match(capturedUrl, /vehicles\?vin=eq\.1WAHSBE44G3230973/);
    assert.equal(capturedMethod, 'PATCH');
    assert.deepEqual(Object.keys(capturedBody).sort(), ['fleetsharp_latitude', 'fleetsharp_longitude', 'fleetsharp_speed', 'fleetsharp_status', 'fleetsharp_updated_at'].sort());
    assert.equal(capturedBody.fleetsharp_status, 'MOVING');
    assert.equal(capturedBody.fleetsharp_updated_at, new Date(1442392916000).toISOString());
  } finally { global.fetch = originalFetch; }
});

test('fleetsharp_push: a VIN with no matching vehicle row comes back HTTP ok from PostgREST but must count as skipped, not updated (regression: return=minimal made this indistinguishable)', async () => {
  process.env.FLEETSHARP_PUSH_SECRET = 'correct-secret';
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => [] });
  try {
    const r = await callFleetSharpPush({
      headers: { authentication: 'Bearer correct-secret' },
      body: { pushType: 'POSITION', vin: 'NO-SUCH-VEHICLE-VIN', latitude: 1, longitude: 1 },
    });
    assert.equal(r.statusCode, 201);
    assert.equal(r.body.updated, 0);
    assert.equal(r.body.skipped, 1);
  } finally { global.fetch = originalFetch; }
});

test('fleetsharp_push: non-POSITION pushTypes (FENCE_EVENT, STOP, TRIP, ALERT, etc.) are acknowledged 201 but skipped, no DB write', async () => {
  process.env.FLEETSHARP_PUSH_SECRET = 'correct-secret';
  let fetchCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => [] }; };
  try {
    const r = await callFleetSharpPush({ headers: { authentication: 'Bearer correct-secret' }, body: { pushType: 'ALERT', vin: '1WAHSBE44G3230973', alertCode: 'NO_SIGNAL' } });
    assert.equal(r.statusCode, 201);
    assert.equal(r.body.skipped, 1);
    assert.equal(r.body.updated, 0);
    assert.equal(fetchCalled, false);
  } finally { global.fetch = originalFetch; }
});

test('fleetsharp_push: a POSITION with no VIN is acknowledged 201 but skipped (no vehicle to match)', async () => {
  process.env.FLEETSHARP_PUSH_SECRET = 'correct-secret';
  const r = await callFleetSharpPush({ headers: { authentication: 'Bearer correct-secret' }, body: { pushType: 'POSITION', latitude: 1, longitude: 2 } });
  assert.equal(r.statusCode, 201);
  assert.equal(r.body.skipped, 1);
});

test('fleetsharp_push: GET is rejected 405 (POST only, per FleetSharp\'s own spec)', async () => {
  process.env.FLEETSHARP_PUSH_SECRET = 'correct-secret';
  const r = await callFleetSharpPush({ method: 'GET', headers: { authentication: 'Bearer correct-secret' } });
  assert.equal(r.statusCode, 405);
});

// ---------------------------------------------------- C. read side: FleetSharp only
//
// Rewritten 2026-08-16 (Chris: "Remove Jobber GPS from this equation all
// together and use FleetSharp only").
//
// This used to be a freshest-of-two merge with Jobber as the fallback. That
// fallback was never real: Jobber's GPS on this account has been frozen since
// 2026-07-28, so falling back meant drawing a three-week-old position that
// looked exactly like a live one. Verified against production before the
// change -- all 10 vehicles carry a FleetSharp fix, newest minutes old, newest
// Jobber fix 2026-07-28 -- so dropping Jobber costs no coverage.
//
// Losing the fallback makes freshness reporting more important, not less: with
// one source there is nothing to mask an outage, so `stale`/`ageMs` are what
// stop a parked history being drawn as a live truck.

test('vehicleGps: reads FleetSharp, and ignores Jobber even when Jobber looks newer', () => {
  const v = {
    latitude: 1, longitude: 1, speed: 5, status: 'DRIVING', gps_updated_at: '2026-08-11T12:00:00Z',
    fleetsharp_latitude: 2, fleetsharp_longitude: 2, fleetsharp_speed: 20, fleetsharp_status: 'MOVING', fleetsharp_updated_at: '2026-08-11T11:55:00Z',
  };
  // Jobber's timestamp is 5 minutes NEWER here. Under the old merge it won.
  const fresh = vehicleGps(v, Date.parse('2026-08-11T12:00:00Z'));
  assert.deepEqual(fresh, {
    lat: 2, lng: 2, speed: 20, status: 'MOVING', updatedAt: '2026-08-11T11:55:00Z',
    source: 'fleetsharp', ageMs: 5 * 60 * 1000, stale: false,
  });
});

test('vehicleGps: a vehicle FleetSharp has never reported returns no position at all -- never a Jobber one', () => {
  // The old behaviour returned Jobber's coordinates here. That is exactly how
  // 2026-07-28 positions kept reaching the map.
  const v = {
    latitude: 1, longitude: 1, speed: 5, status: 'DRIVING', gps_updated_at: '2026-08-10T00:00:00Z',
    fleetsharp_latitude: null, fleetsharp_longitude: null, fleetsharp_speed: null, fleetsharp_status: null, fleetsharp_updated_at: null,
  };
  const fresh = vehicleGps(v, Date.parse('2026-08-10T00:10:00Z'));
  assert.equal(fresh.lat, null, 'no FleetSharp fix means no position');
  assert.equal(fresh.source, 'fleetsharp', 'the source is always FleetSharp now');
  assert.equal(fresh.stale, true, 'and it must read as stale, not as a live Jobber fix');
  assert.equal(fresh.ageMs, null);
});

test('vehicleGps: a FleetSharp fix that has gone quiet is flagged stale', () => {
  const v = {
    fleetsharp_latitude: 2, fleetsharp_longitude: 2, fleetsharp_speed: 0, fleetsharp_status: 'STOPPED', fleetsharp_updated_at: '2026-08-15T20:00:00Z',
  };
  const fresh = vehicleGps(v, Date.parse('2026-08-15T21:16:00Z'));
  assert.equal(fresh.stale, true, '76 minutes is past the 30-minute threshold');
  assert.ok(fresh.ageMs > 60 * 60 * 1000, 'and its age is reported so a caller can say how old');
  assert.equal(fresh.lat, 2, 'the position is still returned -- the caller decides whether to draw it');
});

test('vehicleGps: a position with no timestamp counts as stale, with an unknown age', () => {
  const v = { fleetsharp_latitude: 1, fleetsharp_longitude: 1, fleetsharp_speed: 0, fleetsharp_status: 'OFF', fleetsharp_updated_at: null };
  const fresh = vehicleGps(v, Date.now());
  assert.equal(fresh.stale, true, 'undated cannot be shown as current');
  assert.equal(fresh.ageMs, null, 'and its age is unknown, not zero');
});

test('every vehicle-position read selects the FleetSharp columns and no Jobber ones', () => {
  // The four endpoints that regressed did so by selecting
  // latitude/longitude/gps_updated_at directly and never calling the helper.
  // One shared constant is what stops that happening again.
  for (const col of ['fleetsharp_latitude', 'fleetsharp_longitude', 'fleetsharp_speed', 'fleetsharp_status', 'fleetsharp_updated_at']) {
    assert.ok(VEHICLE_GPS_COLUMNS.includes(col), `${col} must be selected`);
  }
  for (const col of ['gps_updated_at', 'latitude', 'longitude']) {
    assert.ok(!VEHICLE_GPS_COLUMNS.split(',').includes(col), `${col} must NOT be selected for position`);
  }
});

test('no read path in track1 reads a Jobber position column any more', () => {
  const src = fsSync.readFileSync('api/track1.js', 'utf8');
  const offenders = src.match(/\b(v|row|vehicle)\.(latitude|longitude|gps_updated_at)\b/g) || [];
  assert.deepEqual(offenders, [], `these read Jobber GPS directly: ${offenders.join(', ')}`);
});
