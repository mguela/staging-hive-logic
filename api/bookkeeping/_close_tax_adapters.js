// api/bookkeeping/_close_tax_adapters.js
//
// Shared read-time adapter for close.js/close-package.js, same pattern as
// close.js's own withEvidenceDocumentIds(): the real ledger-system blob
// (api/bookkeeping/ledger/_store.js's getSystem()) has never carried
// system.vendors / system.contractorPayments / system.sales /
// system.taxPayments -- nothing in this app's data model writes to those
// fields -- so server/bookkeeping/src/close.js's closeReadiness() and
// buildClosePackage() have always evaluated their sales-tax and
// contractor-1099 checks against nothing, regardless of a company's real
// data (see ./contractors.js and ./sales-tax.js's header comments for the
// full picture -- this file is the piece that actually feeds their real
// output into the close engine, shared so both routes compute it
// identically rather than drifting apart).
//
// Takes the SAME already-fetched `system` object close.js/close-package.js
// already load for their own ledger/trial-balance purposes, so this never
// issues a second, redundant getSystem() call -- it only reads
// system.controls.approvals off the object already in hand.

import { listExpenses } from './_expense_store.js';
import { listContractorProfiles } from './_contractor_store.js';
import { listSalesTaxEntries } from './_sales_tax_store.js';
let _load_catalog_cache;
async function _load_catalog() {
  if (!_load_catalog_cache) _load_catalog_cache = await import('../../server/bookkeeping/src/catalog.js');
  return _load_catalog_cache;
}

const QBO_ENTITY_TYPES = ['purchase', 'bill'];

export async function attachContractorAndSalesTaxData(companyId, system) {
  const { normalizeCatalogTerm } = await _load_catalog();
  const [profiles, expenses, taxEntries] = await Promise.all([
    listContractorProfiles(companyId),
    listExpenses(companyId),
    listSalesTaxEntries(companyId)
  ]);

  const trackedByKey = new Map(profiles.filter(p => p.track1099).map(p => [p.vendorKey, p]));
  const expensesById = new Map(expenses.map(expense => [expense.id, expense]));

  const vendors = Array.from(trackedByKey.values()).map(profile => ({
    id: profile.vendorKey,
    name: profile.vendorName,
    track1099: true,
    taxIdLast4: profile.taxIdLast4 || null,
    w9OnFile: !!profile.w9OnFile
  }));

  // Only expenses whose approval was actually decided 'approved' count --
  // an unapproved or rejected expense was never really paid, and must
  // never inflate a real 1099-reportable total.
  const contractorPayments = (system.controls?.approvals || [])
    .filter(approval => approval.status === 'approved' && QBO_ENTITY_TYPES.includes(approval.entityType))
    .map(approval => {
      const expense = expensesById.get(approval.entityId);
      if (!expense || !expense.vendor) return null;
      const vendorKey = normalizeCatalogTerm(expense.vendor);
      if (!trackedByKey.has(vendorKey)) return null;
      return {
        vendorId: vendorKey,
        date: expense.transactionDate || approval.requestedAt || '',
        amount: Number(expense.total || 0),
        status: 'posted',
        reportable: true
      };
    })
    .filter(Boolean);

  const activeTaxEntries = taxEntries.filter(entry => entry.status !== 'void');
  const sales = activeTaxEntries
    .filter(entry => entry.kind === 'collected')
    .map(entry => ({ date: entry.date, status: 'active', taxState: entry.taxState, taxableAmount: entry.taxableAmount, exemptAmount: entry.exemptAmount, taxCollected: entry.taxCollected }));
  const taxPayments = activeTaxEntries
    .filter(entry => entry.kind === 'remitted')
    .map(entry => ({ date: entry.date, status: 'active', taxState: entry.taxState, amount: entry.amount }));

  system.vendors = vendors;
  system.contractorPayments = contractorPayments;
  system.contractorThreshold = system.contractorThreshold || 600;
  system.sales = sales;
  system.taxPayments = taxPayments;
  return system;
}
