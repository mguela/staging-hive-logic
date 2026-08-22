// api/bookkeeping/purchase-orders/job-cost-report.js — Vercel serverless function.
// The owner/controller/accounting-facing report the outside review asked for:
// "Reports (owner, controller, accounting) updated to reflect POs and
// after-the-fact purchases distinctly." Rather than bolt this onto the
// separate Financial/P&L pages (which are still static design mockups per
// HiveLogic-Build-Sheet.md — not this task's scope), this report is native to
// the PO engine itself: it runs the already-tested
// approvedActualCostsForJobCosting() across every PO in the company and
// aggregates the result per job, keeping preapproved and after-the-fact
// dollars in visibly separate totals — never a single blended number.
//
// This report only ever shows costs the engine has already deemed ready to
// release (see approvedActualCostsForJobCosting: draft POs, unapproved POs,
// and POs with unresolved exceptions are excluded). QBO writes are never
// made from this route.

let _load_purchase_orders_cache;
async function _load_purchase_orders() {
  if (!_load_purchase_orders_cache) _load_purchase_orders_cache = await import('../../../server/bookkeeping/src/purchase-orders.js');
  return _load_purchase_orders_cache;
}
import { listPurchaseOrders } from './_store.js';
import { getTrustedActor } from './_actor.js';
import { guardBookkeepingRequest } from '../_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false, jobs: [] }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { approvedActualCostsForJobCosting } = await _load_purchase_orders();
        const purchaseOrders = await listPurchaseOrders(actor.companyId);
    const byJob = new Map();
    const notReady = [];

    for (const po of purchaseOrders) {
      const feed = approvedActualCostsForJobCosting(po);
      if (!feed.ready) {
        if (feed.reason) notReady.push({ poNumber: po.poNumber, jobId: po.jobId, reason: feed.reason });
        continue;
      }
      const jobKey = po.jobId || po.overheadCategory || 'unassigned';
      if (!byJob.has(jobKey)) byJob.set(jobKey, { jobId: po.jobId || null, overheadCategory: po.jobId ? null : (po.overheadCategory || 'Unassigned'), preapprovedTotal: 0, afterTheFactTotal: 0, lines: [] });
      const bucket = byJob.get(jobKey);
      for (const line of feed.lines) {
        // Parity addition: the reference UI's per-line supporting-detail
        // table needs a vendor, a timing label, and a transaction date --
        // none of which approvedActualCostsForJobCosting() puts on a line
        // (it only knows amounts and PO linkage, not the PO's vendor or a
        // per-line date). Attached here, in the route, from the real po
        // object already in scope -- the tested engine function itself is
        // not touched. transactionDate uses the line's own voidedAt when
        // present (a reversal line), otherwise the PO's real updatedAt:
        // the engine tracks a last-mutation timestamp per PO, not a
        // distinct timestamp per line, so every line on a PO honestly
        // shares that PO's own updatedAt rather than a fabricated date.
        const enrichedLine = {
          ...line,
          vendor: po.vendorName || null,
          timing: line.notPreapproved ? 'after_the_fact' : 'preapproved',
          transactionDate: line.voidedAt || po.updatedAt || po.approvedAt || po.createdAt || null
        };
        if (enrichedLine.notPreapproved) bucket.afterTheFactTotal += enrichedLine.amount;
        else bucket.preapprovedTotal += enrichedLine.amount;
        bucket.lines.push(enrichedLine);
      }
    }

    const jobs = [...byJob.values()].map(bucket => ({
      ...bucket,
      preapprovedTotal: Math.round(bucket.preapprovedTotal * 100) / 100,
      afterTheFactTotal: Math.round(bucket.afterTheFactTotal * 100) / 100,
      total: Math.round((bucket.preapprovedTotal + bucket.afterTheFactTotal) * 100) / 100
    }));

    const companyTotals = jobs.reduce((sum, j) => ({
      preapprovedTotal: sum.preapprovedTotal + j.preapprovedTotal,
      afterTheFactTotal: sum.afterTheFactTotal + j.afterTheFactTotal
    }), { preapprovedTotal: 0, afterTheFactTotal: 0 });

    res.status(200).json({
      ok: true,
      enabled: true,
      jobs,
      companyTotals: {
        preapprovedTotal: Math.round(companyTotals.preapprovedTotal * 100) / 100,
        afterTheFactTotal: Math.round(companyTotals.afterTheFactTotal * 100) / 100,
        total: Math.round((companyTotals.preapprovedTotal + companyTotals.afterTheFactTotal) * 100) / 100
      },
      notReady,
      note: 'Only approved, exception-free (or controller-force-closed) actual costs appear here. After-the-fact purchases are always included in the total but are never counted as preapproved, in this report or any export.'
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Could not build the job cost report.' });
  }
}
