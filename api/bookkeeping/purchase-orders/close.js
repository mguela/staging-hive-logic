// api/bookkeeping/purchase-orders/close.js
// Closing with force=true requires a controller role and a written reason —
// enforced in the engine (closePurchaseOrder), not here. The unresolved
// exceptions and the override reason are preserved in the permanent audit
// trail (po.history), never silently dropped.

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
    const { closePurchaseOrder } = await _load_purchase_orders();
        const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const closed = await updatePurchaseOrder(actor.companyId, input.poId, po => closePurchaseOrder(po, actor, { force: !!input.force, reason: input.reason }));
    res.status(200).json({ ok: true, purchaseOrder: closed });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not close this purchase order.' });
  }
}
