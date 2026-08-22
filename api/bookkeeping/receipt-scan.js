// api/bookkeeping/receipt-scan.js
//
// Task 8 (Receipt scanning / OCR pipeline) -- the route. Suggest-only, same
// standing rule as api/bookkeeping/reina-suggest.js: this NEVER writes an
// expense, never changes an evidence document's HUMAN review status, and
// never auto-applies anything. It reads one already-uploaded evidence
// document, asks server/bookkeeping/src/reina-scan.js to read it, runs the
// result through the already-ported, already-tested confidence/learning
// pipeline (server/bookkeeping/src/reina-learning.js's
// annotateScanConfidence()), and hands back a scan a human reviews before
// clicking "Use" on any field -- exactly like reina-suggest.js's
// suggestions, and exactly like every other AI-assisted field in this app.
//
// POST body: { evidenceId }
//
// Deliberately does NOT:
// - write to expenses, ledger, or any store
// - append a document-reviews.js-style audit-chain "reviewed" entry -- that
//   route remains the only human-accountable review action of record
//
// UPDATED 2026-07-24 (task-8 follow-up): this route used to re-scan a
// document fresh on every call and never persisted anything, which had two
// real costs: (a) every reload/re-open of an already-scanned receipt billed
// a fresh Anthropic vision call for no reason, and (b) close.js's
// document_intake check could ONLY be cleared by a human's manual
// "Reviewed" click in document-reviews.js, even after Reina had already read
// a document with high confidence -- exactly the gap
// _evidence_store.js's own header comment predicted before this pipeline
// existed. Fixed by persisting the scan (sql/028_bookkeeping_evidence_
// extracted.sql, additive -- confirmed applied to production Supabase
// 2026-07-24) via the new
// updateEvidenceExtracted():
// - a document already scanned (evidence.extracted && evidence.documentType
//   both already set) replays the stored result -- no second Anthropic call
// - a fresh, confident scan is stored with status 'extracted', clearing the
//   document_intake blocker with no separate human click required
// - a fresh, low-confidence scan is stored with status 'needs_review' --
//   NOT in ['extracted','processed'], so it still surfaces in the existing
//   document-reviews.js queue for a human to resolve; nothing here ever
//   claims a document is handled when Reina genuinely wasn't sure

import { getEvidence, updateEvidenceExtracted } from './_evidence_store.js';
import { getTrustedActor } from './purchase-orders/_actor.js';
import { guardBookkeepingRequest } from './_security.js';

let _load_reina_scan_cache;
async function _load_reina_scan() {
  if (!_load_reina_scan_cache) _load_reina_scan_cache = await import('../../server/bookkeeping/src/reina-scan.js');
  return _load_reina_scan_cache;
}

let _load_reina_learning_cache;
async function _load_reina_learning() {
  if (!_load_reina_learning_cache) _load_reina_learning_cache = await import('../../server/bookkeeping/src/reina-learning.js');
  return _load_reina_learning_cache;
}

// Reina's document reader only knows how to look at images and PDFs -- a
// bank CSV or any other mime type attached as "evidence" for a different
// reason has nothing for it to visually read.
const SCANNABLE_MIME_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const evidenceId = typeof input.evidenceId === 'string' ? input.evidenceId.trim() : '';
    if (!evidenceId) { res.status(400).json({ ok: false, error: 'evidenceId is required.' }); return; }

    const doc = await getEvidence(actor.companyId, evidenceId);
    if (!doc) { res.status(404).json({ ok: false, error: 'That evidence document was not found.' }); return; }

    if (!SCANNABLE_MIME_TYPES.has(doc.mimeType)) {
      res.status(200).json({
        ok: true,
        enabled: true,
        scannable: false,
        note: `Reina can only read images and PDFs -- this document is ${doc.mimeType || 'an unrecognized file type'} and cannot be scanned.`
      });
      return;
    }

    const { scanReceiptWithReina, reinaScanConfigured } = await _load_reina_scan();
    const { annotateScanConfidence } = await _load_reina_learning();

    let annotated;
    let cached = false;
    if (doc.extracted && doc.documentType) {
      // Already scanned once -- replay the stored, already-annotated result
      // rather than paying for a second Anthropic call against the same,
      // immutable (no edit endpoint exists) file.
      annotated = doc.extracted;
      cached = true;
    } else {
      const rawScan = await scanReceiptWithReina({ imageBase64: doc.dataBase64, mimeType: doc.mimeType });
      annotated = annotateScanConfidence(rawScan);
      const requiresReview = Boolean(annotated.needsAiConnection) || Boolean(annotated.reviewSummary && annotated.reviewSummary.requiresReview);
      const newStatus = requiresReview ? 'needs_review' : 'extracted';
      await updateEvidenceExtracted(actor.companyId, doc.id, { status: newStatus, documentType: annotated.documentType, extracted: annotated });
    }

    res.status(200).json({
      ok: true,
      enabled: true,
      scannable: true,
      configured: reinaScanConfigured(),
      cached,
      evidenceId: doc.id,
      scan: annotated
    });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || "Could not scan this document with Reina." });
  }
}
