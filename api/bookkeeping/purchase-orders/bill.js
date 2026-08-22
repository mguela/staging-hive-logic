// api/bookkeeping/purchase-orders/bill.js
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
    const { markBilled } = await _load_purchase_orders();
        const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const billed = await updatePurchaseOrder(actor.companyId, input.poId, po => markBilled(po, actor, input.billId));
    res.status(200).json({ ok: true, purchaseOrder: billed });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not bill this purchase order.' });
  }
}
