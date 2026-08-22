// api/bookkeeping/ledger/reports.js — read-only financial reports over the
// real, posted general ledger. GET /api/bookkeeping/ledger/reports?report=X
// where X is one of: trial-balance | income-statement | balance-sheet |
// general-ledger | retained-earnings | ar-aging | ap-aging | expense-summary.
//
// Query params: throughDate, startDate, endDate, basis (cash|accrual),
// fiscalYearStartDate (for retained-earnings), groupBy (vendor|ownerType,
// for expense-summary). The first five reports are pure read-only
// computations over already-posted entries in this app's internal ledger.
// ar-aging / ap-aging / expense-summary are read-only computations over
// real Jobber-synced invoices and real saved Expense Entry records
// (deliberately NOT the internal ledger's chart of accounts -- see
// ledger/_store.js's defaultChartOfAccounts() header comment for why that
// chart does not yet mirror this company's real QuickBooks accounts). No
// QBO write, no mutation of any kind, in any of these eight report types.

let _load_reporting_cache;
async function _load_reporting() {
  if (!_load_reporting_cache) _load_reporting_cache = await import('../../../server/bookkeeping/src/reporting.js');
  return _load_reporting_cache;
}
import { getSystem } from './_store.js';
import { getTrustedActor } from './_actor.js';
import { guardBookkeepingRequest } from '../_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Only GET is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { basisTrialBalance, incomeStatement, basisBalanceSheet, generalLedgerReport, retainedEarnings, accountsReceivableAging, accountsPayableAging, expenseSummary } = await _load_reporting();
        const { report, throughDate = '9999-12-31', startDate = '0000-01-01', endDate = '9999-12-31', basis = 'accrual', fiscalYearStartDate, groupBy = 'vendor' } = req.query || {};
    const system = await getSystem(actor.companyId);

    let result;
    switch (report) {
      case 'trial-balance':
        result = basisTrialBalance(system.ledger, actor.companyId, { throughDate, basis });
        break;
      case 'income-statement':
        result = incomeStatement(system.ledger, actor.companyId, { startDate, endDate, basis });
        break;
      case 'balance-sheet':
        result = basisBalanceSheet(system.ledger, actor.companyId, { throughDate, basis });
        break;
      case 'general-ledger':
        result = generalLedgerReport(system.ledger, actor.companyId, { startDate, throughDate, basis });
        break;
      case 'retained-earnings':
        if (!fiscalYearStartDate) { res.status(400).json({ ok: false, error: 'fiscalYearStartDate is required for the retained-earnings report.' }); return; }
        result = retainedEarnings(system.ledger, actor.companyId, fiscalYearStartDate, throughDate, basis);
        break;
      case 'ar-aging': {
        const { getInvoicesData } = await import('../../invoices.js');
        const { invoices } = await getInvoicesData({ limit: 10000 });
        result = accountsReceivableAging(invoices, { throughDate });
        break;
      }
      case 'ap-aging': {
        const { listExpenses } = await import('../_expense_store.js');
        const expenses = await listExpenses(actor.companyId);
        result = accountsPayableAging(expenses, { throughDate });
        break;
      }
      case 'expense-summary': {
        const { listExpenses } = await import('../_expense_store.js');
        const expenses = await listExpenses(actor.companyId);
        result = expenseSummary(expenses, { startDate, endDate, groupBy });
        break;
      }
      default:
        res.status(400).json({ ok: false, error: 'report must be one of: trial-balance, income-statement, balance-sheet, general-ledger, retained-earnings, ar-aging, ap-aging, expense-summary.' });
        return;
    }
    res.status(200).json({ ok: true, report, ...result });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not generate this report.' });
  }
}
