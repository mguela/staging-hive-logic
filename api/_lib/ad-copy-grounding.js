// api/_lib/ad-copy-grounding.js
// Real grounding facts for ad copy generation -- same job-classification
// approach api/marketing.js already uses for its own campaign copy and
// planning-assumption facts (realDivisionJobFacts / realServiceTerritoryForPlan).
// Kept here rather than imported (marketing.js has no exports for it) so
// this module has one clear job: real facts in, no fabricated claim out.
// If marketing.js's division classifier ever changes, update the copy here
// too -- see the comment at its definition in api/marketing.js.

import { supabaseRequest as defaultSupabaseRequest } from './jobber.js';

const KNOWN_DIVISIONS = ['HVAC', 'Electric', 'Plumbing', 'Design|Build', 'Outdoor Spaces', 'Handyman'];

const PAGE_SIZE = 1000;
const MAX_PAGES = 10;

export async function fetchAllRows(table, query, supabaseRequest) {
  let all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const sep = query.includes('?') ? '&' : '?';
    const res = await supabaseRequest(table + query + sep + 'limit=' + PAGE_SIZE + '&offset=' + offset);
    if (!res.ok) {
      const text = await res.text();
      const err = new Error('Failed to read ' + table + ': ' + text);
      if (res.status === 404 || /relation .* does not exist/i.test(text)) err.notSynced = true;
      throw err;
    }
    const rows = await res.json();
    all = all.concat(rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

export function jobDivision(title) {
  const t = String(title || '').toLowerCase();
  if (/hvac|heat pump|furnace|boiler|air condition|mini.?split|condenser|thermostat/.test(t)) return 'HVAC';
  if (/electric|panel upgrade|outlet|wiring|lighting|generator|ev charger|breaker|recessed/.test(t)) return 'Electric';
  if (/plumb|water heater|drain|sewer|faucet|toilet|leak|pipe|sump|shower valve/.test(t)) return 'Plumbing';
  if (/design|build|renovat|remodel|addition|kitchen|basement|bath/.test(t)) return 'Design|Build';
  if (/outdoor|patio|deck|landscap|fence|paver|pergola|masonry|walkway|yard|drainage/.test(t)) return 'Outdoor Spaces';
  if (/handyman|repair|install|mount|assemble|caulk|paint|door|window|gutter|trim|shelv|punch/.test(t)) return 'Handyman';
  return 'Handyman';
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function realDivisionJobFacts(division, supabaseRequest = defaultSupabaseRequest) {
  let rows;
  try {
    rows = await fetchAllRows('jobs', '?select=title,total,completed_at&completed_at=not.is.null', supabaseRequest);
  } catch (e) {
    if (e.notSynced) return { completedJobCount: 0, completedJobCountLast180Days: 0, avgJobValueCents: null };
    throw e;
  }
  const since180 = Date.now() - 180 * 24 * 60 * 60 * 1000;
  const matched = rows.filter((r) => jobDivision(r.title) === division);
  const recentMatched = matched.filter((r) => r.completed_at && new Date(r.completed_at).getTime() >= since180);
  const withTotal = matched.filter((r) => Number(r.total) > 0);
  const avgTotalCents = withTotal.length
    ? Math.round((withTotal.reduce((s, r) => s + Number(r.total || 0), 0) / withTotal.length) * 100)
    : null;
  return {
    completedJobCount: matched.length,
    completedJobCountLast180Days: recentMatched.length,
    avgJobValueCents: avgTotalCents,
  };
}

export async function realServiceTerritoryFacts(supabaseRequest = defaultSupabaseRequest) {
  try {
    const [officeRows, clientLocs] = await Promise.all([
      fetchAllRows('office_location', '?id=eq.hq&select=lat,lng', supabaseRequest),
      fetchAllRows('client_locations', '?select=lat,lng&lat=not.is.null', supabaseRequest),
    ]);
    const office = officeRows[0];
    if (!office || !isFinite(Number(office.lat)) || !isFinite(Number(office.lng))) {
      return { geocodedCustomerCount: 0, avgDistanceMiles: null, maxDistanceMiles: null, officeSet: false };
    }
    const officeLat = Number(office.lat);
    const officeLng = Number(office.lng);
    const distances = clientLocs
      .filter((c) => isFinite(Number(c.lat)) && isFinite(Number(c.lng)))
      .map((c) => haversineMiles(officeLat, officeLng, Number(c.lat), Number(c.lng)));
    if (!distances.length) {
      return { geocodedCustomerCount: 0, avgDistanceMiles: null, maxDistanceMiles: null, officeSet: true };
    }
    const sum = distances.reduce((s, d) => s + d, 0);
    return {
      geocodedCustomerCount: distances.length,
      avgDistanceMiles: Math.round((sum / distances.length) * 10) / 10,
      maxDistanceMiles: Math.round(Math.max(...distances) * 10) / 10,
      officeSet: true,
    };
  } catch (e) {
    if (e.notSynced) return { geocodedCustomerCount: 0, avgDistanceMiles: null, maxDistanceMiles: null, officeSet: false };
    throw e;
  }
}

export { KNOWN_DIVISIONS };
