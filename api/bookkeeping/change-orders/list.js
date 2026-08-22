// api/bookkeeping/change-orders/list.js — GET all change orders for the
// actor's company, optionally filtered by ?jobId=. This is what the
// Change Orders page's table and toggle (Estimate vs. Invoice) render from —
// real data, not the static three-row mockup that used to live in
// public/index.html.

import { listChangeOrders } from './_store.js';
import { getTrustedActor } from '../purchase-orders/_actor.js';

export default async function handler(req, res) {
  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false, changeOrders: [] }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const jobId = req.query?.jobId || null;
    const changeOrders = await listChangeOrders(actor.companyId, { jobId });
    const { withComputedStatus } = await import('../../../server/bookkeeping/src/change-orders.js');
    res.status(200).json({ ok: true, enabled: true, changeOrders: changeOrders.map(withComputedStatus) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Could not list change orders.' });
  }
}
