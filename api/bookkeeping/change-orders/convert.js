// api/bookkeeping/change-orders/convert.js — paid -> converted. Body: { id }.
// This is the "convert to Change Order Job" step in Chris's workflow: the
// change order becomes its own job record, permanently chained to the
// original job (parentJobId), while its dollars keep rolling into the
// parent job's profitability report as an additional activity.

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
    const { convertToChangeOrderJob } = await _load_change_orders();
    const { id } = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!id) { res.status(422).json({ ok: false, error: 'A change order id is required.' }); return; }

    const current = await getChangeOrder(actor.companyId, id);
    if (!current) { res.status(404).json({ ok: false, error: 'Change order not found.' }); return; }

    const updated = await updateChangeOrder(actor.companyId, id, co => convertToChangeOrderJob(co, actor, {}));
    res.status(200).json({ ok: true, changeOrder: updated, note: `Converted to Change Order Job ${updated.convertedJobId}, chained to parent job ${updated.jobId}.` });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not convert this change order to a job.' });
  }
}
