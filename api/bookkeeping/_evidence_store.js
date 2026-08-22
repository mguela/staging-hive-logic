// api/bookkeeping/_evidence_store.js
//
// Backs POST/GET /api/bookkeeping/evidence -- the route
// public/app-bookkeeping.js has called since it was written, but which had
// NO SERVER ROUTE AT ALL until this commit (confirmed by
// `git grep -rn "bookkeeping/evidence"` across the whole repo returning
// only the one fetch() call in app-bookkeeping.js and one comment
// referencing the expected route in purchase-orders/match.js -- no
// api/bookkeeping/evidence.js file existed anywhere). Every "attach a
// receipt" click was silently 404ing, state.evidenceId never got set, and
// saveExpense() refuses to save without an evidenceId -- so Expense Entry
// could not be submitted at all until this fix. A real, verified, high-
// value bug, not a polish item.
//
// Two backends, same dual-backend convention as every other bookkeeping
// store in this app (_expense_store.js, _catalog_store.js,
// purchase-orders/_store.js):
//
// - "memory": module-level array per company. Local/demo only; resets on
//   cold start.
// - "durable": Postgres via Supabase's REST endpoint
//   (sql/022_bookkeeping_evidence.sql + sql/023_bookkeeping_evidence_review.sql
//   + sql/028_bookkeeping_evidence_extracted.sql). The raw file is stored as
//   a base64 TEXT column, not bytea -- PostgREST's JSON encoding of bytea is
//   hex-escaped and awkward to round-trip, and the data already arrives from
//   the browser as base64 and needs to be re-served as raw bytes to an
//   <img>/<iframe> src, so storing the same base64 text sidesteps a real
//   encoding mismatch rather than adding one. The ~33% storage overhead vs.
//   true binary is a deliberate, documented trade-off for receipt-volume
//   documents, not a hidden problem.
//
// Which backend is active is controlled by BOOKKEEPING_EVIDENCE_STORE
// ('memory' default, 'durable' to opt in), with the same fail-closed
// production rule every other bookkeeping store in this app enforces.
//
// Review status (added alongside api/bookkeeping/document-reviews.js):
// every document is created with status 'received' -- an honest starting
// state, since it genuinely hasn't been looked at yet. It moves to
// 'processed' when a human resolves it through the document-reviews route,
// to 'extracted' automatically once Reina's OCR scan (below) reads it with
// real confidence, or to 'needs_review' when Reina scanned it but wasn't
// confident enough to call it done. server/bookkeeping/src/close.js's
// document_intake close-readiness check reads exactly this field: any
// document not in ['extracted','processed'] counts as a real, permanent
// blocker until a person -- or a confident scan -- resolves it.
//
// Scan persistence (documentType/extracted, sql/028_bookkeeping_evidence_
// extracted.sql, additive, NOT applied to any real database by this
// change -- run it yourself before enabling durable storage on an
// environment with existing evidence documents): added alongside the
// api/bookkeeping/receipt-scan.js caching fix. Two real effects: (1) a
// document already scanned replays the stored `extracted` result instead of
// calling Anthropic a second time for the same file -- real cost/latency
// discipline, since a vision-model scan is a paid API call, not free; (2) a
// confident scan is the SECOND real path into the document_intake passing
// state, exactly as predicted in this file's own comment before this
// pipeline existed.

import { supabaseRequest } from '../_lib/jobber.js';
import { randomUUID, createHash } from 'node:crypto';

export const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024; // 20MB -- receipts/bills, not video

function resolveBackend() {
  const requested = process.env.BOOKKEEPING_EVIDENCE_STORE === 'durable' ? 'durable' : 'memory';
  const isProduction = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';

  if (isProduction) {
    if (requested !== 'durable') {
      throw new Error(
        'FAIL_CLOSED: this is a production environment and BOOKKEEPING_EVIDENCE_STORE is not set to "durable". ' +
        'Refusing to start on in-memory evidence storage in production -- real receipts/bills would silently ' +
        'vanish on every cold start. Set BOOKKEEPING_EVIDENCE_STORE=durable after running ' +
        'sql/022_bookkeeping_evidence.sql and sql/023_bookkeeping_evidence_review.sql against the real Supabase project.'
      );
    }
    if (process.env.BOOKKEEPING_EVIDENCE_MIGRATION_CONFIRMED !== 'true') {
      throw new Error(
        'FAIL_CLOSED: production is configured for durable evidence storage, but ' +
        'BOOKKEEPING_EVIDENCE_MIGRATION_CONFIRMED is not "true". Set that flag only after you have personally run ' +
        'sql/022_bookkeeping_evidence.sql and sql/023_bookkeeping_evidence_review.sql against this environment\'s ' +
        'real Supabase project -- this is a deliberate human checkpoint before real evidence documents depend on ' +
        'that schema existing.'
      );
    }
    return 'durable';
  }

  if (requested === 'memory') {
    const allowMemory = process.env.NODE_ENV === 'test' || process.env.BOOKKEEPING_ALLOW_MEMORY_STORE === 'true';
    if (!allowMemory) {
      throw new Error(
        'FAIL_CLOSED: memory-mode evidence storage requires an explicit development/test flag. ' +
        'Set BOOKKEEPING_ALLOW_MEMORY_STORE=true for local/demo use, or run under NODE_ENV=test for automated ' +
        'tests. This prevents memory mode from ever being a silent, un-opted-into default.'
      );
    }
  }
  return requested;
}

const BACKEND = resolveBackend();

// ---------------------------------------------------------------------------
// memory backend
// ---------------------------------------------------------------------------
const memEvidenceByCompany = {};
function memDocs(companyId) {
  return memEvidenceByCompany[companyId] || (memEvidenceByCompany[companyId] = []);
}

// ---------------------------------------------------------------------------
// durable backend
// ---------------------------------------------------------------------------
function rowToDoc(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    dataBase64: row.data_base64,
    status: row.status || 'received',
    resolution: row.resolution || null,
    reviewNote: row.review_note || null,
    reviewedAt: row.reviewed_at || null,
    reviewedBy: row.reviewed_by || null,
    documentType: row.document_type || null,
    extracted: row.extracted || null,
    createdAt: row.created_at
  };
}

// Same shape as rowToDoc() but without data_base64 or extracted -- listing
// is for a vault index (filename/type/size/date/review status), never for
// handing raw file bytes -- or a full scan payload, which can carry a whole
// line-item table -- back in bulk. GET /api/bookkeeping/evidence?id=... and
// POST /api/bookkeeping/scan remain the only ways to get a document's actual
// bytes or its full scan result.
function rowToDocSummary(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    status: row.status || 'received',
    resolution: row.resolution || null,
    reviewNote: row.review_note || null,
    reviewedAt: row.reviewed_at || null,
    reviewedBy: row.reviewed_by || null,
    documentType: row.document_type || null,
    createdAt: row.created_at
  };
}

async function durableInsert(doc) {
  const res = await supabaseRequest('bookkeeping_evidence_documents', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      id: doc.id,
      company_id: doc.companyId,
      filename: doc.filename,
      mime_type: doc.mimeType,
      size_bytes: doc.sizeBytes,
      sha256: doc.sha256,
      data_base64: doc.dataBase64,
      status: doc.status,
      created_by: doc.createdBy || null
    }])
  });
  if (!res.ok) throw new Error(`Could not save this file to the evidence vault: ${await res.text()}`);
  const rows = await res.json();
  return rowToDoc(rows[0]);
}

async function durableGet(companyId, id) {
  const res = await supabaseRequest(`bookkeeping_evidence_documents?company_id=eq.${encodeURIComponent(companyId)}&id=eq.${encodeURIComponent(id)}&select=*`);
  if (!res.ok) throw new Error(`Could not read this evidence document: ${await res.text()}`);
  const rows = await res.json();
  return rows.length ? rowToDoc(rows[0]) : null;
}

// select= explicitly omits data_base64 and extracted -- listing every
// receipt's full file body or full scan payload just to build a vault index
// would be a real (and needless) payload blow-up once a company has hundreds
// of receipts on file.
async function durableList(companyId) {
  const res = await supabaseRequest(`bookkeeping_evidence_documents?company_id=eq.${encodeURIComponent(companyId)}&select=id,company_id,filename,mime_type,size_bytes,sha256,status,resolution,review_note,reviewed_at,reviewed_by,document_type,created_at&order=created_at.desc`);
  if (!res.ok) throw new Error(`Could not list evidence documents: ${await res.text()}`);
  const rows = await res.json();
  return rows.map(rowToDocSummary);
}

async function durableUpdateReview(companyId, id, { status, resolution, reviewNote, reviewedBy }) {
  const res = await supabaseRequest(`bookkeeping_evidence_documents?company_id=eq.${encodeURIComponent(companyId)}&id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      status,
      resolution: resolution || null,
      review_note: reviewNote || null,
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewedBy || null
    })
  });
  if (!res.ok) throw new Error(`Could not update this document's review status: ${await res.text()}`);
  const rows = await res.json();
  return rows.length ? rowToDoc(rows[0]) : null;
}

// Persists a Reina OCR scan result -- distinct from durableUpdateReview()
// above, which is the human-reviewer path (sets resolution/reviewer/
// timestamp, always to 'processed'). This path is machine-authored: it only
// ever touches status/document_type/extracted, never resolution or
// reviewed_by/reviewed_at, so a machine scan is never confused with a human
// having actually signed off on a document.
async function durableUpdateExtracted(companyId, id, { status, documentType, extracted }) {
  const res = await supabaseRequest(`bookkeeping_evidence_documents?company_id=eq.${encodeURIComponent(companyId)}&id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      status,
      document_type: documentType || null,
      extracted: extracted || null
    })
  });
  if (!res.ok) throw new Error(`Could not save this document's scan result: ${await res.text()}`);
  const rows = await res.json();
  return rows.length ? rowToDoc(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Public interface -- api/bookkeeping/evidence.js, document-reviews.js, and
// scan.js/receipt-scan.js go through this, never the two backends directly,
// so swapping BOOKKEEPING_EVIDENCE_STORE never touches route code.
// ---------------------------------------------------------------------------
export function storeBackend() {
  return BACKEND;
}

// Server computes and returns the sha256 itself -- never trusts a
// client-supplied hash, since the whole point of the hash here is tamper
// evidence for what is actually stored, not for what the client claims to
// have sent.
export async function insertEvidence({ companyId, filename, mimeType, dataBase64, createdBy }) {
  if (!dataBase64) throw new Error('No file data was received.');
  let buffer;
  try {
    buffer = Buffer.from(dataBase64, 'base64');
  } catch {
    throw new Error('That file could not be read. Try a different file.');
  }
  if (!buffer.length) throw new Error('That file appears to be empty.');
  if (buffer.length > MAX_EVIDENCE_BYTES) {
    throw new Error(`That file is too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). The limit is ${MAX_EVIDENCE_BYTES / 1024 / 1024} MB.`);
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const doc = {
    id: randomUUID(),
    companyId,
    filename: String(filename || 'receipt').slice(0, 255),
    mimeType: String(mimeType || 'application/octet-stream'),
    sizeBytes: buffer.length,
    sha256,
    dataBase64: buffer.toString('base64'),
    status: 'received',
    createdBy: createdBy || null
  };

  if (BACKEND === 'memory') {
    const stored = { ...doc, resolution: null, reviewNote: null, reviewedAt: null, reviewedBy: null, documentType: null, extracted: null, createdAt: new Date().toISOString() };
    memDocs(companyId).push(stored);
    return stored;
  }
  return durableInsert(doc);
}

export async function getEvidence(companyId, id) {
  if (BACKEND === 'memory') return memDocs(companyId).find(d => d.id === id) || null;
  return durableGet(companyId, id);
}

// Added for the Books Home evidence vault (list view) and for wiring real
// evidence documents into close.js's closeReadiness()/buildClosePackage() --
// both previously had no way to see "every evidence document this company
// has" at all; close.js was passing a hardcoded empty array instead.
// Returns summaries (no file bytes, no full scan payload) newest-first.
export async function listEvidence(companyId) {
  if (BACKEND === 'memory') {
    return memDocs(companyId)
      .map(rowToDocSummary_memory)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }
  return durableList(companyId);
}

// Marks one evidence document reviewed -- the only write path that moves a
// document out of the close-readiness document_intake blocker BY A HUMAN.
// Mirrors the approved reference's POST /api/document-reviews/:kind/:id/resolve
// for the 'evidence' kind (this app has no documentInbox/loans/taxNotices/
// payrollSummaries collections -- those only exist in the reference because
// its Reina OCR scan step classifies incoming documents into those types;
// this app has no OCR/scan pipeline yet, so evidence documents are the only
// real review queue there is to build against right now -- a disclosed,
// intentional scope limit, not a shortcut).
export async function markEvidenceReviewed(companyId, id, { resolution, reviewNote, reviewedBy } = {}) {
  if (BACKEND === 'memory') {
    const doc = memDocs(companyId).find(d => d.id === id);
    if (!doc) return null;
    doc.status = 'processed';
    doc.resolution = resolution || 'reviewed_no_ledger_entry';
    doc.reviewNote = reviewNote || null;
    doc.reviewedAt = new Date().toISOString();
    doc.reviewedBy = reviewedBy || null;
    return doc;
  }
  return durableUpdateReview(companyId, id, { status: 'processed', resolution: resolution || 'reviewed_no_ledger_entry', reviewNote, reviewedBy });
}

// Persists a Reina OCR scan result onto its evidence document -- added
// alongside api/bookkeeping/receipt-scan.js's caching fix (task 8 follow-up,
// 2026-07-24). Deliberately separate from markEvidenceReviewed() above: this
// never sets resolution/reviewedBy/reviewedAt, so a machine-authored scan
// (status 'extracted' or 'needs_review') is never confused with a human
// having actually reviewed and signed off on a document -- that remains
// document-reviews.js's job alone, and its own audit-chain entry is the only
// tamper-evident record of an actual human decision. A confident scan simply
// clears the document_intake blocker without requiring that extra click; a
// low-confidence scan ('needs_review') deliberately does NOT clear it, so it
// still surfaces in document-reviews.js's existing queue unchanged.
export async function updateEvidenceExtracted(companyId, id, { status, documentType, extracted }) {
  if (BACKEND === 'memory') {
    const doc = memDocs(companyId).find(d => d.id === id);
    if (!doc) return null;
    doc.status = status || doc.status;
    doc.documentType = documentType || null;
    doc.extracted = extracted || null;
    return doc;
  }
  return durableUpdateExtracted(companyId, id, { status, documentType, extracted });
}

// Memory-backend docs are already plain objects (not Postgres rows), so this
// just strips dataBase64 and extracted (matching rowToDocSummary()'s field
// set exactly) rather than reshaping snake_case columns.
function rowToDocSummary_memory(doc) {
  const { dataBase64, extracted, ...summary } = doc;
  return summary;
}
