// api/bookkeeping/document-reviews.js
//
// The document review queue: closes a real, previously-permanent gap in
// server/bookkeeping/src/close.js's document_intake close-readiness check.
// That check has always looked for an 'extracted'/'processed' status on
// every stored evidence document (byte-for-byte parity with the approved
// hivelogic-expense-control reference's own check), but until this commit
// no evidence document in this app ever had a status field at all --
// api/bookkeeping/evidence.js's insertEvidence() never set one, and no
// route existed to change it. That meant document_intake was destined to
// become a real, permanent close blocker the moment any document was ever
// uploaded, with no way to clear it. See api/bookkeeping/ledger/close.js's
// header comment, which disclosed this exact gap rather than hiding it.
//
// Deliberately scoped to evidence documents only, NOT a full port of the
// reference's four-collection review queue (documentInbox/loans/
// taxNotices/payrollSummaries): those only exist in the reference because
// its Reina OCR scan step (scanStoredEvidence()) classifies every upload
// into one of those document types automatically. This app has no OCR/
// receipt-scan pipeline yet (that is its own, separate, larger task), so
// there is nothing to classify a document INTO beyond "an evidence document
// that a human still needs to look at." Building the other three
// collections now, with no real classification step to ever populate them,
// would be unused scaffolding, not a real feature -- so this route covers
// exactly the one review queue this app can honestly support today, and
// stays extensible (kind: 'evidence' in every response, matching the
// reference's shape) so a future OCR pipeline can add more kinds later
// without a breaking change here.
//
// GET  -- returns every evidence document not yet reviewed (status not in
//         ['extracted','processed']), newest first: the queue a bookkeeper
//         actually has to work through before a period can close.
// POST -- body { id, resolution?, note? } marks one document reviewed.
//         resolution defaults to 'reviewed_no_ledger_entry' -- matching the
//         reference's own default and its single "Reviewed · no entry"
//         button (no resolution picker in its UI either; this app's Books
//         Home queue mirrors that same one-click simplicity). Also appends
//         a real, tamper-evident audit entry to the same ledger audit chain
//         api/bookkeeping/ledger/audit-verify.js already checks (via
//         recordAuditEvent()), giving this action the same durability
//         guarantee as every other consequential bookkeeping action in this
//         app -- not just a status flip nobody could later verify happened.

import { getTrustedActor } from './purchase-orders/_actor.js';
import { listEvidence, markEvidenceReviewed } from './_evidence_store.js';
import { updateSystem } from './ledger/_store.js';
import { guardBookkeepingRequest } from './_security.js';

let _load_ledger_cache;
async function _load_ledger() {
  if (!_load_ledger_cache) _load_ledger_cache = await import('../../server/bookkeeping/src/ledger.js');
  return _load_ledger_cache;
}

const NEEDS_REVIEW_STATUSES_EXCLUDED = ['extracted', 'processed'];

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  if (req.method === 'GET') {
    try {
      const documents = await listEvidence(actor.companyId);
      const reviews = documents
        .filter(doc => !NEEDS_REVIEW_STATUSES_EXCLUDED.includes(doc.status || 'received'))
        .map(doc => ({ kind: 'evidence', ...doc }));
      res.status(200).json({ ok: true, reviews });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || 'Could not load the document review queue.' });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (!input.id) { res.status(400).json({ ok: false, error: 'id is required.' }); return; }

      const resolution = typeof input.resolution === 'string' && input.resolution.trim() ? input.resolution.trim() : 'reviewed_no_ledger_entry';
      const reviewed = await markEvidenceReviewed(actor.companyId, input.id, {
        resolution,
        reviewNote: typeof input.note === 'string' ? input.note.trim() : '',
        reviewedBy: actor.id
      });
      if (!reviewed) { res.status(404).json({ ok: false, error: 'That document was not found.' }); return; }

      const { recordAuditEvent } = await _load_ledger();
      await updateSystem(actor.companyId, system => {
        recordAuditEvent(system.ledger, {
          companyId: actor.companyId,
          actorId: actor.id,
          action: 'document.reviewed',
          entityType: 'evidence',
          entityId: input.id,
          after: { resolution, status: 'processed' }
        });
        return system;
      });

      res.status(200).json({ ok: true, review: { kind: 'evidence', ...reviewed } });
    } catch (error) {
      res.status(422).json({ ok: false, error: error.message || 'Could not mark this document reviewed.' });
    }
    return;
  }

  res.status(405).json({ ok: false, error: 'Only GET and POST are supported for this route.' });
}
