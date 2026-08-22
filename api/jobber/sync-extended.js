// api/jobber/sync-extended.js - Vercel serverless function
// ADDITIVE ONLY: extends the Jobber sync with more resource types, without
// touching sync.js/callback.js or the original clients/jobs/invoices logic
// there (per standing rule: never edit those, only add new files/entries).
// Same cursor-pagination + upsert pattern as sync.js, imports the same
// shared jobberGraphQL/supabaseRequest helpers from _lib/jobber.js.
//
// HONESTY NOTE (Law 1): the GraphQL field names below for requests, visits,
// expenses, timeSheetEntries, and users are a GOOD-FAITH best effort based
// on Jobber's documented top-level resource names (developer.getjobber.com)
// and the field-naming conventions already CONFIRMED correct in sync.js
// (clients/jobs/invoices) and via this session's live tests (quotes,
// invoices via reina-ai). They have NOT been live-verified against the real
// schema the way clients/jobs/invoices/quotes were. Each resource is synced
// independently and wrapped in its own try/catch -- if a field name is wrong,
// Jobber's GraphQL response names the bad field directly (same as it did
// for every prior fix this session), that ONE resource is skipped and
// reported in the response, and every other resource still succeeds. Run
// this once after deploying and read the response before trusting any new
// tile that depends on it.
//
// 2026-07-18 UPDATE: added real crew assignment (Visit.assignedUsers) and
// arrival window (Visit.arrivalWindow) to the visits query -- CONFIRMED LIVE
// against the real Jobber account before writing this (Monday 7/20 visits
// show real technician names: Steve Walz, Gerry Martinez, Sandro Gomez,
// etc). Also added a new `vehicles` resource for Jobber's built-in live GPS
// fleet tracking (Vehicle.liveState.currentPosition) -- also confirmed live
// against all 10 real fleet vehicles, real Greenwich CT coordinates. Also
// added availableForScheduling/status to the users query. None of this
// needs FleetSharp -- Jobber already has it.
//
// Verification (same 5-minute method used for quotes/invoices tonight):
// 1. Deploy this file (git push).
// 2. Visit https://hivelogic-live.vercel.app/api/jobber/sync-extended
// (or POST it -- GET works too, no side effects beyond the sync itself).
// 3. Read the JSON response: counts + errors per resource.
// 4. Any resource with an error: send Reina the exact error text, she'll
// fix the one field name and you re-push. Everything else is already live.

import { jobberGraphQL, supabaseRequest } from '../_lib/jobber.js';
import { dedupeRowsByConflictKey } from '../_lib/sync-dedupe.js';
import { checkCronSecret, checkBearerSecret } from '../_lib/guard.js';
import { requireStaff } from '../_lib/agents/security.js';

const PAGE_SIZE = 25;
const PAGE_DELAY_MS = 400;
const TIME_BUDGET_MS = 260000; // same safety margin as sync.js (300s function cap)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Queries ----------

// QUOTES: field shape CONFIRMED LIVE tonight against the real Greenwich Handyman Jobber
// account via reina-ai's local OAuth connection (id, quoteNumber, title,
// quoteStatus, amounts.total, client.id/name all returned real records
// correctly). Unlike the resources below, this one does not need the
// morning verification step -- it's already proven.
// 2026-08-10: jobberWebUri added for the Estimates tab's "Batch Send" (opens
// each quote's real Jobber page). UNVERIFIED against the live schema, unlike
// every other field in this query -- inferred from Request/Job/Invoice
// having this same field, but Visit (below) is a known counter-example.
// Check sync_log for a quotes-sync error after the next real run.
const QUOTES_QUERY = `
  query Quotes($cursor: String) {
    quotes(first: ${PAGE_SIZE}, after: $cursor) {
      nodes {
        id
        quoteNumber
        title
        quoteStatus
        amounts { total }
        client { id name }
        jobberWebUri
        createdAt
        updatedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ---------- Queries below this line: good-faith, see HONESTY NOTE above ----------

const REQUESTS_QUERY = `
  query Requests($cursor: String) {
    requests(first: ${PAGE_SIZE}, after: $cursor) {
      nodes {
        id
        title
        requestStatus
        client { id }
        jobberWebUri
        createdAt
        updatedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// VISITS: field shape CORRECTED 2026-07-16 after the first live run against
// the real schema returned errors naming the exact bad fields: "isAllDay"
// doesn't exist (Jobber suggested `allDay`), and Visit has no `jobberWebUri`
// or `updatedAt` field at all.
// 2026-07-18: added visitStatus, assignedUsers (real crew, confirmed live),
// and arrivalWindow (real client-facing arrival window, confirmed live).
const VISITS_QUERY = `
  query Visits($cursor: String) {
    visits(first: ${PAGE_SIZE}, after: $cursor) {
      nodes {
        id
        title
        startAt
        endAt
        completedAt
        allDay
        visitStatus
        client { id }
        job { id }
        createdAt
        assignedUsers {
          nodes { id name { full } }
        }
        arrivalWindow { startAt endAt }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// EXPENSES: field shape CORRECTED 2026-07-16 -- the live schema error named
// the exact bad fields: "reimbursableToUser" doesn't exist (Jobber suggested
// `reimbursableTo`), and Expense has no `job` relation field at all. Dropped
// the job link for now (mapExpense leaves job_id null) since the correct
// relation name isn't confirmed; can add it back once verified.
// Second correction: `reimbursableTo` returns a User object, not a scalar --
// Jobber's error named this too ("must have selections... did you mean
// 'reimbursableTo { ... }'"), so it needs a sub-selection (id).
const EXPENSES_QUERY = `
  query Expenses($cursor: String) {
    expenses(first: ${PAGE_SIZE}, after: $cursor) {
      nodes {
        id
        title
        total
        date
        reimbursableTo { id }
        createdAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const TIME_SHEET_ENTRIES_QUERY = `
  query TimeSheetEntries($cursor: String) {
    timeSheetEntries(first: ${PAGE_SIZE}, after: $cursor) {
      nodes {
        id
        startAt
        endAt
        finalDuration
        user { id }
        job { id }
        createdAt
        updatedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// USERS: 2026-07-18 added availableForScheduling/status -- confirmed live
// (both real, correctly-typed fields on Jobber's User type).
const USERS_QUERY = `
  query Users($cursor: String) {
    users(first: ${PAGE_SIZE}, after: $cursor) {
      nodes {
        id
        name { full }
        email { raw }
        availableForScheduling
        status
        assignedVehicle { id name }
        createdAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// VEHICLES: new 2026-07-18. Jobber's built-in fleet GPS tracking --
// CONFIRMED LIVE against all 10 real Greenwich Handyman vehicles before
// writing this (real lat/lng in Greenwich CT, real speed/engine status).
// No FleetSharp needed for this data.
const VEHICLES_QUERY = `
  query Vehicles($cursor: String) {
    vehicles(first: ${PAGE_SIZE}, after: $cursor) {
      nodes {
        id
        name
        make
        model
        year
        licensePlate
        vin
        iconColor
        liveState {
          currentPosition { latitude longitude timestamp }
          speed
          status
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// LOCATIONS: field shape CONFIRMED LIVE earlier tonight (billingAddress {
// street city province } was tested and returned real addresses via
// reina-ai's getClients()). Adding postalCode/country here too -- same
// field family, not yet re-verified against the live schema, but low risk
// given the sibling fields already confirmed. Powers the real service-area
// map (client_locations table, geocoded separately by the ?resource=geocode
// action below).
const LOCATIONS_QUERY = `
  query ClientLocations($cursor: String) {
    clients(first: ${PAGE_SIZE}, after: $cursor) {
      nodes {
        id
        name
        billingAddress { street city province postalCode country }
        updatedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ---------- Shared pagination/upsert plumbing (mirrors sync.js) ----------

async function getStoredCursor(resource) {
  const res = await supabaseRequest(`sync_cursors?resource=eq.${resource}&select=cursor`);
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? rows[0].cursor : null;
}

async function saveCursor(resource, cursor) {
  await supabaseRequest('sync_cursors?on_conflict=resource', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ resource, cursor, updated_at: new Date().toISOString() }),
  });
}

async function fetchAllPages(query, key, deadline, startCursor) {
  const all = [];
  let cursor = startCursor || null;
  let truncated = false;
  while (true) {
    if (Date.now() >= deadline) {
      truncated = true;
      break;
    }
    const data = await jobberGraphQL(query, { cursor });
    const connection = data[key];
    all.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) {
      cursor = null;
      break;
    }
    cursor = connection.pageInfo.endCursor;
    await sleep(PAGE_DELAY_MS);
  }
  return { records: all, truncated, lastCursor: cursor };
}

async function upsert(table, rows, conflictColumn) {
  if (!rows.length) return 0;
  const deduped = dedupeRowsByConflictKey(rows, conflictColumn);
  if (deduped.duplicatesDropped) {
    console.warn(`Jobber extended sync dropped ${deduped.duplicatesDropped} duplicate ${conflictColumn} row(s) before upserting ${table}.`);
  }
  const res = await supabaseRequest(`${table}?on_conflict=${conflictColumn}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(deduped.rows),
  });
  if (!res.ok) {
    throw new Error(`Failed to upsert ${table}: ${await res.text()}`);
  }
  return deduped.rows.length;
}

// ---------- Mappers ----------

function mapQuote(q) {
  const amounts = q.amounts || {};
  return {
    jobber_id: q.id,
    quote_number: q.quoteNumber,
    title: q.title,
    quote_status: q.quoteStatus,
    total: amounts.total,
    client_id: q.client ? q.client.id : null,
    client_name: q.client ? q.client.name : null,
    jobber_web_uri: q.jobberWebUri || null,
    jobber_created_at: q.createdAt,
    jobber_updated_at: q.updatedAt,
    synced_at: new Date().toISOString(),
  };
}

function mapRequest(r) {
  return {
    jobber_id: r.id,
    title: r.title,
    request_status: r.requestStatus,
    client_id: r.client ? r.client.id : null,
    jobber_web_uri: r.jobberWebUri,
    jobber_created_at: r.createdAt,
    jobber_updated_at: r.updatedAt,
    synced_at: new Date().toISOString(),
  };
}

// 2026-07-18: now also stores real crew assignment (assigned_users, as a
// JSON array of {id, name}) and the real client-facing arrival window
// (arrival_window_start/end), plus visit_status. All three confirmed live.
function mapVisit(v) {
  const assigned = (v.assignedUsers && v.assignedUsers.nodes) || [];
  const aw = v.arrivalWindow || {};
  return {
    jobber_id: v.id,
    title: v.title,
    start_at: v.startAt,
    end_at: v.endAt,
    completed_at: v.completedAt,
    is_all_day: v.allDay,
    client_id: v.client ? v.client.id : null,
    job_id: v.job ? v.job.id : null,
    jobber_web_uri: null,
    jobber_created_at: v.createdAt,
    jobber_updated_at: null,
    visit_status: v.visitStatus || null,
    assigned_users: assigned.map((u) => ({ id: u.id, name: u.name ? u.name.full : null })),
    arrival_window_start: aw.startAt || null,
    arrival_window_end: aw.endAt || null,
    synced_at: new Date().toISOString(),
  };
}

function mapExpense(e) {
  return {
    jobber_id: e.id,
    title: e.title,
    total: e.total,
    expense_date: e.date,
    // reimbursableTo returns a linked User object, not a plain yes/no --
    // but the Supabase column is boolean (confirmed by the upsert failure:
    // "invalid input syntax for type boolean" when a Jobber gid string was
    // sent). Storing "is this expense reimbursable to someone" as a flag,
    // matching the column's original intent, rather than altering the table.
    reimbursable_to_user: !!e.reimbursableTo,
    job_id: null,
    jobber_created_at: e.createdAt,
    jobber_updated_at: null,
    synced_at: new Date().toISOString(),
  };
}

function mapTimeSheetEntry(t) {
  return {
    jobber_id: t.id,
    start_at: t.startAt,
    end_at: t.endAt,
    final_duration: t.finalDuration,
    user_id: t.user ? t.user.id : null,
    job_id: t.job ? t.job.id : null,
    jobber_created_at: t.createdAt,
    jobber_updated_at: t.updatedAt,
    synced_at: new Date().toISOString(),
  };
}

// 2026-07-18: now also stores available_for_scheduling and status, both
// confirmed live against the real Jobber account (61 real crew members).
function mapUser(u) {
  const vehicle = u.assignedVehicle || null;
  return {
    jobber_id: u.id,
    name: u.name ? u.name.full : null,
    email: u.email ? u.email.raw : null,
    available_for_scheduling: u.availableForScheduling != null ? u.availableForScheduling : null,
    status: u.status || null,
    assigned_vehicle_id: vehicle ? vehicle.id : null,
    assigned_vehicle_name: vehicle ? vehicle.name : null,
    jobber_created_at: u.createdAt,
    jobber_updated_at: null,
    synced_at: new Date().toISOString(),
  };
}

function mapLocation(c) {
  const a = c.billingAddress || {};
  return {
    jobber_id: c.id,
    street: a.street || null,
    city: a.city || null,
    province: a.province || null,
    postal_code: a.postalCode || null,
    country: a.country || null,
    synced_at: new Date().toISOString(),
  };
}

// New 2026-07-18: real live GPS per vehicle, confirmed against all 10 real
// fleet vehicles. Vehicle-to-technician linkage is NOT set up in this
// Jobber account (checked all 61 users -- none had a vehicle assigned), so
// this is a standalone "where are our trucks right now" feed for now, not
// yet joinable to a specific crew member.
function mapVehicle(v) {
  const ls = v.liveState || {};
  const pos = ls.currentPosition || {};
  return {
    jobber_id: v.id,
    name: v.name,
    make: v.make,
    model: v.model,
    year: v.year,
    license_plate: v.licensePlate,
    vin: v.vin,
    icon_color: v.iconColor || null,
    status: ls.status || null,
    speed: ls.speed != null ? ls.speed : null,
    latitude: pos.latitude != null ? pos.latitude : null,
    longitude: pos.longitude != null ? pos.longitude : null,
    gps_updated_at: pos.timestamp || null,
    jobber_updated_at: null,
    synced_at: new Date().toISOString(),
  };
}

const RESOURCES = {
  quotes: { query: QUOTES_QUERY, key: 'quotes', table: 'quotes', map: mapQuote },
  requests: { query: REQUESTS_QUERY, key: 'requests', table: 'requests', map: mapRequest },
  visits: { query: VISITS_QUERY, key: 'visits', table: 'visits', map: mapVisit },
  expenses: { query: EXPENSES_QUERY, key: 'expenses', table: 'expenses', map: mapExpense },
  timesheets: { query: TIME_SHEET_ENTRIES_QUERY, key: 'timeSheetEntries', table: 'time_sheet_entries', map: mapTimeSheetEntry },
  users: { query: USERS_QUERY, key: 'users', table: 'users', map: mapUser },
  vehicles: { query: VEHICLES_QUERY, key: 'vehicles', table: 'vehicles', map: mapVehicle },
  locations: { query: LOCATIONS_QUERY, key: 'clients', table: 'client_locations', map: mapLocation },
};

// ---------- FleetSharp Push API webhook (2026-08-11) ----------
// FleetSharp's "Push API" is inbound, not something we poll: FleetSharp POSTs
// JSON to a URL we host whenever a device reports, authenticated by a bearer
// token WE generate and hand to FleetSharp (their PDF names the header
// "Authentication", which is nonstandard, so both that and the normal
// "Authorization" header are accepted). This is the fix for Jobber's own
// Vehicle.liveState.currentPosition going stale -- Jobber's upstream
// connection to FleetSharp had failed -- so this writes into separate
// fleetsharp_* shadow columns on `vehicles` (matched by VIN) rather than the
// jobber-sourced latitude/longitude/speed/status/gps_updated_at columns.
// handleCrewSchedule in track1.js picks whichever of the two has the newer
// timestamp per vehicle, which is what makes FleetSharp "primary, Jobber
// fallback" in practice: FleetSharp wins whenever it's actively pushing,
// Jobber only wins if FleetSharp goes quiet for that specific truck.
//
// Only POSITION pushes are handled; FENCE_EVENT/STOP/USAGE_HOURS/TRIP/ALERT/
// device-update pushes are acknowledged (201, per FleetSharp's spec, so they
// don't get retried) but otherwise ignored -- out of scope for the GPS-
// freshness fix this was built for. A push with no VIN match (e.g. Jobber
// hasn't synced that truck yet) is also silently acknowledged and dropped,
// per explicit product decision -- this is an enrichment layer, not the
// source of truth for which vehicles exist.
async function handleFleetSharpPush(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'FleetSharp push endpoint accepts POST only.' });
  }
  const authHeader = (req.headers && (req.headers['authentication'] || req.headers['authorization'])) || '';
  if (!checkBearerSecret(authHeader, process.env.FLEETSHARP_PUSH_SECRET)) {
    return res.status(401).json({ ok: false, error: 'Invalid or missing FleetSharp push token.' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      return res.status(400).json({ ok: false, error: 'Invalid JSON body.' });
    }
  }
  const items = Array.isArray(body) ? body : [body].filter(Boolean);
  let updated = 0;
  let skipped = 0;
  for (const item of items) {
    if (!item || item.pushType !== 'POSITION' || !item.vin) { skipped++; continue; }
    const updatedAtIso = item.date
      ? new Date(item.date).toISOString()
      : (item.formattedDate ? new Date(item.formattedDate).toISOString() : new Date().toISOString());
    const patch = {
      fleetsharp_latitude: item.latitude != null ? item.latitude : null,
      fleetsharp_longitude: item.longitude != null ? item.longitude : null,
      fleetsharp_speed: item.speed != null ? item.speed : null,
      fleetsharp_status: item.currentState || null,
      fleetsharp_updated_at: updatedAtIso,
    };
    try {
      // Prefer=return=representation (not the previous return=minimal): a
      // PATCH whose vin=eq. filter matches zero rows still comes back HTTP
      // 200/204 with an empty array -- return=minimal made that
      // indistinguishable from "matched, updated" (r.ok is true either way),
      // so a VIN that doesn't exist yet in `vehicles` was silently counted
      // as updated. Count actual rows returned instead.
      const r = await supabaseRequest(`vehicles?vin=eq.${encodeURIComponent(item.vin)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      const matched = r.ok ? (await r.json().catch(() => [])) : [];
      if (Array.isArray(matched) && matched.length > 0) updated++; else skipped++;
    } catch (e) { skipped++; }
  }
  return res.status(201).json({ ok: true, received: items.length, updated, skipped });
}

// ---------- Geocoding (two-tier: Nominatim rooftop -> Census fallback) ----------
// Tier 1 is Nominatim/OpenStreetMap, which returns true rooftop/address-point
// coordinates when OSM has the parcel. Tier 2 is the US Census geocoder, which
// only street-interpolates -- accurate enough to place a pin on the right block
// but not the right lot (it put 37 Chesterfield Rd in front of 25). We prefer
// Nominatim and only fall back to Census when OSM has no rooftop-grade hit.
// Assumes Greenwich Handyman's clients are US addresses (real HQ is Bedford, NY).
const CENSUS_GEOCODE_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const NOMINATIM_GEOCODE_URL = 'https://nominatim.openstreetmap.org/search';
// Nominatim's usage policy requires a real, identifying User-Agent and caps
// clients at 1 request/second. We honor both; a violation gets us IP-banned.
const NOMINATIM_USER_AGENT = 'HiveLogic/1.0 c_kendall@icloud.com';
const NOMINATIM_MIN_INTERVAL_MS = 1100; // >= 1s between Nominatim calls
const GEOCODE_BATCH_LIMIT = 3000; // the deadline check inside the loop is what actually keeps this safe under the 300s cap -- raising the fetch ceiling just means fewer manual clicks needed to catch up
const OFFICE_ADDRESS = '23 Bedford Banksville Rd, Bedford, NY 10506';

async function censusGeocode(oneLine) {
  const params = new URLSearchParams({ address: oneLine, benchmark: 'Public_AR_Current', format: 'json' });
  const r = await fetch(`${CENSUS_GEOCODE_URL}?${params.toString()}`);
  if (!r.ok) throw new Error(`Census geocoder HTTP ${r.status}`);
  const body = await r.json();
  const match = body.result && body.result.addressMatches && body.result.addressMatches[0];
  if (!match) return null;
  return { lat: match.coordinates.y, lng: match.coordinates.x };
}

// Only a building/house/address-point counts as rooftop-grade. A street
// centerline (category=highway), a town centroid (addresstype=city), or a
// postcode area is worse than Census interpolation, so we reject those and let
// Census handle it. A genuine house node comes back as category=place/type=house
// (verified against 37 Chesterfield Road, Stamford, CT); a mapped building
// polygon as category=building.
function isRooftopMatch(m) {
  if (!m) return false;
  const addressType = String(m.addresstype || '').toLowerCase();
  const category = String(m.category || m.class || '').toLowerCase();
  const type = String(m.type || '').toLowerCase();
  if (addressType === 'building' || addressType === 'house') return true;
  if (category === 'building') return true;
  if (category === 'place' && (type === 'house' || type === 'building')) return true;
  return false;
}

// Structured Nominatim lookup. Returns rooftop-grade coords or null (a miss --
// including when OSM only had a street/area-level result we deliberately reject).
async function nominatimGeocode({ street, city, province }) {
  const params = new URLSearchParams({ format: 'jsonv2', limit: '1', addressdetails: '1' });
  if (street) params.set('street', street);
  if (city) params.set('city', city);
  if (province) params.set('state', province);
  const r = await fetch(`${NOMINATIM_GEOCODE_URL}?${params.toString()}`, {
    headers: { 'User-Agent': NOMINATIM_USER_AGENT, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Nominatim HTTP ${r.status}`);
  const body = await r.json();
  const match = Array.isArray(body) ? body[0] : null;
  if (!isRooftopMatch(match)) return null;
  return { lat: Number(match.lat), lng: Number(match.lon) };
}

async function geocodeOffice() {
  const r = await supabaseRequest('office_location?id=eq.hq&select=lat');
  const rows = r.ok ? await r.json() : [];
  if (rows.length && rows[0].lat != null) return; // already geocoded
  const hit = await censusGeocode(OFFICE_ADDRESS);
  await supabaseRequest('office_location?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      id: 'hq', address: OFFICE_ADDRESS,
      lat: hit ? hit.lat : null, lng: hit ? hit.lng : null,
      geocoded_at: new Date().toISOString(),
    }),
  });
}

// Best-effort count of geocode candidates we're skipping because a human locked
// the pin (geocode_locked = true). Reported in the run summary only; a failure
// here must not derail the batch, so we swallow errors and return 0.
async function countLockedCandidates() {
  try {
    const r = await supabaseRequest(
      `client_locations?lat=is.null&street=not.is.null&geocode_locked=is.true&select=jobber_id`,
      { method: 'HEAD', headers: { Prefer: 'count=exact', Range: '0-0' } }
    );
    const total = (r.headers.get('content-range') || '').split('/')[1];
    return total && total !== '*' ? Number(total) : 0;
  } catch (e) {
    return 0;
  }
}

async function geocodeClientBatch(deadline) {
  await geocodeOffice();
  // geocode_locked=not.is.true keeps rows where the flag is false OR null (the
  // trigger blocks lat/lng writes on locked rows anyway, but excluding them here
  // avoids wasting the batch's time budget re-geocoding pins a human fixed).
  const r = await supabaseRequest(
    `client_locations?lat=is.null&street=not.is.null&geocode_locked=not.is.true&select=jobber_id,street,city,province,postal_code,country&limit=${GEOCODE_BATCH_LIMIT}`
  );
  if (!r.ok) throw new Error(`Failed to read client_locations: ${await r.text()}`);
  const rows = await r.json();
  const skippedLocked = await countLockedCandidates();
  let geocoded = 0, viaNominatim = 0, viaCensus = 0, noMatch = 0, processed = 0, writeErrors = 0, firstWriteError = null;
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    processed++;
    let hit = null, source = null;
    // Tier 1: Nominatim, rooftop-grade only. A thrown error (HTTP 429/5xx) or a
    // non-rooftop result both fall through to Census. We always wait the 1s
    // rate-limit interval after touching Nominatim, hit or miss.
    try {
      hit = await nominatimGeocode(row);
      if (hit) source = 'nominatim';
    } catch (e) {
      // swallow -- Census is the fallback below
    }
    await sleep(NOMINATIM_MIN_INTERVAL_MS);
    // Tier 2: Census fallback (street-interpolated, unchanged).
    if (!hit) {
      const oneLine = [row.street, row.city, row.province, row.postal_code].filter(Boolean).join(', ');
      try {
        hit = await censusGeocode(oneLine);
        if (hit) source = 'census';
      } catch (e) {
        // one bad address should not stop the batch -- leave lat/lng null, try again next run
        continue;
      }
    }
    const patchRes = await supabaseRequest(`client_locations?jobber_id=eq.${encodeURIComponent(row.jobber_id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        lat: hit ? hit.lat : null,
        lng: hit ? hit.lng : null,
        geocode_match: Boolean(hit),
        geocode_source: source,
        geocoded_at: new Date().toISOString(),
      }),
    });
    // 2026-08-19: this write was never checked -- a failing PATCH looked
    // identical to a successful one (geocoded/noMatch still incremented off
    // the in-memory `hit`), which is exactly how client_locations.geocoded_at
    // sat frozen at 2026-08-01 for 17 days while the job kept reporting
    // "processed: 100" like nothing was wrong. Counting only confirmed writes
    // as geocoded/noMatch, and surfacing the first failure's real error,
    // turns that silent failure into a visible one (same principle as
    // api/_lib/health-signals.js's whole reason for existing).
    if (!patchRes.ok) {
      writeErrors++;
      if (!firstWriteError) firstWriteError = `HTTP ${patchRes.status}: ${(await patchRes.text()).slice(0, 300)}`;
      continue;
    }
    if (hit) {
      geocoded++;
      if (source === 'nominatim') viaNominatim++; else viaCensus++;
    } else {
      noMatch++;
    }
  }
  // remaining if the deadline cut the loop short (processed < fetched) OR we
  // fetched a full page (there could be more beyond this batch either way).
  const remaining = processed < rows.length || rows.length === GEOCODE_BATCH_LIMIT;
  return { attempted: rows.length, processed, geocoded, viaNominatim, viaCensus, noMatch, skippedLocked, writeErrors, firstWriteError, remaining };
}

// When Jobber turns a request into real work it marks the request "converted"
// -- 1,120 of the 1,487 requests are already in that state. An opportunity that
// came from such a request is won, and saying so automatically is the difference
// between a win rate that is true and one that depends on someone remembering to
// drag a card (Chris's decision 3, 2026-08-17).
//
// Derived from Jobber rather than owned here, so it stays a one-way mirror: we
// only ever move an opportunity that is still open. A card already marked won or
// lost by hand is left exactly as the team set it -- this must never overwrite a
// deliberate "lost" just because Jobber later booked something.
//
// Runs after the requests upsert so it reads the statuses that just landed.
async function closeOpportunitiesForConvertedRequests() {
  const openRes = await supabaseRequest(
    'lead_pipeline?request_id=not.is.null&stage=not.in.(won,lost)&select=id,request_id'
  );
  // The column only exists once 20260818120000 has been applied. Before that
  // this is a no-op rather than a sync failure -- the rest of the sync matters
  // more than this bookkeeping step.
  if (!openRes.ok) return { closed: 0, skipped: true };
  const open = await openRes.json();
  if (!open.length) return { closed: 0 };

  const ids = open.map((o) => o.request_id);
  const inList = `(${ids.map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})`;
  const convRes = await supabaseRequest(
    `requests?jobber_id=in.${encodeURIComponent(inList)}&request_status=eq.converted&select=jobber_id`
  );
  if (!convRes.ok) return { closed: 0, skipped: true };
  const converted = new Set((await convRes.json()).map((r) => r.jobber_id));
  const toClose = open.filter((o) => converted.has(o.request_id)).map((o) => o.id);
  if (!toClose.length) return { closed: 0 };

  const idList = `(${toClose.map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})`;
  const patch = await supabaseRequest(`lead_pipeline?id=in.${encodeURIComponent(idList)}`, {
    method: 'PATCH',
    body: JSON.stringify({ stage: 'won', updated_at: new Date().toISOString() }),
  });
  if (!patch.ok) return { closed: 0, skipped: true };
  return { closed: toClose.length };
}

// The step 3 backfill put the open requests on the board once. Without this,
// that is all it would ever be -- a snapshot of 2026-08-17 that silently goes
// stale, with every request arriving afterwards invisible in exactly the way the
// rebuild set out to fix. So every requests sync also opens a card for anything
// new.
//
// Same rules as the backfill, so a re-run and a sync agree: converted and
// archived are ignored, and the stage reflects only what Jobber records --
// unworked enquiries land in the Requests column, anything with a visit already
// on the calendar goes straight to Estimate Booked.
async function createOpportunitiesForNewRequests() {
  const openRes = await supabaseRequest(
    'requests?request_status=not.in.(converted,archived)&client_id=not.is.null' +
    '&select=jobber_id,client_id,title,request_status,jobber_created_at&limit=500'
  );
  if (!openRes.ok) return { created: 0, skipped: true };
  const open = await openRes.json();
  if (!open.length) return { created: 0 };

  // request_id only exists once 20260818120000 is applied; before that this is
  // a no-op rather than a sync failure.
  const haveRes = await supabaseRequest('lead_pipeline?request_id=not.is.null&select=request_id&limit=2000');
  if (!haveRes.ok) return { created: 0, skipped: true };
  const have = new Set((await haveRes.json()).map((r) => r.request_id));
  const candidates = open.filter((r) => !have.has(r.jobber_id));
  if (!candidates.length) return { created: 0 };

  // client_id is a foreign key -- one request pointing at a client that has not
  // synced yet would reject the whole batch, so check before inserting.
  const idList = `(${[...new Set(candidates.map((r) => r.client_id))].map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})`;
  const cRes = await supabaseRequest(`clients?jobber_id=in.${encodeURIComponent(idList)}&select=jobber_id`);
  if (!cRes.ok) return { created: 0, skipped: true };
  const known = new Set((await cRes.json()).map((c) => c.jobber_id));

  const rows = candidates.filter((r) => known.has(r.client_id)).map((r) => ({
    client_id: r.client_id,
    request_id: r.jobber_id,
    title: (r.title || '').trim() || null,
    stage: ['new', 'unscheduled'].includes(r.request_status) ? 'request' : 'estimate_booked',
    created_at: r.jobber_created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));
  if (!rows.length) return { created: 0 };

  // Ignore duplicates rather than failing: two syncs overlapping would otherwise
  // collide on the partial unique index on request_id.
  const ins = await supabaseRequest('lead_pipeline?on_conflict=request_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!ins.ok) return { created: 0, skipped: true };
  return { created: rows.length };
}

async function syncResource(name, deadline) {
  const spec = RESOURCES[name];
  const startCursor = await getStoredCursor(`ext_${name}`);
  const { records, truncated, lastCursor } = await fetchAllPages(spec.query, spec.key, deadline, startCursor);
  const count = await upsert(spec.table, records.map(spec.map), 'jobber_id');
  await saveCursor(`ext_${name}`, truncated ? lastCursor : null);
  if (name === 'requests') {
    // Open the new ones first, then close anything Jobber has since converted --
    // that order means a request that arrived and converted between two syncs
    // still lands on the board as a win rather than being missed entirely.
    const opened = await createOpportunitiesForNewRequests();
    const won = await closeOpportunitiesForConvertedRequests();
    return { count, truncated, opportunitiesOpened: opened.created, opportunitiesWon: won.closed };
  }
  return { count, truncated };
}

export default async function handler(req, res) {
  // FleetSharp's webhook calls in on ITS OWN schedule with ITS OWN secret --
  // it can never carry CRON_SECRET, so this must be checked (and return)
  // before the cron-auth gate below, not after it.
  if (req.query && req.query.resource === 'fleetsharp_push') {
    return handleFleetSharpPush(req, res);
  }
  const requested = req.query && req.query.resource;

  // Cron auth. Item 6 (2026-08-01): Authorization: Bearer <CRON_SECRET> only
  // (no ?key= query param), timing-safe, fails closed when CRON_SECRET unset.
  // "geocode" additionally accepts a signed-in admin/superadmin session -- it's
  // a maintenance action with no destructive effect (worst case it re-tries
  // rows that already failed), and the 2026-08-19 investigation into why
  // client_locations.geocoded_at sat stale for 17 days needed a way to run it
  // on demand without anyone having to touch CRON_SECRET (shared with every
  // other cron on this endpoint) just to look.
  const staff = requested === 'geocode' ? await requireStaff(req) : null;
  const isStaff = staff && !staff.forbidden;
  if (!isStaff && !checkCronSecret((req.headers && req.headers.authorization) || '')) {
    return res.status(401).json({ ok: false, error: 'This endpoint runs on Vercel Cron only. Provide Authorization: Bearer <CRON_SECRET>.' });
  }
  const startedAt = Date.now();
  const deadline = startedAt + TIME_BUDGET_MS;

  // "geocode" is not a Jobber resource -- it's a maintenance action that reads
  // already-synced client_locations rows (from ?resource=locations) and fills
  // in lat/lng via the free Census geocoder. Kept in this file (not a new
  // file) to stay under Vercel's Hobby 12-function cap.
  if (requested === 'geocode') {
    try {
      const result = await geocodeClientBatch(deadline);
      return res.status(200).json({ ok: true, action: 'geocode', ...result, ms: Date.now() - startedAt });
    } catch (err) {
      return res.status(500).json({ ok: false, action: 'geocode', error: String((err && err.message) || err) });
    }
  }

  const names = requested && RESOURCES[requested] ? [requested] : Object.keys(RESOURCES);

  const counts = {};
  const truncatedResources = [];
  const errors = {};

  // Each resource is isolated: an unverified field name in one query (e.g.
  // timesheets) never blocks the others (e.g. requests/visits) from
  // succeeding. This is the key difference from sync.js's original
  // all-or-nothing loop -- appropriate here specifically because these
  // queries are new and not yet schema-verified.
  for (const name of names) {
    try {
      const result = await syncResource(name, deadline);
      counts[name] = result.count;
      if (result.truncated) truncatedResources.push(name);
    } catch (err) {
      errors[name] = String((err && err.message) || err);
      counts[name] = 0;
    }
  }

  const ok = Object.keys(errors).length === 0;

  // sync_log write (2026-08-07 fix): this run used to leave no durable trace
  // at all -- sync.js has always logged here, this file never did, so a
  // stalled/failing extended sync was only detectable by manually diffing
  // synced_at across every one of its 8 tables. source='sync_extended' +
  // sql/063's details column keep this a best-effort addition: a failure to
  // write the log must never turn a real sync result into an error response.
  const status = Object.keys(errors).length === names.length && names.length > 0
    ? 'error'
    : (truncatedResources.length || Object.keys(errors).length ? 'partial' : 'success');
  await supabaseRequest('sync_log', {
    method: 'POST',
    body: JSON.stringify({
      source: 'sync_extended',
      status,
      details: {
        ...counts,
        ...(truncatedResources.length ? { truncated: truncatedResources } : {}),
        ...(Object.keys(errors).length ? { errors } : {}),
      },
    }),
  }).catch(() => {});

  return res.status(ok ? 200 : 207).json({
    ok,
    synced: names,
    counts,
    truncated: truncatedResources,
    errors: Object.keys(errors).length ? errors : undefined,
    ms: Date.now() - startedAt,
  });
}
