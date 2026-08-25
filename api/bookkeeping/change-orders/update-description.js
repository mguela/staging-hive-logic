// api/bookkeeping/change-orders/update-description.js — edit a change
// order's label/description before anything has been decided against it.
// Body: { id, description }.
//
// 2026-08-26, jomell: "the invoices and job order should have a title or
// label rather than just the number... their names should be edittable."
// Change orders are 100% HiveLogic-native (never Jobber-synced), so unlike
// invoices there's no sync-clobber risk here -- the only guard is the
// lifecycle one updateChangeOrderDescription enforces (draft/sent only),
// the same append-only discipline every other mutation in this file follows
// once a real decision (approve/reject/pay) has been recorded.

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
    const { updateChangeOrderDescription } = await _load_change_orders();
    const { id, description } = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!id) { res.status(422).json({ ok: false, error: 'A change order id is required.' }); return; }

    const current = await getChangeOrder(actor.companyId, id);
    if (!current) { res.status(404).json({ ok: false, error: 'Change order not found.' }); return; }

    const updated = await updateChangeOrder(actor.companyId, id, co => updateChangeOrderDescription(co, actor, { description }));
    res.status(200).json({ ok: true, changeOrder: updated });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not update this change order.' });
  }
}
