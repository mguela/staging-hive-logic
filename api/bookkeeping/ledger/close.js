// api/bookkeeping/ledger/close.js — period-close readiness check.
// GET returns the 18-point close-readiness checklist (closeReadiness() in
// server/bookkeeping/src/close.js) for the given throughDate: trial balance
// balanced, balance sheet balanced, audit chain intact, posted entries
// unchanged, every expense owned/evidenced/approved, all journals posted,
// duplicates resolved, all bank/card activity resolved and reconciled,
// sales tax assigned, contractor paperwork complete, no critical automation
// exceptions, source links intact.
//
// Real data fix (earlier commit): this route used to call closeReadiness()
// with hardcoded `expenses: []` and `evidenceDocuments: []` -- the readiness
// engine itself was always real, but every expense/evidence-backed check
// (unknown_expenses, supporting_evidence, approvals, posting, duplicates,
// rejected_expenses, sales_tax, contractors, source_links) was silently
// evaluated against nothing, so it always read as passing regardless of a
// company's actual data. That made the displayed close-readiness score
// accurate only for the pure-ledger checks and quietly wrong for everything
// else. Now wired to the same stores Expense Entry and the evidence vault
// actually write to (../_expense_store.js, ../_evidence_store.js), so the
// score reflects real saved expenses and real stored evidence documents.
//
// document_intake fix (earlier commit): this check used to become a real,
// permanent close blocker the moment any evidence document existed, because
// no evidence document ever had the 'extracted'/'processed' status this
// check looks for, and there was no route to set one. api/bookkeeping/
// document-reviews.js and the updated _evidence_store.js now give every
// document a real 'received' -> 'processed' lifecycle, so this check now
// reflects genuine, resolvable review state instead of an unresolvable one.
//
// sales_tax / contractors fix (task 7): these two checks have always
// evaluated against system.sales/system.taxPayments/system.vendors/
// system.contractorPayments -- fields nothing in this app's ledger-system
// blob ever populated, so they always read as trivially passing ("no
// liability", "no contractors") regardless of a company's real data. Now
// wired via ../_close_tax_adapters.js to the real, tracked contractor
// 1099/W-9 profiles (../contractors.js) and manually-logged sales-tax
// entries (../sales-tax.js), joined against the real approved
// control-approvals and expense records that already exist. See both of
// those routes' header comments for why contractor tracking is a
// dedicated store (not the separate `subcontractors` directory on `main`,
// which this branch doesn't have) and why sales-tax entries are a manual
// log (this app has no invoicing/sales data of its own to draw from).
//
// One remaining known, disclosed gap:
//  - bank_matching / reconciliations / reconciliation_integrity / statements
//    still read as trivially passing, because this app has no bank-feed
//    import route or UI yet (server/bookkeeping/src/banking.js exists but is
//    entirely unwired) -- company.bankTransactions is always empty here.
//
// This route now also depends on BOOKKEEPING_EXPENSE_STORE/
// BOOKKEEPING_EVIDENCE_STORE being resolvable in whatever environment it
// runs in (same fail-closed rule those two stores already enforce
// everywhere else) -- close readiness genuinely can't be computed without
// real expense/evidence data, so failing closed here is correct, not a
// regression.
//
// This route still does NOT build/export the close package -- see
// ./close-package.js for that (added alongside the earlier fix, since
// buildClosePackage() in server/bookkeeping/src/close.js was already a
// complete, real, tested engine with no route wired to it).

let _load_close_cache;
async function _load_close() {
  if (!_load_close_cache) _load_close_cache = await import('../../../server/bookkeeping/src/close.js');
  return _load_close_cache;
}
import { getSystem } from './_store.js';
import { getTrustedActor } from './_actor.js';
import { listExpenses } from '../_expense_store.js';
import { listEvidence } from '../_evidence_store.js';
import { attachContractorAndSalesTaxData } from '../_close_tax_adapters.js';
import { guardBookkeepingRequest } from '../_security.js';

// closeReadiness() expects each expense to carry evidenceDocumentIds (an
// array -- a document can theoretically support more than one expense
// entry). Expense Entry's actual saved shape only ever records a single
// evidenceId (see public/app-bookkeeping.js's state.evidenceId / the
// `evidenceId` field on the payload built by saveExpense()). This adapts
// the read-time shape without touching how expenses are stored.
function withEvidenceDocumentIds(expense) {
  if (Array.isArray(expense.evidenceDocumentIds)) return expense;
  return { ...expense, evidenceDocumentIds: expense.evidenceId ? [expense.evidenceId] : [] };
}

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Only GET is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { closeReadiness } = await _load_close();
    const { throughDate = new Date().toISOString().slice(0, 10) } = req.query || {};
    const system = await getSystem(actor.companyId);
    await attachContractorAndSalesTaxData(actor.companyId, system);
    const [rawExpenses, evidenceDocuments] = await Promise.all([
      listExpenses(actor.companyId),
      listEvidence(actor.companyId)
    ]);
    const expenses = rawExpenses.map(withEvidenceDocumentIds);
    const readiness = closeReadiness({ system, expenses, companyId: actor.companyId, throughDate, evidenceDocuments });
    res.status(200).json({
      ok: true,
      ...readiness,
      note: 'Expense- and evidence-backed checks (owners, supporting evidence, approvals, posting, duplicates, rejected expenses, source links) reflect this company\'s real saved expenses and stored evidence documents. Sales-tax and contractor 1099/W-9 checks now reflect real tracked data too (task 7) -- see the Books Home dashboard\'s Sales tax & contractors card. Bank/card checks (bank_matching, reconciliations, reconciliation_integrity, statements) still read as passing because no bank-feed import exists in this app yet. The document_intake check reflects a real review queue -- see the Books Home dashboard\'s document review section -- rather than an unresolvable permanent blocker.'
    });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not compute close readiness.' });
  }
}
