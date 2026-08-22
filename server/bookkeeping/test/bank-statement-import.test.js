import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBankStatementCsv } from '../src/bank-statement-import.js';

test('parses a single signed Amount column, standard US date format', () => {
  const csv = 'Date,Description,Amount\n07/20/2026,"Home Depot, Inc.",-84.50\n07/22/2026,Client Deposit,1200\n';
  const { transactions, warnings } = parseBankStatementCsv(csv);
  assert.equal(warnings.length, 0);
  assert.equal(transactions.length, 2);
  assert.deepEqual(transactions[0], { postedDate: '2026-07-20', amount: -84.5, description: 'Home Depot, Inc.', checkNumber: null, externalId: null, authorizedDate: null });
  assert.equal(transactions[1].amount, 1200);
  assert.equal(transactions[1].postedDate, '2026-07-22');
});

test('parses separate Debit/Credit columns with correct sign convention', () => {
  const csv = 'Posted Date,Memo,Debit,Credit\n2026-07-01,ATM Withdrawal,60.00,\n2026-07-02,Payroll Deposit,,2500.00\n';
  const { transactions, warnings } = parseBankStatementCsv(csv);
  assert.equal(warnings.length, 0);
  assert.equal(transactions[0].amount, -60);
  assert.equal(transactions[1].amount, 2500);
});

test('parses ISO dates, dollar signs, commas, and parenthesized negatives', () => {
  const csv = 'Date,Description,Amount\n2026-07-05,Big Purchase,"($1,250.00)"\n2026-07-06,Refund,"$45.00"\n';
  const { transactions } = parseBankStatementCsv(csv);
  assert.equal(transactions[0].amount, -1250);
  assert.equal(transactions[1].amount, 45);
});

test('skips one bad row with a warning instead of failing the whole import', () => {
  const csv = 'Date,Description,Amount\nnot-a-date,Bad row,10\n2026-07-01,Good row,10\n2026-07-02,Zero row,0\n';
  const { transactions, warnings } = parseBankStatementCsv(csv);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].description, 'Good row');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Row 2/);
  assert.match(warnings[1], /Row 4/);
});

test('throws a clear error when no date column can be found', () => {
  const csv = 'Description,Amount\nSomething,10\n';
  assert.throws(() => parseBankStatementCsv(csv), /date column/);
});

test('throws a clear error when no amount/debit-credit columns can be found', () => {
  const csv = 'Date,Description\n2026-07-01,Something\n';
  assert.throws(() => parseBankStatementCsv(csv), /amount column/);
});

test('throws on a completely empty file', () => {
  assert.throws(() => parseBankStatementCsv(''), /empty/);
});

test('passes through check number, external id, and authorized date when present', () => {
  const csv = 'Date,Description,Amount,Check Number,Transaction ID,Authorized Date\n2026-07-10,Rent Check,-1500,1042,txn-abc,07/09/2026\n';
  const { transactions } = parseBankStatementCsv(csv);
  assert.equal(transactions[0].checkNumber, '1042');
  assert.equal(transactions[0].externalId, 'txn-abc');
  assert.equal(transactions[0].authorizedDate, '2026-07-09');
});
