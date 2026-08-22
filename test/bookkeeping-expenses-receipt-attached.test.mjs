// test/bookkeeping-expenses-receipt-attached.test.mjs
// 2026-08-14 (jomell): "Receipt or supporting document is required" came back
// on every expense submission, even with a file genuinely attached. Root
// cause: api/bookkeeping/expenses.js built the object it hands to the real
// accounting-engine validator (server/bookkeeping/src/accounting.js,
// validateExpense) with `receiptAttached: !!input.receiptAttached` -- but the
// client (public/app-bookkeeping.js's buildPayload()) sends the uploaded
// receipt's id as `evidenceId`, never as `receiptAttached`. That field was
// always undefined, so the check was always false regardless of what the
// user attached.
//
// This exercises the real accounting.js validator (not mocked) so the fix is
// verified against the actual rule, not a stand-in for it. Only the actor/
// storage seams are mocked.
// Run with: node --experimental-test-module-mocks --test test/bookkeeping-expenses-receipt-attached.test.mjs

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.BOOKKEEPING_ENABLED = 'true';
process.env.HIVELOGIC_COMPANY_ID = 'greenwich-handyman';

mock.module('../api/bookkeeping/purchase-orders/_actor.js', {
  namedExports: {
    getTrustedActor: async () => ({ id: 'actor-1', companyId: 'greenwich-handyman', role: 'controller' }),
  },
});

let lastInserted = null;
mock.module('../api/bookkeeping/_expense_store.js', {
  namedExports: {
    insertExpense: async (expense) => { lastInserted = expense; return { ...expense, id: 'exp-1' }; },
    updateExpense: async () => null,
    storeBackend: () => 'memory',
  },
});

const { default: handler } = await import('../api/bookkeeping/expenses.js');

function res() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function baseExpense(overrides = {}) {
  return {
    status: 'draft',
    transactionKind: 'paid',
    vendor: 'Test Vendor',
    transactionDate: '2026-08-14',
    receiptSubtotal: 10,
    salesTaxTotal: 0,
    total: 10,
    paymentAccountId: 'bank-1',
    allocations: [{
      description: 'Test line', ownerType: 'employee', ownerId: 'emp-1', qboAccountId: 'acct-1',
      subtotal: 10, salesTaxAmount: 0, amount: 10,
    }],
    ...overrides,
  };
}

function req(body) {
  return { method: 'POST', headers: {}, socket: {}, body };
}

test('a submission with a real evidenceId attached is accepted -- no "receipt required" error', async () => {
  lastInserted = null;
  const r = res();
  await handler(req(baseExpense({ evidenceId: 'evidence-123' })), r);
  assert.equal(r.statusCode, 200, 'expected a clean save: ' + JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.ok(!(r.body.errors || []).includes('Receipt or supporting document is required.'));
  assert.equal(lastInserted.receiptAttached, true, 'the stored expense must record that a receipt was attached');
});

test('a submission with no evidenceId at all is still correctly rejected (the check is not simply disabled)', async () => {
  const r = res();
  await handler(req(baseExpense()), r);
  assert.equal(r.statusCode, 422);
  assert.ok(r.body.errors.includes('Receipt or supporting document is required.'));
});
