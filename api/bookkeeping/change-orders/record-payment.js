// api/bookkeeping/change-orders/record-payment.js — approved/paid -> paid.
// Body: { id, amount, method, reference }. This RECORDS that a payment
// happened (deposit or progress payment) — it never moves money itself and
// never touches QBO or a bank feed.

let _load_change_orders_cache;
async function _load_change_orders() {
  if (!_load_change_orders_cache) _load_change_orders_cache = await import('../../../server/bookkeeping/src/change-orders.js');
  return _load_change_orders_cache;
}
import { getChangeOrder, updateChangeOrder } from './_store.js';
import { getTrustedActor } from '../purchase-orders/_actor.js';

export default async function handler(req, res) {
  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { recordPayment } = await _load_change_orders();
    const { id, amount, method, reference } = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!id) { res.status(422).json({ ok: false, error: 'A change order id is required.' }); return; }

    const current = await getChangeOrder(actor.companyId, id);
    if (!current) { res.status(404).json({ ok: false, error: 'Change order not found.' }); return; }

    const updated = await updateChangeOrder(actor.companyId, id, co => recordPayment(co, actor, { amount, method, reference }));
    res.status(200).json({ ok: true, changeOrder: updated, note: 'Payment recorded only. No bank feed or QBO write occurred.' });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not record this payment.' });
  }
}
