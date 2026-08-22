// api/_lib/hivedoc-search.js
//
// The one structured file-search engine. Everything that asks "which files
// belong to this client / job / category" goes through here: the Global Search
// bar, Reina's natural-language layer, HiveDoc's own client -> job -> category
// browse UI, and the file list on a client record.
//
// WHY THIS EXISTS. As of the 2026-08-21 audit, HiveLogic had three file stores
// and no way to ask one question across them:
//
//   * `media` + the `media` bucket -- 40,939 files, 18 GB, every real file the
//     business owns. Keyed to a JOB, with no client column at all.
//   * `documents` + the `docs` bucket -- the Documents tab. One test upload.
//     Keyed to a client AND a job, with a doc type.
//   * a standalone HiveDoc app on its own Supabase project -- completely empty.
//
// The decision (REPORT.md, approved 2026-08-21) is that `documents` is the
// canonical metadata table and `media` stays exactly where it is as HiveDoc's
// photo store. Unification is therefore a READ MODEL, not a data migration:
// this module projects both tables into one row shape and one set of filters.
// Nothing is copied and nothing is deleted.
//
// THE CLIENT LINK. `media` has no client_id, but 100% of its rows resolve to a
// client through `jobs.jobber_id = media.job_id` (753 distinct clients, verified
// against production). So a client filter is answered by resolving client ->
// jobs first and querying media by that job set. That join is the whole reason
// `media` never needed a backfill to become searchable by client.
//
// This file is deliberately free of I/O so it can be tested without a database.
// api/hivedoc.js supplies the rows; everything here is a pure transform.

// The categories in Chris's spec. `documents.doc_type` already uses lowercase
// singulars of most of these; anything unrecognised files as Other rather than
// inventing a category.
export const CATEGORIES = ['Contract', 'Permit', 'Photo', 'Invoice', 'Receipt', 'Estimate', 'Payroll', 'Other'];

const DOC_TYPE_TO_CATEGORY = {
  contract: 'Contract',
  permit: 'Permit',
  photo: 'Photo',
  invoice: 'Invoice',
  receipt: 'Receipt',
  estimate: 'Estimate',
  payroll: 'Payroll',
  other: 'Other',
};

// How a `media` row's storage path identifies the tool that produced it. Every
// one of these prefixes is a real write path in this repo; the counts after each
// are what production held on 2026-08-21, which is why `companycam-` is the only
// one that currently matches anything.
const MEDIA_SOURCE_PATTERNS = [
  [/^takeoffs\//, 'Takeoff'],              // api/takeoffs.js          (0 rows)
  [/\/companycam-/, 'CompanyCam'],         // api/import-companycam.js (40,937 rows)
  [/\/field-/, 'Field App'],               // api/fieldops.js photo_add (0 rows)
  [/\/signature-/, 'Signature'],           // api/fieldops.js signature (0 rows)
];

export function normalizeCategory(value) {
  if (!value) return null;
  const key = String(value).trim().toLowerCase();
  if (DOC_TYPE_TO_CATEGORY[key]) return DOC_TYPE_TO_CATEGORY[key];
  const match = CATEGORIES.find((c) => c.toLowerCase() === key || `${c.toLowerCase()}s` === key);
  return match || null;
}

// A media row's origin, read off its storage path. Falls back to HiveSight
// because that is the tool that owns bare `{job}/{file}` uploads.
export function mediaSource(storagePath) {
  const path = String(storagePath || '');
  const hit = MEDIA_SOURCE_PATTERNS.find(([re]) => re.test(path));
  return hit ? hit[1] : 'HiveSight';
}

// "Kitchen Reno — Permit — 2026-07-14". A default that reads like something a
// person would have typed, built from what we actually know rather than showing
// a bare `companycam-8f3a1c.jpg` in a result list.
export function defaultTitle({ jobTitle, category, date, filename }) {
  const parts = [];
  if (jobTitle) parts.push(String(jobTitle).trim());
  if (category) parts.push(category);
  const day = isoDay(date);
  if (day) parts.push(day);
  return parts.length >= 2 ? parts.join(' — ') : (filename || parts[0] || 'Untitled');
}

function isoDay(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function basename(path) {
  const s = String(path || '');
  const i = s.lastIndexOf('/');
  return i === -1 ? s : s.slice(i + 1);
}

// ---------- row projection ----------
//
// Both stores land in this shape. `source_system` is kept on every row on
// purpose: a result list that cannot say which store a file came from is
// exactly the ambiguity this whole exercise is meant to remove.

export function normalizeDocumentRow(row) {
  const r = row || {};
  const category = normalizeCategory(r.doc_type) || 'Other';
  const documentDate = r.document_date || r.uploaded_at || null;
  return {
    id: r.id,
    source_system: 'documents',
    source: r.source || 'Manual upload',
    title: r.title || r.filename || defaultTitle({ jobTitle: r.job_title, category, date: documentDate }),
    filename: r.filename || null,
    category,
    client_id: r.client_id || null,
    client_name: r.client_name || null,
    job_id: r.job_id || null,
    job_title: r.job_title || null,
    vendor_name: r.vendor_name || null,
    document_date: documentDate,
    uploaded_at: r.uploaded_at || null,
    mime_type: r.mime_type || null,
    size_bytes: r.size_bytes == null ? null : Number(r.size_bytes),
    sensitive: !!r.sensitive,
    client_visible: !!r.client_visible,
    sub_visible: !!r.sub_visible,
    storage_bucket: 'docs',
    storage_path: r.storage_path || null,
    open_url: r.storage_path ? `/api/hivedoc?resource=file&system=documents&id=${encodeURIComponent(r.id)}` : null,
  };
}

// `jobIndex` maps a Jobber job id to { client_id, client_name, job_title }.
// It is how a media row gets a client at all -- see the header note.
export function normalizeMediaRow(row, jobIndex = {}) {
  const r = row || {};
  const job = jobIndex[r.job_id] || {};
  const category = 'Photo'; // every media row is media_type PHOTO; nothing else has ever been written
  const documentDate = r.captured_at || r.created_at || null;
  return {
    id: r.id,
    source_system: 'media',
    source: mediaSource(r.storage_path),
    title: defaultTitle({ jobTitle: job.job_title, category, date: documentDate, filename: basename(r.storage_path) }),
    filename: basename(r.storage_path) || null,
    category,
    client_id: job.client_id || null,
    client_name: job.client_name || null,
    job_id: r.job_id || null,
    job_title: job.job_title || null,
    vendor_name: null, // media has never carried a vendor; see REPORT.md section 4
    document_date: documentDate,
    uploaded_at: r.created_at || null,
    mime_type: r.mime_type || null,
    size_bytes: r.size_bytes == null ? null : Number(r.size_bytes),
    sensitive: false,
    // media is internal, always -- see canSee() and the visibility migration
    client_visible: false,
    sub_visible: false,
    storage_bucket: 'media',
    storage_path: r.storage_path || null,
    open_url: r.id ? `/api/hivedoc?resource=file&system=media&id=${encodeURIComponent(r.id)}` : null,
  };
}

// ---------- fuzzy job matching ----------
//
// "kitchen reno" has to find "Kitchen Renovation". Exact-string matching fails
// that, and a naive substring match fails it the other way round (the needle is
// longer than any single word). So: every token in the needle must prefix some
// token in the haystack. Cheap, predictable, and it does not match "kitchen"
// against "chicken" the way an edit-distance approach would.

export function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function fuzzyMatch(haystack, needle) {
  const want = tokenize(needle);
  if (!want.length) return true;
  const have = tokenize(haystack);
  if (!have.length) return false;
  return want.every((w) => have.some((h) => h.startsWith(w) || w.startsWith(h)));
}

// How well a job title matches, so the better of two candidate jobs wins.
// Whole-token hits beat prefix hits; a shorter title beats a longer one at equal
// score, because "Kitchen Reno" is a better answer than "Kitchen Reno Phase 2
// Punch List" for the query "kitchen reno".
export function matchScore(haystack, needle) {
  const want = tokenize(needle);
  if (!want.length) return 0;
  const have = tokenize(haystack);
  let score = 0;
  for (const w of want) {
    if (have.includes(w)) score += 2;
    else if (have.some((h) => h.startsWith(w))) score += 1;
  }
  return score - Math.min(have.length, 20) / 100;
}

// ---------- filters ----------

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function intOr(value, fallback, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return max == null ? n : Math.min(n, max);
}

export function parseFilters(query = {}) {
  const q = query || {};
  const category = normalizeCategory(q.category);
  return {
    // Free text, matched against title/filename/client/job when nothing more
    // specific is given. This is what the Global Search bar sends as you type.
    q: (q.q || '').trim(),
    client: (q.client || '').trim(),
    clientId: (q.client_id || '').trim(),
    job: (q.job || '').trim(),
    jobId: (q.job_id || '').trim(),
    category,
    // A category the caller asked for but we do not have is reported back
    // rather than silently ignored -- otherwise "receipts" would return photos.
    unknownCategory: q.category && !category ? String(q.category) : null,
    vendor: (q.vendor || q.vendor_name || '').trim(),
    source: (q.source || '').trim(),
    from: (q.from || '').trim(),
    to: (q.to || '').trim(),
    sort: q.sort === 'oldest' ? 'oldest' : 'newest',
    limit: intOr(q.limit, DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT,
    offset: intOr(q.offset, 0),
  };
}

// Whether the media store can possibly satisfy these filters. Every media row is
// a Photo with no vendor, so a search for invoices or for "Joe the Plumber" can
// skip 40,939 rows entirely instead of filtering them one by one.
export function mediaCouldMatch(filters) {
  if (filters.category && filters.category !== 'Photo') return false;
  if (filters.vendor) return false;
  if (filters.source && !['CompanyCam', 'Field App', 'HiveSight', 'Signature', 'Takeoff'].includes(filters.source)) return false;
  return true;
}

export function documentsCouldMatch(filters) {
  // Nothing about the documents table rules itself out the way media does --
  // it can hold any category, any source, any vendor.
  return !filters.unknownCategory;
}

// ---------- final filtering, ranking, paging ----------

function withinDates(row, filters) {
  const d = row.document_date || row.uploaded_at;
  if (!d) return !(filters.from || filters.to);
  const t = new Date(d).getTime();
  if (Number.isNaN(t)) return !(filters.from || filters.to);
  if (filters.from && t < new Date(filters.from).getTime()) return false;
  // An inclusive end date: "to=2026-07-14" means through the end of that day.
  if (filters.to) {
    const to = new Date(filters.to);
    if (/^\d{4}-\d{2}-\d{2}$/.test(filters.to)) to.setUTCHours(23, 59, 59, 999);
    if (t > to.getTime()) return false;
  }
  return true;
}

export function rowMatches(row, filters) {
  if (filters.category && row.category !== filters.category) return false;
  if (filters.source && row.source !== filters.source) return false;
  if (filters.clientId && row.client_id !== filters.clientId) return false;
  if (filters.jobId && row.job_id !== filters.jobId) return false;
  if (filters.client && !fuzzyMatch(row.client_name, filters.client)) return false;
  if (filters.job && !fuzzyMatch(row.job_title, filters.job)) return false;
  if (filters.vendor && !fuzzyMatch(row.vendor_name || row.filename, filters.vendor)) return false;
  if (!withinDates(row, filters)) return false;
  if (filters.q) {
    const haystack = [row.title, row.filename, row.client_name, row.job_title, row.vendor_name, row.category]
      .filter(Boolean).join(' ');
    if (!fuzzyMatch(haystack, filters.q)) return false;
  }
  return true;
}

// Newest first by default, because "latest invoice from Joe the Plumber" is a
// question about recency and the spec says show the newest and let Chris pick
// rather than guessing which one he meant.
export function sortRows(rows, filters) {
  const dir = filters.sort === 'oldest' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const ta = new Date(a.document_date || a.uploaded_at || 0).getTime() || 0;
    const tb = new Date(b.document_date || b.uploaded_at || 0).getTime() || 0;
    if (ta !== tb) return (ta - tb) * dir;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

export function applySearch(rows, filters) {
  const matched = (rows || []).filter((r) => rowMatches(r, filters));
  const sorted = sortRows(matched, filters);
  return {
    total: sorted.length,
    results: sorted.slice(filters.offset, filters.offset + filters.limit),
  };
}

// Groups a result set into the client -> job -> category tree HiveDoc's browse
// UI renders. Same rows, same filters, no second query.
export function groupIntoTree(rows) {
  const clients = new Map();
  for (const row of rows || []) {
    const clientKey = row.client_id || '__unassigned__';
    if (!clients.has(clientKey)) {
      clients.set(clientKey, { client_id: row.client_id || null, client_name: row.client_name || 'Unassigned', jobs: new Map(), count: 0 });
    }
    const client = clients.get(clientKey);
    client.count++;
    const jobKey = row.job_id || '__nojob__';
    if (!client.jobs.has(jobKey)) {
      client.jobs.set(jobKey, { job_id: row.job_id || null, job_title: row.job_title || 'No job', categories: new Map(), count: 0 });
    }
    const job = client.jobs.get(jobKey);
    job.count++;
    job.categories.set(row.category, (job.categories.get(row.category) || 0) + 1);
  }
  return [...clients.values()]
    .map((c) => ({
      client_id: c.client_id,
      client_name: c.client_name,
      count: c.count,
      jobs: [...c.jobs.values()].map((j) => ({
        job_id: j.job_id,
        job_title: j.job_title,
        count: j.count,
        categories: [...j.categories.entries()].map(([category, count]) => ({ category, count }))
          .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
      })).sort((a, b) => b.count - a.count || String(a.job_title).localeCompare(String(b.job_title))),
    }))
    .sort((a, b) => b.count - a.count || String(a.client_name).localeCompare(String(b.client_name)));
}

// ---------- who is allowed to see a file ----------
//
// Added 2026-08-21. The audit found neither document system had the
// internal / client-visible / subcontractor-visible model the brief described --
// only `sensitive`, which is a staff-side admin-only flag and answers a
// different question. Both axes now exist and both are enforced here, in ONE
// place, so that "can this person see this file" has a single implementation
// every surface shares. A second copy of this logic in a portal is how files
// leak.
//
// Two axes, deliberately not collapsed into one:
//
//   OUTSIDE the company -- client_visible / sub_visible on the row. Independent
//   booleans because the audiences overlap without nesting: a permit can be
//   visible to the homeowner and the plumbing sub at once, while a client
//   contract must never reach a sub. See the migration for the full argument.
//
//   INSIDE the company -- `sensitive`, unchanged: contracts and payroll are
//   admin-only, crew cannot see them.
//
// EVERYTHING IS CLOSED BY DEFAULT. A row says nothing about visibility unless
// somebody set it, an unknown audience sees nothing, and `media` is treated as
// internal always -- photo sharing has its own mechanism (client_photo_shares)
// and a second parallel path would mean two places to check.

export const AUDIENCES = ['staff', 'client', 'subcontractor'];

// Staff roles that may see a `sensitive` document. Mirrors
// api/_lib/permission-roles.js's coarse profiles.role flags.
const SENSITIVE_ROLES = ['admin', 'superadmin'];

// `viewer` is the resolved identity of whoever is asking:
//   { audience: 'staff',         role: 'admin' | 'crew' | 'superadmin' }
//   { audience: 'client',        clientId: '<jobber client id>' }
//   { audience: 'subcontractor', jobIds: ['<jobber job id>', ...] }
//
// It is built from a VERIFIED session by the caller. Nothing here trusts a
// query parameter -- an endpoint that let the caller name its own audience
// would be an open door.
export function normalizeViewer(viewer) {
  const v = viewer || {};
  const audience = AUDIENCES.includes(v.audience) ? v.audience : null;
  return {
    audience, // null means "unrecognised" -- sees nothing, rather than defaulting to staff
    role: v.role || null,
    clientId: v.clientId || null,
    jobIds: Array.isArray(v.jobIds) ? v.jobIds.filter(Boolean) : [],
  };
}

// The single decision. Returns true only if this viewer may see this row.
export function canSee(row, viewer) {
  const v = normalizeViewer(viewer);
  if (!row || !v.audience) return false;

  if (v.audience === 'staff') {
    // Staff see everything except that crew cannot open a sensitive document.
    if (row.sensitive && !SENSITIVE_ROLES.includes(v.role)) return false;
    return true;
  }

  // Outside the company, `media` is internal, always. A photo reaches a client
  // through client_photo_shares, not through this endpoint.
  if (row.source_system !== 'documents') return false;

  // A sensitive document is admin-only INSIDE the company; it has no business
  // outside it regardless of a sharing flag someone may have set.
  if (row.sensitive) return false;

  if (v.audience === 'client') {
    if (!row.client_visible) return false;
    // Scoped to THIS client. Without the id match, one client's portal would
    // see every client-visible file in the business.
    return !!(v.clientId && row.client_id && row.client_id === v.clientId);
  }

  if (v.audience === 'subcontractor') {
    if (!row.sub_visible) return false;
    // Scoped to the jobs this sub is actually assigned to.
    return !!(row.job_id && v.jobIds.includes(row.job_id));
  }

  return false;
}

export function filterVisible(rows, viewer) {
  return (rows || []).filter((r) => canSee(r, viewer));
}

// What a row looks like to an outside audience: the sharing flags and the
// storage location are internal bookkeeping and are not part of the answer.
export function redactForAudience(row, viewer) {
  const v = normalizeViewer(viewer);
  if (v.audience === 'staff') return row;
  const { sensitive, client_visible, sub_visible, storage_bucket, storage_path, source_system, ...safe } = row;
  return safe;
}
