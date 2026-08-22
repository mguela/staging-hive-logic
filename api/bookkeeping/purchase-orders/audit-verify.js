// api/bookkeeping/purchase-orders/audit-verify.js
// GET-only, read-only, on-demand integrity check for one purchase order's
// append-only history chain (server/bookkeeping/src/purchase-orders.js's
// verifyPurchaseOrderHistory() -- exported, tested, but never wired to a
// route before this commit, so the UI had no way to ever call it).
//
// Honest scope note, matching the rebuild spec's "no fake results" rule:
// this checks that the PO's own history array is internally self-consistent
// (each record's hash correctly chains from the previous one) -- it does
// NOT cross-check against an independent, append-only witness table the way
// api/bookkeeping/ledger/audit-verify.js's verifyAuditChainAgainstLog()
// does against bookkeeping_audit_log. A wholesale rewrite of the stored PO
// blob could in theory still produce a self-consistent chain. The UI must
// label this "history chain self-consistent," never "cryptographically
// verified" or "tamper-proof" -- those claims are not true of this specific
// check, whatever the reference implementation's UI copy says.

import { getPurchaseOrder } from './_store.js';
import { getTrustedActor } from './_actor.js';
import { guardBookkeepingRequest } from '../_security.js';

let _load_purchase_orders_cache;
async function _load_purchase_orders() {
  if (!_load_purchase_orders_cache) _load_purchase_orders_cache = await import('../../../server/bookkeeping/src/purchase-orders.js');
  return _load_purchase_orders_cache;
}

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Only GET is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { poId } = req.query || {};
    if (!poId) { res.status(400).json({ ok: false, error: 'A purchase order id is required.' }); return; }
    const po = await getPurchaseOrder(actor.companyId, poId);
    if (!po) { res.status(404).json({ ok: false, error: 'That purchase order was not found.' }); return; }
    const { verifyPurchaseOrderHistory } = await _load_purchase_orders();
    const result = verifyPurchaseOrderHistory(po);
    res.status(200).json({ ok: true, valid: result.valid, brokenAt: result.brokenAt || null, records: result.records ?? (po.history || []).length });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not verify this purchase order\'s history.' });
  }
}
