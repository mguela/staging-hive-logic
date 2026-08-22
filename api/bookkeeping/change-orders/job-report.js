// api/bookkeeping/change-orders/job-report.js — GET ?jobId=... — the
// reporting-side answer to Chris's spec: "it becomes an additional activity
// on the reporting side when calculating profitability but also can be
// drilled down into for a closer reporting of just the change order
// itself." Returns both: the rolled-up additional-activity numbers for the
// job, and a per-CO drill-down list.

import { listChangeOrders } from './_store.js';
import { getTrustedActor } from '../purchase-orders/_actor.js';

export default async function handler(req, res) {
  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  const jobId = req.query?.jobId;
  if (!jobId) { res.status(422).json({ ok: false, error: 'A jobId query parameter is required.' }); return; }

  try {
    const { changeOrderProfitabilityForJob, changeOrderDrilldown } = await import('../../../server/bookkeeping/src/change-orders.js');
    const changeOrders = await listChangeOrders(actor.companyId, { jobId });
    const profitability = changeOrderProfitabilityForJob(changeOrders, jobId);
    const drilldowns = changeOrders.map(changeOrderDrilldown);
    res.status(200).json({ ok: true, enabled: true, jobId, profitability, changeOrders: drilldowns });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Could not build the change order job report.' });
  }
}
