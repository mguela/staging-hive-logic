// api/_lib/fleet/positions.js
//
// HiveLogic Fleet — Slice 3 (via FleetSharp): pure helpers for recording truck
// position history. No hardware needed — we snapshot the live GPS that already
// lands in public.vehicles (FleetSharp Push + Jobber sync) into the Fleet
// history tables (fleet_positions + fleet_vehicle_latest).
//
// These functions are PURE (no I/O) so they are unit-tested without a database.
// The endpoint api/fleet/record-positions.js wires them to PostgREST.

// public.vehicles carries two independent GPS sources (see sql/068_fleetsharp_push):
//   FleetSharp: fleetsharp_latitude/longitude/speed/status/fleetsharp_updated_at
//   Jobber:     latitude/longitude/speed/status/gps_updated_at
// Pick whichever has the NEWER timestamp — "FleetSharp primary, Jobber fallback"
// is just "whichever moved most recently", exactly like api/track1.js does.
export function pickFreshestFix(v) {
  if (!v) return null;
  const candidates = [
    {
      source: 'fleetsharp',
      lat: num(v.fleetsharp_latitude),
      lng: num(v.fleetsharp_longitude),
      speed: num(v.fleetsharp_speed),
      status: v.fleetsharp_status || null,
      deviceTime: isoOrNull(v.fleetsharp_updated_at),
    },
    {
      source: 'jobber',
      lat: num(v.latitude),
      lng: num(v.longitude),
      speed: num(v.speed),
      status: v.status || null,
      deviceTime: isoOrNull(v.gps_updated_at),
    },
  ].filter((c) => c.lat != null && c.lng != null && c.deviceTime != null);

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Date.parse(b.deviceTime) - Date.parse(a.deviceTime));
  return candidates[0];
}

// Only record when this fix is strictly newer than what we last stored for the
// vehicle — this is the idempotency guard that keeps each cron tick from
// inserting a duplicate of the same unchanged position.
export function shouldRecord(fix, lastDeviceTimeIso) {
  if (!fix || !fix.deviceTime) return false;
  if (!lastDeviceTimeIso) return true;
  return Date.parse(fix.deviceTime) > Date.parse(lastDeviceTimeIso);
}

// Coarse movement state for the compact latest-state row / map.
export function movementState(status, speed) {
  const s = (status || '').toString().trim().toUpperCase();
  if (s === 'DRIVING' || s === 'MOVING') return 'moving';
  if (s === 'IDLE' || s === 'IDLING') return 'idle';
  if (s === 'OFF' || s === 'PARKED' || s === 'STOPPED') return 'parked';
  if (typeof speed === 'number' && speed > 1) return 'moving';
  if (typeof speed === 'number' && speed === 0) return 'parked';
  return 'unknown';
}

// Stable dedup key for a snapshot (no device id — this is mirror-sourced).
export function positionHash(vehicleId, deviceTimeIso, source) {
  return `mirror:${source || 'na'}:${vehicleId}:${deviceTimeIso}`;
}

function num(x) {
  if (x == null || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function isoOrNull(x) {
  if (!x) return null;
  const t = Date.parse(x);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}
