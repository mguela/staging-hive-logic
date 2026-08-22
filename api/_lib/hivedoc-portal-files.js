// api/_lib/hivedoc-portal-files.js
//
// The client portal's and the sub portal's shared route to HiveDoc files.
//
// WHY THIS IS A SHARED HELPER AND NOT TWO IMPLEMENTATIONS. The visibility model
// (see canSee() in hivedoc-search.js) is only worth anything if there is exactly
// one place that decides who may see a file. Two portals each writing their own
// version is precisely how the two drift apart and one of them starts serving a
// file the other would refuse. Both portals call this; neither queries
// `documents` directly.
//
// WHAT CHANGED HERE, HONESTLY. Before this, NEITHER portal could see HiveDoc
// documents at all -- the client portal serves photos (gated separately by
// client_photo_shares) and the sub portal's `documents` action serves the sub's
// own uploaded compliance paperwork. So this is not a retrofit that tightens
// existing access; it OPENS a path that did not exist, and it is the first way
// a HiveDoc document can leave the company. That is why every layer below is
// closed by default and why the SQL filter is not trusted on its own.
//
// DEFENCE IN DEPTH, on purpose:
//
//   1. The identity comes from the portal's VERIFIED session. Never a query
//      parameter -- a caller who can name their own client id or job list has
//      everyone's files.
//   2. The SQL narrows to rows that are flagged shared AND scoped to that
//      identity.
//   3. canSee() is then applied to every row anyway. If someone later loosens
//      the query, or a column default changes, or a row arrives through a path
//      nobody anticipated, this is the check that still holds. The SQL is an
//      optimisation; canSee() is the rule.
//   4. Rows are redacted before they leave, so storage paths and the sharing
//      flags themselves never reach an outside audience.
//   5. A file whose bytes cannot be signed is dropped from the list rather than
//      returned with a dead link.

import { normalizeDocumentRow, normalizeViewer, filterVisible, redactForAudience } from './hivedoc-search.js';

const MAX_PORTAL_FILES = 200;

// Everything the portals need to answer "which HiveDoc files may this person
// see". `sb` runs a PostgREST select; `sign` mints a short-lived URL for a
// bucket/path pair and returns null if the object is unreachable.
export async function listPortalFiles({ viewer, sb, sign }) {
  const v = normalizeViewer(viewer);
  if (!v.audience || v.audience === 'staff') return [];

  let rows = [];
  if (v.audience === 'client') {
    // No client id means nobody, not everybody. Returning early matters: an
    // unfiltered query here would hand this client the whole company's shared
    // files.
    if (!v.clientId) return [];
    rows = await sb(
      `documents?client_id=eq.${encodeURIComponent(v.clientId)}&client_visible=is.true`
      + `&order=document_date.desc.nullslast&limit=${MAX_PORTAL_FILES}&select=*`
    );
  } else if (v.audience === 'subcontractor') {
    if (!v.jobIds.length) return [];
    // Job refs come from our own tables, not from the sub -- but they are
    // interpolated into a PostgREST in.() list, where a stray comma, quote or
    // paren would end the list early and silently widen the query. Allowlisted
    // to the characters a Jobber GID can actually contain rather than escaping
    // the ones we happen to have thought of.
    const safeIds = v.jobIds.map((id) => String(id)).filter((id) => /^[A-Za-z0-9+/=_-]+$/.test(id));
    if (!safeIds.length) return [];
    const inList = safeIds.map((id) => `"${id}"`).join(',');
    rows = await sb(
      `documents?job_id=in.(${inList})&sub_visible=is.true`
      + `&order=document_date.desc.nullslast&limit=${MAX_PORTAL_FILES}&select=*`
    );
  } else {
    return [];
  }

  // Step 3: the query is not the authority. Every row is re-checked.
  const allowed = filterVisible((rows || []).map(normalizeDocumentRow), v);

  const out = [];
  for (const row of allowed) {
    const url = row.storage_path ? await sign('docs', row.storage_path) : null;
    if (!url) continue; // unreachable object: drop it rather than serve a dead link
    out.push({ ...redactForAudience(row, v), url });
  }
  return out;
}

// The job ids a subcontractor is actually attached to. This is the scope of
// everything they are allowed to see, so it is derived from real assignment
// rows -- RFQs they were sent and schedule items booked to them -- and never
// from anything the sub can supply.
export async function subJobIds(sub, sb) {
  if (!sub || !sub.id) return [];
  const [rfqs, schedule] = await Promise.all([
    sb(`sub_rfqs?sub_id=eq.${encodeURIComponent(sub.id)}&select=job_ref`),
    sb(`sub_schedule_items?sub_id=eq.${encodeURIComponent(sub.id)}&select=job_ref`),
  ]);
  const ids = [...(rfqs || []), ...(schedule || [])].map((r) => r && r.job_ref).filter(Boolean);
  return [...new Set(ids)];
}
