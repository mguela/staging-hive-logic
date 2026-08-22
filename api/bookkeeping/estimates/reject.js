// api/bookkeeping/estimates/reject.js — sent -> rejected. Body: { id, reason }.

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

  try {
    const { rejectEstimate } = await _load_estimates();
    const { id, reason } = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!id) { res.status(422).json({ ok: false, error: 'An estimate id is required.' }); return; }

    const current = await getEstimate(actor.companyId, id);
    if (!current) { res.status(404).json({ ok: false, error: 'Estimate not found.' }); return; }

    const updated = await updateEstimate(actor.companyId, id, est => rejectEstimate(est, actor, { reason }));
    res.status(200).json({ ok: true, estimate: updated });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not reject this estimate.' });
  }
}
