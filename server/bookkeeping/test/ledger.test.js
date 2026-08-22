import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, addCompany, createEntry, approveEntry, postEntry, reverseEntry, setPeriodLock, setClosingDate, trialBalance, balanceSheet, verifyAuditChain, verifyPostedEntries } from '../src/ledger.js';

const controller = { id: 'controller-1', role: 'controller' };
const submitter = { id: 'user-1', role: 'submitter' };
const approver = { id: 'user-2', role: 'approver' };
const accounts = [
  { id: '1000', name: 'Cash', type: 'asset' }, { id: '2000', name: 'Accounts Payable', type: 'liability' },
  { id: '3000', name: 'Owner Equity', type: 'equity' }, { id: '4000', name: 'Revenue', type: 'income' },
  { id: '5000', name: 'Materials Expense', type: 'expense' }
];

function setup() { const ledger = createLedger(); addCompany(ledger, { id: 'co-1', name: 'GH Group', accounts }, controller); return ledger; }

test('rejects an unbalanced journal entry', () => {
  const ledger = setup();
  assert.throws(() => createEntry(ledger, { companyId: 'co-1', date: '2026-07-20', description: 'Bad entry', lines: [{ accountId: '5000', debit: 100 }, { accountId: '1000', credit: 90 }] }, submitter), /must balance/);
});

test('rejects non-finite money and impossible calendar dates before they reach storage', () => {
  const ledger = setup();
  assert.throws(() => createEntry(ledger, { companyId: 'co-1', date: '2026-07-20', description: 'Infinite entry', lines: [{ accountId: '5000', debit: Infinity }, { accountId: '1000', credit: Infinity }] }, submitter), /invalid amount/);
  assert.throws(() => createEntry(ledger, { companyId: 'co-1', date: '2026-02-31', description: 'Impossible date', lines: [{ accountId: '5000', debit: 10 }, { accountId: '1000', credit: 10 }] }, submitter), /valid posting date/);
  assert.throws(() => setClosingDate(ledger, 'co-1', '2026-02-31', controller), /real calendar date/);
});

test('rejects an independently unbalanced cash-basis journal view', () => {
  const ledger = setup();
  assert.throws(() => createEntry(ledger, { companyId: 'co-1', date: '2026-07-20', cashDate: '2026-08-01', description: 'Bad cash view', lines: [{ accountId: '2000', debit: 100 }, { accountId: '5000', credit: 100 }], cashLines: [{ accountId: '1000', debit: 100 }, { accountId: '4000', credit: 90 }] }, controller), /Cash-basis debits and credits must balance/);
});

test('requires separation of duties and idempotently posts', () => {
  const ledger = setup();
  const entry = createEntry(ledger, { companyId: 'co-1', date: '2026-07-20', description: 'Materials', lines: [{ accountId: '5000', debit: 100 }, { accountId: '1000', credit: 100 }] }, submitter);
  assert.throws(() => approveEntry(ledger, 'co-1', entry.id, submitter), /cannot entry:approve/);
  approveEntry(ledger, 'co-1', entry.id, approver);
  const posted = postEntry(ledger, 'co-1', entry.id, controller, 'expense:abc');
  assert.equal(postEntry(ledger, 'co-1', entry.id, controller, 'expense:abc').id, posted.id);
  assert.equal(trialBalance(ledger, 'co-1').balanced, true);
});

test('locked periods cannot accept entries', () => {
  const ledger = setup(); setPeriodLock(ledger, 'co-1', '2026-06', true, controller);
  assert.throws(() => createEntry(ledger, { companyId: 'co-1', date: '2026-06-30', description: 'Late', lines: [{ accountId: '5000', debit: 1 }, { accountId: '1000', credit: 1 }] }, controller), /locked/);
});

test('closing date blocks every backdated entry, even outside the named lock month', () => {
  const ledger = setup(); setClosingDate(ledger, 'co-1', '2026-06-30', controller);
  assert.throws(() => createEntry(ledger, { companyId: 'co-1', date: '2026-05-31', description: 'Backdated', lines: [{ accountId: '5000', debit: 1 }, { accountId: '1000', credit: 1 }] }, controller), /closing date/);
  assert.doesNotThrow(() => createEntry(ledger, { companyId: 'co-1', date: '2026-07-01', description: 'Current period', lines: [{ accountId: '5000', debit: 1 }, { accountId: '1000', credit: 1 }] }, controller));
  assert.throws(() => setClosingDate(ledger, 'co-1', '2026-05-31', controller), /cannot move backward/);
});

test('corrections reverse without destroying the original history', () => {
  const ledger = setup();
  const entry = createEntry(ledger, { companyId: 'co-1', date: '2026-07-20', description: 'Materials', lines: [{ accountId: '5000', debit: 100 }, { accountId: '1000', credit: 100 }] }, controller);
  entry.status = 'approved'; postEntry(ledger, 'co-1', entry.id, controller, 'manual:1');
  const reversal = reverseEntry(ledger, 'co-1', entry.id, '2026-07-21', 'Wrong vendor', controller);
  assert.equal(ledger.companies['co-1'].entries.length, 2); assert.equal(reversal.sourceId, entry.id); assert.equal(trialBalance(ledger, 'co-1').rows.find(row => row.accountId === '5000').balance, 0);
});

test('balance sheet includes current earnings and always balances', () => {
  const ledger = setup();
  const sale = createEntry(ledger, { companyId: 'co-1', date: '2026-07-20', description: 'Cash sale', lines: [{ accountId: '1000', debit: 250 }, { accountId: '4000', credit: 250 }] }, controller);
  sale.status = 'approved'; postEntry(ledger, 'co-1', sale.id, controller, 'sale:1');
  const sheet = balanceSheet(ledger, 'co-1'); assert.equal(sheet.assets, 250); assert.equal(sheet.equity, 250); assert.equal(sheet.balanced, true);
});

test('audit trail is tamper evident', () => {
  const ledger = setup(); assert.equal(verifyAuditChain(ledger).valid, true); ledger.audit[0].after.name = 'Tampered'; assert.equal(verifyAuditChain(ledger).valid, false);
});

test('posted journal contents are sealed against later mutation', () => {
  const ledger = setup(); const entry = createEntry(ledger, { companyId: 'co-1', date: '2026-07-20', description: 'Sealed', lines: [{ accountId: '5000', debit: 10 }, { accountId: '1000', credit: 10 }] }, controller); entry.status = 'approved'; postEntry(ledger, 'co-1', entry.id, controller, 'seal:1');
  assert.equal(verifyPostedEntries(ledger, 'co-1').valid, true); entry.lines[0].debit = 11; assert.equal(verifyPostedEntries(ledger, 'co-1').failures[0].reason, 'content changed');
});

test('multi-company books remain isolated', () => {
  const ledger = setup(); addCompany(ledger, { id: 'co-2', name: 'Second Company', basis: 'cash', accounts }, controller);
  const entry = createEntry(ledger, { companyId: 'co-1', date: '2026-07-20', description: 'Only company one', lines: [{ accountId: '5000', debit: 10 }, { accountId: '1000', credit: 10 }] }, controller); entry.status = 'approved'; postEntry(ledger, 'co-1', entry.id, controller, 'co1:1');
  assert.equal(trialBalance(ledger, 'co-2').totalDebits, 0);
});
