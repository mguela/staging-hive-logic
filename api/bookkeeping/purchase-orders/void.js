// api/bookkeeping/purchase-orders/void.js
// Round 5 addition: the controller-only, audit-preserving reversal path for
// a PO that already has received/billed activity against it. See
// voidPostedPurchaseOrder in server/bookkeeping/src/purchase-orders.js --
// this never touches the original received/billed data, it only marks the
// PO voided with a reason, which the job-cost feed reads to emit an
// equal-and-opposite reversal line alongside the (still fully visible)
// original.
let _load_purchase_orders_cache;
async function _load_purchase_orders() {
  if (!_load_purchase_orders_cache) _load_purchase_orders_cache = await import('../../../server/bookkeeping/src/purchase-orders.js');
  return _load_purchase_orders_cache;
}
import { updatePurchaseOrder } from './_store.js';
import { getTrustedActor } from './_actor.js';
import { guardBookkeepingRequest } from '../_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }
  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { voidPostedPurchaseOrder } = await _load_purchase_orders();
        const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const voided = await updatePurchaseOrder(actor.companyId, input.poId, po => voidPostedPurchaseOrder(po, actor, input.reason));
    res.status(200).json({ ok: true, purchaseOrder: voided });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not void this purchase order.' });
  }
}
