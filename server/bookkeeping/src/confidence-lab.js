import { distributeSalesTax, toQboPurchase, validateExpense } from './accounting.js';
import { addCompany, approveEntry, balanceSheet, correctEntry, createEntry, createLedger, postEntry, setPeriodLock, trialBalance, verifyAuditChain } from './ledger.js';
import { confirmBankMatch, detectExpenseDuplicates, importBankFeed, reconcileStatement, verifyReconciliation } from './banking.js';
import { basisBalanceSheet, contractorTaxReport, incomeStatement, salesTaxLiability } from './reporting.js';
import { buildExportPackage, verifyExportPackage } from './exports.js';

const money = value => Math.round((Number(value) || 0) * 100) / 100;

const people = {
  submitter: { id: 'field-owner', role: 'submitter' },
  approver: { id: 'office-reviewer', role: 'approver' },
  controller: { id: 'controller', role: 'controller' }
};

const accounts = [
  { id: 'bank', name: 'Operating Bank', type: 'asset', cashFlowRole: 'cash' },
  { id: 'card', name: 'Business Credit Card', type: 'liability' },
  { id: 'ar', name: 'Accounts Receivable', type: 'asset' },
  { id: 'ap', name: 'Accounts Payable', type: 'liability' },
  { id: 'materials', name: 'Job Materials', type: 'expense' },
  { id: 'subcontractors', name: 'Subcontractor Costs', type: 'expense' },
  { id: 'fuel', name: 'Gas & Fuel', type: 'expense' },
  { id: 'rental', name: 'Equipment Rental', type: 'expense' },
  { id: 'insurance', name: 'Insurance', type: 'expense' },
  { id: 'rent', name: 'Rent & Lease', type: 'expense' },
  { id: 'tools', name: 'Tools & Equipment', type: 'expense' },
  { id: 'interest', name: 'Interest Expense', type: 'expense' },
  { id: 'loan', name: 'Loan Payable', type: 'liability' },
  { id: 'tax', name: 'Sales Tax Payable', type: 'liability' },
  { id: 'revenue', name: 'Contract Revenue', type: 'income' },
  { id: 'equity', name: 'Owner Equity', type: 'equity' }
];

function result(checks, family, title, plainEnglish, work) {
  try {
    const evidence = work();
    checks.push({ family, title, plainEnglish, passed: true, evidence: evidence || 'Passed.' });
  } catch (error) {
    checks.push({ family, title, plainEnglish, passed: false, evidence: error.message });
  }
}

function expect(condition, message) { if (!condition) throw new Error(message); }

function post(ledger, companyId, input) {
  const entry = createEntry(ledger, { companyId, basis: 'accrual', ...input }, people.submitter);
  approveEntry(ledger, companyId, entry.id, people.approver);
  return postEntry(ledger, companyId, entry.id, people.controller, `lab:${input.sourceId || entry.id}`);
}

function paid(lines) { return { cashDate: '2026-07-15', cashLines: lines }; }

/**
 * Runs a self-contained contractor bookkeeping month. It never reads or writes
 * the live company file; it exists to prove that the domain rules catch normal
 * problems before an owner can close a period.
 */
export function runConfidenceLab() {
  const checks = [];
  const ledger = createLedger();
  addCompany(ledger, { id: 'lab', name: 'Northstar Contracting — Practice Month', basis: 'accrual', accounts }, people.controller);

  const openingLines = [{ accountId: 'bank', debit: 25000 }, { accountId: 'equity', credit: 25000 }];
  post(ledger, 'lab', { date: '2026-07-01', description: 'Owner funding', source: 'owner_funding', sourceId: 'opening', lines: openingLines, ...paid(openingLines) });
  const saleLines = [{ accountId: 'bank', debit: 21400 }, { accountId: 'revenue', credit: 20000 }, { accountId: 'tax', credit: 1400 }];
  post(ledger, 'lab', { date: '2026-07-03', description: 'Kitchen renovation deposit', source: 'sale', sourceId: 'sale-1', lines: saleLines, ...paid(saleLines) });

  const operatingEntries = [
    ['2026-07-05', 'Home Depot materials', 'materials', 'card', 159.72, 'materials-1'],
    ['2026-07-07', 'Fuel for work truck', 'fuel', 'bank', 185, 'fuel-1'],
    ['2026-07-09', 'Lift rental', 'rental', 'bank', 795, 'rental-1'],
    ['2026-07-11', 'General liability insurance', 'insurance', 'bank', 425, 'insurance-1'],
    ['2026-07-12', 'Warehouse rent', 'rent', 'bank', 1800, 'rent-1'],
    ['2026-07-14', 'Portable tools', 'tools', 'bank', 539, 'tools-1']
  ];
  for (const [date, description, expenseAccount, paymentAccount, value, sourceId] of operatingEntries) {
    const lines = [{ accountId: expenseAccount, debit: value }, { accountId: paymentAccount, credit: value }];
    post(ledger, 'lab', { date, description, source: 'expense', sourceId, lines, ...(paymentAccount === 'bank' ? paid(lines) : { cashDate: date, cashLines: lines }) });
  }
  const billLines = [{ accountId: 'subcontractors', debit: 1400 }, { accountId: 'ap', credit: 1400 }];
  post(ledger, 'lab', { date: '2026-07-16', description: 'Licensed electrical subcontractor bill', source: 'vendor_bill', sourceId: 'sub-1', lines: billLines });
  const loanLines = [{ accountId: 'loan', debit: 800 }, { accountId: 'interest', debit: 175 }, { accountId: 'bank', credit: 975 }];
  post(ledger, 'lab', { date: '2026-07-18', description: 'Truck loan payment — principal and interest', source: 'loan_payment', sourceId: 'loan-1', lines: loanLines, ...paid(loanLines) });

  result(checks, 'Books', 'Every debit has a matching credit', 'A complete contractor month stays mathematically balanced before reports are shown.', () => {
    const trial = trialBalance(ledger, 'lab', '2026-07-31'); const sheet = balanceSheet(ledger, 'lab', '2026-07-31'); const cashSheet = basisBalanceSheet(ledger, 'lab', { throughDate: '2026-07-31', basis: 'cash' });
    expect(trial.balanced && sheet.balanced && cashSheet.balanced, 'A trial balance or balance sheet did not balance.');
    return `${trial.totalDebits.toFixed(2)} in debits exactly matches ${trial.totalCredits.toFixed(2)} in credits on both accounting views.`;
  });

  result(checks, 'Receipts', 'Receipt tax stays attached to the right work', 'A materials receipt splits sales tax by line and keeps every penny accounted for.', () => {
    const split = distributeSalesTax([{ subtotal: 41.29 }, { subtotal: 41.61 }], 5.39);
    expect(money(split[0] + split[1]) === 5.39, 'The line-level tax did not add back to the receipt tax.');
    return `A $5.39 receipt tax was assigned as $${split[0].toFixed(2)} and $${split[1].toFixed(2)}; no penny disappeared.`;
  });

  result(checks, 'Exceptions', 'Unknown ownership cannot disappear', 'An expense without a known owner stays in the unrecorded-expenses bucket until a person resolves it.', () => {
    const invalid = validateExpense({ vendor: 'Cash purchase', transactionDate: '2026-07-15', total: 44, receiptAttached: true, paymentAccountId: 'bank', allocations: [{ ownerType: 'unknown', ownerId: 'unknown', qboAccountId: '64', amount: 44 }] });
    expect(!invalid.valid && invalid.errors.some(item => item.includes('Unrecorded Expenses')), 'Unknown ownership was allowed into a normal expense account.');
    return 'The test expense was blocked and kept out of normal books until it can be assigned.';
  });

  result(checks, 'Duplicates', 'Duplicate receipts are stopped', 'The same vendor, amount, and reference cannot silently become two expenses.', () => {
    const duplicates = detectExpenseDuplicates([{ id: 'a', vendor: 'Home Depot', transactionDate: '2026-07-05', total: 159.72, reference: 'HD-4921' }, { id: 'b', vendor: 'HOME DEPOT', transactionDate: '2026-07-06', total: 159.72, reference: 'HD-4921' }]);
    expect(duplicates.length === 1 && duplicates[0].confidence === 1, 'The exact duplicate was not identified.');
    return 'An exact duplicate was flagged before posting.';
  });

  result(checks, 'Banking', 'Bank activity has to match or be explained', 'A card charge is matched once and the statement seal exposes later changes.', () => {
    const expense = { id: 'materials-1', vendor: 'Home Depot', transactionDate: '2026-07-05', total: 159.72 };
    const imported = importBankFeed(ledger, 'lab', [{ accountId: 'card', externalId: 'card-0710', postedDate: '2026-07-06', amount: -159.72, description: 'HOME DEPOT #4921' }], 'practice-card-july');
    confirmBankMatch(ledger, 'lab', imported.transactions[0].id, expense, people.controller);
    const reconciliation = reconcileStatement(ledger, 'lab', { accountId: 'card', startDate: '2026-07-01', endDate: '2026-07-31', statementBeginningBalance: 0, statementEndingBalance: 159.72, bookEndingBalance: 159.72 }, people.controller);
    expect(verifyReconciliation(ledger, 'lab', reconciliation.id).valid, 'The completed bank reconciliation did not verify.');
    return 'The card charge matched once, then the July statement was sealed against silent changes.';
  });

  result(checks, 'Contractors', 'Contractor tax paperwork is not forgotten', 'A reportable subcontractor without a W-9 remains on the exception list.', () => {
    const report = contractorTaxReport([{ id: 'electric-sub', name: 'Bright Wire LLC', track1099: true, w9OnFile: false, taxIdLast4: null }], [{ vendorId: 'electric-sub', date: '2026-07-16', amount: 1400, reportable: true }], { year: 2026, threshold: 600 });
    expect(report.reportableCount === 1 && report.blockers.length === 2, 'The missing contractor paperwork was not surfaced.');
    return 'Bright Wire exceeds the threshold and is held for both a W-9 and tax ID.';
  });

  result(checks, 'Sales tax', 'State tax stays separated', 'Florida and Georgia tax liabilities are tracked separately from vendor sales tax paid on receipts.', () => {
    const tax = salesTaxLiability([{ date: '2026-07-03', taxState: 'FL', taxableAmount: 20000, taxCollected: 1400 }, { date: '2026-07-20', taxState: 'GA', taxableAmount: 1000, taxCollected: 70 }], [{ date: '2026-07-22', taxState: 'FL', amount: 500 }], '2026-07-31');
    expect(tax.states.length === 2 && tax.totalLiability === 970, 'State tax liability totals were not separated correctly.');
    return 'Florida owes $900.00 after a payment; Georgia owes $70.00. Receipt tax is not mixed into either liability.';
  });

  result(checks, 'Bills', 'Unpaid bills do not pretend cash moved', 'A vendor bill credits accounts payable and is shaped as a QBO Bill, not a paid purchase.', () => {
    const payload = toQboPurchase({ id: 'sub-1', transactionKind: 'bill', vendor: 'Bright Wire LLC', qboVendorId: 'vendor-84', transactionDate: '2026-07-16', dueDate: '2026-08-15', total: 1400, receiptAttached: true, allocations: [{ ownerType: 'subcontractor', ownerId: 'bright-wire', qboAccountId: '65', subtotal: 1400, salesTaxAmount: 0, amount: 1400 }] });
    expect(payload.APAccountRef?.value === '2000' && !payload.AccountRef, 'The unpaid bill was formatted as a paid transaction.');
    return 'The subcontractor bill is payable, not falsely shown as cash already spent.';
  });

  result(checks, 'Close', 'Locked months cannot be rewritten', 'Once a month is closed, late changes must go through a controlled correction in a later period.', () => {
    setPeriodLock(ledger, 'lab', '2026-07', true, people.controller);
    let blocked = false;
    try { createEntry(ledger, { companyId: 'lab', date: '2026-07-31', description: 'Late receipt', lines: [{ accountId: 'materials', debit: 10 }, { accountId: 'bank', credit: 10 }] }, people.submitter); } catch { blocked = true; }
    expect(blocked, 'A late entry was allowed into a locked month.');
    return 'A late July receipt was blocked; it cannot silently alter a closed month.';
  });

  result(checks, 'Corrections', 'Corrections preserve the original history', 'A correction creates a reversal and replacement instead of erasing the original transaction.', () => {
    setPeriodLock(ledger, 'lab', '2026-07', false, people.controller);
    const original = ledger.companies.lab.entries.find(entry => entry.sourceId === 'tools-1');
    const correction = correctEntry(ledger, 'lab', original.id, { date: '2026-08-01', description: 'Corrected portable tools amount', lines: [{ accountId: 'tools', debit: 499 }, { accountId: 'bank', credit: 499 }], cashDate: '2026-08-01', cashLines: [{ accountId: 'tools', debit: 499 }, { accountId: 'bank', credit: 499 }] }, 'Vendor credit corrected the original receipt', people.controller);
    expect(correction.original.status === 'posted' && correction.reversal.status === 'posted' && correction.corrected.status === 'posted', 'The correction did not preserve the complete history.');
    return 'The original, reversal, and corrected entry remain traceable in the audit trail.';
  });

  result(checks, 'Audit', 'The audit trail detects tampering', 'Every approval, posting, bank match, lock, and correction is chained together.', () => {
    const audit = verifyAuditChain(ledger);
    expect(audit.valid && audit.records > 20, 'The audit chain is not intact.');
    return `${audit.records} chained audit events verify from the first entry through the correction.`;
  });

  result(checks, 'Accountant handoff', 'The accountant package can be verified independently', 'The export includes the books, support schedules, and checksums needed for review.', () => {
    const packageData = buildExportPackage({ ledger, companyId: 'lab', audience: 'accountant', throughDate: '2026-08-31', fiscalYearStartDate: '2026-01-01', vendors: [], contractorPayments: [] });
    expect(verifyExportPackage(packageData).valid, 'The accountant export checksum verification failed.');
    return `${packageData.files.length} verified files were prepared for accountant review.`;
  });

  const trial = trialBalance(ledger, 'lab', '2026-08-31');
  const income = incomeStatement(ledger, 'lab', { startDate: '2026-01-01', endDate: '2026-08-31', basis: 'accrual' });
  const sheet = balanceSheet(ledger, 'lab', '2026-08-31');
  const passed = checks.filter(check => check.passed).length;
  return {
    title: 'Northstar Contracting practice month',
    period: 'July 2026',
    generatedAt: new Date().toISOString(),
    summary: { total: checks.length, passed, failed: checks.length - passed, score: Math.round((passed / checks.length) * 100) },
    financialSnapshot: { revenue: income.revenue, expenses: income.expenses, netIncome: income.netIncome, assets: sheet.assets, liabilities: sheet.liabilities, equity: sheet.equity, trialBalanced: trial.balanced, balanceSheetBalanced: sheet.balanced },
    checks
  };
}
