// api/hivedoc.js - Vercel serverless function
//
// HiveDoc's read API: one structured search across every file the business
// owns, plus the client -> job -> category browse tree and a signed open link.
//
// This is the single engine the 2026-08-21 architecture decision calls for
// (REPORT.md). Three consumers share it and none of them re-implement search:
//
//   1. the Global Search bar's live results,
//   2. Reina's natural-language layer, which translates English into these
//      same filters and calls this same endpoint,
//   3. HiveDoc's own browse UI (?resource=tree).
//
// It reads BOTH stores -- `documents` (the canonical metadata table, `docs`
// bucket) and `media` (40,939 photos, `media` bucket) -- and projects them into
// one row shape. Nothing is copied between them and nothing is deleted: `media`
// stays exactly where it is as HiveDoc's photo store, which is what makes this
// an additive change rather than a migration.
//
// Usage:
//   GET ?resource=search&client=&job=&category=&vendor=&source=&q=&from=&to=&sort=&limit=&offset=
//   GET ?resource=tree[&client=...]        client -> job -> category counts
//   GET ?resource=facets                   the categories/sources that exist, with counts
//   GET ?resource=file&system=documents|media&id=...   short-lived signed URL
import { supabaseRequest } from './_lib/jobber.js';
import { requireUser } from './_lib/auth.js';
import { hasAllowedRole } from './_lib/permission-roles.js';
import {
  parseFilters, applySearch, groupIntoTree, normalizeDocumentRow, normalizeMediaRow,
  normalizeSubDocumentRow, normalizeSubInvoiceRow, mergeDuplicateFileRows,
  mediaCouldMatch, documentsCouldMatch, subDocumentsCouldMatch, subInvoicesCouldMatch,
  fuzzyMatch, matchScore, rowMatches, CATEGORIES,
  filterVisible, redactForAudience, canSee,
} from './_lib/hivedoc-search.js';
import { parseFileQuestion } from './_lib/hivedoc-nl.js';

// A client can own a lot of jobs, and `job_id=in.(...)` goes in a URL. Past this
// many we stop filtering media server-side and let the row filter do it, rather
// than building a request that a proxy will reject.
const MAX_JOB_IDS_IN_URL = 300;
// Ceiling on how many media rows one search will pull before filtering. The
// corpus is 40,939 rows; an unbounded read would be a timeout waiting to happen.
const MEDIA_SCAN_CAP = 4000;
const DOC_SCAN_CAP = 2000;
// Both sub tables are small by construction -- one company's subcontractors --
// so a cap this size is a runaway guard, not a real ceiling.
const SUB_SCAN_CAP = 1000;

// The viewer is built from the VERIFIED session, never from a query parameter.
// An endpoint that let the caller name its own audience would be an open door,
// so this is the only place an audience is decided for a request to this file.
//
// This endpoint is staff-only: it is behind requireUser and there is no client
// or subcontractor login that reaches it. The client and subcontractor
// audiences exist in the shared helper so the portals can adopt the SAME
// decision function rather than writing a second copy of it -- which is how
// files leak. They have not adopted it yet; see REPORT.md.
async function resolveStaffViewer(user) {
  let role = null;
  try {
    const rows = await sbJson(`profiles?id=eq.${encodeURIComponent(user.id)}&select=role&limit=1`);
    role = rows && rows[0] ? rows[0].role : null;
  } catch (e) {
    // A profile we cannot read is treated as the least privileged staff role,
    // not as an admin. A lookup failure must not widen what somebody can see.
    role = null;
  }
  return { audience: 'staff', role };
}

async function sbJson(path) {
  const res = await supabaseRequest(path);
  if (!res.ok) throw new Error(`${path.split('?')[0]}: ${await res.text()}`);
  return res.json();
}

// ---------- resolving the client/job side of a query ----------
//
// `media` has no client column, so a client filter becomes a job filter. This is
// the join described in REPORT.md section 3: 100% of media rows reach a client
// through jobs.jobber_id = media.job_id.

async function resolveJobIndex(filters) {
  // Pull the jobs that could possibly match, then narrow with the fuzzy matcher
  // in code -- PostgREST's ilike cannot express "kitchen reno" -> "Kitchen
  // Renovation" without a full-text index we do not have on this column yet.
  const select = 'jobber_id,title,client_id,client_uuid';
  let rows;
  if (filters.jobId) {
    rows = await sbJson(`jobs?jobber_id=eq.${encodeURIComponent(filters.jobId)}&select=${select}`);
  } else if (filters.clientId) {
    rows = await sbJson(`jobs?client_id=eq.${encodeURIComponent(filters.clientId)}&select=${select}&limit=2000`);
  } else if (filters.client) {
    const clients = await resolveClients(filters.client);
    if (!clients.length) return { index: {}, jobIds: [], clients: [], noClientMatch: true };
    const ids = clients.map((c) => c.jobber_id).filter(Boolean);
    if (!ids.length) return { index: {}, jobIds: [], clients, noClientMatch: false };
    rows = await sbJson(`jobs?client_id=in.(${ids.map(encodeURIComponent).join(',')})&select=${select}&limit=2000`);
  } else {
    rows = null; // no client/job constraint: the index is built lazily from the rows we find
  }

  if (!rows) return { index: null, jobIds: null, clients: [], noClientMatch: false };

  let jobs = rows;
  if (filters.job) {
    const scored = jobs.map((j) => ({ j, s: matchScore(j.title, filters.job) })).filter((x) => fuzzyMatch(x.j.title, filters.job));
    jobs = scored.sort((a, b) => b.s - a.s).map((x) => x.j);
  }
  const clientNames = await clientNameIndex(jobs.map((j) => j.client_id));
  const index = {};
  for (const j of jobs) {
    index[j.jobber_id] = { client_id: j.client_id, client_name: clientNames[j.client_id] || null, job_title: j.title };
  }
  return { index, jobIds: jobs.map((j) => j.jobber_id), clients: [], noClientMatch: false };
}

async function resolveClients(nameText) {
  // A cheap prefilter in the database on the first token, then the fuzzy matcher
  // in code so "john smith" still finds "Smith, John".
  const first = String(nameText).split(/\s+/)[0] || '';
  const rows = await sbJson(`clients?name=ilike.*${encodeURIComponent(first)}*&select=jobber_id,name&limit=200`);
  return rows.filter((c) => fuzzyMatch(c.name, nameText));
}

async function clientNameIndex(clientIds) {
  const ids = [...new Set((clientIds || []).filter(Boolean))];
  if (!ids.length) return {};
  const out = {};
  // Chunked so a client with a wide job spread cannot blow the URL length.
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200).map(encodeURIComponent).join(',');
    const rows = await sbJson(`clients?jobber_id=in.(${chunk})&select=jobber_id,name`);
    for (const r of rows) out[r.jobber_id] = r.name;
  }
  return out;
}

// ---------- the two stores ----------

async function fetchDocuments(filters) {
  if (!documentsCouldMatch(filters)) return [];
  const params = [`select=*`, `limit=${DOC_SCAN_CAP}`, `order=uploaded_at.desc`];
  // Only push filters down that map cleanly onto columns that exist today. The
  // richer fields (category/source/vendor_name/document_date/title) arrive with
  // the additive migration in supabase/migrations; until then they are matched
  // in code by the row filter, which costs nothing at this row count.
  if (filters.clientId) params.push(`client_id=eq.${encodeURIComponent(filters.clientId)}`);
  if (filters.jobId) params.push(`job_id=eq.${encodeURIComponent(filters.jobId)}`);
  const rows = await sbJson(`documents?${params.join('&')}`);
  return rows.map(normalizeDocumentRow);
}

async function fetchMedia(filters, jobIndex, jobIds) {
  if (!mediaCouldMatch(filters)) return [];
  const params = [
    'select=id,job_id,job_uuid,storage_path,mime_type,size_bytes,captured_at,created_at',
    `limit=${MEDIA_SCAN_CAP}`,
    'order=captured_at.desc',
  ];
  if (jobIds && jobIds.length && jobIds.length <= MAX_JOB_IDS_IN_URL) {
    params.push(`job_id=in.(${jobIds.map(encodeURIComponent).join(',')})`);
  } else if (jobIds && jobIds.length === 0) {
    return []; // the client/job filter resolved to no jobs at all
  }
  const rows = await sbJson(`media?${params.join('&')}`);
  const index = jobIndex || (await lazyJobIndex(rows.map((r) => r.job_id)));
  return rows.map((r) => normalizeMediaRow(r, index));
}

// When a search has no client/job constraint we still need names for whatever
// rows come back, so the index is built from the results instead of up front.
async function lazyJobIndex(jobIds) {
  const ids = [...new Set((jobIds || []).filter(Boolean))];
  if (!ids.length) return {};
  const index = {};
  const clientIds = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200).map(encodeURIComponent).join(',');
    const rows = await sbJson(`jobs?jobber_id=in.(${chunk})&select=jobber_id,title,client_id`);
    for (const j of rows) {
      index[j.jobber_id] = { client_id: j.client_id, client_name: null, job_title: j.title };
      clientIds.push(j.client_id);
    }
  }
  const names = await clientNameIndex(clientIds);
  for (const key of Object.keys(index)) index[key].client_name = names[index[key].client_id] || null;
  return index;
}

// A sub's company name lives only in `subs`, and it is the `vendor_name` that
// makes "invoice from Joe the plumber" work, so it is resolved once per request
// and shared by both projections.
async function subNameIndex(subIds) {
  const ids = [...new Set((subIds || []).filter(Boolean))];
  if (!ids.length) return {};
  const out = {};
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200).map(encodeURIComponent).join(',');
    const rows = await sbJson(`subs?id=in.(${chunk})&select=id,company_name`);
    for (const r of rows) out[r.id] = { company_name: r.company_name || null };
  }
  return out;
}

async function fetchSubDocuments(filters) {
  if (!subDocumentsCouldMatch(filters)) return [];
  const rows = await sbJson(
    `sub_documents?select=*&limit=${SUB_SCAN_CAP}&order=uploaded_at.desc`,
  );
  if (!rows.length) return [];
  const subs = await subNameIndex(rows.map((r) => r.sub_id));
  return rows.map((r) => normalizeSubDocumentRow(r, subs));
}

async function fetchSubInvoices(filters, jobIndex, jobIds) {
  if (!subInvoicesCouldMatch(filters)) return [];
  const params = ['select=*', `limit=${SUB_SCAN_CAP}`, 'order=submitted_at.desc'];
  // A client or job filter narrows to that job set, exactly as it does for
  // media. `job_ref` holds the same Jobber job GID `media.job_id` does.
  if (jobIds && jobIds.length === 0) return [];
  if (jobIds && jobIds.length && jobIds.length <= MAX_JOB_IDS_IN_URL) {
    params.push(`job_ref=in.(${jobIds.map(encodeURIComponent).join(',')})`);
  }
  const rows = await sbJson(`sub_invoices?${params.join('&')}`);
  if (!rows.length) return [];
  const subs = await subNameIndex(rows.map((r) => r.sub_id));
  const index = jobIndex || (await lazyJobIndex(rows.map((r) => r.job_ref)));
  return rows.map((r) => normalizeSubInvoiceRow(r, subs, index));
}

async function gatherRows(filters) {
  const { index, jobIds, noClientMatch } = await resolveJobIndex(filters);
  if (noClientMatch) return { rows: [], noClientMatch: true };
  const [docs, media, subDocs, subInvoices] = await Promise.all([
    fetchDocuments(filters),
    fetchMedia(filters, index, jobIds),
    fetchSubDocuments(filters),
    fetchSubInvoices(filters, index, jobIds),
  ]);
  // Truncation is reported per store rather than by comparing one total against
  // one sum of caps -- that older arithmetic could only ever be right when every
  // store was read, and three of the four are now skipped routinely.
  const truncated = docs.length >= DOC_SCAN_CAP
    || media.length >= MEDIA_SCAN_CAP
    || subDocs.length >= SUB_SCAN_CAP
    || subInvoices.length >= SUB_SCAN_CAP;
  // One file, one row. A sub upload writes a documents row AND a sub row for the
  // same object, so without this an admin sees each sub file twice. The sub row
  // stops being listed; its vendor/client/job/amount ride along on the documents
  // row, which on its own knows none of them. See mergeDuplicateFileRows().
  const rows = mergeDuplicateFileRows([...docs, ...media, ...subDocs, ...subInvoices]);
  return { rows, noClientMatch: false, truncated };
}

// ---------- handler ----------

export default async function handler(req, res) {
  const user = await requireUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Sign in to search files.' });

  // Resolved once, from the verified session, and passed to everything that
  // makes a visibility decision. It was referenced below but never built, so
  // every search threw ReferenceError into the catch and came back as a 502.
  const viewer = await resolveStaffViewer(user);

  const resource = req.query.resource || 'search';
  let filters = parseFilters(req.query);

  // Reina's quick tab sends the question as typed. The English is turned into
  // filters here and then runs through the identical path a typed search takes
  // -- one engine, two front doors. `interpreted` goes back with the results so
  // a wrong reading shows up as a wrong filter rather than as "no files found".
  let interpreted = null;
  let interpretedBy = null;
  if (resource === 'ask') {
    const question = String(req.query.q || '').trim();
    if (!question) return res.status(400).json({ ok: false, error: 'Ask a question, e.g. "photos of the John Smith job".' });
    const parsed = await parseFileQuestion(question);
    interpreted = parsed.filters;
    interpretedBy = parsed.parsedBy;
    filters = parseFilters({ ...req.query, ...parsed.filters, q: parsed.filters.q });
  }

  try {
    if (resource === 'file') return await handleFile(req, res, viewer);
    if (resource === 'share') return await handleShare(req, res, user, viewer);

    if (resource === 'facets') {
      const { rows } = await gatherRows({ ...filters, limit: 200, offset: 0 });
      const visible = filterVisible(rows, viewer);
      const by = (key) => {
        const counts = {};
        for (const r of visible) counts[r[key]] = (counts[r[key]] || 0) + 1;
        return Object.entries(counts).map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
      };
      return res.status(200).json({
        ok: true, resource: 'facets', categories: by('category'), sources: by('source'),
        knownCategories: CATEGORIES,
      });
    }

    const { rows: allRows, noClientMatch, truncated } = await gatherRows(filters);
    // Visibility is applied BEFORE search, so counts and totals describe what
    // this viewer may actually see rather than what exists.
    const rows = filterVisible(allRows, viewer);

    if (resource === 'tree') {
      const matched = rows.filter((r) => rowMatches(r, filters));
      return res.status(200).json({ ok: true, resource: 'tree', clients: groupIntoTree(matched), scanned: rows.length });
    }

    const { total, results } = applySearch(rows, filters);
    return res.status(200).json({
      ok: true,
      resource: resource === 'ask' ? 'ask' : 'search',
      // Only present for ?resource=ask: what the question was understood to
      // mean, and whether the model or the fallback reader did the reading.
      ...(interpreted ? { interpreted, interpretedBy } : {}),
      total,
      limit: filters.limit,
      offset: filters.offset,
      results: results.map((r) => redactForAudience(r, viewer)),
      // Said out loud rather than returned as a silent empty list: "no such
      // client" and "that client has no files" are different answers.
      noClientMatch: !!noClientMatch,
      unknownCategory: filters.unknownCategory,
      // A scan that hit its cap has not seen everything, and a result list that
      // cannot say so would be quietly lying about completeness.
      truncated: !!truncated,
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }
}

// A short-lived signed URL, so a file is opened through HiveDoc rather than by
// handing out a bucket path. Both buckets are private.
//
// SIGNING IS A READ. This runs on the service key, which bypasses RLS, so the
// decision the database would have made has to be made here instead — with the
// SAME canSee() the list uses, not a second copy of the rule. Without it a row
// id alone was enough to open any file in the business, sensitive ones
// included: payroll, contracts, and (since 2026-08-22) onboarding licences.
// Adding the sub stores made the same 404-not-403 rule apply to two more
// tables, so the per-system knowledge is a table rather than three parallel
// ternaries that have to be kept in step by hand. A W9 has a taxpayer ID on it.
const FILE_SYSTEMS = {
  documents:     { table: 'documents',     bucket: 'docs',  normalize: (row) => normalizeDocumentRow(row) },
  media:         { table: 'media',         bucket: 'media', normalize: (row) => normalizeMediaRow(row, {}) },
  sub_documents: { table: 'sub_documents', bucket: 'docs',  normalize: (row, subs) => normalizeSubDocumentRow(row, subs) },
  sub_invoices:  { table: 'sub_invoices',  bucket: 'docs',  normalize: (row, subs) => normalizeSubInvoiceRow(row, subs, {}) },
};

async function handleFile(req, res, viewer) {
  // An unknown ?system= falls back to `documents` rather than being interpolated
  // into a query -- the query must never name a table the caller chose.
  const system = Object.prototype.hasOwnProperty.call(FILE_SYSTEMS, req.query.system)
    ? req.query.system
    : 'documents';
  const spec = FILE_SYSTEMS[system];
  const id = req.query.id;
  if (!id) return res.status(400).json({ ok: false, error: 'id is required' });

  // The whole row, not just storage_path: canSee() needs the fields the
  // projection reads, and asking for a subset is how a visibility flag quietly
  // arrives as undefined and reads as false-but-for-the-wrong-reason.
  const rows = await sbJson(`${spec.table}?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  if (!rows.length) return res.status(404).json({ ok: false, error: 'File not found' });

  const subs = rows[0].sub_id ? await subNameIndex([rows[0].sub_id]) : {};
  const row = spec.normalize(rows[0], subs);

  if (!canSee(row, viewer)) {
    // Deliberately the same 404 an unknown id gets. "You may not see this file"
    // and "there is no such file" have to be indistinguishable from outside, or
    // the error itself confirms which ids exist.
    return res.status(404).json({ ok: false, error: 'File not found' });
  }
  if (!row.storage_path) return res.status(404).json({ ok: false, error: 'This record has no file attached.' });

  const signRes = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/sign/${spec.bucket}/${row.storage_path}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!signRes.ok) return res.status(502).json({ ok: false, error: `Could not sign this file: ${await signRes.text()}` });
  const signed = await signRes.json();
  return res.status(200).json({ ok: true, url: `${process.env.SUPABASE_URL}/storage/v1${signed.signedURL}` });
}

// ---------- sharing a document outside the company ----------
//
// The staff-side write that turns the visibility flags on and off. It is an API
// rather than a direct browser write (which is how the rest of the Documents tab
// talks to Supabase) for three reasons, all of which are about blast radius:
// this is the only action in HiveDoc that can send a file OUTSIDE the company,
// it needs a role check RLS alone does not express, and it is the one action
// worth having an audit trail for.
//
// Who may share. The same roles that already manage the Client Portal, plus the
// admin/superadmin bypass hasAllowedRole() applies. Someone who can invite a
// client to the portal can also decide what that client sees; anyone else
// cannot.
const HIVEDOC_SHARE_ROLES = ['owner', 'project_manager', 'office_ar'];

// The database enforces the two leak-shaped rules as well (see the visibility
// migration), but a CHECK violation surfaces as an opaque 400. These checks
// exist so the person clicking the button is told what is actually wrong.
export function validateShare(doc, next) {
  if (!doc) return 'That document no longer exists.';
  if (next.client_visible && !doc.client_id) {
    return 'This document is not attached to a client, so there is nobody to share it with. File it under a client first.';
  }
  if (next.sub_visible && !doc.job_id) {
    return 'This document is not attached to a job, so there are no subs to share it with. File it under a job first.';
  }
  // canSee() refuses to send a sensitive document outside the company whatever
  // the sharing flags say. Rejecting it here too means the UI cannot create a
  // state that silently does nothing -- a switch that appears on and has no
  // effect is worse than one that refuses.
  if (doc.sensitive && (next.client_visible || next.sub_visible)) {
    return 'This document is marked sensitive, so it cannot be shared outside the company. Clear the sensitive flag first if that is wrong.';
  }
  return null;
}

async function handleShare(req, res, user, viewer) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });

  // hasAllowedRole needs the profile's email for the granular role lookup, and
  // its coarse role for the admin bypass.
  let profile = null;
  try {
    const rows = await sbJson(`profiles?id=eq.${encodeURIComponent(user.id)}&select=id,email,role&limit=1`);
    profile = rows && rows[0];
  } catch (e) { profile = null; }
  if (!profile) return res.status(403).json({ ok: false, error: 'Could not confirm your role, so this change was not made.' });
  if (!(await hasAllowedRole(profile, HIVEDOC_SHARE_ROLES))) {
    return res.status(403).json({ ok: false, error: 'Your role cannot share files outside the company. Ask an owner, project manager, or the office.' });
  }

  const body = req.body || {};
  const id = body.id;
  if (!id) return res.status(400).json({ ok: false, error: 'id is required' });
  const next = {
    client_visible: body.client_visible === true,
    sub_visible: body.sub_visible === true,
  };

  const rows = await sbJson(`documents?id=eq.${encodeURIComponent(id)}&select=id,filename,client_id,job_id,sensitive,client_visible,sub_visible&limit=1`);
  const doc = rows && rows[0];
  const problem = validateShare(doc, next);
  if (problem) return res.status(doc ? 400 : 404).json({ ok: false, error: problem });

  const upd = await supabaseRequest(`documents?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(next),
  });
  if (!upd.ok) return res.status(502).json({ ok: false, error: `Could not save that: ${await upd.text()}` });
  const saved = (await upd.json())[0];

  // Logged to the client audit trail, which is where a "this left the company"
  // event belongs. client_ref is nullable, so a sub-only share on a document
  // with no client still records rather than being dropped for lack of a key.
  supabaseRequest('client_audit_log', {
    method: 'POST',
    body: JSON.stringify({
      client_ref: doc.client_id || null,
      actor: 'staff:' + (profile.email || user.id),
      action: (next.client_visible || next.sub_visible) ? 'document_shared' : 'document_unshared',
      entity_type: 'document',
      entity_id: doc.id,
      detail: {
        filename: doc.filename,
        from: { client_visible: !!doc.client_visible, sub_visible: !!doc.sub_visible },
        to: next,
      },
    }),
  }).catch(() => {});

  // The staff caller is inside the company, so nothing is redacted.
  return res.status(200).json({ ok: true, document: saved });
}

