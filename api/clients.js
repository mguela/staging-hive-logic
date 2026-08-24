// api/clients.js - Vercel serverless function
// Read-only pull of synced Jobber clients from Supabase, reshaped for the frontend.
// Reuses the same Supabase helper the sync job already uses (api/_lib/jobber.js) --
// does not touch sync.js, callback.js, or vercel.json.
import { supabaseRequest } from './_lib/jobber.js';

const PAGE_SIZE = 50;

// Extracted so api/chat.js can call this directly in-process instead of
// self-fetching this file's own /api/clients route over HTTP. Same shape,
// same defaults/caps -- just callable without a network hop.
export async function getClientsData({ limit, offset, order, search } = {}) {
  // Bug fix (2026-07-23): Number(limit) || PAGE_SIZE treated any non-zero
  // number as valid, including negative ones -- ?limit=-5 passed a literal
  // &limit=-5 straight to Supabase's PostgREST endpoint, which rejects it
  // and turned into an unhandled 500 here. Only a finite, positive number
  // is accepted now; anything else (negative, zero, NaN, missing) falls
  // back to PAGE_SIZE, same as the existing safeOffset pattern below.
  const parsedLimit = Number(limit);
  const cappedLimit = Math.min(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : PAGE_SIZE, 10000);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  // offset + order support so the frontend can page past PostgREST's
  // 1000-row-per-request cap (HiveDocs' alphabetical Clients dropdown).
  const orderClause = order === 'name' ? 'name.asc.nullslast' : 'jobber_updated_at.desc';

  // Typeahead support for the Schedule board's client picker. With 8,600+
  // clients a dropdown of everything is not a picker, it is a scroll -- so the
  // board sends what the dispatcher typed and gets back only matches. Archived
  // clients are excluded because you cannot schedule work for one.
  // PostgREST's or= takes a bare comma list; the term is escaped so a name
  // containing a comma or paren cannot break out of the filter it sits in.
  const term = String(search == null ? '' : search).trim();
  let searchClause = '';
  if (term) {
    const safe = term.replace(/[,()\*]/g, ' ').trim();
    if (safe) {
      const pat = `*${safe}*`;
      searchClause = `&is_archived=not.is.true&or=(name.ilike.${encodeURIComponent(pat)},company_name.ilike.${encodeURIComponent(pat)},email.ilike.${encodeURIComponent(pat)})`;
    }
  }

  // Bug fix (2026-07-23): PostgREST enforces its own hard per-request row
  // cap (1000 in this project -- same limit api/jobs.js's
  // fetchAllClientLocations/fetchAllClientNames already work around)
  // regardless of what &limit= is sent. A caller asking for more than that
  // (e.g. ?limit=10000, which this function's own cap allows) was silently
  // getting back only the first 1000 rows with no error and no signal
  // anything was truncated. Loop in <=1000-row pages against Supabase
  // until cappedLimit rows are gathered or the table runs out.
  const SUPABASE_PAGE_CAP = 1000;
  let rows = [];
  let totalCount = null;
  let pageOffset = safeOffset;
  while (rows.length < cappedLimit) {
    const pageLimit = Math.min(SUPABASE_PAGE_CAP, cappedLimit - rows.length);
    const r = await supabaseRequest(`clients?select=*&order=${orderClause}&limit=${pageLimit}&offset=${pageOffset}${searchClause}`, {
      headers: { Prefer: 'count=exact' }
    });
    if (!r.ok) throw new Error(await r.text());
    const pageRows = await r.json();
    if (totalCount === null) {
      const range = r.headers.get('content-range'); // e.g. "0-999/8656"
      totalCount = range && range.includes('/') && range.split('/')[1] !== '*'
        ? Number(range.split('/')[1]) : null;
    }
    rows = rows.concat(pageRows);
    pageOffset += pageRows.length;
    if (pageRows.length < pageLimit) break; // fewer rows than asked for -- table's exhausted
  }
  if (totalCount === null) totalCount = rows.length;

  // Service addresses, so the client pickers can find someone by where the work
  // is. Chris, 2026-08-23, on search priority: "name / address / number /
  // email / everything else." Address is the only one of those four not already
  // on the clients row -- it lives one table over, 1:1 on jobber_id, and 6,409
  // of 8,690 clients have one.
  //
  // Non-fatal by design: a client book with no addresses is worth far more than
  // no client book, and this route is what every picker in the app waits on.
  const addressById = new Map();
  try {
    let locOffset = 0;
    for (;;) {
      const lr = await supabaseRequest(
        `client_locations?select=jobber_id,street,city,province&limit=${SUPABASE_PAGE_CAP}&offset=${locOffset}`
      );
      if (!lr.ok) break;
      const locs = await lr.json();
      for (const l of locs) {
        if (!l.jobber_id) continue;
        const line = [l.street, l.city, l.province].filter(Boolean).join(', ');
        if (line && !addressById.has(l.jobber_id)) addressById.set(l.jobber_id, line);
      }
      if (locs.length < SUPABASE_PAGE_CAP) break;
      locOffset += locs.length;
    }
  } catch (e) { /* addresses are a search aid, never a reason to fail the book */ }

  const clients = rows.map(c => ({
    id: c.jobber_id,
    name: c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || 'Unnamed client',
    companyName: c.company_name,
    email: c.email,
    phone: c.phone_e164 || c.phone || null,
    address: addressById.get(c.jobber_id) || null,
    balance: c.balance,
    isLead: c.is_lead,
    isArchived: c.is_archived,
    jobberUrl: c.jobber_web_uri,
    updatedAt: c.jobber_updated_at
  }));

  return { totalCount, returned: clients.length, clients };
}

// Fetch a specific set of clients by their Jobber id (jobber_id), instead of
// paging through the whole table. Added 2026-07-25: the Invoices view was
// paging through the ENTIRE clients table (9 requests for 8,600+ rows) on
// every single load just to resolve the ~1,000 client names its invoices
// actually reference. This lets a caller ask for exactly the ids it needs
// in one request instead. Purely additive -- does not change getClientsData
// or the existing GET behavior of this route in any way.
// `deps.supabaseRequest` is an optional override used by tests so this can
// be verified without hitting the real Supabase project (same convention as
// getMapping() in api/hiveconnect-bridge.js).
const IDS_CHUNK_SIZE = 250;
const IDS_MAX = 5000;

export async function getClientsByIds(ids, deps = {}) {
  const request = deps.supabaseRequest || supabaseRequest;
  const unique = Array.from(new Set((Array.isArray(ids) ? ids : []).filter(Boolean).map(String))).slice(0, IDS_MAX);
  if (unique.length === 0) return { totalCount: 0, returned: 0, clients: [] };

  const chunks = [];
  for (let i = 0; i < unique.length; i += IDS_CHUNK_SIZE) {
    chunks.push(unique.slice(i, i + IDS_CHUNK_SIZE));
  }

  const pages = await Promise.all(chunks.map(async (chunk) => {
    const filter = chunk.map(id => encodeURIComponent(id)).join(',');
    const r = await request(`clients?select=*&jobber_id=in.(${filter})`);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }));

  const rows = pages.flat();
  const clients = rows.map(c => ({
    id: c.jobber_id,
    name: c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || 'Unnamed client',
    companyName: c.company_name,
    email: c.email,
    balance: c.balance,
    isLead: c.is_lead,
    isArchived: c.is_archived,
    jobberUrl: c.jobber_web_uri,
    updatedAt: c.jobber_updated_at
  }));

  return { totalCount: clients.length, returned: clients.length, clients };
}


// P0 auth gate (2026-07-29): this endpoint previously returned the full synced
// Jobber dataset (real client PII) to anonymous requests. A valid signed-in
// Supabase session is now required. Minimal token verification mirrored from
// api/track1.js's getRequestingProfile (mirrored, not imported -- same
// convention as fieldops.js / marketing.js / voice.js; no profile lookup here
// because this endpoint only needs "is this a real signed-in user", not a
// role). Response shape for signed-in callers is unchanged.
async function requireUser(req) {
  const headers = (req && req.headers) || {};
  const authHeader = headers['authorization'] || headers['Authorization'] || '';
  const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  return user && user.id ? user : null;
}

export default async function handler(req, res) {
  const user = await requireUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  try {
    if (req.method === 'POST' && req.body && Array.isArray(req.body.ids)) {
      const data = await getClientsByIds(req.body.ids);
      res.status(200).json({ ok: true, source: 'Jobber via Supabase', ...data });
      return;
    }
    const data = await getClientsData({ limit: req.query.limit, offset: req.query.offset, order: req.query.order, search: req.query.search });
    res.status(200).json({ ok: true, source: 'Jobber via Supabase', ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}