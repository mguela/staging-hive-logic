import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateEstimateNumber, createEstimate, validateEstimateInput, validatePaymentSchedule,
  estimateTotals, paymentScheduleAmounts, sendEstimate, recordDepositPayment, approveEstimate,
  rejectEstimate, convertToJob, cancelEstimate, withComputedStatus,
  assertActorAuthenticated, assertSameCompany
} from '../src/estimates.js';

const field = { id: 'jeff', role: 'field', companyId: 'ghgrp' };
const controller = { id: 'controller-1', role: 'controller', companyId: 'ghgrp' };
const otherCompanyField = { id: 'intruder', role: 'field', companyId: 'other-co' };

function estimateInput(overrides = {}) {
  return {
    companyId: 'ghgrp', clientId: 'client-42', clientName: 'Mrs. Jones', requestedBy: 'jeff',
    title: 'Kitchen remodel',
    lines: [
      { type: 'material', description: 'Cabinets', qty: 1, unitCost: 4000, pmode: 'markup', markupPct: 40 },
      { type: 'labor', description: 'Install labor (40 hours)', qty: 40, unitCost: 65, pmode: 'markup', markupPct: 40 }
    ],
    paymentSchedule: [
      { label: 'Deposit due upon approval', pct: 50, isDeposit: true },
      { label: 'Balance due on completion', pct: 50, isDeposit: false }
    ],
    ...overrides
  };
}

function makeEstimate(overrides = {}) {
  return createEstimate(estimateInput(overrides), field, { now: '2026-07-22T09:00:00Z' }).estimate;
}

// ---------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------

test('numbering comes from a durable counter, scoped per company', () => {
  const first = allocateEstimateNumber(undefined, { companyId: 'ghgrp' });
  const second = allocateEstimateNumber(first.nextCounterState, { companyId: 'ghgrp' });
  assert.equal(first.estimateNumber, 'EST-0001');
  assert.equal(second.estimateNumber, 'EST-0002');
});

// ---------------------------------------------------------------------------
// Payment schedule validation -- this is the real-world workaround made
// into a first-class model
// ---------------------------------------------------------------------------

test('a payment schedule must sum to 100% and have exactly one deposit row', () => {
  assert.equal(validatePaymentSchedule([{ label: 'Deposit', pct: 50, isDeposit: true }]).valid, false);
  assert.equal(validatePaymentSchedule([
    { label: 'Deposit', pct: 50, isDeposit: true },
    { label: 'Balance', pct: 50, isDeposit: false }
  ]).valid, true);
  assert.equal(validatePaymentSchedule([
    { label: 'A', pct: 50, isDeposit: true },
    { label: 'B', pct: 50, isDeposit: true }
  ]).valid, false, 'two deposit rows is invalid -- exactly one is required');
  assert.equal(validatePaymentSchedule([
    { label: 'A', pct: 50, isDeposit: false },
    { label: 'B', pct: 50, isDeposit: false }
  ]).valid, false, 'zero deposit rows is invalid');
});

test('validation rejects an estimate with no payment schedule at all', () => {
  const result = validateEstimateInput({ ...estimateInput(), paymentSchedule: [] });
  assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------------
// Creation & totals
// ---------------------------------------------------------------------------

test('creating an estimate starts in draft with a computed deposit requirement', () => {
  const est = makeEstimate();
  assert.equal(est.lifecycleStatus, 'draft');
  const totals = estimateTotals(est);
  // cabinets: 4000 * 1.4 = 5600; labor: 40*65*1.4 = 3640; base total = 9240.
  // Cash-discount program (default 400 bps): fee 369.60 at the bottom ->
  // posted/card total 9609.60. Rates and margin basis never change.
  assert.equal(totals.price, 9240);
  assert.equal(totals.cardRateBps, 400);
  assert.equal(totals.cardFee, 369.6);
  assert.equal(totals.cardPrice, 9609.6);
  assert.equal(totals.margin, estimateTotals(est).price - estimateTotals(est).cost, 'margin stays on the base price — the fee is pass-through, never profit');
  assert.equal(est.depositRequired, 4804.8);     // 50% of the POSTED total
  assert.equal(est.depositRequiredCash, 4620);   // 50% of the base total (cash/check/ACH)
  assert.equal(est.depositSatisfied, false);
});

test('cardRateBps: 0 turns card pricing off for a specific estimate', () => {
  const est = makeEstimate({ cardRateBps: 0 });
  const totals = estimateTotals(est);
  assert.equal(totals.cardFee, 0);
  assert.equal(totals.cardPrice, totals.price);
  assert.equal(est.depositRequired, 4620);
});

test('a legacy estimate with no cardRateBps behaves exactly as before (no fee, no discount)', () => {
  const est = makeEstimate();
  delete est.cardRateBps; // simulates a pre-feature estimate document
  const totals = estimateTotals(est);
  assert.equal(totals.cardFee, 0);
  assert.equal(totals.cardPrice, 9240);
  assert.equal(paymentScheduleAmounts(est)[0].amount, 4620);
});

test('paymentScheduleAmounts computes posted and cash dollar amounts off the estimate totals', () => {
  const est = makeEstimate();
  const rows = paymentScheduleAmounts(est);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amount, 4804.8);      // posted (card) amount due
  assert.equal(rows[0].cashAmount, 4620);    // same row by cash/check/ACH
  assert.equal(rows[1].amount, 4804.8);
  assert.equal(rows[1].cashAmount, 4620);
});

test('actor authentication and company-scoping guards match the established conventions', () => {
  assert.throws(() => assertActorAuthenticated(null), /authenticated actor/);
  assert.throws(() => createEstimate(estimateInput(), otherCompanyField, {}), /not scoped to this company/);
  assert.throws(() => assertSameCompany({ companyId: 'a' }, { companyId: 'b' }), /crosses a company boundary/);
});

// ---------------------------------------------------------------------------
// The core rule: deposit required to approve
// ---------------------------------------------------------------------------

test('an estimate cannot be approved before the deposit is paid, even fully sent', () => {
  let est = makeEstimate();
  est = sendEstimate(est, field, {});
  assert.equal(est.lifecycleStatus, 'sent');
  assert.throws(() => approveEstimate(est, controller, {}), /required deposit has not been paid yet/);
});

test('a partial deposit payment does not satisfy the approval gate', () => {
  let est = makeEstimate();
  est = sendEstimate(est, field, {});
  est = recordDepositPayment(est, controller, { amount: 2000 }); // deposit required is 4804.80 posted
  assert.equal(est.depositSatisfied, false);
  assert.throws(() => approveEstimate(est, controller, {}), /required deposit has not been paid yet/);
});

test('once the deposit is fully paid (card / posted amount), the estimate can be approved', () => {
  let est = makeEstimate();
  est = sendEstimate(est, field, {});
  est = recordDepositPayment(est, controller, { amount: 4804.8, method: 'credit' });
  assert.equal(est.depositSatisfied, true);
  est = approveEstimate(est, controller, { now: '2026-07-23T09:00:00Z' });
  assert.equal(est.lifecycleStatus, 'approved');
  assert.equal(est.approvedBy, controller.id);
});

test('paying the CASH amount by check fully satisfies the deposit — the cash discount is applied automatically', () => {
  let est = makeEstimate();
  est = sendEstimate(est, field, {});
  est = recordDepositPayment(est, controller, { amount: 4620, method: 'check' }); // cash amount of the 4804.80 deposit
  assert.equal(est.depositSatisfied, true, 'a check for the cash amount must satisfy the posted deposit');
  const payment = est.depositPayments[0];
  assert.equal(payment.amount, 4620);                 // real dollars received
  assert.equal(payment.creditedAmount, 4804.8);       // what it counted for
  assert.equal(payment.cashDiscountApplied, 184.8);   // the discount given
  est = approveEstimate(est, controller, {});
  assert.equal(est.lifecycleStatus, 'approved');
});

test('a card payment gets NO cash discount — face value only', () => {
  let est = makeEstimate();
  est = sendEstimate(est, field, {});
  est = recordDepositPayment(est, controller, { amount: 4620, method: 'credit' });
  assert.equal(est.depositSatisfied, false, 'a card payment of the cash amount must NOT satisfy the posted deposit');
  assert.equal(est.depositPayments[0].creditedAmount, 4620);
  assert.equal(est.depositPayments[0].cashDiscountApplied, 0);
});

test('deposit payments can arrive in multiple installments and still satisfy the gate once they sum to the required amount', () => {
  let est = makeEstimate();
  est = sendEstimate(est, field, {});
  est = recordDepositPayment(est, controller, { amount: 2000 });
  est = recordDepositPayment(est, controller, { amount: 2804.8 });
  assert.equal(est.depositSatisfied, true);
  assert.equal(est.depositPaidTotal, 4804.8);
  est = approveEstimate(est, controller, {});
  assert.equal(est.lifecycleStatus, 'approved');
});

test('a deposit payment cannot exceed the required deposit amount', () => {
  let est = makeEstimate();
  est = sendEstimate(est, field, {});
  assert.throws(() => recordDepositPayment(est, controller, { amount: 5000 }), /more than the required deposit/);
  assert.throws(() => recordDepositPayment(est, controller, { amount: 4700, method: 'check' }), /more than the required deposit/, 'a check overshooting via its credited amount is rejected too');
});

test('a rejected estimate cannot later be approved or converted', () => {
  let est = makeEstimate();
  est = sendEstimate(est, field, {});
  est = rejectEstimate(est, controller, { reason: 'Client went with another contractor.' });
  assert.equal(est.lifecycleStatus, 'rejected');
  assert.throws(() => approveEstimate(est, controller, {}), /Cannot approve/);
});

// ---------------------------------------------------------------------------
// Conversion to job with the remaining payment schedule
// ---------------------------------------------------------------------------

test('converting an approved estimate produces a job carrying only the remaining (non-deposit) payment schedule rows', () => {
  let est = makeEstimate();
  est = sendEstimate(est, field, {});
  est = recordDepositPayment(est, controller, { amount: 4620, method: 'check' });
  est = approveEstimate(est, controller, {});
  est = convertToJob(est, controller, { now: '2026-07-24T09:00:00Z' });

  assert.equal(est.lifecycleStatus, 'converted');
  assert.equal(est.convertedJobId, est.estimateNumber + '-JOB');
  assert.equal(est.remainingPaymentSchedule.length, 1);
  assert.equal(est.remainingPaymentSchedule[0].label, 'Balance due on completion');
  assert.equal(est.remainingPaymentSchedule[0].amount, 4804.8);   // posted (card) amount
  assert.equal(est.remainingPaymentSchedule[0].cashAmount, 4620); // cash/check/ACH amount
  assert.equal(est.remainingPaymentSchedule.some(row => row.isDeposit), false, 'the deposit row must never appear in the remaining schedule -- it is already collected');
});

test('a multi-row schedule beyond deposit+balance still only strips the single deposit row on conversion', () => {
  let est = makeEstimate({
    paymentSchedule: [
      { label: 'Deposit due upon approval', pct: 30, isDeposit: true },
      { label: 'Progress payment at rough-in', pct: 40, isDeposit: false },
      { label: 'Balance due on completion', pct: 30, isDeposit: false }
    ]
  });
  est = sendEstimate(est, field, {});
  const depositAmount = est.depositRequired;
  est = recordDepositPayment(est, controller, { amount: depositAmount });
  est = approveEstimate(est, controller, {});
  est = convertToJob(est, controller, {});
  assert.equal(est.remainingPaymentSchedule.length, 2);
  assert.deepEqual(est.remainingPaymentSchedule.map(r => r.label), ['Progress payment at rough-in', 'Balance due on completion']);
});

test('cannot convert to a job before approval', () => {
  const est = makeEstimate();
  assert.throws(() => convertToJob(est, controller, {}), /Cannot convert to a job/);
});

test('cancellation is always reasoned and preserved in history', () => {
  let est = makeEstimate();
  est = cancelEstimate(est, controller, { reason: 'Client put the project on hold.' });
  assert.equal(est.lifecycleStatus, 'cancelled');
  assert.equal(est.cancelReason, 'Client put the project on hold.');
});

test('every transition appends an append-only history entry', () => {
  let est = makeEstimate();
  est = sendEstimate(est, field, {});
  est = recordDepositPayment(est, controller, { amount: est.depositRequired });
  est = approveEstimate(est, controller, {});
  const types = est.history.map(h => h.type);
  assert.deepEqual(types, ['created', 'sent', 'deposit_payment_recorded', 'approved']);
});

// ---------------------------------------------------------------------------
// Display status
// ---------------------------------------------------------------------------

test('a sent estimate with no deposit paid yet displays as awaiting_deposit', () => {
  let est = makeEstimate();
  est = sendEstimate(est, field, {});
  const display = withComputedStatus(est);
  assert.equal(display.lifecycleStatus, 'sent');
  assert.equal(display.displayStatus, 'awaiting_deposit');
});
