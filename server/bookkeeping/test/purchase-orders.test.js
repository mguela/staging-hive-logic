import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocatePurchaseOrderNumber, createPurchaseOrder, validatePurchaseOrderInput, purchaseOrderEstimatedTotal,
  approvePurchaseOrder, rejectPurchaseOrder, revisePurchaseOrder, requiresApproval, matchReceiptToPurchaseOrders,
  computeReceivingLifecycle, detectExceptions, markBilled, closePurchaseOrder, cancelPurchaseOrder,
  evaluateOrderTiming, assertOrderTypeImmutable, approvedActualCostsForJobCosting, toQboPurchaseOrderPreview,
  verifyPurchaseOrderHistory, assertActorAuthenticated, assertSameCompany, withComputedStatus, voidPostedPurchaseOrder
} from '../src/purchase-orders.js';

const approver = { id: 'approver-1', role: 'approver', companyId: 'ghgrp' };
const controller = { id: 'controller-1', role: 'controller', companyId: 'ghgrp' };
const requester = { id: 'jeff', role: 'field', companyId: 'ghgrp' };
const otherFieldUser = { id: 'amy', role: 'field', companyId: 'ghgrp' };
const bookkeeper = { id: 'bookkeeper-1', role: 'bookkeeper', companyId: 'ghgrp' };
const otherCompanyApprover = { id: 'intruder', role: 'approver', companyId: 'other-co' };

function basicInput(overrides = {}) {
  return {
    companyId: 'ghgrp', jobId: '231-004', vendorName: 'Home Depot', requestedBy: 'jeff',
    lines: [{ type: 'material', description: '12/2 Romex', estimatedQty: 2, estimatedUnitPrice: 89.5 }],
    ...overrides
  };
}

function makeApprovedPo(overrides = {}, { orderedAt = '2026-07-18T09:00:00Z' } = {}) {
  const { purchaseOrder } = createPurchaseOrder(basicInput(overrides), requester, { now: '2026-07-17T09:00:00Z' });
  return { ...approvePurchaseOrder(purchaseOrder, approver, { now: orderedAt }) };
}

// ---------------------------------------------------------------------------
// Regression tests for the four bugs the outside review reproduced
// ---------------------------------------------------------------------------

test('BUG 1 FIX: a purchase whose vendor transaction date predates PO approval is blocked, regardless of upload time', () => {
  const po = makeApprovedPo({}, { orderedAt: '2026-07-20T09:00:00Z' });
  // Uploaded AFTER approval (would have fooled the old upload-time check)...
  const receiptUploadedLate = { id: 'rct-1', companyId: 'ghgrp', uploadedAt: '2026-07-25T09:00:00Z', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  // ...but the vendor's own document says the purchase happened BEFORE approval.
  assert.throws(
    () => matchReceiptToPurchaseOrders([po], receiptUploadedLate, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 2, unitPrice: 89.5 }], approver),
    /before .* was approved and ordered/
  );
});

test('BUG 1 FIX: a vendor transaction on or after the order date is accepted, even if uploaded much later', () => {
  const po = makeApprovedPo({}, { orderedAt: '2026-07-18T09:00:00Z' });
  const receipt = { id: 'rct-2', companyId: 'ghgrp', uploadedAt: '2026-08-15T09:00:00Z', vendorTransactionDate: '2026-07-20T09:00:00Z' };
  const [updated] = matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 2, unitPrice: 89.5 }], approver);
  assert.equal(updated.status, 'fully_received');
  assert.ok(!updated.exceptions.includes('planning_unverified'));
});

test('BUG 1 FIX: missing vendor transaction date is flagged for controller review, not silently accepted as planned', () => {
  const po = makeApprovedPo();
  const receiptNoVendorDate = { id: 'rct-3', companyId: 'ghgrp', uploadedAt: '2026-07-21T09:00:00Z' };
  const timing = evaluateOrderTiming(po, receiptNoVendorDate);
  assert.equal(timing.blocked, false);
  assert.equal(timing.requiresControllerReview, true);
  const [updated] = matchReceiptToPurchaseOrders([po], receiptNoVendorDate, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 2, unitPrice: 89.5 }], approver);
  assert.ok(updated.exceptions.includes('planning_unverified'));
  assert.equal(updated.status, 'exception');
});

// ---------------------------------------------------------------------------
// Round 3 correction #6 adversarial tests: the same-day loophole
// ---------------------------------------------------------------------------

test('ROUND 3 #6: reproduces the same-day loophole -- a purchase made BEFORE approval, on the same calendar day, must not pass as verified', () => {
  const po = makeApprovedPo({}, { orderedAt: '2026-07-19T15:00:00Z' }); // approved 3pm
  // Same calendar day, but the vendor's own timestamp is 9am -- six hours
  // BEFORE approval. The old day-only comparison would have called this
  // "not an earlier calendar day" and silently treated it as verified.
  const receipt = { id: 'rct-sameday-before', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  const timing = evaluateOrderTiming(po, receipt);
  assert.equal(timing.blocked, true, 'a same-day purchase that actually preceded approval must be blocked, not silently accepted');
  assert.match(timing.reason, /even though both fall on the same calendar day/);
});

test('ROUND 3 #6: same calendar day with NO reliable time-of-day (midnight-only vendor date) is flagged unverified, not auto-approved', () => {
  const po = makeApprovedPo({}, { orderedAt: '2026-07-19T15:00:00Z' });
  // Midnight UTC is indistinguishable from "just a date, no real clock time".
  const receipt = { id: 'rct-sameday-midnight', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T00:00:00.000Z' };
  const timing = evaluateOrderTiming(po, receipt);
  assert.equal(timing.blocked, false);
  assert.equal(timing.requiresControllerReview, true, 'same-day with no authoritative time-of-day must require controller review, not pass silently');
  assert.match(timing.reason, /Same-day timing cannot be treated as verified/);
});

test('ROUND 3 #6: same calendar day WITH a genuine, later, non-midnight vendor timestamp after approval is correctly verified', () => {
  const po = makeApprovedPo({}, { orderedAt: '2026-07-19T09:00:00Z' }); // approved 9am
  const receipt = { id: 'rct-sameday-after', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T15:00:00Z' }; // purchased 3pm, same day
  const timing = evaluateOrderTiming(po, receipt);
  assert.equal(timing.blocked, false);
  assert.equal(timing.requiresControllerReview, false, 'a genuinely later same-day timestamp is real proof and needs no review');
});

test('BUG 2 FIX: a draft, unapproved PO cannot release actual costs into job costing', () => {
  const { purchaseOrder: draft } = createPurchaseOrder(basicInput(), requester);
  // Even if someone hand-crafts receivedAmount on a draft (bypassing matching), the gate still blocks it.
  const tampered = { ...draft, lines: draft.lines.map(l => ({ ...l, receivedAmount: 179, receivedQty: 2 })) };
  const feed = approvedActualCostsForJobCosting(tampered);
  assert.equal(feed.ready, false);
  assert.match(feed.reason, /draft, unapproved/);
});

test('BUG 2 FIX: an approved PO with a resolved (empty) exception list can release costs; one with exceptions cannot unless force-closed', () => {
  const po = makeApprovedPo({ lines: [{ type: 'material', estimatedQty: 2, estimatedUnitPrice: 89.5 }] });
  const receipt = { id: 'rct-4', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  const [clean] = matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 2, unitPrice: 89.5 }], approver);
  assert.equal(approvedActualCostsForJobCosting(clean).ready, true);

  const excessive = makeApprovedPo({ lines: [{ type: 'material', estimatedQty: 2, estimatedUnitPrice: 89.5 }] });
  const [flagged] = matchReceiptToPurchaseOrders([excessive], { id: 'rct-5', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' }, [{ poId: excessive.id, lineId: excessive.lines[0].id, receiptLineId: 'rl-1', quantity: 5, unitPrice: 200 }], approver);
  assert.equal(approvedActualCostsForJobCosting(flagged).ready, false);
  const closed = closePurchaseOrder(flagged, controller, { force: true, reason: 'Controller-reviewed, materials substitution approved verbally by owner.' });
  assert.equal(approvedActualCostsForJobCosting(closed).ready, true);
});

test('BUG 3 FIX: matching the identical receipt line twice (a replay/retry/double-click) does not double received quantity or amount', () => {
  const po = makeApprovedPo({ lines: [{ type: 'material', estimatedQty: 4, estimatedUnitPrice: 89.5 }] });
  const receipt = { id: 'rct-6', evidenceDocumentId: 'doc-6', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  const match = { poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 2, unitPrice: 89.5 };
  const [once] = matchReceiptToPurchaseOrders([po], receipt, [match], approver);
  const [twice] = matchReceiptToPurchaseOrders([once], receipt, [match], approver);
  assert.equal(once.lines[0].receivedQty, 2);
  assert.equal(twice.lines[0].receivedQty, 2, 'replaying the identical match must not double-count');
  assert.equal(twice.lines[0].receivedAmount, once.lines[0].receivedAmount);
});

test('BUG 3 FIX: a genuinely different match (different allocationId) on the same PO line is NOT treated as a replay', () => {
  const po = makeApprovedPo({ lines: [{ type: 'material', estimatedQty: 4, estimatedUnitPrice: 89.5 }] });
  const receipt = { id: 'rct-7', evidenceDocumentId: 'doc-7', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  const [first] = matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', allocationId: 'a', quantity: 2, unitPrice: 89.5 }], approver);
  const [second] = matchReceiptToPurchaseOrders([first], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-2', allocationId: 'b', quantity: 2, unitPrice: 89.5 }], approver);
  assert.equal(second.lines[0].receivedQty, 4);
});

test('BUG 4 FIX: numbering comes from a durable counter, never from counting an existing-orders array', () => {
  // No array of existing POs is even passed to this function anymore — proves it can't derive from one.
  const first = allocatePurchaseOrderNumber(undefined, { jobId: '231-004', companyId: 'ghgrp' });
  const second = allocatePurchaseOrderNumber(first.nextCounterState, { jobId: '231-004', companyId: 'ghgrp' });
  const third = allocatePurchaseOrderNumber(second.nextCounterState, { jobId: '231-004', companyId: 'ghgrp' });
  assert.equal(first.poNumber, 'PO-231-004-01');
  assert.equal(second.poNumber, 'PO-231-004-02');
  assert.equal(third.poNumber, 'PO-231-004-03');
});

test('BUG 4 FIX: a "gap" in a snapshot array (e.g. a cancelled PO filtered out elsewhere) cannot cause number reuse, because numbering never reads that array', () => {
  const step1 = allocatePurchaseOrderNumber(undefined, { jobId: '231-005', companyId: 'ghgrp' });
  const step2 = allocatePurchaseOrderNumber(step1.nextCounterState, { jobId: '231-005', companyId: 'ghgrp' });
  // Simulate: PO #1 gets cancelled/deleted and vanishes from whatever array a caller might have (irrelevant here).
  const step3 = allocatePurchaseOrderNumber(step2.nextCounterState, { jobId: '231-005', companyId: 'ghgrp' });
  assert.equal(step3.poNumber, 'PO-231-005-03', 'the counter must keep incrementing regardless of what happened to earlier POs');
});

test('BUG 4 FIX: general (non-job) purchases and job-scoped purchases use independent counters', () => {
  const jobAllocation = allocatePurchaseOrderNumber(undefined, { jobId: '231-004', companyId: 'ghgrp' });
  const generalAllocation = allocatePurchaseOrderNumber(jobAllocation.nextCounterState, { companyId: 'ghgrp' });
  assert.equal(generalAllocation.poNumber, 'PO-GEN-0001');
});

// ---------------------------------------------------------------------------
// Basic creation / validation / totals (carried forward)
// ---------------------------------------------------------------------------

test('a purchase order requires a company, a job or overhead category, a vendor, a requester, and at least one line', () => {
  const validation = validatePurchaseOrderInput({});
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(e => e.includes('company ID')));
  assert.ok(validation.errors.some(e => e.includes('job or an overhead category')));
  assert.ok(validation.errors.some(e => e.includes('vendor')));
  assert.ok(validation.errors.some(e => e.includes('requester')));
  assert.ok(validation.errors.some(e => e.includes('at least one line')));
});

test('estimated total sums lines and treats discounts as negative', () => {
  const { purchaseOrder: po } = createPurchaseOrder(basicInput({
    lines: [
      { type: 'material', estimatedQty: 2, estimatedUnitPrice: 89.5 },
      { type: 'delivery', estimatedQty: 1, estimatedUnitPrice: 25 },
      { type: 'discount', estimatedQty: 1, estimatedUnitPrice: 10 }
    ]
  }), requester);
  assert.equal(purchaseOrderEstimatedTotal(po), 89.5 * 2 + 25 - 10);
});

// ---------------------------------------------------------------------------
// Server-side actor authentication — never trust client-supplied identity
// ---------------------------------------------------------------------------

test('every mutating action requires a server-authenticated actor with an id and role', () => {
  assert.throws(() => assertActorAuthenticated(null), /authenticated actor/);
  assert.throws(() => assertActorAuthenticated({}), /authenticated actor/);
  assert.throws(() => assertActorAuthenticated({ id: 'x' }), /authenticated actor/);
  assert.throws(() => createPurchaseOrder(basicInput(), null), /authenticated actor/);
  const { purchaseOrder: po } = createPurchaseOrder(basicInput(), requester);
  assert.throws(() => approvePurchaseOrder(po, { id: 'nobody' }), /authenticated actor/);
});

test('the requester cannot approve their own purchase order even if they hold an approver role', () => {
  const requesterWhoIsAlsoAnApprover = { id: 'jeff', role: 'approver', companyId: 'ghgrp' };
  const { purchaseOrder: po } = createPurchaseOrder(basicInput(), requester);
  assert.throws(() => approvePurchaseOrder(po, requesterWhoIsAlsoAnApprover), /cannot approve their own/);
});

test('someone without an approver, controller, or bookkeeper role cannot approve at all', () => {
  const { purchaseOrder: po } = createPurchaseOrder(basicInput(), requester);
  assert.throws(() => approvePurchaseOrder(po, { id: 'someone-else', role: 'field', companyId: 'ghgrp' }), /Only an approver, controller, or bookkeeper/);
});

test('approval flips a planned PO from draft to ordered, sets orderedAt, and is recorded in history', () => {
  const { purchaseOrder: po } = createPurchaseOrder(basicInput(), requester, { now: '2026-07-17T09:00:00Z' });
  const approved = approvePurchaseOrder(po, approver, { now: '2026-07-18T09:00:00Z' });
  assert.equal(approved.lifecycleStatus, 'ordered');
  assert.equal(approved.status, 'ordered');
  assert.equal(approved.approverId, 'approver-1');
  assert.equal(approved.orderedAt, '2026-07-18T09:00:00Z');
  assert.equal(approved.history.length, 2);
  assert.equal(verifyPurchaseOrderHistory(approved).valid, true);
});

// ---------------------------------------------------------------------------
// CROSS-COMPANY / TENANT SCOPING (adversarial)
// ---------------------------------------------------------------------------

test('CROSS-COMPANY: an actor from a different company cannot approve a purchase order', () => {
  const { purchaseOrder: po } = createPurchaseOrder(basicInput(), requester);
  assert.throws(() => approvePurchaseOrder(po, otherCompanyApprover), /company boundary/);
});

test('CROSS-COMPANY: a receipt from a different company cannot be matched to a purchase order', () => {
  const po = makeApprovedPo();
  const foreignReceipt = { id: 'rct-x', companyId: 'other-co', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  assert.throws(
    () => matchReceiptToPurchaseOrders([po], foreignReceipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 1, unitPrice: 89.5 }], approver),
    /company boundary/
  );
});

test('CROSS-COMPANY: an actor from a different company cannot close or cancel a purchase order', () => {
  const po = makeApprovedPo();
  assert.throws(() => closePurchaseOrder(po, otherCompanyApprover), /company boundary/);
  assert.throws(() => cancelPurchaseOrder(po, otherCompanyApprover, 'test'), /company boundary/);
});

// ---------------------------------------------------------------------------
// ENFORCED STATE TRANSITIONS
// ---------------------------------------------------------------------------

test('STATE MACHINE: a draft PO cannot receive goods or match bills', () => {
  const { purchaseOrder: draft } = createPurchaseOrder(basicInput(), requester);
  const receipt = { id: 'rct-8', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  assert.throws(
    () => matchReceiptToPurchaseOrders([draft], receipt, [{ poId: draft.id, lineId: draft.lines[0].id, receiptLineId: 'rl-1', quantity: 1, unitPrice: 89.5 }], approver),
    /must be approved and ordered/
  );
});

test('STATE MACHINE: a cancelled PO rejects receiving, billing, approval, and closing', () => {
  const { purchaseOrder: draft } = createPurchaseOrder(basicInput(), requester);
  const cancelled = cancelPurchaseOrder(draft, approver, 'Job cancelled by customer.');
  assert.equal(cancelled.status, 'cancelled');
  assert.throws(() => approvePurchaseOrder(cancelled, approver), /cannot be approved again|status "cancelled"/);
  assert.throws(
    () => matchReceiptToPurchaseOrders([cancelled], { id: 'r', companyId: 'ghgrp' }, [{ poId: cancelled.id, lineId: cancelled.lines[0].id, receiptLineId: 'rl-1', quantity: 1, unitPrice: 1 }], approver),
    /cancelled and cannot receive/
  );
  assert.throws(() => closePurchaseOrder(cancelled, approver), /cancelled purchase order cannot be closed/);
  assert.throws(() => markBilled(cancelled, approver, 'bill-1'), /cannot be billed from status "cancelled"/);
});

test('STATE MACHINE: a closed PO rejects every further action', () => {
  const po = makeApprovedPo();
  const receipt = { id: 'rct-9', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  const [received] = matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 2, unitPrice: 89.5 }], approver);
  const closed = closePurchaseOrder(received, approver);
  assert.throws(() => closePurchaseOrder(closed, approver), /already closed/);
  assert.throws(() => cancelPurchaseOrder(closed, approver, 'too late'), /closed purchase order cannot be cancelled/);
  assert.throws(
    () => matchReceiptToPurchaseOrders([closed], { id: 'rct-10', companyId: 'ghgrp' }, [{ poId: closed.id, lineId: closed.lines[0].id, receiptLineId: 'rl-2', quantity: 1, unitPrice: 89.5 }], approver),
    /closed and cannot receive/
  );
});

test('STATE MACHINE: an already-approved (ordered) PO cannot be approved a second time', () => {
  const po = makeApprovedPo();
  assert.throws(() => approvePurchaseOrder(po, approver), /cannot be approved again/);
});

test('STATE MACHINE: rejecting a draft PO requires a reason and moves it straight to cancelled', () => {
  const { purchaseOrder: draft } = createPurchaseOrder(basicInput(), requester);
  assert.throws(() => rejectPurchaseOrder(draft, approver, ''), /reason is required/);
  const rejected = rejectPurchaseOrder(draft, approver, 'Not a valid business expense.');
  assert.equal(rejected.status, 'cancelled');
});

test('STATE MACHINE: only a draft PO can be revised; an approved PO requires a new PO instead', () => {
  const { purchaseOrder: draft } = createPurchaseOrder(basicInput(), requester);
  const revised = revisePurchaseOrder(draft, requester, { vendorName: 'Ferguson Supply' });
  assert.equal(revised.vendorName, 'Ferguson Supply');
  assert.equal(revised.poNumber, draft.poNumber, 'revision must not change the PO number');
  const approved = approvePurchaseOrder(revised, approver);
  assert.throws(() => revisePurchaseOrder(approved, requester, { vendorName: 'Someone Else' }), /Only a draft purchase order can be revised/);
});

// ---------------------------------------------------------------------------
// Round 3 correction #7 adversarial tests: revision forgery
// ---------------------------------------------------------------------------

test('ROUND 3 #7: revisePurchaseOrder rejects an attempt to forge lifecycle/approval/identity/audit fields through "changes"', () => {
  const { purchaseOrder: draft } = createPurchaseOrder(basicInput(), requester);
  const forgeryAttempts = [
    { lifecycleStatus: 'closed' },
    { approverId: 'someone-else', approvedAt: '2020-01-01T00:00:00Z' },
    { id: 'not-the-real-id' },
    { poNumber: 'PO-FAKE-01' },
    { companyId: 'other-co' },
    { requestedBy: 'someone-else-entirely' },
    { history: [] },
    { exceptions: [] },
    { appliedMatchKeys: ['forged'] },
    { receiptIds: ['forged-receipt'] },
    { billIds: ['forged-bill'] },
    { cancelled: true, cancelReason: 'forged' },
    { closedForced: true, closeOverrideReason: 'forged', closeOverrideBy: 'someone-else' },
    { orderType: 'after_the_fact' },
    { notPreapproved: false },
    { createdAt: '2020-01-01T00:00:00Z', createdBy: 'someone-else' }
  ];
  for (const attempt of forgeryAttempts) {
    assert.throws(
      () => revisePurchaseOrder(draft, requester, attempt),
      /cannot change/,
      `expected revisePurchaseOrder to reject forging ${Object.keys(attempt).join(',')}`
    );
  }
});

test('ROUND 3 #7: legitimate draft-only fields (vendor, job, lines, qbo vendor, after-the-fact reason) can still be revised', () => {
  const { purchaseOrder: draft } = createPurchaseOrder(basicInput(), requester);
  const revised = revisePurchaseOrder(draft, requester, {
    vendorName: 'Ferguson Supply',
    jobId: '231-999',
    qboVendorId: 'qbo-vendor-1',
    lines: [{ ...draft.lines[0], description: 'Updated description', estimatedQty: 5 }]
  });
  assert.equal(revised.vendorName, 'Ferguson Supply');
  assert.equal(revised.jobId, '231-999');
  assert.equal(revised.qboVendorId, 'qbo-vendor-1');
  assert.equal(revised.lines[0].description, 'Updated description');
  assert.equal(revised.lines[0].estimatedQty, 5);
  assert.equal(revised.lines[0].id, draft.lines[0].id, 'revising a line must preserve its original id');
});

test('ROUND 5: reproduces the reported bug -- a revision can no longer empty out the vendor, job, or every line', () => {
  const { purchaseOrder: draft } = createPurchaseOrder(basicInput(), requester);
  // Emptying the vendor with no jobId/overheadCategory change and no
  // qboVendorId leaves the PO with neither a vendor name nor a QBO vendor id.
  assert.throws(() => revisePurchaseOrder(draft, requester, { vendorName: '' }), /would make the purchase order invalid.*[Vv]endor/);
  // Clearing jobId with no overheadCategory set leaves the PO unassignable to any job or bucket.
  assert.throws(() => revisePurchaseOrder(draft, requester, { jobId: null }), /would make the purchase order invalid.*job or an overhead category/);
  // Emptying every line.
  assert.throws(() => revisePurchaseOrder(draft, requester, { lines: [] }), /would make the purchase order invalid.*at least one line/);
});

// ---------------------------------------------------------------------------
// Round 3 correction #8: history chain verified before every mutation
// ---------------------------------------------------------------------------

test('ROUND 3 #8: a tampered history record (e.g. edited by a direct database write) blocks every further mutation', () => {
  const { purchaseOrder: draft } = createPurchaseOrder(basicInput(), requester);
  // Simulate exactly the kind of tampering the review is worried about: a
  // history record's recorded detail is edited directly (bypassing
  // appendHistory entirely, e.g. a raw database UPDATE), leaving the hash
  // chain internally inconsistent.
  const tampered = { ...draft, history: [{ ...draft.history[0], detail: { poNumber: 'FORGED-NUMBER' } }] };
  assert.equal(verifyPurchaseOrderHistory(tampered).valid, false, 'sanity check: the tampered PO must actually fail verification');

  assert.throws(() => approvePurchaseOrder(tampered, approver), /history chain has been tampered/);
  assert.throws(() => revisePurchaseOrder(tampered, requester, { vendorName: 'New Vendor' }), /history chain has been tampered/);
  assert.throws(() => rejectPurchaseOrder(tampered, approver, 'no'), /history chain has been tampered/);

  const tamperedApproved = { ...approvePurchaseOrder(draft, approver) };
  const tamperedApprovedBroken = { ...tamperedApproved, history: tamperedApproved.history.map((r, i) => i === 0 ? { ...r, detail: { forged: true } } : r) };
  assert.throws(() => markBilled(tamperedApprovedBroken, approver, 'bill-1'), /history chain has been tampered/);
  assert.throws(() => closePurchaseOrder(tamperedApprovedBroken, controller, { force: true, reason: 'x' }), /history chain has been tampered/);
  assert.throws(() => cancelPurchaseOrder(tamperedApprovedBroken, controller, 'no'), /history chain has been tampered/);

  const receipt = { id: 'rct-tamper', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  assert.throws(
    () => matchReceiptToPurchaseOrders([tamperedApprovedBroken], receipt, [{ poId: tamperedApprovedBroken.id, lineId: tamperedApprovedBroken.lines[0].id, receiptLineId: 'rl-1', quantity: 2, unitPrice: 89.5 }], approver),
    /history chain has been tampered/
  );
});

test('ROUND 3 #8: in a multi-PO match batch, ONE tampered PO blocks the whole batch, not just itself', () => {
  const poA = makeApprovedPo({ jobId: '231-004' });
  const poB = approvePurchaseOrder(createPurchaseOrder(basicInput({ jobId: '231-005' }), requester, { now: '2026-07-17T09:00:00Z' }).purchaseOrder, approver, { now: '2026-07-18T09:00:00Z' });
  const tamperedB = { ...poB, history: poB.history.map((r, i) => i === 0 ? { ...r, detail: { forged: true } } : r) };
  const receipt = { id: 'rct-tamper-batch', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  assert.throws(
    () => matchReceiptToPurchaseOrders([poA, tamperedB], receipt, [
      { poId: poA.id, lineId: poA.lines[0].id, receiptLineId: 'rl-1', quantity: 2, unitPrice: 89.5 }
    ], approver),
    /history chain has been tampered/,
    'a tampered PO anywhere in the batch must block the whole call, even if no match in this request touches it directly'
  );
});

// ---------------------------------------------------------------------------
// ROUND 5 adversarial tests: permissions + void/reversal
// ---------------------------------------------------------------------------

test('ROUND 5: reproduces the reported bug -- a field/crew user cancelling a billed PO used to make its cost vanish from job costing', () => {
  const { purchaseOrder: draft } = createPurchaseOrder(basicInput(), requester);
  const ordered = approvePurchaseOrder(draft, approver, { now: '2026-07-17T09:00:00Z' });
  const [received] = matchReceiptToPurchaseOrders([ordered], { id: 'rct-r5', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' }, [
    { poId: ordered.id, lineId: ordered.lines[0].id, receiptLineId: 'rl-1', quantity: 2, unitPrice: 89.5 }
  ], approver);
  const billed = markBilled(received, approver, 'bill-r5');
  assert.equal(billed.lifecycleStatus, 'billed');

  // A field/crew user must NOT be able to cancel a billed PO at all.
  assert.throws(() => cancelPurchaseOrder(billed, requester, 'nope'), /already has received or billed activity/);
  // Not even a controller can plain-cancel it -- posted activity must go through void instead.
  assert.throws(() => cancelPurchaseOrder(billed, controller, 'nope'), /already has received or billed activity/);

  const feedBefore = approvedActualCostsForJobCosting(billed);
  assert.equal(feedBefore.total, 179, 'the real cost must be visible before any void');

  // The only legitimate path: a controller voids it, with a reason, and the
  // ORIGINAL cost stays fully visible alongside an equal-and-opposite reversal.
  assert.throws(() => voidPostedPurchaseOrder(billed, requester, 'not a controller'), /Only a controller can void/);
  const voided = voidPostedPurchaseOrder(billed, controller, 'Billed in error -- duplicate of PO-231-02.');
  const feedAfter = approvedActualCostsForJobCosting(voided);
  assert.equal(feedAfter.total, 0, 'net effect of a void must be zero, not silence');
  assert.equal(feedAfter.lines.length, 2, 'both the original charge and its reversal must remain visible');
  assert.ok(feedAfter.lines.some(l => l.amount === 179), 'the original $179 charge must still be visible');
  assert.ok(feedAfter.lines.some(l => l.amount === -179 && l.reversalOf), 'an equal-and-opposite reversal must be recorded, referencing the original line');
});

test('ROUND 5: markBilled and closePurchaseOrder require approver/controller/bookkeeper -- a field/crew user is rejected', () => {
  const { purchaseOrder: draft } = createPurchaseOrder(basicInput(), requester);
  const ordered = approvePurchaseOrder(draft, approver, { now: '2026-07-17T09:00:00Z' });
  const [received] = matchReceiptToPurchaseOrders([ordered], { id: 'rct-r5b', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' }, [
    { poId: ordered.id, lineId: ordered.lines[0].id, receiptLineId: 'rl-1', quantity: 2, unitPrice: 89.5 }
  ], approver);
  assert.throws(() => markBilled(received, requester, 'bill-x'), /Only an approver, controller, or bookkeeper can mark/);
  assert.throws(() => closePurchaseOrder(received, requester), /Only an approver, controller, or bookkeeper can close/);
  // bookkeeper is allowed for both (matches the approve/reject role set).
  const billed = markBilled(received, bookkeeper, 'bill-y');
  assert.equal(billed.lifecycleStatus, 'billed');
});

test('ROUND 5: a field/crew user can cancel their OWN draft/ordered PO with no posted activity, but not someone else\'s', () => {
  const { purchaseOrder: draft } = createPurchaseOrder(basicInput(), requester);
  assert.throws(() => cancelPurchaseOrder(draft, otherFieldUser, 'not mine'), /Only the original requester, an approver, a controller, or a bookkeeper/);
  const cancelled = cancelPurchaseOrder(draft, requester, 'Changed my mind before approval.');
  assert.equal(cancelled.status, 'cancelled');
});

test('ROUND 5: voidPostedPurchaseOrder requires a reason and refuses a PO with no posted activity', () => {
  const { purchaseOrder: draft } = createPurchaseOrder(basicInput(), requester);
  const ordered = approvePurchaseOrder(draft, approver);
  assert.throws(() => voidPostedPurchaseOrder(ordered, controller, ''), /written reason is required/);
  assert.throws(() => voidPostedPurchaseOrder(ordered, controller, 'no activity yet'), /has no received or billed activity yet/);
});

test('ROUND 5: reproduces the reported bug -- negative quantity/price can no longer produce a "fully received" PO with negative receivedQty', () => {
  const po = makeApprovedPo({ lines: [{ type: 'material', estimatedQty: 2, estimatedUnitPrice: 89.5 }] });
  const receipt = { id: 'rct-neg', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  assert.throws(
    () => matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: -1, unitPrice: 89.5 }], approver),
    /invalid quantity/
  );
  assert.throws(
    () => matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 1, unitPrice: -50 }], approver),
    /invalid unit price/
  );
  assert.throws(
    () => matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: Infinity, unitPrice: 1 }], approver),
    /invalid quantity/
  );
  assert.throws(
    () => matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 1, unitPrice: 1, splitPortion: -1 }], approver),
    /invalid splitPortion/
  );
  assert.throws(
    () => matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 1, unitPrice: 1, splitPortion: 1.5 }], approver),
    /invalid splitPortion/
  );
  // A legitimate, positive match still works.
  const [ok] = matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 2, unitPrice: 89.5 }], approver);
  assert.equal(ok.lines[0].receivedQty, 2);
});

// ---------------------------------------------------------------------------
// SPLIT VALIDATION AND RECONCILIATION
// ---------------------------------------------------------------------------

test('SPLITS: splits for one receipt line must total exactly 100%', () => {
  const poA = makeApprovedPo({ jobId: '231-004' });
  const poB = approvePurchaseOrder(createPurchaseOrder(basicInput({ jobId: '231-005' }), requester, { now: '2026-07-17T09:00:00Z' }).purchaseOrder, approver, { now: '2026-07-18T09:00:00Z' });
  const receipt = { id: 'rct-split', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  assert.throws(
    () => matchReceiptToPurchaseOrders([poA, poB], receipt, [
      { poId: poA.id, lineId: poA.lines[0].id, receiptLineId: 'rl-1', splitPortion: 0.5, quantity: 1, unitPrice: 89.5 },
      { poId: poB.id, lineId: poB.lines[0].id, receiptLineId: 'rl-1', splitPortion: 0.3, quantity: 1, unitPrice: 89.5 }
    ], approver),
    /must total exactly 100%/
  );
});

test('SPLITS: splits totaling exactly 100% across two jobs succeed and each PO gets its correct share', () => {
  const poA = makeApprovedPo({ jobId: '231-004' });
  const poB = approvePurchaseOrder(createPurchaseOrder(basicInput({ jobId: '231-005' }), requester, { now: '2026-07-17T09:00:00Z' }).purchaseOrder, approver, { now: '2026-07-18T09:00:00Z' });
  const receipt = { id: 'rct-split-2', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  const updated = matchReceiptToPurchaseOrders([poA, poB], receipt, [
    { poId: poA.id, lineId: poA.lines[0].id, receiptLineId: 'rl-2', splitPortion: 0.6, quantity: 2, unitPrice: 89.5 },
    { poId: poB.id, lineId: poB.lines[0].id, receiptLineId: 'rl-2', splitPortion: 0.4, quantity: 2, unitPrice: 89.5 }
  ], approver);
  const a = updated.find(po => po.id === poA.id), b = updated.find(po => po.id === poB.id);
  assert.equal(a.lines[0].receivedQty, 1.2);
  assert.equal(b.lines[0].receivedQty, 0.8);
});

test('SPLITS: matched amounts must reconcile exactly to the receipt line total when the receipt carries lines', () => {
  const po = makeApprovedPo({ lines: [{ type: 'material', estimatedQty: 2, estimatedUnitPrice: 89.5 }] });
  const receipt = { id: 'rct-recon', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z', lines: [{ id: 'rl-recon', amount: 179 }] };
  assert.throws(
    () => matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-recon', quantity: 1, unitPrice: 89.5 }], approver),
    /must reconcile exactly to the receipt line amount/
  );
  const [ok] = matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-recon', quantity: 2, unitPrice: 89.5 }], approver);
  assert.equal(ok.lines[0].receivedAmount, 179);
});

// Round 3 correction #3 adversarial test: a genuine valid 60/40 split across
// TWO DIFFERENT purchase orders, where the receipt actually carries a line
// with a real dollar amount, must reconcile correctly by applying each
// match's splitPortion -- not by summing each match's full (un-split)
// quantity*unitPrice, which would double-count the line and always throw.
test('SPLITS: a valid 60/40 split across two different purchase orders reconciles correctly against the receipt line amount', () => {
  const poA = makeApprovedPo({ jobId: '231-004', lines: [{ type: 'material', estimatedQty: 2, estimatedUnitPrice: 89.5 }] });
  const poB = approvePurchaseOrder(createPurchaseOrder(basicInput({ jobId: '231-005', lines: [{ type: 'material', estimatedQty: 2, estimatedUnitPrice: 89.5 }] }), requester, { now: '2026-07-17T09:00:00Z' }).purchaseOrder, approver, { now: '2026-07-18T09:00:00Z' });
  const receipt = { id: 'rct-6040', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z', lines: [{ id: 'rl-6040', amount: 179 }] };
  const updated = matchReceiptToPurchaseOrders([poA, poB], receipt, [
    { poId: poA.id, lineId: poA.lines[0].id, receiptLineId: 'rl-6040', splitPortion: 0.6, quantity: 2, unitPrice: 89.5 },
    { poId: poB.id, lineId: poB.lines[0].id, receiptLineId: 'rl-6040', splitPortion: 0.4, quantity: 2, unitPrice: 89.5 }
  ], approver);
  const a = updated.find(po => po.id === poA.id), b = updated.find(po => po.id === poB.id);
  assert.equal(a.lines[0].receivedAmount, 107.4, '60% of $179');
  assert.equal(b.lines[0].receivedAmount, 71.6, '40% of $179');
  assert.equal(Math.round((a.lines[0].receivedAmount + b.lines[0].receivedAmount) * 100) / 100, 179, 'the two shares must sum back to the full receipt line amount');
});

// ---------------------------------------------------------------------------
// WEIGHTED ACTUAL UNIT PRICE (not last-write-wins)
// ---------------------------------------------------------------------------

test('WEIGHTED PRICE: actual unit price is a quantity-weighted average across all applied matches, not just the latest', () => {
  const po = makeApprovedPo({ lines: [{ type: 'material', estimatedQty: 10, estimatedUnitPrice: 90 }] });
  const receipt1 = { id: 'rct-w1', evidenceDocumentId: 'doc-w1', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  const receipt2 = { id: 'rct-w2', evidenceDocumentId: 'doc-w2', companyId: 'ghgrp', vendorTransactionDate: '2026-07-20T09:00:00Z' };
  const [afterFirst] = matchReceiptToPurchaseOrders([po], receipt1, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 6, unitPrice: 90 }], approver);
  const [afterSecond] = matchReceiptToPurchaseOrders([afterFirst], receipt2, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 4, unitPrice: 100 }], approver);
  // Weighted: (6*90 + 4*100) / 10 = 94, NOT 100 (which last-write-wins would have produced).
  assert.equal(afterSecond.lines[0].actualUnitPrice, 94);
});

// ---------------------------------------------------------------------------
// EXCEPTIONS — percent AND dollar tolerance, duplicate bills, missing receipt
// ---------------------------------------------------------------------------

test('TOLERANCE: a small-dollar item with a large percent variance is not flagged (below the dollar threshold)', () => {
  const po = makeApprovedPo({ lines: [{ type: 'material', estimatedQty: 1, estimatedUnitPrice: 4 }] });
  const receipt = { id: 'rct-tol-1', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  const [updated] = matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 1, unitPrice: 4.8 }], approver); // 20% over, but only $0.80
  assert.ok(!updated.exceptions.includes('excess_price'));
});

test('TOLERANCE: a large-dollar item with the same percent variance IS flagged (exceeds the dollar threshold)', () => {
  const po = makeApprovedPo({ lines: [{ type: 'material', estimatedQty: 10, estimatedUnitPrice: 400 }] });
  const receipt = { id: 'rct-tol-2', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  const [updated] = matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 10, unitPrice: 480 }], approver); // 20% over, $800 impact
  assert.ok(updated.exceptions.includes('excess_price'));
});

test('EXCEPTIONS: excess quantity beyond percent tolerance is flagged', () => {
  const po = makeApprovedPo({ lines: [{ type: 'material', estimatedQty: 2, estimatedUnitPrice: 89.5 }] });
  const receipt = { id: 'rct-11', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  const [updated] = matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 3, unitPrice: 89.5 }], approver);
  assert.ok(updated.exceptions.includes('excess_quantity'));
  assert.equal(updated.status, 'exception');
});

test('DUPLICATE BILL: normalized matching on company, vendor identity, invoice number, currency, and amount', () => {
  const po = makeApprovedPo();
  const flags = detectExceptions(po, {
    receipt: { qboVendorId: 'qbo-vendor-9', invoiceNumber: 'INV-100', amount: 179, currency: 'USD' },
    existingBills: [{ companyId: 'ghgrp', qboVendorId: 'qbo-vendor-9', invoiceNumber: 'INV-100', amount: 179, currency: 'USD' }]
  });
  assert.ok(flags.includes('duplicate_bill'));
});

test('DUPLICATE BILL: a same-invoice-number bill from a DIFFERENT company is not flagged (tenant isolation in duplicate detection)', () => {
  const po = makeApprovedPo();
  const flags = detectExceptions(po, {
    receipt: { qboVendorId: 'qbo-vendor-9', invoiceNumber: 'INV-100', amount: 179, currency: 'USD' },
    existingBills: [{ companyId: 'other-co', qboVendorId: 'qbo-vendor-9', invoiceNumber: 'INV-100', amount: 179, currency: 'USD' }]
  });
  assert.ok(!flags.includes('duplicate_bill'));
});

test('DUPLICATE BILL: same invoice number but different currency or amount is not flagged', () => {
  const po = makeApprovedPo();
  const flagsDiffCurrency = detectExceptions(po, {
    receipt: { qboVendorId: 'v', invoiceNumber: 'INV-1', amount: 100, currency: 'CAD' },
    existingBills: [{ companyId: 'ghgrp', qboVendorId: 'v', invoiceNumber: 'INV-1', amount: 100, currency: 'USD' }]
  });
  assert.ok(!flagsDiffCurrency.includes('duplicate_bill'));
});

test('OVERBILLING: billing without any receipt attached is flagged missing_receipt', () => {
  const po = makeApprovedPo();
  const billed = markBilled(po, approver, 'bill-1');
  assert.ok(billed.exceptions.includes('missing_receipt'));
  assert.equal(billed.status, 'exception');
});

test('markBilled enforces valid source states and requires a bill id', () => {
  const { purchaseOrder: draft } = createPurchaseOrder(basicInput(), requester);
  assert.throws(() => markBilled(draft, approver, 'bill-1'), /cannot be billed from status "draft"/);
  const po = makeApprovedPo();
  assert.throws(() => markBilled(po, approver, ''), /bill ID is required/);
});

// ---------------------------------------------------------------------------
// FORCED CLOSE — controller-only, written reason required, audit-preserved
// ---------------------------------------------------------------------------

test('FORCED CLOSE: cannot close with unresolved exceptions without forcing', () => {
  const po = makeApprovedPo({ lines: [{ type: 'material', estimatedQty: 2, estimatedUnitPrice: 89.5 }] });
  const receipt = { id: 'rct-fc-1', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  const [flagged] = matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 5, unitPrice: 200 }], approver);
  assert.throws(() => closePurchaseOrder(flagged, approver), /unresolved exceptions/);
});

test('FORCED CLOSE: only a controller can force-close, and a written reason is required', () => {
  const po = makeApprovedPo({ lines: [{ type: 'material', estimatedQty: 2, estimatedUnitPrice: 89.5 }] });
  const receipt = { id: 'rct-fc-2', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  const [flagged] = matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 5, unitPrice: 200 }], approver);
  assert.throws(() => closePurchaseOrder(flagged, approver, { force: true, reason: 'x' }), /Only a controller can force-close/);
  assert.throws(() => closePurchaseOrder(flagged, controller, { force: true }), /written reason is required/);
  const closed = closePurchaseOrder(flagged, controller, { force: true, reason: 'Owner verbally approved the substitution; documented in job notes.' });
  assert.equal(closed.status, 'closed');
  const lastEvent = closed.history.at(-1);
  assert.equal(lastEvent.type, 'closed');
  assert.equal(lastEvent.detail.forced, true);
  assert.deepEqual(lastEvent.detail.unresolvedExceptionsAtClose, ['excess_quantity', 'excess_price']);
  assert.equal(verifyPurchaseOrderHistory(closed).valid, true);
});

// ---------------------------------------------------------------------------
// AFTER-THE-FACT: immutable notPreapproved, separate from resolvable exceptions
// ---------------------------------------------------------------------------

test('AFTER-THE-FACT: requires a reason, is flagged notPreapproved permanently, and always requires approval', () => {
  assert.throws(() => createPurchaseOrder(basicInput({ orderType: 'after_the_fact' }), requester), /requires a reason/);
  const { purchaseOrder: po } = createPurchaseOrder(basicInput({ orderType: 'after_the_fact', afterTheFactReason: 'Emergency parts run, no PO existed beforehand.' }), requester);
  assert.equal(po.notPreapproved, true);
  assert.equal(po.exceptions.length, 0, 'notPreapproved must not live in the resolvable exceptions array');
  assert.equal(requiresApproval(po, {}), true);
});

test('AFTER-THE-FACT: once approved, it can progress normally through receiving/billing/closing while notPreapproved stays true forever', () => {
  const { purchaseOrder: draft } = createPurchaseOrder(basicInput({ orderType: 'after_the_fact', afterTheFactReason: 'Truck broke down, bought a part on the way to the job.' }), requester, { now: '2026-07-17T09:00:00Z' });
  const approved = approvePurchaseOrder(draft, approver, { now: '2026-07-18T09:00:00Z' });
  assert.equal(approved.status, 'ordered', 'an approved after-the-fact PO must be able to progress like any other, not get stuck displaying "exception" forever');
  const receipt = { id: 'rct-atf', companyId: 'ghgrp', vendorTransactionDate: '2026-07-18T12:00:00Z' };
  const [received] = matchReceiptToPurchaseOrders([approved], receipt, [{ poId: approved.id, lineId: approved.lines[0].id, receiptLineId: 'rl-1', quantity: 2, unitPrice: 89.5 }], approver);
  assert.equal(received.status, 'fully_received');
  const closed = closePurchaseOrder(received, approver);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.notPreapproved, true, 'notPreapproved must never clear, even once approved/closed');
  const feed = approvedActualCostsForJobCosting(closed);
  assert.equal(feed.ready, true);
  assert.equal(feed.lines[0].notPreapproved, true, 'the job-costing feed must carry the not-preapproved flag through, permanently');
});

test('AFTER-THE-FACT: order type is immutable and can never be silently upgraded to planned', () => {
  const { purchaseOrder: po } = createPurchaseOrder(basicInput({ orderType: 'after_the_fact', afterTheFactReason: 'Field emergency.' }), requester);
  assert.throws(() => assertOrderTypeImmutable(po, 'planned'), /cannot be changed after creation/);
});

// ---------------------------------------------------------------------------
// QBO PREVIEW — schema-aware, reports incompleteness rather than fabricating
// ---------------------------------------------------------------------------

test('QBO PREVIEW: reports itself incomplete when no QBO vendor or item/account mapping exists, rather than emitting a payload QBO would reject', () => {
  const { purchaseOrder: po } = createPurchaseOrder(basicInput(), requester);
  const preview = toQboPurchaseOrderPreview(po);
  assert.equal(preview.incomplete, true);
  assert.ok(preview.missingFields.some(f => f.includes('qboVendorId')));
  assert.ok(preview.missingFields.some(f => f.includes('qboAccountId')));
});

test('QBO PREVIEW: DocNumber respects the 21-character QBO limit', () => {
  const { purchaseOrder: po } = createPurchaseOrder(basicInput({ poNumber: 'PO-A-VERY-LONG-JOB-NUMBER-THAT-EXCEEDS-LIMITS-001' }), requester);
  const preview = toQboPurchaseOrderPreview(po);
  assert.ok(preview.DocNumber.length <= 21);
});

test('QBO PREVIEW: a fully mapped line uses ItemBasedExpenseLineDetail; an unmapped line falls back to AccountBasedExpenseLineDetail and is complete when an account is present', () => {
  const { purchaseOrder: po } = createPurchaseOrder(basicInput({
    qboVendorId: 'qbo-v-1',
    lines: [{ type: 'material', estimatedQty: 1, estimatedUnitPrice: 50, qboItemId: 'item-1' }, { type: 'delivery', estimatedQty: 1, estimatedUnitPrice: 25, qboAccountId: 'acct-1' }]
  }), requester);
  const preview = toQboPurchaseOrderPreview(po);
  assert.equal(preview.incomplete, false);
  assert.equal(preview.Line[0].DetailType, 'ItemBasedExpenseLineDetail');
  assert.equal(preview.Line[1].DetailType, 'AccountBasedExpenseLineDetail');
});

test('QBO PREVIEW: marks after-the-fact purchases in the private note', () => {
  const { purchaseOrder: po } = createPurchaseOrder(basicInput({ orderType: 'after_the_fact', afterTheFactReason: 'Field emergency, no PO existed.' }), requester);
  const preview = toQboPurchaseOrderPreview(po);
  assert.match(preview.PrivateNote, /AFTER-THE-FACT PURCHASE — not preapproved/);
});

// ---------------------------------------------------------------------------
// TAX AND DISCOUNT LINES
// ---------------------------------------------------------------------------

test('TAX: a tax line that is not marked taxable but receives an amount is flagged unexpected_tax', () => {
  const { purchaseOrder: draft } = createPurchaseOrder(basicInput({
    lines: [{ type: 'material', estimatedQty: 1, estimatedUnitPrice: 100 }, { type: 'tax', estimatedQty: 1, estimatedUnitPrice: 0, taxable: false }]
  }), requester, { now: '2026-07-17T09:00:00Z' });
  const po = approvePurchaseOrder(draft, approver, { now: '2026-07-18T09:00:00Z' });
  const receipt = { id: 'rct-tax', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  const [updated] = matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[1].id, receiptLineId: 'rl-tax', quantity: 1, unitPrice: 7 }], approver);
  assert.ok(updated.exceptions.includes('unexpected_tax'));
});

test('DISCOUNT: a discount line reduces the estimated total and does not itself trigger variance exceptions', () => {
  const { purchaseOrder: po } = createPurchaseOrder(basicInput({
    lines: [{ type: 'material', estimatedQty: 1, estimatedUnitPrice: 100 }, { type: 'discount', estimatedQty: 1, estimatedUnitPrice: 15 }]
  }), requester);
  assert.equal(purchaseOrderEstimatedTotal(po), 85);
});

// ---------------------------------------------------------------------------
// PARTIAL RECEIVING AND CORRECTIONS
// ---------------------------------------------------------------------------

test('PARTIAL RECEIVING: a PO moves from ordered to partially_received to fully_received across multiple deliveries', () => {
  const po = makeApprovedPo({ lines: [{ type: 'material', estimatedQty: 10, estimatedUnitPrice: 20 }] });
  const receipt1 = { id: 'rct-p1', evidenceDocumentId: 'doc-p1', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  const [partial] = matchReceiptToPurchaseOrders([po], receipt1, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 4, unitPrice: 20 }], approver);
  assert.equal(partial.status, 'partially_received');
  const receipt2 = { id: 'rct-p2', evidenceDocumentId: 'doc-p2', companyId: 'ghgrp', vendorTransactionDate: '2026-07-20T09:00:00Z' };
  const [full] = matchReceiptToPurchaseOrders([partial], receipt2, [{ poId: partial.id, lineId: partial.lines[0].id, receiptLineId: 'rl-1', quantity: 6, unitPrice: 20 }], approver);
  assert.equal(full.status, 'fully_received');
});

test('CORRECTIONS: history is append-only and hash-chained across a full life cycle including a forced-close correction', () => {
  const po = makeApprovedPo({ lines: [{ type: 'material', estimatedQty: 2, estimatedUnitPrice: 89.5 }] });
  const receipt = { id: 'rct-corr', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  const [received] = matchReceiptToPurchaseOrders([po], receipt, [{ poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-1', quantity: 3, unitPrice: 89.5 }], approver);
  const closed = closePurchaseOrder(received, controller, { force: true, reason: 'Reviewed and accepted overage.' });
  assert.equal(verifyPurchaseOrderHistory(closed).valid, true);
  assert.ok(closed.history.length >= 3);
  assert.equal(closed.history[0].type, 'created');
});

test('CANCELLATION: requires a reason and is recorded in an untampered history', () => {
  const { purchaseOrder: po } = createPurchaseOrder(basicInput(), requester);
  assert.throws(() => cancelPurchaseOrder(po, approver, ''), /reason is required/);
  const cancelled = cancelPurchaseOrder(po, approver, 'Job was cancelled by the customer.');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.history.at(-1).type, 'cancelled');
  assert.equal(verifyPurchaseOrderHistory(cancelled).valid, true);
});

test('CONCURRENCY-STYLE: two independent matches against two different lines of the same PO both apply cleanly', () => {
  const { purchaseOrder: draft } = createPurchaseOrder(basicInput({
    lines: [{ type: 'material', estimatedQty: 2, estimatedUnitPrice: 50 }, { type: 'delivery', estimatedQty: 1, estimatedUnitPrice: 25 }]
  }), requester, { now: '2026-07-17T09:00:00Z' });
  const po = approvePurchaseOrder(draft, approver, { now: '2026-07-18T09:00:00Z' });
  const receipt = { id: 'rct-conc', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  const updated = matchReceiptToPurchaseOrders([po], receipt, [
    { poId: po.id, lineId: po.lines[0].id, receiptLineId: 'rl-material', quantity: 2, unitPrice: 50 },
    { poId: po.id, lineId: po.lines[1].id, receiptLineId: 'rl-delivery', quantity: 1, unitPrice: 25 }
  ], approver);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].status, 'fully_received');
});

test('one receipt can still cover multiple purchase orders and one purchase order can still receive multiple receipts', () => {
  const poA = makeApprovedPo({ jobId: '231-004' });
  const poB = approvePurchaseOrder(createPurchaseOrder(basicInput({ jobId: '231-005' }), requester, { now: '2026-07-17T09:00:00Z' }).purchaseOrder, approver, { now: '2026-07-18T09:00:00Z' });
  const receipt = { id: 'rct-shared', companyId: 'ghgrp', vendorTransactionDate: '2026-07-19T09:00:00Z' };
  const updated = matchReceiptToPurchaseOrders([poA, poB], receipt, [
    { poId: poA.id, lineId: poA.lines[0].id, receiptLineId: 'rl-a', quantity: 1, unitPrice: 40 },
    { poId: poB.id, lineId: poB.lines[0].id, receiptLineId: 'rl-b', quantity: 1, unitPrice: 49.5 }
  ], approver);
  assert.equal(updated.length, 2);
  assert.ok(updated.every(po => po.receiptIds.includes('rct-shared')));

  const secondReceipt = { id: 'rct-second', companyId: 'ghgrp', vendorTransactionDate: '2026-07-21T09:00:00Z' };
  const [poAAgain] = matchReceiptToPurchaseOrders([updated[0]], secondReceipt, [{ poId: updated[0].id, lineId: updated[0].lines[0].id, receiptLineId: 'rl-a2', quantity: 1, unitPrice: 40 }], approver);
  assert.equal(poAAgain.receiptIds.length, 2);
});
