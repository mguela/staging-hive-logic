import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateChangeOrderNumber, createChangeOrder, validateChangeOrderInput, changeOrderTotals,
  sendChangeOrder, recordApproval, recordPayment, convertToChangeOrderJob, cancelChangeOrder,
  withComputedStatus, changeOrderProfitabilityForJob, changeOrderDrilldown,
  assertActorAuthenticated, assertSameCompany, CO_KINDS, CO_LIFECYCLE_STATES
} from '../src/change-orders.js';

const field = { id: 'jeff', role: 'field', companyId: 'ghgrp' };
const controller = { id: 'controller-1', role: 'controller', companyId: 'ghgrp' };
const otherCompanyField = { id: 'intruder', role: 'field', companyId: 'other-co' };

function estimateInput(overrides = {}) {
  return {
    companyId: 'ghgrp', jobId: '231-004', kind: 'estimate', requestedBy: 'jeff',
    description: 'Additional electrical outlet installation in master bedroom per client request.',
    reasonCategory: 'client_request',
    lines: [
      { type: 'material', description: 'Receptacle outlet + weatherproof box', qty: 2, unitCost: 87.5, pmode: 'markup', markupPct: 0 },
      { type: 'labor', description: 'Electrical labor (2 hours)', qty: 2, unitCost: 95, pmode: 'markup', markupPct: 0 }
    ],
    ...overrides
  };
}

function invoiceInput(overrides = {}) {
  return estimateInput({ kind: 'invoice', ...overrides });
}

function makeEstimate(overrides = {}) {
  return createChangeOrder(estimateInput(overrides), field, { now: '2026-07-14T09:00:00Z' }).changeOrder;
}

// ---------------------------------------------------------------------------
// Numbering — chained to the job, durable counter, never derived by counting
// ---------------------------------------------------------------------------

test('numbering is chained to the job and comes from a durable counter, mirroring CO-231-004-01', () => {
  const first = allocateChangeOrderNumber(undefined, { jobId: '231-004', companyId: 'ghgrp' });
  const second = allocateChangeOrderNumber(first.nextCounterState, { jobId: '231-004', companyId: 'ghgrp' });
  assert.equal(first.coNumber, 'CO-231-004-01');
  assert.equal(second.coNumber, 'CO-231-004-02');
});

test('numbering requires a jobId — a change order can never be created unchained from a job', () => {
  assert.throws(() => allocateChangeOrderNumber(undefined, { companyId: 'ghgrp' }), /chained to a job/);
});

test('different jobs get independent counters', () => {
  const a = allocateChangeOrderNumber(undefined, { jobId: '231-004', companyId: 'ghgrp' });
  const b = allocateChangeOrderNumber(a.nextCounterState, { jobId: '231-005', companyId: 'ghgrp' });
  assert.equal(b.coNumber, 'CO-231-005-01');
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('validation requires company, job, kind, requester, description, and at least one line', () => {
  const result = validateChangeOrderInput({});
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => /company/i.test(e)));
  assert.ok(result.errors.some(e => /job/i.test(e)));
  assert.ok(result.errors.some(e => /kind/i.test(e)));
});

test('kind must be estimate or invoice — the toggle Chris asked for', () => {
  assert.deepEqual(CO_KINDS, ['estimate', 'invoice']);
  const result = validateChangeOrderInput({ ...estimateInput(), kind: 'something_else' });
  assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------------
// Creation & totals — same shape/math as the Estimate Builder's line items
// ---------------------------------------------------------------------------

test('creating an estimate-kind CO starts in draft, is not auto-approved, and computes totals from its lines', () => {
  const co = makeEstimate();
  assert.equal(co.lifecycleStatus, 'draft');
  assert.equal(co.autoApproved, false);
  const totals = changeOrderTotals(co);
  // cost: (2*87.5) + (2*95) = 175 + 190 = 365; markupPct 0 on both lines -> price === cost
  assert.equal(totals.cost, 365);
  assert.equal(totals.price, 365);
});

test('creating an invoice-kind CO is permanently auto-approved and flagged as such, never confused with a real client approval', () => {
  const { changeOrder: co } = createChangeOrder(invoiceInput(), field, { now: '2026-07-14T09:00:00Z' });
  assert.equal(co.kind, 'invoice');
  assert.equal(co.autoApproved, true);
  assert.equal(co.lifecycleStatus, 'draft'); // still starts draft; sendChangeOrder is what moves it to approved
});

test('a manual-price line uses qty * manualUnitPrice instead of cost*(1+markup)', () => {
  const co = makeEstimate({
    lines: [{ type: 'material', description: 'Custom fixture', qty: 1, unitCost: 100, pmode: 'manual', manualUnitPrice: 250 }]
  });
  const totals = changeOrderTotals(co);
  assert.equal(totals.cost, 100);
  assert.equal(totals.price, 250);
  assert.equal(totals.margin, 150);
});

test('actor authentication and company-scoping guards match the PO engine\'s conventions', () => {
  assert.throws(() => assertActorAuthenticated(null), /authenticated actor/);
  assert.throws(() => createChangeOrder(estimateInput(), otherCompanyField, {}), /not scoped to this company/);
  assert.throws(() => assertSameCompany({ companyId: 'a' }, { companyId: 'b' }), /crosses a company boundary/);
});

// ---------------------------------------------------------------------------
// Workflow: Additional work requested > CO Est created + sent > Approval +
// payment > convert to Change Order Job
// ---------------------------------------------------------------------------

test('estimate workflow: draft -> sent -> approved -> paid -> converted, exactly as spec\'d', () => {
  let co = makeEstimate();
  co = sendChangeOrder(co, field, { now: '2026-07-14T10:00:00Z' });
  assert.equal(co.lifecycleStatus, 'sent');

  co = recordApproval(co, controller, { approved: true, now: '2026-07-15T09:00:00Z' });
  assert.equal(co.lifecycleStatus, 'approved');
  assert.equal(co.approvedBy, controller.id);

  const totals = changeOrderTotals(co);
  co = recordPayment(co, controller, { amount: totals.price, method: 'check', now: '2026-07-16T09:00:00Z' });
  assert.equal(co.lifecycleStatus, 'paid');
  assert.equal(co.paidTotal, totals.price);

  co = convertToChangeOrderJob(co, controller, { now: '2026-07-17T09:00:00Z' });
  assert.equal(co.lifecycleStatus, 'converted');
  assert.equal(co.convertedJobId, '231-004-01');
});

test('a change order cannot skip states — cannot approve a draft, cannot pay an unapproved CO', () => {
  const co = makeEstimate();
  assert.throws(() => recordApproval(co, controller, { approved: true }), /Cannot approve/);
  assert.throws(() => recordPayment(co, controller, { amount: 100 }), /Cannot record a payment/);
});

test('a rejected estimate cannot be paid or converted', () => {
  let co = makeEstimate();
  co = sendChangeOrder(co, field, {});
  co = recordApproval(co, controller, { approved: false, reason: 'Client declined the extra cost.' });
  assert.equal(co.lifecycleStatus, 'rejected');
  assert.equal(co.rejectionReason, 'Client declined the extra cost.');
  assert.throws(() => recordPayment(co, controller, { amount: 100 }), /Cannot record a payment/);
});

test('invoice workflow skips the approval step entirely: draft -> sent (auto-approved) -> paid -> converted', () => {
  let co = createChangeOrder(invoiceInput(), field, { now: '2026-07-14T09:00:00Z' }).changeOrder;
  co = sendChangeOrder(co, field, { now: '2026-07-14T10:00:00Z' });
  assert.equal(co.lifecycleStatus, 'approved', 'invoice kind lands directly in approved, no "sent" waiting room');
  assert.equal(co.approvedAt, '2026-07-14T10:00:00Z');
  assert.equal(co.autoApproved, true);

  const totals = changeOrderTotals(co);
  co = recordPayment(co, controller, { amount: totals.price });
  co = convertToChangeOrderJob(co, controller, {});
  assert.equal(co.lifecycleStatus, 'converted');
});

test('partial payments accumulate toward paidTotal and cannot exceed the CO total', () => {
  let co = makeEstimate();
  co = sendChangeOrder(co, field, {});
  co = recordApproval(co, controller, { approved: true });
  const totals = changeOrderTotals(co);
  co = recordPayment(co, controller, { amount: totals.price / 2 });
  assert.equal(co.paidTotal, totals.price / 2);
  assert.throws(() => recordPayment(co, controller, { amount: totals.price }), /more than the change order's total/);
});

test('cancellation is always reasoned and preserved in history, and is blocked once paid or converted', () => {
  let co = makeEstimate();
  co = cancelChangeOrder(co, controller, { reason: 'Client withdrew the request before sending.' });
  assert.equal(co.lifecycleStatus, 'cancelled');
  assert.equal(co.cancelReason, 'Client withdrew the request before sending.');

  let paidCo = makeEstimate();
  paidCo = sendChangeOrder(paidCo, field, {});
  paidCo = recordApproval(paidCo, controller, { approved: true });
  paidCo = recordPayment(paidCo, controller, { amount: changeOrderTotals(paidCo).price });
  assert.throws(() => cancelChangeOrder(paidCo, controller, { reason: 'too late' }), /Cannot cancel/);
});

test('every transition appends an append-only history entry', () => {
  let co = makeEstimate();
  co = sendChangeOrder(co, field, {});
  co = recordApproval(co, controller, { approved: true });
  const types = co.history.map(h => h.type);
  assert.deepEqual(types, ['created', 'sent', 'approved']);
});

// ---------------------------------------------------------------------------
// Computed display status — "overdue" overlay
// ---------------------------------------------------------------------------

test('a sent estimate past its target approval date displays as overdue without changing its true lifecycle status', () => {
  let co = makeEstimate({ targetApprovalBy: '2026-07-10' });
  co = sendChangeOrder(co, field, {});
  const display = withComputedStatus(co);
  assert.equal(display.lifecycleStatus, 'sent');
  assert.equal(display.displayStatus, 'overdue');
});

// ---------------------------------------------------------------------------
// Reporting: additional-activity rollup + standalone drill-down
// ---------------------------------------------------------------------------

test('committed (paid/converted) change orders roll into the job\'s profitability as additional activity; pending ones show as pipeline only', () => {
  let paidCo = makeEstimate({ jobId: '231-004' });
  paidCo = sendChangeOrder(paidCo, field, {});
  paidCo = recordApproval(paidCo, controller, { approved: true });
  paidCo = recordPayment(paidCo, controller, { amount: changeOrderTotals(paidCo).price });

  const draftCo = makeEstimate({ jobId: '231-004', description: 'A second, still-pending ask.' });

  const report = changeOrderProfitabilityForJob([paidCo, draftCo], '231-004');
  assert.equal(report.changeOrderCount, 2);
  assert.equal(report.committed.count, 1);
  assert.equal(report.committed.additionalRevenue, changeOrderTotals(paidCo).price);
  assert.equal(report.pipeline.count, 1);
  assert.equal(report.pipeline.potentialRevenue, changeOrderTotals(draftCo).price);
});

test('a rejected or cancelled CO counts toward changeOrderCount but is excluded from both committed and pipeline totals', () => {
  let rejectedCo = makeEstimate({ jobId: '231-004' });
  rejectedCo = sendChangeOrder(rejectedCo, field, {});
  rejectedCo = recordApproval(rejectedCo, controller, { approved: false, reason: 'declined' });

  const report = changeOrderProfitabilityForJob([rejectedCo], '231-004');
  assert.equal(report.changeOrderCount, 1);
  assert.equal(report.committed.count, 0);
  assert.equal(report.pipeline.count, 0);
});

test('changeOrderDrilldown gives a standalone P&L for just the one change order, independent of the job\'s blended numbers', () => {
  let co = makeEstimate();
  co = sendChangeOrder(co, field, {});
  co = recordApproval(co, controller, { approved: true });
  const totals = changeOrderTotals(co);
  co = recordPayment(co, controller, { amount: totals.price / 2 });

  const drilldown = changeOrderDrilldown(co);
  assert.equal(drilldown.totals.price, totals.price);
  assert.equal(drilldown.paidTotal, totals.price / 2);
  // balanceDue is against the POSTED (card) total — the half paid above was
  // an unspecified-method payment, so it credited at face value only.
  assert.equal(drilldown.balanceDue, Math.round((totals.cardPrice - totals.price / 2) * 100) / 100);
  assert.equal(drilldown.lines.length, 2);
});

// ---------------------------------------------------------------------------
// Cash-discount (card) pricing on change orders — added 2026-07-26
// ---------------------------------------------------------------------------

test('CO totals carry the posted card price on top of the untouched base price', () => {
  const co = makeEstimate();
  const totals = changeOrderTotals(co);
  assert.equal(totals.cardRateBps, 400);
  assert.equal(totals.cardFee, Math.round(totals.price * 0.04 * 100) / 100);
  assert.equal(totals.cardPrice, Math.round((totals.price + totals.cardFee) * 100) / 100);
});

test('paying the CASH amount by check settles a CO in full — discount applied automatically', () => {
  let co = makeEstimate();
  co = sendChangeOrder(co, field, {});
  co = recordApproval(co, controller, { approved: true });
  const totals = changeOrderTotals(co);
  co = recordPayment(co, controller, { amount: totals.price, method: 'check' });
  const drilldown = changeOrderDrilldown(co);
  assert.equal(drilldown.paidTotal, totals.price);           // real dollars received
  assert.equal(drilldown.paidCreditedTotal, totals.cardPrice); // fully settled
  assert.equal(drilldown.balanceDue, 0);
  assert.equal(co.payments[0].cashDiscountApplied, totals.cardFee);
});

test('a legacy CO with no cardRateBps behaves exactly as before', () => {
  const co = makeEstimate();
  delete co.cardRateBps;
  const totals = changeOrderTotals(co);
  assert.equal(totals.cardFee, 0);
  assert.equal(totals.cardPrice, totals.price);
});
