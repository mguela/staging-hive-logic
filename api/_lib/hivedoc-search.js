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
// 2026-08-22 adds the two stores REPORT.md section 5 flagged and did not fold
// in: `sub_documents` (a subcontractor's COI / W9 / licence) and `sub_invoices`
// (the invoices a sub sends us). Both were dead on arrival -- api/subportal.js
// uploaded them to buckets that did not exist -- and both now land in the same
// private `docs` bucket, so surfacing them here costs one projection each and
// no data movement. They are the reason Chris's own acceptance question,
// "latest invoice from Joe the plumber on the John Smith job", was previously
// unanswerable: a sub's invoice was in neither table this engine read.
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

import { storagePathFromFileUrl } from './hivedoc-files.js';

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

// The two subcontractor stores. Both are keyed to a SUB, not to a client, and
// `subs` is the only place a sub's company name lives -- which is exactly the
// `vendor_name` the spec's "invoice from Joe the plumber" question filters on.
// `subIndex` maps a sub id to { company_name }.
//
// `sub_documents` has no job and no client column at all, so those stay null
// and the row files under Unassigned in the browse tree. That is the honest
// answer: a W9 belongs to a vendor, not to a job. `sub_invoices` carries a
// `job_ref` (a Jobber job GID), so it reaches a client through the same job
// index media uses.

// A subcontractor's compliance folder is admin-material, whatever `doc_type`
// says.
//
// This used to exempt a named-harmless list -- coi, insurance, licence -- on the
// reasoning that a crew lead has a real reason to check a certificate of
// insurance on site. That was wrong, and shipped wrong: #521 and #531 landed
// within hours of each other and only together revealed the disagreement.
//
// The WRITE path (api/subportal.js, SUB_DOC_SENSITIVE) stamps every sub document
// `sensitive: true` on its public.documents row, for a better reason than the
// exemption had: `doc_type` is free text the portal has never validated, so we
// cannot tell a W9 from a COI by looking. Meanwhile this function said a row
// whose doc_type happened to read "coi" was not sensitive -- so the SAME object
// was refused to crew through ?system=documents and served to them through
// ?system=sub_documents. Two representations of one file, disagreeing about who
// may open it, and the permissive one wins by being asked.
//
// One decision, taken at write time, on the stricter side. The parameter stays
// so the call site still reads as a question about a document rather than a
// constant, and so a future validated doc_type has somewhere to be honoured --
// but nothing is exempt today.
export function subDocumentIsSensitive(_docType) {
  return true;
}

const SUB_DOC_LABELS = { coi: 'Insurance (COI)', w9: 'W-9', license: 'License', licence: 'Licence' };

export function normalizeSubDocumentRow(row, subIndex = {}) {
  const r = row || {};
  const sub = subIndex[r.sub_id] || {};
  const vendor = sub.company_name || null;
  const label = SUB_DOC_LABELS[String(r.doc_type || '').toLowerCase()] || (r.doc_type || 'Document');
  const documentDate = r.uploaded_at || null;
  return {
    id: r.id,
    source_system: 'sub_documents',
    source: 'Sub Portal',
    // Not one of the spec's categories -- a COI is not a Contract, a Permit or
    // an Invoice. Filing it as Other keeps `category` inside the vocabulary the
    // filters and the documents CHECK constraint share, and `source` plus
    // `vendor_name` are what actually make it findable.
    category: 'Other',
    title: [vendor, label].filter(Boolean).join(' — ') || label,
    filename: basename(r.file_url) || null,
    client_id: null,
    client_name: null,
    job_id: null,
    job_title: null,
    vendor_name: vendor,
    document_date: documentDate,
    uploaded_at: r.uploaded_at || null,
    mime_type: null,   // sub_documents has never recorded one
    size_bytes: null,  // nor a size
    sensitive: subDocumentIsSensitive(r.doc_type),
    // A sub's own paperwork is internal. It reaches that sub through the sub
    // portal's `documents` action, which is scoped to their session -- not
    // through this endpoint, which has no per-sub scoping for these rows.
    client_visible: false,
    sub_visible: false,
    // Extra, honest fields the other two stores have no equivalent for.
    sub_id: r.sub_id || null,
    doc_type: r.doc_type || null,
    expires_at: r.expires_at || null,
    status: r.status || null,
    storage_bucket: 'docs',
    storage_path: storagePathFromFileUrl(r.file_url),
    open_url: r.id ? `/api/hivedoc?resource=file&system=sub_documents&id=${encodeURIComponent(r.id)}` : null,
  };
}

export function normalizeSubInvoiceRow(row, subIndex = {}, jobIndex = {}) {
  const r = row || {};
  const sub = subIndex[r.sub_id] || {};
  const vendor = sub.company_name || null;
  const job = jobIndex[r.job_ref] || {};
  const documentDate = r.submitted_at || null;
  return {
    id: r.id,
    source_system: 'sub_invoices',
    source: 'Sub Portal',
    category: 'Invoice',
    title: defaultTitle({ jobTitle: vendor || job.job_title, category: 'Invoice', date: documentDate }),
    filename: basename(r.file_url) || null,
    client_id: job.client_id || null,
    client_name: job.client_name || null,
    job_id: r.job_ref || null,
    job_title: job.job_title || null,
    vendor_name: vendor,
    document_date: documentDate,
    uploaded_at: r.submitted_at || null,
    mime_type: null,
    size_bytes: null,
    // An accounts-payable invoice is ordinary staff business, the same as an
    // Invoice row in `documents`. `sensitive` means admin-only-inside-the-
    // company and is reserved for contracts, payroll and tax paperwork.
    sensitive: false,
    // Never leaves the company through this endpoint. A sub sees their OWN
    // invoices through the sub portal's session-scoped `invoices` action; a
    // sub_visible flag here would show one sub another sub's billing.
    client_visible: false,
    sub_visible: false,
    sub_id: r.sub_id || null,
    amount: r.amount == null ? null : Number(r.amount),
    amount_source: r.amount_source || null,
    status: r.status || null,
    payment_due: r.payment_due || null,
    paid_at: r.paid_at || null,
    storage_bucket: 'docs',
    storage_path: storagePathFromFileUrl(r.file_url),
    open_url: r.id ? `/api/hivedoc?resource=file&system=sub_invoices&id=${encodeURIComponent(r.id)}` : null,
  };
}

// ---------- one file, one row ----------
//
// A sub upload writes TWICE: storeFiledDocument() puts a public.documents row
// next to the bytes -- which is what makes the object readable at all, since the
// `docs` read policy grants an object only when a documents row points at the
// same storage_path -- and the sub portal writes its own sub_documents /
// sub_invoices row whose file_url is that same path. Both stores are in the read
// model, so one COI arrived as two search results.
//
// THE SUB ROW IS THE ONE THAT STOPS BEING LISTED. It is not the one that gets
// thrown away, and the difference matters: the documents row for a sub upload
// holds only filename, path, mime, size, doc_type and sensitive. It has no
// vendor, no client, no job and no amount, because insertDocumentRow() writes
// baseline columns only. Suppressing the sub row outright would make "latest
// invoice from Joe the plumber on the John Smith job" -- the acceptance case the
// sub stores were added for -- match nothing at all, since the surviving row is
// a bare `invoice.pdf`.
//
// So the surviving row is the documents row, carrying the sub row's domain facts
// with it. Which half wins each field is decided by which half is authoritative
// for it, not by order:
//
//   sensitive     EITHER saying yes wins. The documents row carries the write
//                 path's own decision (SUB_DOC_SENSITIVE) and the projection
//                 agrees with it; OR-ing is the belt to that braces.
//   identity      the documents row: its id and open_url are the canonical way
//                 to reach the bytes, and its storage_path is what the bucket
//                 policy matches on.
//   sharing flags the documents row: client_visible / sub_visible only exist
//                 there, and are what the portals read.
//   everything    the sub row, where the documents row has nothing. Vendor,
//    else         client, job, amount, status, expiry and a real title are
//                 facts only the sub portal knows.
//
// A sub row with no documents row twin is left exactly as it is. That is not a
// hypothetical: rows written before 2026-08-22 have no twin, because the upload
// that would have created one always failed.

function fileKey(row) {
  return row && row.storage_bucket && row.storage_path
    ? `${row.storage_bucket}::${row.storage_path}`
    : null;
}

const SUB_SYSTEMS = ['sub_documents', 'sub_invoices'];

// Fields the sub row owns outright -- the documents row for a sub upload has no
// column for any of them.
const SUB_ONLY_FIELDS = [
  'vendor_name', 'sub_id', 'doc_type', 'expires_at', 'status',
  'amount', 'amount_source', 'payment_due', 'paid_at',
];

export function mergeDuplicateFileRows(rows) {
  const list = rows || [];
  const docsByKey = new Map();
  for (const row of list) {
    if (!row || row.source_system !== 'documents') continue;
    const key = fileKey(row);
    // First writer wins on a key collision rather than last, so the result does
    // not depend on the order two stores happened to come back in.
    if (key && !docsByKey.has(key)) docsByKey.set(key, row);
  }
  if (!docsByKey.size) return list;

  const merged = new Map();
  const out = [];
  for (const row of list) {
    if (!row || !SUB_SYSTEMS.includes(row.source_system)) { out.push(row); continue; }
    const key = fileKey(row);
    const doc = key && docsByKey.get(key);
    if (!doc) { out.push(row); continue; } // no twin: list it as it is

    // Merge into the documents row IN PLACE in the output, so the file keeps
    // the documents row's position rather than jumping to where the sub row was.
    const target = merged.get(key) || doc;
    const next = { ...target };
    for (const field of SUB_ONLY_FIELDS) {
      if (row[field] !== undefined && row[field] !== null && (next[field] === undefined || next[field] === null)) {
        next[field] = row[field];
      }
    }
    for (const field of ['client_id', 'client_name', 'job_id', 'job_title', 'category', 'source']) {
      if (!next[field] && row[field]) next[field] = row[field];
    }
    // `invoice.pdf` is a filename, not a title. The sub row builds one that
    // reads like something a person would have typed.
    if ((!next.title || next.title === next.filename) && row.title) next.title = row.title;
    if (!next.document_date && row.document_date) next.document_date = row.document_date;
    // Closed wins.
    next.sensitive = !!next.sensitive || !!row.sensitive;
    // Says out loud that this row now answers for both stores, so a caller can
    // tell a merged row from a plain documents row.
    next.also_in = [...new Set([...(next.also_in || []), row.source_system])];
    next.sub_row_id = next.sub_row_id || row.id;

    merged.set(key, next);
  }

  if (!merged.size) return out;
  return out.map((row) => {
    if (!row || row.source_system !== 'documents') return row;
    const key = fileKey(row);
    return (key && merged.get(key)) || row;
  });
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

// The same "can this store possibly answer this query" gate for the two sub
// stores, so a search for permits does not read either of them.
export function subDocumentsCouldMatch(filters) {
  if (filters.unknownCategory) return false;
  // Every sub_documents row files as Other and has no client and no job.
  if (filters.category && filters.category !== 'Other') return false;
  if (filters.source && filters.source !== 'Sub Portal') return false;
  if (filters.clientId || filters.client || filters.jobId || filters.job) return false;
  return true;
}

export function subInvoicesCouldMatch(filters) {
  if (filters.unknownCategory) return false;
  if (filters.category && filters.category !== 'Invoice') return false;
  if (filters.source && filters.source !== 'Sub Portal') return false;
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

  // Outside the company, only `documents` rows are shareable at all.
  //
  // `media` is internal always -- a photo reaches a client through
  // client_photo_shares, not through this endpoint. So are the two sub stores
  // added 2026-08-22: a subcontractor already sees their OWN paperwork and
  // their OWN invoices through the sub portal's session-scoped actions, which
  // are keyed to sub_id. This endpoint has no per-sub scoping for those rows,
  // so letting one through here would hand a sub another sub's billing. The
  // check is on an allowlist of one, not a denylist, so a store added later is
  // closed until somebody deliberately opens it.
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
