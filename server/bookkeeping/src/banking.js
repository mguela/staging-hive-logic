import { createHash, randomUUID } from 'node:crypto';
import { createEntry, recordAuditEvent } from './ledger.js';

const cents = value => Math.round((Number(value) || 0) * 100);
const amount = value => cents(value) / 100;
const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function companyOf(ledger, companyId) {
  const company = ledger.companies[companyId]; if (!company) throw new Error('Company not found.');
  company.bankTransactions ||= []; company.bankImportKeys ||= {}; company.reconciliations ||= [];
  return company;
}

function transactionFingerprint(transaction) {
  return hash({ accountId: transaction.accountId, postedDate: transaction.postedDate, amount: amount(transaction.amount), externalId: transaction.externalId || '', description: normalize(transaction.description), checkNumber: transaction.checkNumber || '' });
}

export function importBankFeed(ledger, companyId, transactions, importKey, actor = { id: 'bank-feed-system', role: 'system' }) {
  const company = companyOf(ledger, companyId);
  if (!importKey) throw new Error('Bank-feed import key is required.');
  if (company.bankImportKeys[importKey]) return { imported: 0, duplicates: transactions.length, replay: true, transactionIds: company.bankImportKeys[importKey] };
  const imported = [], duplicates = [];
  for (const input of transactions) {
    if (!input.accountId || !company.accounts[input.accountId] || !/^\d{4}-\d{2}-\d{2}$/.test(input.postedDate || '') || !Number.isFinite(Number(input.amount)) || cents(input.amount) === 0) throw new Error('Every bank transaction needs a mapped account, valid posting date, and non-zero amount.');
    const fingerprint = transactionFingerprint(input);
    const existing = company.bankTransactions.find(transaction => transaction.fingerprint === fingerprint || (input.externalId && transaction.externalId === input.externalId && transaction.accountId === input.accountId));
    if (existing) { duplicates.push({ input, existingId: existing.id, reason: 'Exact bank-feed duplicate' }); continue; }
    const transaction = { id: randomUUID(), companyId, accountId: input.accountId, externalId: input.externalId || null, postedDate: input.postedDate, authorizedDate: input.authorizedDate || null, amount: amount(input.amount), description: input.description || '', checkNumber: input.checkNumber || null, fingerprint, status: 'unmatched', match: null, importedAt: new Date().toISOString(), importKey };
    company.bankTransactions.push(transaction); imported.push(transaction);
  }
  company.bankImportKeys[importKey] = imported.map(transaction => transaction.id);
  recordAuditEvent(ledger, { companyId, actorId: actor.id, action: 'bank_feed.imported', entityType: 'bank_feed_import', entityId: importKey, after: { importedIds: imported.map(transaction => transaction.id), duplicateCount: duplicates.length } });
  return { imported: imported.length, duplicates: duplicates.length, transactions: imported, duplicateDetails: duplicates, replay: false };
}

export function detectExpenseDuplicates(expenses = []) {
  const groups = [];
  for (let left = 0; left < expenses.length; left += 1) for (let right = left + 1; right < expenses.length; right += 1) {
    const a = expenses[left], b = expenses[right];
    const sameAmount = cents(a.total) === cents(b.total); const sameVendor = normalize(a.vendor) === normalize(b.vendor);
    const dateDistance = Math.abs((new Date(a.transactionDate) - new Date(b.transactionDate)) / 86400000);
    const sameReference = a.reference && b.reference && normalize(a.reference) === normalize(b.reference);
    if (sameAmount && sameVendor && (dateDistance <= 3 || sameReference)) groups.push({ expenseIds: [a.id, b.id], confidence: sameReference ? 1 : dateDistance === 0 ? .95 : .82, reasons: ['same amount', 'same vendor', sameReference ? 'same reference' : `dates within ${dateDistance} day(s)`] });
  }
  return groups;
}

export function matchCandidates(bankTransaction, expenses = []) {
  return expenses.filter(expense => !expense.bankTransactionId).map(expense => {
    let score = 0; const reasons = [];
    if (cents(Math.abs(bankTransaction.amount)) === cents(expense.total)) { score += .55; reasons.push('exact amount'); }
    if (normalize(bankTransaction.description).includes(normalize(expense.vendor)) || normalize(expense.vendor).includes(normalize(bankTransaction.description))) { score += .25; reasons.push('vendor text'); }
    const dateDistance = Math.abs((new Date(bankTransaction.postedDate) - new Date(expense.transactionDate)) / 86400000);
    if (dateDistance <= 1) { score += .15; reasons.push('date within one day'); } else if (dateDistance <= 3) { score += .08; reasons.push('date within three days'); }
    if (expense.reference && normalize(bankTransaction.description).includes(normalize(expense.reference))) { score += .05; reasons.push('reference'); }
    return { expenseId: expense.id, score: Math.min(1, score), reasons };
  }).filter(candidate => candidate.score >= .55).sort((a, b) => b.score - a.score);
}

export function confirmBankMatch(ledger, companyId, bankTransactionId, expense, actor) {
  const company = companyOf(ledger, companyId); const transaction = company.bankTransactions.find(item => item.id === bankTransactionId);
  if (!transaction) throw new Error('Bank transaction not found.');
  if (transaction.status === 'matched') {
    if (transaction.match?.expenseId === expense.id) return transaction;
    throw new Error('Bank transaction is already matched.');
  }
  if (expense.bankTransactionId && expense.bankTransactionId !== transaction.id) throw new Error('Expense is already matched to another bank transaction.');
  if (cents(Math.abs(transaction.amount)) !== cents(expense.total)) throw new Error('Bank amount must equal the expense total.');
  transaction.status = 'matched'; transaction.match = { expenseId: expense.id, confirmedBy: actor.id, confirmedAt: new Date().toISOString(), amount: amount(expense.total) }; expense.bankTransactionId = transaction.id;
  recordAuditEvent(ledger, { companyId, actorId: actor.id, action: 'bank_transaction.matched', entityType: 'bank_transaction', entityId: transaction.id, after: transaction.match });
  return transaction;
}

export function classifyBankTransaction(ledger, companyId, bankTransactionId, input, actor) {
  const company = companyOf(ledger, companyId); const transaction = company.bankTransactions.find(item => item.id === bankTransactionId); if (!transaction) throw new Error('Bank transaction not found.');
  if (transaction.status === 'classified_pending' || transaction.status === 'classified') return transaction; if (transaction.status !== 'unmatched') throw new Error('Only unmatched bank transactions can be categorized.');
  const sourceAccount = company.accounts[transaction.accountId], offsetAccount = company.accounts[input.offsetAccountId]; if (!sourceAccount || !offsetAccount || sourceAccount.id === offsetAccount.id) throw new Error('Choose a valid offset account different from the bank or card account.');
  const classificationType = input.classificationType || (offsetAccount.type === 'income' ? 'income' : offsetAccount.type === 'expense' ? 'expense' : 'other'); if (!['income', 'expense', 'transfer', 'loan', 'equity', 'other'].includes(classificationType)) throw new Error('Choose a valid bank transaction category.');
  const value = Math.abs(amount(transaction.amount)); const sourceLine = transaction.amount > 0 ? { accountId: sourceAccount.id, debit: value } : { accountId: sourceAccount.id, credit: value }; const offsetLine = transaction.amount > 0 ? { accountId: offsetAccount.id, credit: value } : { accountId: offsetAccount.id, debit: value };
  const description = String(input.description || transaction.description || 'Bank transaction').trim(); const lines = [{ ...sourceLine, memo: description, dimensions: { bankTransactionId: transaction.id, classificationType } }, { ...offsetLine, memo: description, dimensions: { bankTransactionId: transaction.id, classificationType } }];
  const journal = createEntry(ledger, { companyId, date: transaction.postedDate, cashDate: transaction.postedDate, description, memo: input.memo || '', source: 'bank_classification', sourceId: transaction.id, lines, cashLines: lines }, actor);
  transaction.status = 'classified_pending'; transaction.classification = { classificationType, offsetAccountId: offsetAccount.id, journalEntryId: journal.id, description, memo: input.memo || '', classifiedBy: actor.id, classifiedAt: new Date().toISOString() };
  recordAuditEvent(ledger, { companyId, actorId: actor.id, action: 'bank_transaction.classification_requested', entityType: 'bank_transaction', entityId: transaction.id, after: transaction.classification }); return transaction;
}

function reconciliationPayload(company, input) {
  const transactions = company.bankTransactions.filter(transaction => transaction.accountId === input.accountId && transaction.postedDate >= input.startDate && transaction.postedDate <= input.endDate).map(transaction => ({ id: transaction.id, fingerprint: transaction.fingerprint, amount: transaction.amount, status: transaction.status, match: transaction.match }));
  return { accountId: input.accountId, startDate: input.startDate, endDate: input.endDate, statementBeginningBalance: amount(input.statementBeginningBalance), statementEndingBalance: amount(input.statementEndingBalance), bookEndingBalance: amount(input.bookEndingBalance), transactions };
}

export function reconcileStatement(ledger, companyId, input, actor) {
  const company = companyOf(ledger, companyId); const payload = reconciliationPayload(company, input);
  const unresolved = payload.transactions.filter(transaction => !['matched', 'classified', 'excluded'].includes(transaction.status));
  if (unresolved.length) throw new Error(`${unresolved.length} bank transaction(s) are unresolved.`);
  if (cents(payload.statementEndingBalance) !== cents(payload.bookEndingBalance)) throw new Error('Statement and book ending balances must match exactly.');
  const existing = company.reconciliations.find(reconciliation => reconciliation.accountId === input.accountId && reconciliation.endDate === input.endDate && reconciliation.status === 'complete');
  if (existing) return existing;
  const reconciliation = { id: randomUUID(), companyId, ...payload, status: 'complete', reconciledBy: actor.id, reconciledAt: new Date().toISOString() };
  reconciliation.snapshotHash = hash(payload); company.reconciliations.push(reconciliation);
  recordAuditEvent(ledger, { companyId, actorId: actor.id, action: 'reconciliation.completed', entityType: 'reconciliation', entityId: reconciliation.id, after: { accountId: reconciliation.accountId, endDate: reconciliation.endDate, snapshotHash: reconciliation.snapshotHash } });
  return reconciliation;
}

export function verifyReconciliation(ledger, companyId, reconciliationId) {
  const company = companyOf(ledger, companyId); const reconciliation = company.reconciliations.find(item => item.id === reconciliationId);
  if (!reconciliation) throw new Error('Reconciliation not found.');
  const current = reconciliationPayload(company, reconciliation); const currentHash = hash(current); const auditHash = [...ledger.audit].reverse().find(record => record.action === 'reconciliation.completed' && record.entityId === reconciliation.id)?.after?.snapshotHash;
  const valid = currentHash === reconciliation.snapshotHash && auditHash === reconciliation.snapshotHash;
  return { valid, reconciliationId, expectedHash: reconciliation.snapshotHash, auditHash, currentHash, status: valid ? 'intact' : 'broken' };
}
