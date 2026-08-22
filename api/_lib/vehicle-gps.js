// Canonical vehicle-position source shared by every server-side consumer.
// FleetSharp is the only trusted live feed on this account; Jobber's legacy
// latitude/longitude columns are retained in the database but must not be used
// for current-position decisions because that feed has been frozen in place.

export const VEHICLE_GPS_STALE_MS = 30 * 60 * 1000;

export const VEHICLE_GPS_COLUMNS =
  'fleetsharp_latitude,fleetsharp_longitude,fleetsharp_speed,fleetsharp_status,fleetsharp_updated_at';

export function vehicleGps(vehicle, nowMs) {
  const v = vehicle || {};
  const now = nowMs || Date.now();
  const at = v.fleetsharp_updated_at ? new Date(v.fleetsharp_updated_at).getTime() : 0;
  const position = {
    lat: v.fleetsharp_latitude,
    lng: v.fleetsharp_longitude,
    speed: v.fleetsharp_speed,
    status: v.fleetsharp_status,
    updatedAt: v.fleetsharp_updated_at,
    source: 'fleetsharp',
  };
  position.ageMs = at > 0 ? Math.max(0, now - at) : null;
  position.stale = !(at > 0 && (now - at) < VEHICLE_GPS_STALE_MS);
  return position;
}
