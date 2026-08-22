// api/bookkeeping/change-orders/cancel.js — non-terminal -> cancelled.
// Body: { id, reason }. Controller/admin only, always reasoned and kept in
// history — never a silent delete.

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
  if (actor.role !== 'controller') { res.status(403).json({ ok: false, error: 'Only a controller/admin may cancel a change order.' }); return; }

  try {
    const { cancelChangeOrder } = await _load_change_orders();
    const { id, reason } = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!id) { res.status(422).json({ ok: false, error: 'A change order id is required.' }); return; }

    const current = await getChangeOrder(actor.companyId, id);
    if (!current) { res.status(404).json({ ok: false, error: 'Change order not found.' }); return; }

    const updated = await updateChangeOrder(actor.companyId, id, co => cancelChangeOrder(co, actor, { reason }));
    res.status(200).json({ ok: true, changeOrder: updated });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not cancel this change order.' });
  }
}
