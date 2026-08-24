// api/_lib/hivedoc-files.js
//
// The one way to put a file into HiveDoc's `docs` bucket.
//
// WHY THIS EXISTS. The 2026-08-21 audit found three writers uploading to
// Storage buckets that have never existed on the production project --
// `onboarding-licenses` (api/invites.js) and `sub-documents` / `sub-invoices`
// (api/subportal.js). Production has exactly six buckets, verified again on
// 2026-08-22: media, monitor-screenshots, voice-greetings, docs,
// devtodo-attachments, marketing-attachments. Every one of those uploads
// failed, every time, since the day it was written.
//
// The fix is not three new buckets. `documents` + `docs` is the canonical file
// backend (REPORT.md, approved 2026-08-21), `docs` already exists with RLS, and
// routing into it means no migration to apply. What each writer needs is a
// prefix and a metadata row, which is all this module is.
//
// THE INVARIANT: no bytes in `docs` without a public.documents row.
//
// It is not a style rule, it is what makes the file reachable at all. The
// bucket's read policy grants an object only when a VISIBLE documents row
// points at the same storage_path:
//
//     using (bucket_id = 'docs' and exists (
//       select 1 from public.documents d where d.storage_path = storage.objects.name))
//
// So an undescribed object is unreadable by every authenticated user, invisible
// to HiveDoc search, and unreachable by the owner-cleanup policy too (its
// owner_id is null -- these are service-key writes). That is not "a file with
// missing metadata", it is data nobody can find, read, or erase. Hence
// storeFiledDocument(): both writes, or neither.
//
// VISIBILITY. `sensitive` is the staff-side gate -- public.documents' own RLS
// ("read gated by sensitivity and folder" -> is_admin()) hides the row, which
// in turn hides the object. api/hivedoc.js's signing endpoint runs on the
// service key and so bypasses RLS entirely; it enforces the same rule in code
// via canSee(). Both paths have to agree, which is why callers pass `sensitive`
// here rather than deciding it at read time.

import { supabaseRequest } from './jobber.js';

export const DOCS_BUCKET = 'docs';

// Sub-portal rows predate this module. `sub_documents.file_url` and
// `sub_invoices.file_url` were written by uploaders that prefixed the bucket
// name into the value -- `sub-documents/<path>`, `sub-invoices/<path>`, and in
// a few cases `docs/<path>`. Those two hyphenated buckets never existed, so
// the rows point at nothing, but the path AFTER the prefix is the object we
// now write under `docs`. Stripping a known prefix is therefore what makes a
// legacy row signable; anything else is already a bare path and passes through
// untouched. Anchored deliberately -- a bucket name appearing mid-path is part
// of the path, not a prefix to strip.
export function storagePathFromFileUrl(fileUrl) {
  const raw = String(fileUrl || '').trim();
  if (!raw) return null;
  const legacy = /^(docs|sub-documents|sub-invoices)\//.exec(raw);
  return legacy ? raw.slice(legacy[0].length) || null : raw;
}

// 5 MB, matching what the onboarding licence step has always advertised. In
// practice the platform bites first -- these arrive as base64 inside a JSON
// body, and base64 inflates by 4/3 against a 4.5 MB serverless body limit --
// but a decoded-size check is the one that is actually about the file.
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// What a phone camera or a scanned compliance PDF actually produces. An
// allowlist rather than a denylist, and deliberately without text/html or svg:
// those execute when opened from a signed URL on the storage origin.
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic', 'image/heif',
]);

export function isAllowedUploadType(contentType) {
  return ALLOWED_TYPES.has(String(contentType || '').toLowerCase().trim());
}

// A data: URL carries no filename, so an upload from a phone would otherwise be
// filed as an extensionless blob that nothing can preview. Derived from the
// content type, which is already restricted to the allowlist above.
const EXTENSIONS = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export function extensionFor(contentType) {
  return EXTENSIONS[String(contentType || '').toLowerCase().trim()] || 'bin';
}

// One path segment, safe to interpolate into a storage URL. Callers build paths
// out of values that reach us from a browser (a filename, a free-text doc_type
// the sub portal never validated), so `..` and `/` have to stop here rather
// than at whatever Supabase happens to normalise.
//
// Dropping the separators alone would already defuse traversal, but runs of
// dots are collapsed too so no `..` survives anywhere in the result. A single
// segment has no legitimate use for one, and leaving it in would mean trusting
// every layer downstream to agree with us about what it means.
export function safeSegment(value, fallback = 'file') {
  const cleaned = String(value == null ? '' : value)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.]+|[.]+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

// A data: URL as produced by a camera capture or a file input. Returns
// { contentType, buffer } or throws an error safe to show the person uploading.
export function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!match) throw new Error('Expected a base64 data URL (e.g. from a camera capture).');
  const contentType = match[1].toLowerCase().trim();
  if (!isAllowedUploadType(contentType)) throw new Error('That file type is not accepted. Upload a PDF or a photo.');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) throw new Error('That file is empty.');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('That file is too large (max 5 MB).');
  return { contentType, buffer };
}

function storageHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    apikey: process.env.SUPABASE_SERVICE_KEY,
    ...extra,
  };
}

function objectUrl(storagePath) {
  return `${process.env.SUPABASE_URL}/storage/v1/object/${DOCS_BUCKET}/${storagePath}`;
}

export async function putDocsObject({ storagePath, buffer, contentType }) {
  const res = await fetch(objectUrl(storagePath), {
    method: 'POST',
    headers: storageHeaders({ 'Content-Type': contentType, 'x-upsert': 'true' }),
    body: buffer,
  });
  return { ok: res.ok, status: res.status };
}

// Best-effort. Only ever called with a path this process just wrote.
export async function removeDocsObject(storagePath) {
  try {
    await fetch(objectUrl(storagePath), { method: 'DELETE', headers: storageHeaders() });
  } catch { /* an undescribed object is already unreachable */ }
}

// Only baseline columns are written, on purpose. `title`, `source`, `category`,
// `document_date`, `vendor_name`, client_visible and sub_visible arrive with the
// two 2026-08-21 HiveDoc migrations, which are NOT applied to production yet --
// naming one here would make every upload fail with a PostgREST schema error.
// Their eventual defaults (internal, category derived from doc_type) are the
// right values for everything this module files anyway.
export async function insertDocumentRow({ storagePath, filename, contentType, bytes, docType = 'other', sensitive = false }) {
  try {
    const r = await supabaseRequest('documents', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{
        filename,
        storage_path: storagePath,
        mime_type: contentType,
        size_bytes: bytes,
        doc_type: docType,
        sensitive: !!sensitive,
      }]),
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return (rows && rows[0] && rows[0].id) || null;
  } catch { return null; }
}

export async function deleteDocumentRow(id) {
  try {
    await supabaseRequest(`documents?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });
  } catch { /* best effort -- the object it described is already gone */ }
}

// Upload + describe, atomically in effect: on any failure nothing is left in
// the bucket. Returns { ok, storagePath, documentId, detail }. `detail` is the
// engineering reason and is meant for a log or an internal record -- it names
// buckets and HTTP statuses, so callers must not hand it to whoever uploaded.
export async function storeFiledDocument({ storagePath, buffer, contentType, filename, docType = 'other', sensitive = false }) {
  const put = await putDocsObject({ storagePath, buffer, contentType });
  if (!put.ok) {
    return { ok: false, storagePath: null, documentId: null, detail: `Storage upload to "${DOCS_BUCKET}/${storagePath}" failed (${put.status}).` };
  }

  const documentId = await insertDocumentRow({ storagePath, filename, contentType, bytes: buffer.length, docType, sensitive });
  if (!documentId) {
    await removeDocsObject(storagePath);
    return { ok: false, storagePath: null, documentId: null, detail: 'Upload succeeded but the documents row could not be written; the object was removed.' };
  }

  return { ok: true, storagePath, documentId, detail: null };
}

// Undo a storeFiledDocument() whose CALLER then failed -- e.g. the domain row
// (sub_documents, sub_invoices) could not be written, which would leave a file
// filed against a workflow record that does not exist.
export async function discardFiledDocument({ storagePath, documentId }) {
  if (documentId) await deleteDocumentRow(documentId);
  if (storagePath) await removeDocsObject(storagePath);
}
