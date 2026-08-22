// api/bookkeeping/estimates/approve.js — sent -> approved. Body: { id }.
// Blocked by the engine itself until the deposit has been fully paid —
// this route does not duplicate that check, it just surfaces whatever the
// engine says. Controller/admin only, mirroring change-orders/approve.js.

let _load_estimates_cache;
async function _load_estimates() {
  if (!_load_estimates_cache) _load_estimates_cache = await import('../../../server/bookkeeping/src/estimates.js');
  return _load_estimates_cache;
}
import { getEstimate, updateEstimate } from './_store.js';
import { getTrustedActor } from '../purchase-orders/_actor.js';

export default async function handler(req, res) {
  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }
  if (actor.role !== 'controller') { res.status(403).json({ ok: false, error: 'Only a controller/admin may approve an estimate.' }); return; }

  try {
    const { approveEstimate } = await _load_estimates();
    const { id } = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!id) { res.status(422).json({ ok: false, error: 'An estimate id is required.' }); return; }

    const current = await getEstimate(actor.companyId, id);
    if (!current) { res.status(404).json({ ok: false, error: 'Estimate not found.' }); return; }

    const updated = await updateEstimate(actor.companyId, id, est => approveEstimate(est, actor, {}));
    res.status(200).json({ ok: true, estimate: updated });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not approve this estimate.' });
  }
}
