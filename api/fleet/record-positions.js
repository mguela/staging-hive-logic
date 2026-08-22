// api/fleet/record-positions.js - Vercel serverless function (Fleet Slice 3 via FleetSharp)
//
// ADDITIVE ONLY. Snapshots the live GPS already landing in public.vehicles
// (FleetSharp Push + Jobber sync) into the Fleet history tables:
//   - fleet_positions       : append-only location history (the "where has it been")
//   - fleet_vehicle_latest  : one compact current-state row per truck (map/UI)
//
// Reads public.vehicles; NEVER writes to it (locked decision: Fleet never
// writes the mirror). Runs on a Vercel cron every few minutes. Idempotent:
// a position is only appended when strictly newer than the last one stored,
// so repeated ticks on an unchanged truck are no-ops.
//
// Gated by FLEET_ENABLED. Auth: Vercel cron (CRON_SECRET) or a signed-in user,
// via the canonical requireApiAuth gate.

import { supabaseRequest } from '../_lib/jobber.js';
import { requireApiAuth } from '../_lib/guard.js';
import {
  pickFreshestFix,
  shouldRecord,
  movementState,
  positionHash,
} from '../_lib/fleet/positions.js';

export default async function handler(req, res) {
  const gate = await requireApiAuth(req);
  if (!gate.ok) {
    return res.status(401).json({ ok: false, error: 'This endpoint runs on Vercel Cron (Bearer CRON_SECRET) or a signed-in user.' });
  }
  if (process.env.FLEET_ENABLED !== 'true') {
    return res.status(200).json({ ok: true, enabled: false, note: 'Fleet is disabled. Set FLEET_ENABLED=true to record positions.' });
  }

  try {
    // 1) VIN-linked, active Fleet vehicles.
    const fvRes = await supabaseRequest('fleet_vehicles?select=id,vin,company_id&vin=not.is.null&status=eq.active');
    if (!fvRes.ok) {
      return res.status(502).json({ ok: false, error: 'Could not read fleet_vehicles.', status: fvRes.status });
    }
    const fleetVehicles = await fvRes.json().catch(() => []);
    if (!Array.isArray(fleetVehicles) || fleetVehicles.length === 0) {
      return res.status(200).json({ ok: true, enabled: true, checked: 0, recorded: 0, skipped: 0, note: 'No VIN-linked vehicles yet.' });
    }

    // 2) Current GPS from the mirror for those VINs.
    const vinList = fleetVehicles.map((v) => `"${String(v.vin).replace(/"/g, '')}"`).join(',');
    const cols = 'vin,latitude,longitude,speed,status,gps_updated_at,fleetsharp_latitude,fleetsharp_longitude,fleetsharp_speed,fleetsharp_status,fleetsharp_updated_at';
    const mvRes = await supabaseRequest(`vehicles?select=${cols}&vin=in.(${vinList})`);
    const mirror = mvRes.ok ? await mvRes.json().catch(() => []) : [];
    const mirrorByVin = new Map(mirror.map((m) => [m.vin, m]));

    // 3) Last recorded device_time per fleet vehicle.
    const latRes = await supabaseRequest('fleet_vehicle_latest?select=vehicle_id,last_device_time');
    const latest = latRes.ok ? await latRes.json().catch(() => []) : [];
    const lastByVehicle = new Map(latest.map((l) => [l.vehicle_id, l.last_device_time]));

    let recorded = 0;
    let skipped = 0;
    const errors = [];

    for (const fv of fleetVehicles) {
      try {
        const fix = pickFreshestFix(mirrorByVin.get(fv.vin));
        if (!fix || !shouldRecord(fix, lastByVehicle.get(fv.id))) { skipped++; continue; }

        // Append history row.
        const positionRow = {
          company_id: fv.company_id,
          vehicle_id: fv.id,
          device_time: fix.deviceTime,
          latitude: fix.lat,
          longitude: fix.lng,
          speed: fix.speed,
          valid_fix: true,
          inputs: { src: 'mirror', source_feed: fix.source, status: fix.status },
          raw_record_hash: positionHash(fv.id, fix.deviceTime, fix.source),
        };
        const insRes = await supabaseRequest('fleet_positions', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(positionRow),
        });
        if (!insRes.ok) { skipped++; errors.push({ vehicle_id: fv.id, step: 'insert_position', status: insRes.status }); continue; }
        const inserted = await insRes.json().catch(() => []);
        const positionId = Array.isArray(inserted) && inserted[0] ? inserted[0].id : null;

        // Upsert compact latest-state row.
        const latestRow = {
          company_id: fv.company_id,
          vehicle_id: fv.id,
          position_id: positionId,
          last_device_time: fix.deviceTime,
          last_received_at: new Date().toISOString(),
          lat: fix.lat,
          lng: fix.lng,
          speed: fix.speed,
          movement_state: movementState(fix.status, fix.speed),
          stale: false,
          updated_at: new Date().toISOString(),
        };
        await supabaseRequest('fleet_vehicle_latest?on_conflict=vehicle_id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(latestRow),
        });

        recorded++;
      } catch (e) {
        skipped++;
        errors.push({ vehicle_id: fv.id, error: String(e && e.message ? e.message : e) });
      }
    }

    return res.status(200).json({
      ok: true,
      enabled: true,
      checked: fleetVehicles.length,
      recorded,
      skipped,
      ...(errors.length ? { errors } : {}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}
