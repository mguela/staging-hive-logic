// test/purchase-order-number-allocation.test.mjs
//
// A rejected purchase order must not consume a purchase order number.
//
// allocate_po_number() is a durable counter that only ever goes up and is
// never rolled back. That is deliberate and correct -- it is what stops a
// cancelled PO's number from being handed out to a second purchase. But the
// create route called it BEFORE the engine validated the input, so a request
// that 422'd still moved the sequence. Nothing was written, and the number
// was spent.
//
// Production carries the evidence. On 2026-07-29 the reachability probe in
// api/test-workflow.js posted a deliberately incomplete purchase order -- the
// probe exists precisely to confirm the route rejects it -- and po_counters
// still holds the row it left: scope job:ZZTESTRUN-PROBE, next_sequence 1,
// against zero rows in purchase_orders. A request that created nothing wrote
// durable state anyway.
//
// A gap in a PO sequence is not cosmetic. To anyone auditing the books a
// missing number reads as a purchase order that was deleted or hidden, and
// "somebody submitted a form with no line items" is not recoverable from the
// data afterward.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  validatePurchaseOrderInput,
  createPurchaseOrder,
} from '../server/bookkeeping/src/purchase-orders.js';

const CREATE = fs.readFileSync(new URL('../api/bookkeeping/purchase-orders/create.js', import.meta.url), 'utf8');

test('the number is allocated after validation, not before', () => {
  const validateAt = CREATE.indexOf('validatePurchaseOrderInput(engineInput)');
  const allocateAt = CREATE.indexOf('await allocatePoNumber(');
  assert.ok(validateAt > 0, 'the route validates with the engine\'s own validator');
  assert.ok(allocateAt > 0, 'the route still allocates durably');
  assert.ok(validateAt < allocateAt,
    'allocating first means a rejected request spends a number that is never rolled back');
});

test('the guard runs before allocation too', () => {
  const assertAt = CREATE.indexOf('assertActorAuthenticated(actor)');
  const allocateAt = CREATE.indexOf('await allocatePoNumber(');
  assert.ok(assertAt > 0 && assertAt < allocateAt);
});

test('the route borrows the engine\'s rules rather than restating them', () => {
  // A second copy would drift, and an input that passed the copy and failed
  // the engine would burn the number anyway -- the exact failure this
  // ordering exists to prevent.
  assert.match(CREATE, /const \{ createPurchaseOrder, validatePurchaseOrderInput, assertActorAuthenticated \} = await _load_purchase_orders\(\)/);
  assert.doesNotMatch(CREATE, /needs a job or an overhead category/,
    'the route must not carry its own copy of a validation message');
});

// ---- the rules themselves, so the ordering above is worth something -------

test('the probe\'s own payload is rejected, and is rejected by validation', () => {
  // { jobId, vendorName } and nothing else -- exactly what api/test-workflow.js
  // sends, and exactly what left the stranded counter row behind.
  const result = validatePurchaseOrderInput({
    companyId: 'greenwich-handyman',
    jobId: 'ZZTESTRUN-PROBE',
    vendorName: 'ZZTESTRUN',
    requestedBy: 'someone',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /at least one line/i.test(e)),
    'no line items is what makes it invalid');
});

test('a complete purchase order still gets the number it was handed', () => {
  const { purchaseOrder } = createPurchaseOrder({
    companyId: 'greenwich-handyman',
    jobId: '2985',
    vendorName: 'Some Supplier',
    requestedBy: 'chris',
    poNumber: 'PO-2985-01',
    lines: [{ type: 'material', description: 'lumber', estimatedQty: 10, estimatedUnitPrice: 12.5 }],
  }, { id: 'chris', role: 'owner', companyId: 'greenwich-handyman' }, {});

  assert.equal(purchaseOrder.poNumber, 'PO-2985-01');
  assert.equal(purchaseOrder.lifecycleStatus, 'draft');
});

test('the number the engine records in history is the real one', () => {
  // The creation event is hash-chained, and it carries poNumber in its
  // detail. That rules out the shortcut of creating with a placeholder and
  // stamping the real number on afterwards: the history would keep the
  // placeholder, and the hash would make it permanent.
  const { purchaseOrder } = createPurchaseOrder({
    companyId: 'greenwich-handyman',
    jobId: '2985',
    vendorName: 'Some Supplier',
    requestedBy: 'chris',
    poNumber: 'PO-2985-07',
    lines: [{ type: 'material', description: 'lumber', estimatedQty: 1, estimatedUnitPrice: 1 }],
  }, { id: 'chris', role: 'owner', companyId: 'greenwich-handyman' }, {});

  const created = purchaseOrder.history.find((h) => h.type === 'created');
  assert.equal(created.detail.poNumber, 'PO-2985-07');
});
