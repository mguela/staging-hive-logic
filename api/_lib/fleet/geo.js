// api/_lib/fleet/geo.js
//
// HiveLogic Fleet — Slice 6: geofence / job-presence detection.
// PURE functions (no I/O), unit-tested. api/fleet/detect-presence.js wires them
// to the database.
//
// The job: given a truck's recent position history and the job sites it could
// plausibly have visited (already narrowed to jobs SCHEDULED around that time,
// so a truck near an unrelated past client's house doesn't false-match), work
// out the arrival/departure intervals — "truck X was at job Y from 09:12 to
// 12:40". This is evidence only; nothing here decides billing.

const EARTH_RADIUS_M = 6371000;

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Nearest candidate job within radius for one position. A job may carry an
// optional [windowStart, windowEnd] (ms) — its scheduled span with buffer; if
// present, the position's time must fall inside it to count. Returns
// { jobUuid, distanceM } or null.
export function nearestJobWithin(pos, jobs, radiusM) {
  let best = null;
  for (const j of jobs) {
    if (j.lat == null || j.lng == null) continue;
    if (j.windowStart != null && pos.t < j.windowStart) continue;
    if (j.windowEnd != null && pos.t > j.windowEnd) continue;
    const d = haversineMeters(pos.lat, pos.lng, j.lat, j.lng);
    if (d <= radiusM && (best === null || d < best.distanceM)) {
      best = { jobUuid: j.jobUuid, distanceM: d };
    }
  }
  return best;
}

// Confidence 0-100 from how much evidence backs the interval: more in-radius
// samples and longer dwell => higher. A single drive-by snapshot stays low.
export function presenceConfidence(samples, dwellMs) {
  const bySamples = Math.min(70, samples * 20); // 1->20, 2->40, 3->60, 4+->70
  const dwellMin = dwellMs / 60000;
  const byDwell = Math.min(30, Math.round(dwellMin)); // up to +30 for >=30 min
  return Math.max(0, Math.min(100, bySamples + byDwell));
}

// Walk time-ordered positions; emit one interval per unbroken run of the same
// job. Leaving and returning to the same job yields two intervals (correct).
// positions: [{ t:ms, lat, lng }] sorted ascending by t.
export function detectPresence(positions, jobs, opts = {}) {
  const radiusM = opts.radiusM != null ? opts.radiusM : 150; // ~500 ft
  const minSamples = opts.minSamples != null ? opts.minSamples : 1;

  const intervals = [];
  let cur = null; // { jobUuid, arrivedAt, departedAt, samples, arrivalIndex, departureIndex }

  const flush = () => {
    if (cur && cur.samples >= minSamples) {
      const dwellMs = cur.departedAt - cur.arrivedAt;
      intervals.push({
        jobUuid: cur.jobUuid,
        arrivedAt: cur.arrivedAt,
        departedAt: cur.departedAt,
        samples: cur.samples,
        arrivalIndex: cur.arrivalIndex,
        departureIndex: cur.departureIndex,
        dwellMs,
        confidence: presenceConfidence(cur.samples, dwellMs),
      });
    }
    cur = null;
  };

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    if (p == null || p.lat == null || p.lng == null || p.t == null) { flush(); continue; }
    const hit = nearestJobWithin(p, jobs, radiusM);
    if (!hit) { flush(); continue; }

    if (cur && cur.jobUuid === hit.jobUuid) {
      cur.departedAt = p.t;
      cur.departureIndex = i;
      cur.samples += 1;
    } else {
      flush();
      cur = { jobUuid: hit.jobUuid, arrivedAt: p.t, departedAt: p.t, samples: 1, arrivalIndex: i, departureIndex: i };
    }
  }
  flush();
  return intervals;
}
