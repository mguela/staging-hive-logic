const cents = value => Math.round((Number(value) || 0) * 100);
const amount = value => cents(value) / 100;

function companyOf(ledger, companyId) { const company = ledger.companies[companyId]; if (!company) throw new Error('Company not found.'); return company; }
function effectiveDate(entry, basis) { return basis === 'cash' ? (entry.cashLines || entry.basis === 'cash' ? entry.cashDate : null) : entry.date; }
function effectiveLines(entry, basis) { return basis === 'cash' ? (entry.cashLines || (entry.basis === 'cash' ? entry.lines : [])) : entry.lines; }

export function basisTrialBalance(ledger, companyId, { throughDate = '9999-12-31', basis = 'accrual' } = {}) {
  if (!['cash', 'accrual'].includes(basis)) throw new Error('Basis must be cash or accrual.');
  const company = companyOf(ledger, companyId); const rows = Object.values(company.accounts).map(account => ({ accountId: account.id, name: account.name, type: account.type, debit: 0, credit: 0, balance: 0 })); const byId = Object.fromEntries(rows.map(row => [row.accountId, row]));
  const entries = company.entries.filter(entry => entry.status === 'posted' && effectiveDate(entry, basis) && effectiveDate(entry, basis) <= throughDate);
  for (const entry of entries) for (const line of effectiveLines(entry, basis)) { byId[line.accountId].debit = amount(byId[line.accountId].debit + line.debit); byId[line.accountId].credit = amount(byId[line.accountId].credit + line.credit); }
  for (const row of rows) row.balance = amount(row.debit - row.credit);
  const totalDebits = amount(rows.reduce((sum, row) => sum + row.debit, 0)), totalCredits = amount(rows.reduce((sum, row) => sum + row.credit, 0));
  return { companyId, basis, throughDate, rows, totalDebits, totalCredits, balanced: cents(totalDebits) === cents(totalCredits) };
}

export function incomeStatement(ledger, companyId, { startDate = '0000-01-01', endDate = '9999-12-31', basis = 'accrual' } = {}) {
  const company = companyOf(ledger, companyId); const accounts = company.accounts; const lines = [];
  for (const entry of company.entries.filter(item => item.status === 'posted' && effectiveDate(item, basis) >= startDate && effectiveDate(item, basis) <= endDate)) for (const line of effectiveLines(entry, basis)) if (['income', 'expense'].includes(accounts[line.accountId].type)) lines.push({ ...line, account: accounts[line.accountId], entryId: entry.id, effectiveDate: effectiveDate(entry, basis) });
  const revenue = amount(lines.filter(line => line.account.type === 'income').reduce((sum, line) => sum + line.credit - line.debit, 0)); const expenses = amount(lines.filter(line => line.account.type === 'expense').reduce((sum, line) => sum + line.debit - line.credit, 0));
  return { companyId, basis, startDate, endDate, revenue, expenses, netIncome: amount(revenue - expenses), lines };
}

export function generalLedgerReport(ledger, companyId, { startDate = '0000-01-01', throughDate = '9999-12-31', basis = 'accrual' } = {}) {
  if (!['cash', 'accrual'].includes(basis)) throw new Error('Basis must be cash or accrual.');
  const company = companyOf(ledger, companyId); const rows = [];
  for (const entry of company.entries.filter(item => item.status === 'posted')) {
    const date = effectiveDate(entry, basis); if (!date || date < startDate || date > throughDate) continue;
    for (const line of effectiveLines(entry, basis)) rows.push({ date, entryId: entry.id, description: entry.description, source: entry.source || '', sourceId: entry.sourceId || '', accountId: line.accountId, accountName: company.accounts[line.accountId]?.name || line.accountId, debit: amount(line.debit), credit: amount(line.credit), memo: line.memo || entry.memo || '' });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.entryId.localeCompare(b.entryId) || a.accountId.localeCompare(b.accountId));
  const totalDebits = amount(rows.reduce((sum, row) => sum + row.debit, 0)), totalCredits = amount(rows.reduce((sum, row) => sum + row.credit, 0));
  return { companyId, basis, startDate, throughDate, rows, totalDebits, totalCredits, balanced: cents(totalDebits) === cents(totalCredits) };
}

export function basisBalanceSheet(ledger, companyId, { throughDate = '9999-12-31', basis = 'accrual' } = {}) {
  const trial = basisTrialBalance(ledger, companyId, { throughDate, basis });
  const byType = type => amount(trial.rows.filter(row => row.type === type).reduce((sum, row) => sum + row.balance, 0));
  const assets = byType('asset'), liabilities = -byType('liability'), equityPosted = -byType('equity');
  const currentEarnings = amount(-byType('income') - byType('expense')), equity = amount(equityPosted + currentEarnings);
  return { companyId, basis, throughDate, assets, liabilities, equityPosted, retainedEarningsAndCurrentIncome: currentEarnings, equity, balanced: cents(assets) === cents(liabilities + equity), difference: amount(assets - liabilities - equity) };
}

export function retainedEarnings(ledger, companyId, fiscalYearStartDate, throughDate, basis = 'accrual') {
  const priorEnd = new Date(`${fiscalYearStartDate}T00:00:00Z`); priorEnd.setUTCDate(priorEnd.getUTCDate() - 1); const priorEndDate = priorEnd.toISOString().slice(0, 10);
  const company = companyOf(ledger, companyId); const postedEquity = basisTrialBalance(ledger, companyId, { throughDate, basis }).rows.filter(row => row.type === 'equity').reduce((sum, row) => sum - row.balance, 0);
  const priorEarnings = incomeStatement(ledger, companyId, { endDate: priorEndDate, basis }).netIncome; const currentIncome = incomeStatement(ledger, companyId, { startDate: fiscalYearStartDate, endDate: throughDate, basis }).netIncome;
  return { companyId, basis, fiscalYearStartDate, throughDate, postedEquity: amount(postedEquity), priorRetainedEarnings: priorEarnings, currentIncome, totalEquity: amount(postedEquity + priorEarnings + currentIncome) };
}

export function salesTaxLiability(sales = [], payments = [], throughDate = '9999-12-31') {
  const states = {};
  for (const sale of sales.filter(item => item.date <= throughDate && item.status !== 'void')) {
    const state = sale.taxState || 'UNASSIGNED'; states[state] ||= { state, taxableSales: 0, exemptSales: 0, taxCollected: 0, taxRemitted: 0, liability: 0 };
    states[state].taxableSales = amount(states[state].taxableSales + Number(sale.taxableAmount || 0)); states[state].exemptSales = amount(states[state].exemptSales + Number(sale.exemptAmount || 0)); states[state].taxCollected = amount(states[state].taxCollected + Number(sale.taxCollected || 0));
  }
  for (const payment of payments.filter(item => item.date <= throughDate && item.status !== 'void')) { const state = payment.taxState || 'UNASSIGNED'; states[state] ||= { state, taxableSales: 0, exemptSales: 0, taxCollected: 0, taxRemitted: 0, liability: 0 }; states[state].taxRemitted = amount(states[state].taxRemitted + Number(payment.amount || 0)); }
  for (const row of Object.values(states)) row.liability = amount(row.taxCollected - row.taxRemitted);
  return { throughDate, states: Object.values(states).sort((a, b) => a.state.localeCompare(b.state)), totalLiability: amount(Object.values(states).reduce((sum, row) => sum + row.liability, 0)), unassigned: states.UNASSIGNED?.liability || 0 };
}

export function contractorTaxReport(vendors = [], payments = [], { year, threshold = 600 } = {}) {
  if (!year) throw new Error('Tax year is required.'); const start = `${year}-01-01`, end = `${year}-12-31`;
  const report = vendors.filter(vendor => vendor.track1099).map(vendor => { const total = amount(payments.filter(payment => payment.vendorId === vendor.id && payment.date >= start && payment.date <= end && payment.status !== 'void' && payment.reportable !== false).reduce((sum, payment) => sum + Number(payment.amount || 0), 0)); return { vendorId: vendor.id, vendorName: vendor.name, taxIdLast4: vendor.taxIdLast4 || null, w9OnFile: !!vendor.w9OnFile, total, threshold, reportable: total >= threshold, blockers: [...(!vendor.w9OnFile ? ['W-9 missing'] : []), ...(total >= threshold && !vendor.taxIdLast4 ? ['Tax ID missing'] : [])] }; });
  return { year, threshold, contractors: report, reportableCount: report.filter(item => item.reportable).length, reportableTotal: amount(report.filter(item => item.reportable).reduce((sum, item) => sum + item.total, 0)), blockers: report.flatMap(item => item.blockers.map(blocker => ({ vendorId: item.vendorId, vendorName: item.vendorName, blocker }))) };
}

export function accountsPayableAging(expenses = [], { throughDate = '9999-12-31', postedExpenseIds = null } = {}) {
  const through = new Date(`${throughDate}T00:00:00Z`); const allowed = postedExpenseIds ? new Set(postedExpenseIds) : null;
  const bills = expenses.filter(item => item.transactionKind === 'bill' && item.transactionDate <= throughDate && !['paid', 'voided', 'needs_correction'].includes(item.status) && (!allowed || allowed.has(item.id))).map(item => {
    const dueDate = item.dueDate || item.transactionDate; const daysPastDue = Math.max(0, Math.floor((through - new Date(`${dueDate}T00:00:00Z`)) / 86400000)); const bucket = daysPastDue === 0 ? 'Current' : daysPastDue <= 30 ? '1–30 days' : daysPastDue <= 60 ? '31–60 days' : daysPastDue <= 90 ? '61–90 days' : '90+ days';
    return { id: item.id, vendor: item.vendor, qboVendorId: item.qboVendorId || null, transactionDate: item.transactionDate, dueDate, reference: item.reference || '', total: amount(item.total), daysPastDue, bucket, status: item.status };
  }).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.vendor.localeCompare(b.vendor));
  const buckets = Object.fromEntries(['Current', '1–30 days', '31–60 days', '61–90 days', '90+ days'].map(bucket => [bucket, amount(bills.filter(item => item.bucket === bucket).reduce((sum, item) => sum + item.total, 0))]));
  return { throughDate, bills, count: bills.length, totalOutstanding: amount(bills.reduce((sum, item) => sum + item.total, 0)), buckets };
}

export function accountsReceivableAging(invoices = [], { throughDate = '9999-12-31' } = {}) {
  const through = new Date(`${throughDate}T00:00:00Z`);
  const eligible = invoices.filter(inv => amount(inv.balance) > 0 && String(inv.status || '').toLowerCase() !== 'draft');
  const dated = eligible.filter(inv => inv.dueDate || inv.issuedDate);
  const undatedExcluded = eligible.length - dated.length;
  const open = dated.map(inv => {
    const dueDate = inv.dueDate || inv.issuedDate;
    const daysPastDue = Math.max(0, Math.floor((through - new Date(`${dueDate}T00:00:00Z`)) / 86400000));
    const bucket = daysPastDue === 0 ? 'Current' : daysPastDue <= 30 ? '1–30 days' : daysPastDue <= 60 ? '31–60 days' : daysPastDue <= 90 ? '61–90 days' : '90+ days';
    return { id: inv.id, invoiceNumber: inv.invoiceNumber, clientId: inv.clientId, subject: inv.subject, total: amount(inv.total), balance: amount(inv.balance), dueDate, daysPastDue, bucket, status: inv.status };
  }).filter(inv => inv.dueDate <= throughDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const buckets = Object.fromEntries(['Current', '1–30 days', '31–60 days', '61–90 days', '90+ days'].map(bucket => [bucket, amount(open.filter(i => i.bucket === bucket).reduce((sum, i) => sum + i.balance, 0))]));
  return { throughDate, invoices: open, count: open.length, undatedExcluded, totalOutstanding: amount(open.reduce((sum, i) => sum + i.balance, 0)), buckets };
}

export function expenseSummary(expenses = [], { startDate = '0000-01-01', endDate = '9999-12-31', groupBy = 'vendor' } = {}) {
  if (!['vendor', 'ownerType'].includes(groupBy)) throw new Error('groupBy must be vendor or ownerType.');
  const included = expenses.filter(e => !['draft_saved', 'rejected'].includes(e.status) && e.transactionDate && e.transactionDate >= startDate && e.transactionDate <= endDate);
  const groups = {};
  for (const expense of included) {
    for (const allocation of (expense.allocations || [])) {
      const key = groupBy === 'vendor' ? (expense.vendor || 'Unknown vendor') : (allocation.ownerType || 'unassigned');
      groups[key] ||= { key, total: 0, lineCount: 0 };
      groups[key].total = amount(groups[key].total + Number(allocation.amount || 0));
      groups[key].lineCount += 1;
    }
  }
  const rows = Object.values(groups).sort((a, b) => b.total - a.total);
  return { startDate, endDate, groupBy, rows, grandTotal: amount(rows.reduce((sum, row) => sum + row.total, 0)), transactionCount: included.length };
}
