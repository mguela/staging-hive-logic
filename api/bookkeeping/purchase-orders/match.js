// api/bookkeeping/purchase-orders/match.js
// Matches a receipt to one or more PO lines. See purchase-orders.js for the
// idempotency key, split-total, reconciliation, and retroactive-planning
// enforcement — this route just wires the request through to that logic.
//
// Round 3 corrections #4 and #5, both fixed together here since they're the
// same underlying bug: one receipt can touch several purchase orders at
// once, and the PREVIOUS version of this route grouped matches by poId and
// called matchReceiptToPurchaseOrders() once PER PO with only that PO's
// slice of the matches. That meant:
//   (a) the engine's "splits for one receipt line must total exactly 100%"
//       check only ever saw ONE PO's share of a cross-PO split -- it could
//       never actually validate the full allocation together, and would
//       incorrectly reject every valid cross-PO split outright.
//   (b) each PO was written with its own independent compare-and-swap call,
//       so a failure partway through (PO 2 of 3 conflicts, errors, or the
//       process dies) could leave the receipt applied to some POs and not
//       others -- half-posted, with no way to tell from the outside.
//
// Fixed by calling the engine exactly ONCE with every PO the receipt touches
// and every match in the request (so 100% allocation is validated across the
// whole receipt, not per PO), then committing every resulting PO in one
// atomic database transaction via _store.js's applyReceiptMatchBatch (see
// apply_po_batch_update in sql/010_purchase_orders.sql) -- all of them land,
// or none do.

let _load_purchase_orders_cache;
async function _load_purchase_orders() {
  if (!_load_purchase_orders_cache) _load_purchase_orders_cache = await import('../../../server/bookkeeping/src/purchase-orders.js');
  return _load_purchase_orders_cache;
}
import { getExistingBills, applyReceiptMatchBatch } from './_store.js';
import { getTrustedActor } from './_actor.js';
import { getEvidence } from '../_evidence_store.js';
import { guardBookkeepingRequest } from '../_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }
  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { matchReceiptToPurchaseOrders } = await _load_purchase_orders();
        const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!input.receipt?.id || !input.receipt?.companyId) { res.status(400).json({ ok: false, error: 'A receipt with an id and companyId is required.' }); return; }
    if (input.receipt.companyId !== actor.companyId) { res.status(403).json({ ok: false, error: 'CROSS_COMPANY_BLOCKED: this receipt does not belong to your company.', code: 'CROSS_COMPANY_BLOCKED' }); return; }

    // Fix (verified review finding: "receipt matching trusts browser-supplied
    // evidence hashes"): input.receipt.evidenceHash used to be taken as-is
    // from the request body and stored as the seen-bill's dedupe fingerprint
    // -- a client could claim any hash it wanted, including one copied from a
    // different, unrelated receipt, defeating duplicate-bill detection
    // entirely. Now the evidence hash is never trusted from the client: the
    // caller must supply a real evidenceId (from POST /api/bookkeeping/evidence),
    // it's looked up in the server-owned evidence vault, and the sha256 that
    // was computed from the actual uploaded bytes at upload time is the only
    // value ever used as the evidence hash. A receipt with no real evidence
    // record for this company is rejected outright.
    if (!input.receipt.evidenceId) { res.status(400).json({ ok: false, error: 'A receipt must reference a real uploaded document (evidenceId) before it can be matched to a purchase order.' }); return; }
    const evidence = await getEvidence(actor.companyId, input.receipt.evidenceId);
    if (!evidence) { res.status(400).json({ ok: false, error: 'That evidenceId does not match a real, uploaded document for this company.' }); return; }
    input.receipt.evidenceHash = evidence.sha256;
    input.receipt.evidenceDocumentId = evidence.id;

    const matches = input.matches || [];
    const poIds = [...new Set(matches.map(m => m.poId))];
    if (!poIds.length) { res.status(400).json({ ok: false, error: 'At least one match with a poId is required.' }); return; }

    const existingBills = await getExistingBills(actor.companyId);

    // computeUpdates runs inside applyReceiptMatchBatch's read-compute-write
    // (and retry-on-conflict) cycle: `current` is the freshly re-read set of
    // POs for this attempt, so a retry after a concurrent-write conflict
    // recomputes against the latest state rather than reapplying stale data.
    const computeUpdates = (current) =>
      matchReceiptToPurchaseOrders(current, input.receipt, matches, actor, { existingBills });

    // Round 5 fix (task #25): this used to be a separate, later
    // recordSeenBill() call after applyReceiptMatchBatch() had already
    // committed -- two independent round-trips with no shared transaction,
    // so a receipt could end up durably matched to its PO(s) but never
    // recorded for duplicate-bill detection if anything failed in between.
    // Passing seenBill straight into applyReceiptMatchBatch folds the insert
    // into the exact same atomic batch as every PO update.
    const seenBill = (input.receipt.invoiceNumber || input.receipt.qboVendorId) ? {
      companyId: actor.companyId,
      qboVendorId: input.receipt.qboVendorId,
      vendorName: input.receipt.vendorName,
      invoiceNumber: input.receipt.invoiceNumber,
      currency: input.receipt.currency,
      amount: input.receipt.amount,
      evidenceHash: input.receipt.evidenceHash,
      sourceTransactionId: input.receipt.id
    } : null;

    const updated = await applyReceiptMatchBatch(actor.companyId, poIds, computeUpdates, seenBill);

    res.status(200).json({ ok: true, purchaseOrders: updated });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not match this receipt.', code: error.code || null });
  }
}
