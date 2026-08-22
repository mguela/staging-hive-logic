// api/bookkeeping/estimates/send.js — draft -> sent. Body: { id }.
//
// Sending is also the moment the lead this estimate came from moves to
// 'estimate_sent' (Phase 0, item 5). Creating the estimate deliberately does
// not move the card: a draft can still fail to send, and a lead claiming "sent"
// on the strength of a draft would be lying.

let _load_estimates_cache;
async function _load_estimates() {
  if (!_load_estimates_cache) _load_estimates_cache = await import('../../../server/bookkeeping/src/estimates.js');
  return _load_estimates_cache;
}
import { getEstimate, updateEstimate } from './_store.js';
import { getTrustedActor } from '../purchase-orders/_actor.js';
import { advanceLeadOnSend } from '../../_lib/lead-estimate-link.js';

export default async function handler(req, res) {
  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { sendEstimate } = await _load_estimates();
    const { id } = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!id) { res.status(422).json({ ok: false, error: 'An estimate id is required.' }); return; }

    const current = await getEstimate(actor.companyId, id);
    if (!current) { res.status(404).json({ ok: false, error: 'Estimate not found.' }); return; }

    const updated = await updateEstimate(actor.companyId, id, est => sendEstimate(est, actor, {}));

    // The estimate is sent -- that is the real outcome and it has happened. If
    // the lead card can't be moved, say so rather than failing the send.
    let leadMove = null;
    if (updated.sourceLeadId) leadMove = await advanceLeadOnSend(updated.sourceLeadId);

    res.status(200).json({
      ok: true,
      estimate: updated,
      leadAdvanced: leadMove ? leadMove.advanced : undefined,
      leadStage: leadMove ? leadMove.stage : undefined,
    });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not send this estimate.' });
  }
}
