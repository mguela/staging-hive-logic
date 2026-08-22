// api/bookkeeping/estimates/list.js — GET all estimates for the actor's
// company, optionally filtered by ?clientId=. Real data — this is what the
// existing Estimate Builder's list view (efListRender) should read from
// once it's wired up, replacing the localStorage-draft-only flow it has
// today.

import { listEstimates } from './_store.js';
import { getTrustedActor } from '../purchase-orders/_actor.js';

export default async function handler(req, res) {
  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false, estimates: [] }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const clientId = req.query?.clientId || null;
    const estimates = await listEstimates(actor.companyId, { clientId });
    const { withComputedStatus } = await import('../../../server/bookkeeping/src/estimates.js');
    res.status(200).json({ ok: true, enabled: true, estimates: estimates.map(withComputedStatus) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Could not list estimates.' });
  }
}
