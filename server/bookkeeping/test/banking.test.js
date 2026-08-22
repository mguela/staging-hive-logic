import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, addCompany } from '../src/ledger.js';
import { classifyBankTransaction, importBankFeed, detectExpenseDuplicates, matchCandidates, confirmBankMatch, reconcileStatement, verifyReconciliation } from '../src/banking.js';

const actor = { id: 'bookkeeper-1', role: 'bookkeeper' };
function setup() { const ledger = createLedger(); addCompany(ledger, { id: 'co', name: 'GH', accounts: [{ id: 'bank', name: 'Bank', type: 'asset' }] }, { id: 'controller', role: 'controller' }); return ledger; }
const bankInput = { accountId: 'bank', externalId: 'txn-1', postedDate: '2026-07-20', amount: -106.35, description: 'ABC SUPPLY 22412' };
const makeExpense = () => ({ id: 'expense-1', vendor: 'ABC Supply', transactionDate: '2026-07-19', total: 106.35, reference: '22412' });

test('bank imports are idempotent and identify feed duplicates', () => {
  const ledger = setup(); const first = importBankFeed(ledger, 'co', [bankInput], 'feed:1'); assert.equal(first.imported, 1);
  assert.equal(importBankFeed(ledger, 'co', [bankInput], 'feed:1').replay, true);
  assert.equal(importBankFeed(ledger, 'co', [bankInput], 'feed:2').duplicates, 1);
});

test('bank imports reject unmapped accounts and malformed transaction dates', () => {
  const ledger = setup(); assert.throws(() => importBankFeed(ledger, 'co', [{ accountId: 'missing', postedDate: '2026-07-20', amount: -10, description: 'Store' }], 'bad-account'), /mapped account/); assert.throws(() => importBankFeed(ledger, 'co', [{ accountId: 'bank', postedDate: 'July 20', amount: -10, description: 'Store' }], 'bad-date'), /valid posting date/);
});

test('duplicate expenses are surfaced instead of silently posted twice', () => {
  const expense = makeExpense(); const duplicates = detectExpenseDuplicates([expense, { ...expense, id: 'expense-2', transactionDate: '2026-07-20' }]);
  assert.equal(duplicates.length, 1); assert.ok(duplicates[0].confidence >= .82);
});

test('bank matching scores and confirms exact expense candidates', () => {
  const ledger = setup(); const transaction = importBankFeed(ledger, 'co', [bankInput], 'feed:1').transactions[0];
  const expense = makeExpense();
  const candidates = matchCandidates(transaction, [expense]); assert.equal(candidates[0].expenseId, expense.id); assert.ok(candidates[0].score >= .9);
  confirmBankMatch(ledger, 'co', transaction.id, expense, actor); assert.equal(transaction.status, 'matched'); assert.equal(expense.bankTransactionId, transaction.id);
});

test('unmatched deposits and charges become balanced pending journal entries', () => {
  const ledger = setup(); ledger.companies.co.accounts.revenue = { id: 'revenue', name: 'Revenue', type: 'income', normalBalance: 'credit', active: true }; ledger.companies.co.accounts.expense = { id: 'expense', name: 'Expense', type: 'expense', normalBalance: 'debit', active: true };
  const deposit = importBankFeed(ledger, 'co', [{ accountId: 'bank', postedDate: '2026-07-20', amount: 250, description: 'Customer deposit' }], 'deposit').transactions[0]; classifyBankTransaction(ledger, 'co', deposit.id, { offsetAccountId: 'revenue', classificationType: 'income' }, actor); const depositJournal = ledger.companies.co.entries.find(item => item.id === deposit.classification.journalEntryId); assert.equal(depositJournal.lines.find(line => line.accountId === 'bank').debit, 250); assert.equal(depositJournal.lines.find(line => line.accountId === 'revenue').credit, 250);
  const charge = importBankFeed(ledger, 'co', [{ accountId: 'bank', postedDate: '2026-07-21', amount: -25, description: 'Bank fee' }], 'charge').transactions[0]; classifyBankTransaction(ledger, 'co', charge.id, { offsetAccountId: 'expense', classificationType: 'expense' }, actor); const chargeJournal = ledger.companies.co.entries.find(item => item.id === charge.classification.journalEntryId); assert.equal(chargeJournal.lines.find(line => line.accountId === 'bank').credit, 25); assert.equal(chargeJournal.lines.find(line => line.accountId === 'expense').debit, 25); assert.equal(charge.status, 'classified_pending');
});

test('reconciliation cannot complete with unresolved transactions or a balance difference', () => {
  const ledger = setup(); const transaction = importBankFeed(ledger, 'co', [bankInput], 'feed:1').transactions[0];
  const expense = makeExpense();
  const input = { accountId: 'bank', startDate: '2026-07-01', endDate: '2026-07-31', statementBeginningBalance: 1000, statementEndingBalance: 893.65, bookEndingBalance: 893.65 };
  assert.throws(() => reconcileStatement(ledger, 'co', input, actor), /unresolved/);
  confirmBankMatch(ledger, 'co', transaction.id, expense, actor);
  assert.throws(() => reconcileStatement(ledger, 'co', { ...input, bookEndingBalance: 893.64 }, actor), /match exactly/);
});

test('completed reconciliation detects any later silent mutation', () => {
  const ledger = setup(); const expense = makeExpense(); const transaction = importBankFeed(ledger, 'co', [bankInput], 'feed:1').transactions[0]; confirmBankMatch(ledger, 'co', transaction.id, expense, actor);
  const reconciliation = reconcileStatement(ledger, 'co', { accountId: 'bank', startDate: '2026-07-01', endDate: '2026-07-31', statementBeginningBalance: 1000, statementEndingBalance: 893.65, bookEndingBalance: 893.65 }, actor);
  assert.equal(verifyReconciliation(ledger, 'co', reconciliation.id).valid, true); transaction.amount = -100; assert.equal(verifyReconciliation(ledger, 'co', reconciliation.id).status, 'broken');
});

test('reconciliation seal cannot be rewritten to hide a changed statement', () => {
  const ledger = setup(); const expense = makeExpense(); const transaction = importBankFeed(ledger, 'co', [bankInput], 'feed:1').transactions[0]; confirmBankMatch(ledger, 'co', transaction.id, expense, actor);
  const reconciliation = reconcileStatement(ledger, 'co', { accountId: 'bank', startDate: '2026-07-01', endDate: '2026-07-31', statementBeginningBalance: 1000, statementEndingBalance: 893.65, bookEndingBalance: 893.65 }, actor);
  reconciliation.snapshotHash = 'rewritten'; assert.equal(verifyReconciliation(ledger, 'co', reconciliation.id).valid, false);
});
