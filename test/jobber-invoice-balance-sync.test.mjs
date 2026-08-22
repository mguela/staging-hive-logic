// test/jobber-invoice-balance-sync.test.mjs
//
// invoices.balance was NULL on all 2,852 rows in production, and had been
// since the table existed. Not a write failure -- the sync never ASKED Jobber
// for the field. The invoice query selected total, subtotal, depositAmount,
// discountAmount and paymentsTotal, and mapInvoice wrote exactly those.
//
// That is a quiet kind of broken. Nothing errored. Reina's receivables read
// filtered on `balance > 0`, matched zero rows, and reported that nobody owed
// anything -- with 27 invoices past due and roughly $232,000 outstanding. A
// filter on a column nobody fills in does not fail; it answers "none", and
// "none" reads as good news.
//
// The clients query has always asked for `balance` and mapClient has always
// stored it, so the field was never controversial. Invoices were just missed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { isUnknownFieldError } from '../api/jobber/sync.js';
import { deriveInvoiceBalance, invoiceAmountDue } from '../api/_lib/invoice-balance.js';

const SOURCE = fs.readFileSync(new URL('../api/jobber/sync.js', import.meta.url), 'utf8');

test('the invoice query asks Jobber for the balance it keeps', () => {
  assert.match(SOURCE, /INVOICE_AMOUNTS_WITH_BALANCE = 'total subtotal depositAmount discountAmount paymentsTotal balance'/);
  assert.match(SOURCE, /INVOICES_QUERIES = \[\s*invoicesQuery\(INVOICE_AMOUNTS_WITH_BALANCE\)/,
    'the full shape is tried first');
});

test('mapInvoice stores Jobber\'s balance, and never a number of its own making', () => {
  assert.match(SOURCE, /balance: amounts\.balance == null \? null : amounts\.balance/);
  assert.doesNotMatch(SOURCE, /balance: [^\n]*amounts\.total[^\n]*-/,
    'a derived figure written here would be indistinguishable from an authoritative one');
});

// ---- the field might not exist, and that must not cost us the sync ---------

test('a validation error naming an optional field drops to the simpler query', () => {
  const error = new Error(`Jobber GraphQL error: [{"message":"Field 'balance' doesn't exist on type 'InvoiceAmounts'","extensions":{"code":"undefinedField"}}]`);
  assert.equal(isUnknownFieldError(error, 'balance'), true);
});

test('a throttle, a timeout or an auth failure is NOT treated as a missing field', () => {
  // The whole point of the narrow match: a transient failure that silently
  // downgraded the query would stop collecting the column again, and nothing
  // would say so. Losing balance twice for the same reason is not acceptable.
  for (const message of [
    'Jobber GraphQL error: [{"message":"Throttled","extensions":{"code":"THROTTLED"}}]',
    'fetch failed',
    'Jobber GraphQL error: [{"message":"Not authorized"}]',
    'Jobber GraphQL error: [{"message":"balance is unavailable right now"}]',
  ]) {
    assert.equal(isUnknownFieldError(new Error(message), 'balance'), false, message);
  }
});

test('only a field this query actually asked for can trigger the fallback', () => {
  const error = new Error(`Jobber GraphQL error: [{"message":"Field 'tax' doesn't exist on type 'InvoiceAmounts'"}]`);
  assert.equal(isUnknownFieldError(error, 'balance'), false);
  assert.equal(isUnknownFieldError(error, 'tax'), true);
});

test('the fallback is only allowed before the first record, and is reported', () => {
  assert.match(SOURCE, /if \(all\.length === 0 && nextIndex < candidates\.length/,
    'half a pass in one shape and half in another produces rows that disagree');
  assert.match(SOURCE, /OPTIONAL_FIELDS\.some\(\(field\) => isUnknownFieldError\(error, field\)\)/);
  assert.match(SOURCE, /console\.warn\(`\[jobber-sync\] \$\{name\}: fell back to a reduced query`/,
    'a silently reduced query is how this went unnoticed for as long as it did');
});

// ---- one sum, four call sites ---------------------------------------------

test('the shared derivation subtracts deposit and discount and clamps at zero', () => {
  assert.equal(deriveInvoiceBalance({ total: 1000, payments: 0, deposit: 300 }), 700);
  assert.equal(deriveInvoiceBalance({ total: 1000, payments: 200, deposit: 300, discount: 100 }), 400);
  assert.equal(deriveInvoiceBalance({ total: 500, payments: 0, deposit: 900 }), 0,
    'an invoice overpaid via deposit owes nothing, not a negative amount');
  assert.equal(deriveInvoiceBalance({ total: 10.005, payments: 0 }), 10.01, 'rounded to the cent');
  assert.equal(deriveInvoiceBalance(null), 0);
});

test('Jobber\'s own balance wins, and says it is exact', () => {
  assert.deepEqual(invoiceAmountDue({ total: 1000, payments: 0, balance: 250 }),
    { amountDue: 250, isExact: true });
  assert.deepEqual(invoiceAmountDue({ total: 1000, payments: 100, deposit: 200, discount: 0, balance: null }),
    { amountDue: 700, isExact: false });
  assert.equal(invoiceAmountDue({ total: 1000, balance: 0 }).isExact, true,
    'zero owed is a real answer, not a missing one');
});

test('every call site uses the one helper', () => {
  for (const file of ['../api/track1.js', '../api/invoices.js', '../api/clientportal.js']) {
    const contents = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(contents, /from '\.\/_lib\/invoice-balance\.js'/, `${file} imports the shared sum`);
    assert.doesNotMatch(contents, /Math\.max\(0, Math\.round\(\(total - payments - deposit - discount\)/,
      `${file} still carries its own copy of the sum`);
  }
});
