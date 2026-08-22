// api/_lib/service-area.js
//
// The geometry behind a division's service area. Pure functions, no I/O, so
// every boundary case below is pinned by a test rather than argued about.
//
// Three jobs:
//   1. Turn a centre + radius into the camera a map should open on. This is
//      what replaces the hardcoded centre in public/schedule-board/data.js and
//      the hardcoded zoom levels scattered through the map call sites.
//   2. Answer "is this address inside the area we actually work in?" for lead
//      triage and out-of-area flagging.
//   3. Combine several divisions into one company-wide view, for surfaces that
//      show everything at once.

const EARTH_RADIUS_MILES = 3958.7613;

/** Miles between two points, great-circle. */
export function distanceMiles(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A usable area is one that can actually place a circle on a map. */
export function isUsable(area) {
  return Boolean(area
    && area.service_center_lat != null
    && area.service_center_lng != null
    && Number(area.service_radius_miles) > 0);
}

/** The area as a plain { lat, lng, radiusMiles }, or null. */
export function normalize(area) {
  if (!isUsable(area)) return null;
  return {
    lat: Number(area.service_center_lat),
    lng: Number(area.service_center_lng),
    radiusMiles: Number(area.service_radius_miles),
    label: area.service_center_label || null,
  };
}

/**
 * The bounding box that exactly contains the circle.
 *
 * Longitude degrees shrink as you move away from the equator, so the east/west
 * span is divided by cos(latitude). Skipping that is the classic bug: the box
 * looks right in Ecuador and is far too narrow in Connecticut, which would cut
 * the east and west edges off the very area it is meant to frame.
 */
export function boundsOf(area) {
  const a = normalize(area);
  if (!a) return null;
  const latDelta = a.radiusMiles / 69.0;
  const cos = Math.cos((a.lat * Math.PI) / 180);
  // Guard the poles, where cos -> 0 and the division explodes.
  const lngDelta = a.radiusMiles / (69.0 * Math.max(0.01, Math.abs(cos)));
  return {
    south: a.lat - latDelta,
    north: a.lat + latDelta,
    west: a.lng - lngDelta,
    east: a.lng + lngDelta,
  };
}

/**
 * The web-mercator zoom at which a circle of this radius fills a viewport.
 *
 * Derived rather than tabulated: at zoom z the world is 256 * 2^z pixels wide,
 * so the degrees visible across a viewport of `widthPx` is
 * 360 * widthPx / (256 * 2^z). Solving for the zoom that fits the circle's
 * longitude span gives the expression below.
 *
 * Clamped to 3..16. Below 3 the map is showing continents, above 16 it is
 * showing individual driveways -- neither is a sensible "open here" view, and
 * a radius of 0.1 or 5000 miles should still produce a usable screen.
 */
export function zoomForRadius(radiusMiles, widthPx = 900, lat = 41) {
  const r = Number(radiusMiles);
  if (!Number.isFinite(r) || r <= 0) return null;
  const cos = Math.max(0.01, Math.abs(Math.cos((Number(lat) * Math.PI) / 180)));
  // Full width of the circle in degrees of longitude, plus 15% breathing room
  // so the edge of the area is not flush against the edge of the screen.
  const spanDeg = (2 * r * 1.15) / (69.0 * cos);
  const zoom = Math.log2((360 * widthPx) / (256 * spanDeg));
  return Math.max(3, Math.min(16, Math.round(zoom * 10) / 10));
}

/** The camera a map should open on for one area. */
export function cameraFor(area, widthPx = 900) {
  const a = normalize(area);
  if (!a) return null;
  return {
    center: { lat: a.lat, lng: a.lng },
    zoom: zoomForRadius(a.radiusMiles, widthPx, a.lat),
    radiusMiles: a.radiusMiles,
    label: a.label,
  };
}

/** Is this point inside the area? Null when the area cannot answer. */
export function containsPoint(area, point) {
  const a = normalize(area);
  if (!a || !point || point.lat == null || point.lng == null) return null;
  const d = distanceMiles({ lat: a.lat, lng: a.lng }, point);
  return d == null ? null : d <= a.radiusMiles;
}

/**
 * Which divisions cover this point, nearest first.
 * The answer to "who should take this lead?" as well as "is it in area at all?".
 */
export function divisionsCovering(areas, point) {
  return (areas || [])
    .map((d) => {
      const a = normalize(d);
      if (!a) return null;
      const distance = distanceMiles({ lat: a.lat, lng: a.lng }, point);
      if (distance == null) return null;
      return {
        id: d.id, name: d.name, distanceMiles: distance,
        radiusMiles: a.radiusMiles, covers: distance <= a.radiusMiles,
      };
    })
    .filter(Boolean)
    .filter((d) => d.covers)
    // Nearest first; on a tie the TIGHTER area wins. Two divisions working out
    // of the same shop are exactly equidistant from every point, so distance
    // alone would leave the answer to whatever order the rows arrived in. The
    // smaller radius is the more specific claim on the work.
    .sort((x, y) => (x.distanceMiles - y.distanceMiles) || (x.radiusMiles - y.radiusMiles));
}

/**
 * One camera framing every usable division at once.
 *
 * Deliberately NOT the average of the centres. A company working Greenwich and
 * Boca Raton has a mean somewhere off the Carolina coast -- a centre in the
 * ocean, at a zoom showing neither place. Framing the union of the bounding
 * boxes puts both on screen, which is the only honest "show me everything".
 */
export function companyCamera(areas, widthPx = 900) {
  const boxes = (areas || []).map(boundsOf).filter(Boolean);
  if (!boxes.length) return null;
  if (boxes.length === 1) {
    const only = (areas || []).find((a) => isUsable(a));
    return cameraFor(only, widthPx);
  }
  const south = Math.min(...boxes.map((b) => b.south));
  const north = Math.max(...boxes.map((b) => b.north));
  const west = Math.min(...boxes.map((b) => b.west));
  const east = Math.max(...boxes.map((b) => b.east));
  const lat = (south + north) / 2;
  const lng = (west + east) / 2;
  // Convert the union back into an equivalent radius so the same zoom maths
  // serves both cases -- taking the LARGER of the two spans. Using longitude
  // alone framed Greenwich and Boca Raton at a zoom that fit their 400-mile
  // width and cut off 600 miles of the 1,000-mile height between them.
  const cos = Math.max(0.01, Math.abs(Math.cos((lat * Math.PI) / 180)));
  const widthMiles = (east - west) * 69.0 * cos;
  const heightMiles = (north - south) * 69.0;
  const spanMiles = Math.max(widthMiles, heightMiles);
  return {
    center: { lat, lng },
    zoom: zoomForRadius(spanMiles / 2, widthPx, lat),
    radiusMiles: spanMiles / 2,
    label: `${boxes.length} service areas`,
  };
}

/**
 * The camera a map should open on, given every division and an optional
 * preferred one. Falls back: asked-for division -> primary division -> all.
 * Returns null when nothing is configured, and callers keep their own default.
 */
export function defaultCamera(divisions, { divisionId = null, widthPx = 900 } = {}) {
  const usable = (divisions || []).filter(isUsable);
  if (!usable.length) return null;
  if (divisionId) {
    const asked = usable.find((d) => d.id === divisionId);
    if (asked) return cameraFor(asked, widthPx);
  }
  const primary = usable.find((d) => d.is_primary);
  if (primary) return cameraFor(primary, widthPx);
  return companyCamera(usable, widthPx);
}
