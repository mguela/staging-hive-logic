// api/_lib/geocode.js
// Forward-geocode one address: text in, coordinates out.
//
// Two tiers, same order api/jobber/sync-extended.js uses for client locations:
// Nominatim/OpenStreetMap first because it returns true address-point
// coordinates when OSM has the parcel, then the US Census geocoder, which has
// near-complete US street coverage but interpolates along the street segment.
//
// DUPLICATION, NAMED RATHER THAN HIDDEN: sync-extended.js has its own private
// copies of these two calls, wrapped in the batch machinery that walks
// thousands of client rows against a deadline. This module is the single-address
// primitive that a service-area centre needs. Folding the cron onto this module
// is worth doing, but that cron has no test coverage at all, so doing it in the
// same change as a new feature would mean refactoring an untested job with no
// safety net. Listed as a follow-up in REPORT.md instead.
//
// Never throws. A geocoder being down must leave the address saved and the
// coordinates null, not fail the save.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
// Nominatim's usage policy requires a real, identifying User-Agent.
const USER_AGENT = 'HiveLogic/1.0 c_kendall@icloud.com';

function coords(lat, lng, source, label) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return null;
  return { lat: la, lng: ln, source, label: label || null };
}

async function nominatim(address, fetchImpl) {
  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(address)}`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) return null;
  const rows = await res.json();
  const hit = Array.isArray(rows) ? rows[0] : null;
  if (!hit) return null;
  return coords(hit.lat, hit.lon, 'nominatim', hit.display_name);
}

async function census(address, fetchImpl) {
  const url = `${CENSUS_URL}?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(address)}`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json();
  const match = data && data.result && Array.isArray(data.result.addressMatches)
    ? data.result.addressMatches[0] : null;
  if (!match || !match.coordinates) return null;
  return coords(match.coordinates.y, match.coordinates.x, 'census', match.matchedAddress);
}

/**
 * Resolve an address to { lat, lng, source, label }, or null.
 *
 * `fetchImpl` is injectable so the tests never touch the network — which also
 * means the failure paths are actually exercised rather than assumed.
 */
export async function geocodeAddress(address, { fetchImpl = fetch } = {}) {
  const q = String(address || '').trim();
  // Two characters cannot be an address, and sending junk to a public geocoder
  // that rate-limits us is worse than declining locally.
  if (q.length < 3) return null;

  try {
    const osm = await nominatim(q, fetchImpl);
    if (osm) return osm;
  } catch { /* fall through to the second tier */ }

  try {
    const c = await census(q, fetchImpl);
    if (c) return c;
  } catch { /* both tiers down */ }

  return null;
}
