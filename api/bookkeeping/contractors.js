// api/bookkeeping/contractors.js
//
// Real 1099/W-9 contractor tracking (task 7, first half). Closes a gap
// server/bookkeeping/src/reporting.js's contractorTaxReport() has had
// since it was ported: it was already a complete, tested engine function,
// but nothing anywhere fed it real vendors[]/payments[] -- close.js and
// close-package.js have always called it with system.vendors||[] and
// system.contractorPayments||[], and nothing in this ledger-system blob
// ever populated either field, so the contractor-tax section of the
// close-readiness check and the accountant close package has always read
// "no contractors" regardless of a company's real subcontractor spend.
//
// GET returns the tracked contractor profiles (as of 2026-07-24, this
// route's store -- ./_contractor_store.js -- reads/writes these fields
// directly on the `subcontractors` company directory table; the two were
// originally separate but Chris decided to merge them, see
// sql/029_subcontractors_1099_merge.sql for the full history) plus a real,
// computed contractorTaxReport() for a given tax year. The vendors[]/
// payments[] fed into that engine call are built by
// ../_close_tax_adapters.js's attachContractorAndSalesTaxData() -- the
// SAME derivation close.js/close-package.js use, reused here rather than
// re-implemented, so this route's report can never quietly drift from
// what the close-readiness check and accountant package actually see. A
// payment counts toward a contractor's 1099 total only once its approval
// has actually been decided 'approved' -- an unapproved or rejected
// expense was never really paid, so it must never inflate a real
// tax-reporting total (see that adapter's comments for the full join).
//
// POST creates/updates a tracked profile (vendorName required; track1099/
// w9OnFile/taxIdLast4/notes optional, partial -- only fields sent are
// changed). Gated to the ledger 'controller' role (this app's admin
// accounts) since 1099/W-9 status is compliance data, not routine expense
// entry -- the same distinction already drawn for QBO sync (task 5) and
// approval decisions.

import { getTrustedActor } from './ledger/_actor.js';
import { getSystem } from './ledger/_store.js';
import { listContractorProfiles, saveContractorProfile, storeBackend } from './_contractor_store.js';
import { attachContractorAndSalesTaxData } from './_close_tax_adapters.js';
import { guardBookkeepingRequest } from './_security.js';

let _load_reporting_cache;
async function _load_reporting() {
  if (!_load_reporting_cache) _load_reporting_cache = await import('../../server/bookkeeping/src/reporting.js');
  return _load_reporting_cache;
}

async function buildContractorReport(companyId, { year, threshold }) {
  const { contractorTaxReport } = await _load_reporting();
  const system = await getSystem(companyId);
  await attachContractorAndSalesTaxData(companyId, system);
  // contractorTaxReport() itself filters payments to the requested tax
  // year, so every tracked payment (any date) is safe to pass through.
  return contractorTaxReport(system.vendors, system.contractorPayments, { year, threshold });
}

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false, profiles: [] }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  if (req.method === 'GET') {
    try {
      const { year: yearParam, threshold: thresholdParam } = req.query || {};
      const year = Number(yearParam) || new Date().getUTCFullYear();
      const threshold = Number(thresholdParam) || 600;
      const profiles = await listContractorProfiles(actor.companyId);
      const report = await buildContractorReport(actor.companyId, { year, threshold });
      res.status(200).json({ ok: true, enabled: true, profiles, report, storeBackend: storeBackend() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || 'Could not read contractor tax tracking.' });
    }
    return;
  }

  if (req.method === 'POST') {
    if (actor.role !== 'controller') {
      res.status(403).json({ ok: false, error: 'Only a controller-role account can change 1099/W-9 tracking status.' });
      return;
    }
    try {
      const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const result = await saveContractorProfile(actor.companyId, input, actor.email || actor.id);
      res.status(200).json({
        ok: true,
        profile: result.profile,
        created: result.created,
        storeBackend: storeBackend(),
        note: `Saved contractor tax tracking for "${result.profile.vendorName}" (${storeBackend()} backend).`
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message || 'Could not save this contractor profile.' });
    }
    return;
  }

  res.status(405).json({ ok: false, error: 'Only GET and POST are supported for this route.' });
}
