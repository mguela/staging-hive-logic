// api/fleet/detect-presence.js - Vercel serverless function (Fleet Slice 6)
//
// ADDITIVE ONLY. Turns recorded truck positions (fleet_positions) into
// "truck was at job Y from arrived_at to departed_at" intervals
// (fleet_job_presence), by matching each position to job sites SCHEDULED
// around that time (jobs_enriched coords). Evidence only — no billing, no
// alerts. Reina's TIME_MISMATCH consumes this later, after human verification.
//
// Gated by FLEET_ENABLED. Auth: Vercel cron (CRON_SECRET) or signed-in user.

import { supabaseRequest } from '../_lib/jobber.js';
import { requireApiAuth } from '../_lib/guard.js';
import { detectPresence } from '../_lib/fleet/geo.js';

const POSITION_LOOKBACK_HOURS = 24;   // how far back to re-derive visits each run
const JOB_WINDOW_BUFFER_MS = 3 * 3600 * 1000; // schedule slop around a job's start/end
const RADIUS_M = 150;                 // ~500 ft geofence

export default async function handler(req, res) {
  const gate = await requireApiAuth(req);
  if (!gate.ok) {
    return res.status(401).json({ ok: false, error: 'This endpoint runs on Vercel Cron (Bearer CRON_SECRET) or a signed-in user.' });
  }
  if (process.env.FLEET_ENABLED !== 'true') {
    return res.status(200).json({ ok: true, enabled: false, note: 'Fleet is disabled. Set FLEET_ENABLED=true to detect presence.' });
  }

  try {
    const nowMs = Date.now();
    const sinceIso = new Date(nowMs - POSITION_LOOKBACK_HOURS * 3600 * 1000).toISOString();

    // 1) Candidate sites: geocoded jobs with an actual VISIT scheduled around
    // now. This must key off visits.start_at/end_at, not the parent job's own
    // start_at/end_at -- a job's own span covers the whole project (a
    // multi-week renovation), so filtering on it silently excluded every
    // multi-day job's visit today. Confirmed live: a "HALL BATH RENOVATION"
    // job had a real, geocoded visit scheduled today, but the job record's
    // own start_at/end_at was over a week in the past. visits.job_id matches
    // jobs.jobber_id (the same join api/track1.js's crew_schedule uses).
    const jobWindowLoIso = new Date(nowMs - 2 * 24 * 3600 * 1000).toISOString();
    const jobWindowHiIso = new Date(nowMs + 1 * 24 * 3600 * 1000).toISOString();
    const visitsRes = await supabaseRequest(
      `visits?select=job_id,start_at,end_at&end_at=gte.${jobWindowLoIso}&start_at=lte.${jobWindowHiIso}`,
    );
    const visitRows = visitsRes.ok ? await visitsRes.json().catch(() => []) : [];
    if (!Array.isArray(visitRows) || visitRows.length === 0) {
      return res.status(200).json({ ok: true, enabled: true, candidateJobs: 0, checked: 0, upserted: 0, note: 'No scheduled visits in window.' });
    }

    const jobberIds = [...new Set(visitRows.map((v) => v.job_id).filter(Boolean))]
      .map((id) => `"${String(id).replace(/"/g, '')}"`)
      .join(',');

    // Geocode per job (jobs_enriched) and uuid per job (jobs) -- jobs_enriched
    // doesn't carry uuid_id, so both lookups are still needed.
    const [jeRes, jMapRes] = await Promise.all([
      supabaseRequest(`jobs_enriched?select=jobber_id,gps_lat,gps_lng&jobber_id=in.(${jobberIds})&gps_lat=not.is.null`),
      supabaseRequest(`jobs?select=jobber_id,uuid_id&jobber_id=in.(${jobberIds})`),
    ]);
    const jeRows = jeRes.ok ? await jeRes.json().catch(() => []) : [];
    const geoByJobber = new Map(jeRows.map((j) => [j.jobber_id, { lat: Number(j.gps_lat), lng: Number(j.gps_lng) }]));
    const jMap = jMapRes.ok ? await jMapRes.json().catch(() => []) : [];
    const uuidByJobber = new Map(jMap.map((j) => [j.jobber_id, j.uuid_id]));

    const candidateJobs = visitRows
      .map((v) => {
        const geo = geoByJobber.get(v.job_id);
        const jobUuid = uuidByJobber.get(v.job_id);
        if (!geo || !jobUuid) return null;
        return {
          jobUuid,
          lat: geo.lat,
          lng: geo.lng,
          windowStart: v.start_at ? Date.parse(v.start_at) - JOB_WINDOW_BUFFER_MS : null,
          windowEnd: v.end_at ? Date.parse(v.end_at) + JOB_WINDOW_BUFFER_MS : null,
        };
      })
      .filter(Boolean);

    if (candidateJobs.length === 0) {
      return res.status(200).json({ ok: true, enabled: true, candidateJobs: 0, checked: 0, upserted: 0, note: 'No scheduled visits in window have a geocoded job.' });
    }

    // 2) Active fleet vehicles.
    const fvRes = await supabaseRequest('fleet_vehicles?select=id,company_id&status=eq.active');
    const fleetVehicles = fvRes.ok ? await fvRes.json().catch(() => []) : [];

    let checked = 0;
    let upserted = 0;
    const errors = [];

    for (const fv of fleetVehicles) {
      try {
        // 3) Recent positions for this vehicle, oldest first.
        const posRes = await supabaseRequest(
          `fleet_positions?select=id,device_time,latitude,longitude&vehicle_id=eq.${fv.id}&device_time=gte.${sinceIso}&order=device_time.asc&limit=2000`,
        );
        const rows = posRes.ok ? await posRes.json().catch(() => []) : [];
        if (!Array.isArray(rows) || rows.length === 0) continue;
        checked++;

        const positions = rows.map((r) => ({
          t: Date.parse(r.device_time),
          lat: r.latitude != null ? Number(r.latitude) : null,
          lng: r.longitude != null ? Number(r.longitude) : null,
          id: r.id,
        }));

        const intervals = detectPresence(positions, candidateJobs, { radiusM: RADIUS_M });

        // Every run re-derives intervals from scratch out of whatever position
        // array this fetch happened to return, so a still-open visit's computed
        // arrived_at is not guaranteed to come out byte-identical run to run
        // (the 24h lookback, the candidate-job window, and valid_fix gaps can
        // all shift it). The original write path merged on
        // (vehicle_id, job_uuid, arrived_at), so any such drift silently
        // inserted a brand-new row instead of extending the existing one --
        // confirmed in production as ~9 near-duplicate rows for one continuous
        // visit, all sharing the same final departed_at. Fixed by tracking the
        // visit by its currently-OPEN row (status='present') per (vehicle_id,
        // job_uuid) and PATCHing that row's departed_at/status forward,
        // leaving its original arrived_at untouched. A genuine leave-and-return
        // within a single run's window still yields two intervals (unchanged,
        // documented behavior of detectPresence): the open row is consumed by
        // the first of the two and closed out, so the second correctly inserts
        // a fresh row rather than reusing it.
        const openRes = await supabaseRequest(
          `fleet_job_presence?select=id,job_uuid&vehicle_id=eq.${fv.id}&status=eq.present`,
        );
        const openRows = openRes.ok ? await openRes.json().catch(() => []) : [];
        const openIdByJob = new Map(openRows.map((r) => [r.job_uuid, r.id]));

        for (const iv of intervals) {
          const stillHere = iv.departureIndex === positions.length - 1;
          const existingId = openIdByJob.get(iv.jobUuid);
          if (existingId) openIdByJob.delete(iv.jobUuid);

          if (existingId) {
            const patch = {
              departed_at: new Date(iv.departedAt).toISOString(),
              departure_confidence: stillHere ? null : iv.confidence,
              departure_source: stillHere ? null : 'geofence_engine',
              departure_position_id: positions[iv.departureIndex] ? positions[iv.departureIndex].id : null,
              sample_count: iv.samples,
              status: stillHere ? 'present' : 'complete',
              updated_at: new Date().toISOString(),
            };
            const patchRes = await supabaseRequest(`fleet_job_presence?id=eq.${existingId}`, {
              method: 'PATCH',
              headers: { Prefer: 'return=minimal' },
              body: JSON.stringify(patch),
            });
            if (patchRes.ok) upserted++;
            else errors.push({ vehicle_id: fv.id, job_uuid: iv.jobUuid, status: patchRes.status });
            continue;
          }

          const row = {
            company_id: fv.company_id,
            vehicle_id: fv.id,
            job_uuid: iv.jobUuid,
            arrived_at: new Date(iv.arrivedAt).toISOString(),
            departed_at: new Date(iv.departedAt).toISOString(),
            arrival_confidence: iv.confidence,
            departure_confidence: stillHere ? null : iv.confidence,
            arrival_source: 'geofence_engine',
            departure_source: stillHere ? null : 'geofence_engine',
            arrival_position_id: positions[iv.arrivalIndex] ? positions[iv.arrivalIndex].id : null,
            departure_position_id: positions[iv.departureIndex] ? positions[iv.departureIndex].id : null,
            sample_count: iv.samples,
            status: stillHere ? 'present' : 'complete',
            updated_at: new Date().toISOString(),
          };
          const upRes = await supabaseRequest(
            'fleet_job_presence?on_conflict=company_id,vehicle_id,job_uuid,arrived_at',
            {
              method: 'POST',
              headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
              body: JSON.stringify(row),
            },
          );
          if (upRes.ok) upserted++;
          else errors.push({ vehicle_id: fv.id, job_uuid: iv.jobUuid, status: upRes.status });
        }
      } catch (e) {
        errors.push({ vehicle_id: fv.id, error: String(e && e.message ? e.message : e) });
      }
    }

    return res.status(200).json({
      ok: true,
      enabled: true,
      candidateJobs: candidateJobs.length,
      checked,
      upserted,
      ...(errors.length ? { errors } : {}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}
