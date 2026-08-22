import { createHash } from 'node:crypto';
import { basisTrialBalance, basisBalanceSheet, incomeStatement, retainedEarnings, salesTaxLiability, contractorTaxReport, accountsPayableAging } from './reporting.js';
import { verifyAuditChain, verifyPostedEntries } from './ledger.js';

const checksum = content => createHash('sha256').update(content).digest('hex');
const csvEscape = value => { const text = value == null ? '' : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; };
const csv = (headers, rows) => [headers.join(','), ...rows.map(row => headers.map(header => csvEscape(row[header])).join(','))].join('\n');
const json = value => JSON.stringify(value, null, 2);

function addFile(files, name, content, audience, containsSensitive = false) { files.push({ name, content, audience, containsSensitive, sha256: checksum(content), bytes: Buffer.byteLength(content) }); }

export function buildExportPackage({ ledger, companyId, audience, throughDate, fiscalYearStartDate, basis = 'accrual', expenses = [], sales = [], taxPayments = [], vendors = [], contractorPayments = [], contractorThreshold = 600 }) {
  if (!['accountant', 'lender', 'insurer', 'buyer'].includes(audience)) throw new Error('Unsupported export audience.');
  const company = ledger.companies[companyId]; if (!company) throw new Error('Company not found.');
  const audit = verifyAuditChain(ledger); if (!audit.valid) throw new Error('Cannot export books with a broken audit chain.');
  const postedEntries = verifyPostedEntries(ledger, companyId); if (!postedEntries.valid) throw new Error('Cannot export books with modified posted entries.');
  const trial = basisTrialBalance(ledger, companyId, { throughDate, basis }); if (!trial.balanced) throw new Error('Cannot export an unbalanced trial balance.');
  const pnl = incomeStatement(ledger, companyId, { startDate: fiscalYearStartDate, endDate: throughDate, basis }); const sheet = basisBalanceSheet(ledger, companyId, { throughDate, basis }); if (!sheet.balanced) throw new Error('Cannot export an unbalanced balance sheet.');
  const retained = retainedEarnings(ledger, companyId, fiscalYearStartDate, throughDate, basis); const salesTax = salesTaxLiability(sales, taxPayments, throughDate); const contractors = contractorTaxReport(vendors, contractorPayments, { year: Number(throughDate.slice(0, 4)), threshold: contractorThreshold }); const postedExpenseIds = company.entries.filter(entry => entry.status === 'posted' && entry.source === 'expense').map(entry => entry.sourceId); const accountsPayable = accountsPayableAging(expenses, { throughDate, postedExpenseIds });
  const files = [];
  addFile(files, 'trial-balance.csv', csv(['accountId','name','type','debit','credit','balance'], trial.rows), audience);
  addFile(files, 'income-statement.json', json(pnl), audience); addFile(files, 'balance-sheet.json', json(sheet), audience); addFile(files, 'retained-earnings.json', json(retained), audience);
  if (['accountant','buyer'].includes(audience)) { addFile(files, 'sales-tax-liability.json', json(salesTax), audience); addFile(files, 'accounts-payable-aging.json', json(accountsPayable), audience); addFile(files, 'reconciliations.json', json(company.reconciliations), audience); }
  if (audience === 'accountant') { addFile(files, 'contractor-tax-report.json', json(contractors), audience, true); addFile(files, 'journal.csv', csv(['id','date','cashDate','description','kind','source','status'], company.entries), audience); addFile(files, 'audit-log.json', json(ledger.audit), audience, true); }
  if (audience === 'insurer') addFile(files, 'expense-summary.json', json({ throughDate, expenses: pnl.expenses, accountCount: trial.rows.filter(row => row.type === 'expense').length }), audience);
  const manifestBase = { companyId, companyName: company.name, audience, basis, fiscalYearStartDate, throughDate, generatedAt: new Date().toISOString(), auditHead: audit.head, auditRecords: audit.records, files: files.map(({ name, sha256, bytes, containsSensitive }) => ({ name, sha256, bytes, containsSensitive })) };
  addFile(files, 'manifest.json', json(manifestBase), audience); return { ...manifestBase, files };
}

export function verifyExportPackage(exportPackage) { const failures = exportPackage.files.filter(file => checksum(file.content) !== file.sha256).map(file => file.name); return { valid: failures.length === 0, failures, fileCount: exportPackage.files.length }; }
