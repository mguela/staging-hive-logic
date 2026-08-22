// api/bookkeeping/sales-tax.js
//
// Real sales-tax-liability tracking (task 7, second half). Closes the
// other half of the gap described in ./contractors.js's header comment:
// server/bookkeeping/src/reporting.js's salesTaxLiability(sales,
// payments, throughDate) was already a complete, tested engine function,
// but close.js/close-package.js have always called it with
// system.sales||[] and system.taxPayments||[], and nothing in the ledger
// system blob ever populated either -- so the sales-tax section of the
// close-readiness check and the accountant close package has always read
// "no liability" regardless of what a company actually collected.
//
// Deliberately a MANUAL log, not an automatic feed -- see
// sql/026_bookkeeping_sales_tax.sql's header comment for why: this app's
// invoicing lives in Jobber/QuickBooks, not here, and whether a given job
// is even taxable depends on a real business-classification judgment call
// (e.g. Connecticut's capital-improvement-vs-repair distinction) that only
// Chris or his bookkeeper can make per job -- there's no safe way to
// infer "taxable sale" data from anything already in this codebase.
//
// GET returns every active entry plus a real, computed
// salesTaxLiability() as of a given throughDate (default today).
// POST { kind: 'collected', taxState, date, taxableAmount, exemptAmount,
//        taxCollected, jobRef?, note? } logs tax collected from a client
//   on a real taxable sale.
// POST { kind: 'remitted', taxState, date, amount, note? } logs a real
//   payment made to a state's tax authority.
// POST { void: '<entryId>' } voids (never deletes) a mistaken entry,
//   preserving an honest trail.
//
// Gated to the ledger 'controller' role for writes (same distinction as
// ./contractors.js) -- sales-tax records are compliance data, not routine
// expense entry.

import { getTrustedActor } from './ledger/_actor.js';
import { listSalesTaxEntries, recordSalesTaxEntry, voidSalesTaxEntry, storeBackend } from './_sales_tax_store.js';
import { guardBookkeepingRequest } from './_security.js';

let _load_reporting_cache;
async function _load_reporting() {
  if (!_load_reporting_cache) _load_reporting_cache = await import('../../server/bookkeeping/src/reporting.js');
  return _load_reporting_cache;
}

function toEngineShape(entries) {
  const active = entries.filter(entry => entry.status !== 'void');
  const sales = active
    .filter(entry => entry.kind === 'collected')
    .map(entry => ({ date: entry.date, status: 'active', taxState: entry.taxState, taxableAmount: entry.taxableAmount, exemptAmount: entry.exemptAmount, taxCollected: entry.taxCollected }));
  const payments = active
    .filter(entry => entry.kind === 'remitted')
    .map(entry => ({ date: entry.date, status: 'active', taxState: entry.taxState, amount: entry.amount }));
  return { sales, payments };
}

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false, entries: [] }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  if (req.method === 'GET') {
    try {
      const { throughDate } = req.query || {};
      const entries = await listSalesTaxEntries(actor.companyId);
      const { salesTaxLiability } = await _load_reporting();
      const { sales, payments } = toEngineShape(entries);
      const liability = salesTaxLiability(sales, payments, throughDate || new Date().toISOString().slice(0, 10));
      res.status(200).json({ ok: true, enabled: true, entries, liability, storeBackend: storeBackend() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || 'Could not read sales-tax tracking.' });
    }
    return;
  }

  if (req.method === 'POST') {
    if (actor.role !== 'controller') {
      res.status(403).json({ ok: false, error: 'Only a controller-role account can record sales-tax entries.' });
      return;
    }
    try {
      const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (input.void) {
        const entry = await voidSalesTaxEntry(actor.companyId, input.void);
        res.status(200).json({ ok: true, entry, note: 'Sales-tax entry voided.' });
        return;
      }
      const entry = await recordSalesTaxEntry(actor.companyId, input, actor);
      res.status(200).json({
        ok: true,
        entry,
        storeBackend: storeBackend(),
        note: `Recorded a real ${entry.kind === 'collected' ? 'tax-collected' : 'tax-remitted'} entry for ${entry.taxState} (${storeBackend()} backend).`
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message || 'Could not save this sales-tax entry.' });
    }
    return;
  }

  res.status(405).json({ ok: false, error: 'Only GET and POST are supported for this route.' });
}
