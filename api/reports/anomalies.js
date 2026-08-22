// api/reports/anomalies.js — Vercel serverless function.
//
// The Reports page's "Anomalies" card used to show two hardcoded, made-up
// findings (a Handyman revenue dip, an Electric capacity note) with a "Send"
// button that just popped a fake success toast -- nothing was computed and
// nothing was ever sent. This replaces that with real signals computed from
// data that actually exists today:
//
//   1. Revenue MTD swing -- reuses api/reports/summary.js's real invoice-
//      backed computation (the one real metric on this page).
//   2. After-the-fact purchase spend this month -- purchase orders created
//      without prior approval are a genuine "this bypassed the process"
//      signal, computed the same way api/bookkeeping/purchase-orders/
//      job-cost-report.js does (via the already-tested
//      approvedActualCostsForJobCosting()). Only checked when the
//      bookkeeping module is actually enabled/configured in this
//      environment -- if it isn't, this signal is honestly reported as
//      skipped rather than silently shown as "nothing found".
//
// No division-level or crew-capacity anomalies are computed here: jobs and
// invoices have no division/brand column and no crew-capacity data exists
// anywhere in this schema (confirmed by grep across sql/*.sql) -- inventing
// one would repeat exactly the kind of fake finding this replaces.
import { requireUser } from '../_lib/auth.js';
import { computeRevenueMTD } from './summary.js';

const REVENUE_SWING_THRESHOLD_PCT = 15;

async function checkRevenueSwing() {
  const revenueMTD = await computeRevenueMTD();
  if (revenueMTD.trendPct === null || Math.abs(revenueMTD.trendPct) < REVENUE_SWING_THRESHOLD_PCT) return null;
  const direction = revenueMTD.trendPct < 0 ? 'down' : 'up';
  return {
    id: 'revenue-mtd-swing',
    icon: direction === 'down' ? '📉' : '📈',
    title: `Revenue MTD is ${direction} ${Math.abs(revenueMTD.trendPct)}% vs prior period`,
    detail: `$${revenueMTD.value.toLocaleString()} this period vs $${revenueMTD.priorPeriodValue.toLocaleString()} (${revenueMTD.priorPeriodLabel}).`,
    source: 'Jobber invoices via Supabase (issued_date)'
  };
}

async function checkAfterTheFactSpend() {
  if (process.env.BOOKKEEPING_ENABLED !== 'true') {
    return { skipped: true, reason: 'Bookkeeping / purchase-order module is not enabled in this environment.' };
  }
  try {
    const { approvedActualCostsForJobCosting } = await import('../../server/bookkeeping/src/purchase-orders.js');
    const { listPurchaseOrders } = await import('../bookkeeping/purchase-orders/_store.js');
    const { SINGLE_TENANT_COMPANY_ID } = await import('../bookkeeping/purchase-orders/_actor.js');

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const purchaseOrders = await listPurchaseOrders(SINGLE_TENANT_COMPANY_ID);

    let total = 0;
    let count = 0;
    for (const po of purchaseOrders) {
      const feed = approvedActualCostsForJobCosting(po);
      if (!feed.ready) continue;
      for (const line of feed.lines) {
        if (!line.notPreapproved) continue;
        const lineDate = new Date(line.voidedAt || po.updatedAt || po.approvedAt || po.createdAt || 0);
        if (lineDate < monthStart) continue;
        total += line.amount;
        count += 1;
      }
    }
    if (count === 0) return { skipped: false, anomaly: null };
    const roundedTotal = Math.round(total * 100) / 100;
    return {
      skipped: false,
      anomaly: {
        id: 'after-the-fact-spend',
        icon: '🧾',
        title: `${count} after-the-fact purchase${count === 1 ? '' : 's'} this month bypassed PO approval`,
        detail: `$${roundedTotal.toLocaleString()} in after-the-fact spend was recorded without prior approval.`,
        source: 'Purchase order engine (approvedActualCostsForJobCosting)'
      }
    };
  } catch (error) {
    return { skipped: true, reason: `Purchase-order data could not be checked: ${error.message}` };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Only GET is supported.' });
    return;
  }
  const _authedUser = await requireUser(req);
  if (!_authedUser) return res.status(401).json({ ok: false, error: 'Not signed in.' });

  const anomalies = [];
  const skippedChecks = [];

  try {
    const revenueAnomaly = await checkRevenueSwing();
    if (revenueAnomaly) anomalies.push(revenueAnomaly);
  } catch (error) {
    skippedChecks.push({ check: 'revenue-mtd-swing', reason: error.message || 'Could not compute.' });
  }

  const afterTheFact = await checkAfterTheFactSpend();
  if (afterTheFact.skipped) skippedChecks.push({ check: 'after-the-fact-spend', reason: afterTheFact.reason });
  else if (afterTheFact.anomaly) anomalies.push(afterTheFact.anomaly);

  res.status(200).json({
    ok: true,
    anomalies,
    skippedChecks,
    note: anomalies.length
      ? undefined
      : 'No anomalies crossed the threshold on the checks this deployment can currently run.'
  });
}
