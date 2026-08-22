import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExpense, toQboPurchase, qboExpenseEntityType, suggestOwnership, distributeSalesTax } from '../src/accounting.js';

const complete = {
  vendor: 'ABC Supply', transactionDate: '2026-07-19', total: 125.50,
  paymentAccountId: '42', paymentType: 'CreditCard', receiptAttached: true,
  allocations: [{ ownerType: 'job', ownerId: 'JOB-100', qboAccountId: '64', customerJobId: '301', amount: 125.50 }]
};

test('blocks an expense without a fully allocated home', () => {
  const result = validateExpense({ ...complete, allocations: [{ ...complete.allocations[0], amount: 100 }] });
  assert.equal(result.valid, false);
  assert.equal(result.difference, 25.5);
});

test('accepts an expense that reconciles to zero', () => assert.equal(validateExpense(complete).valid, true));

test('maps job ownership into QBO CustomerRef', () => {
  const qbo = toQboPurchase(complete);
  assert.equal(qbo.Line[0].AccountBasedExpenseLineDetail.CustomerRef.value, '301');
  assert.equal(qbo.Line[0].Amount, 125.5);
});

test('preserves the selected QBO vendor identity', () => {
  const qbo = toQboPurchase({ ...complete, qboVendorId: '22412' });
  assert.deepEqual(qbo.EntityRef, { value: '22412', type: 'Vendor' });
});

test('maps an unpaid vendor bill to QBO Accounts Payable without pretending cash moved', () => {
  const bill = { ...complete, transactionKind: 'bill', paymentAccountId: '2000', paymentType: 'Bill', qboVendorId: '22412', dueDate: '2026-08-18', reference: 'INV-77' };
  const qbo = toQboPurchase(bill);
  assert.equal(qboExpenseEntityType(bill), 'bill');
  assert.deepEqual(qbo.VendorRef, { value: '22412' });
  assert.deepEqual(qbo.APAccountRef, { value: '2000' });
  assert.equal(qbo.DueDate, '2026-08-18');
  assert.equal(qbo.DocNumber, 'INV-77');
  assert.equal(qbo.PaymentType, undefined);
  assert.equal(qbo.AccountRef, undefined);
});

test('blocks incomplete or misdated unpaid bills', () => {
  const result = validateExpense({ ...complete, transactionKind: 'bill', paymentAccountId: '42', qboVendorId: '', dueDate: '2026-07-01' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /vendor selected from the QuickBooks vendor directory/);
  assert.match(result.errors.join(' '), /cannot be before/);
  assert.match(result.errors.join(' '), /Accounts Payable/);
});

test('maps receipt sales tax as included purchase cost, not customer sales tax', () => {
  const taxed = { ...complete, total: 106.35, receiptSubtotal: 100, salesTaxTotal: 6.35, allocations: [{ ...complete.allocations[0], subtotal: 100, salesTaxAmount: 6.35, salesTaxState: 'CT', amount: 106.35 }] };
  const qbo = toQboPurchase(taxed);
  assert.equal(qbo.Line[0].Amount, 106.35);
  assert.equal(qbo.Line[0].AccountBasedExpenseLineDetail.TaxCodeRef.value, 'NON');
  assert.match(qbo.PrivateNote, /CT sales tax paid \$6\.35 \(included in expense lines\)/);
  assert.equal(qbo.TxnTaxDetail, undefined);
  assert.equal(qbo.Line[0].HiveLogicTaxTracking, undefined);
});

test('blocks receipt tax totals that do not reconcile to QBO line amounts', () => {
  const result = validateExpense({ ...complete, total: 106.35, receiptSubtotal: 100, salesTaxTotal: 6, allocations: [{ ...complete.allocations[0], subtotal: 100, salesTaxAmount: 6.35, salesTaxState: 'CT', amount: 106.35 }] });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /sales tax must equal/);
});

test('Reina suggests job materials from a recognized receipt', () => {
  const result = suggestOwnership({ vendor: 'Home Depot', text: 'Romex and breakers', total: 88.25 });
  assert.equal(result.ownerType, 'job');
  assert.equal(result.qboAccountId, '64');
});

test('approved history outranks generic rules', () => {
  const result = suggestOwnership({ vendor: 'Home Depot', total: 42 }, [{ vendor: 'Home Depot', uses: 4, suggestion: { ownerType: 'inventory', qboAccountId: '66', ownerId: 'Main warehouse' } }]);
  assert.equal(result.ownerType, 'inventory');
  assert.ok(result.confidence > .8);
});

test('distributes receipt sales tax proportionally and preserves every cent', () => {
  assert.deepEqual(distributeSalesTax([{ subtotal: 10 }, { subtotal: 20 }, { subtotal: 30 }], 4.01), [0.67, 1.34, 2]);
});

test('requires a state when a line contains sales tax', () => {
  const result = validateExpense({ ...complete, allocations: [{ ...complete.allocations[0], subtotal: 120, salesTaxAmount: 5.5, amount: 125.5 }] });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /state where its sales tax belongs/);
});

test('allows an unknown owner only in the unrecorded holding account', () => {
  const unknown = { ...complete, allocations: [{ ...complete.allocations[0], ownerType: 'unknown', ownerId: 'Unknown — needs reconciliation', qboAccountId: '99' }] };
  assert.equal(validateExpense(unknown).valid, true);
  assert.equal(validateExpense({ ...unknown, allocations: [{ ...unknown.allocations[0], qboAccountId: '64' }] }).valid, false);
});

test('Reina recognizes common operating expense homes', () => {
  const examples = [
    ['independent contractor invoice', 'subcontractor', '65'],
    ['United Rentals equipment rental', 'rental', '73'],
    ['monthly loan payment', 'loan', '74'],
    ['warehouse rent landlord', 'rent', '75'],
    ['Shell diesel fuel', 'gas', '76'],
    ['truck repair service center', 'maintenance', '77'],
    ['new drill tool', 'tools', '72'],
    ['truck parking', 'truck', '67']
  ];
  for (const [text, ownerType, account] of examples) {
    const result = suggestOwnership({ text, total: 10 });
    assert.equal(result.ownerType, ownerType, text);
    assert.equal(result.qboAccountId, account, text);
  }
});
