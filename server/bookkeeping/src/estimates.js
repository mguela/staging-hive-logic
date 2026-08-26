// server/bookkeeping/src/estimates.js
//
// Real, native HiveLogic estimate engine — built per the standing project
// rule (2026-07-22): HiveLogic is the destination system, Jobber is only an
// interim data feed. This does not lean on Jobber's quote/payment-schedule
// shapes at all. Mirrors the reviewed conventions already established in
// purchase-orders.js / change-orders.js: no I/O in this module, actor/
// tenant guards, a durable counter the caller owns, enforced state-machine
// transitions, and an append-only audit history.
//
// Chris's spec (2026-07-22):
//   "We can build it as deposit require[d] to approve estimate and then
//   conversion to job with remaining payment schedule."
//   Context: Jobber's native deposit-request feature breaks the Jobber->QBO
//   sync, so the real-world workaround has always been a payment schedule
//   on the estimate whose first row is manually labeled "Deposit due upon
//   approval." This engine makes that workaround the actual, real, first-
//   class model instead of a naming convention on top of someone else's
//   system: a payment schedule of percentage-based rows, one of which is
//   flagged isDeposit, and approval is BLOCKED until that deposit row's
//   dollar amount has actually been recorded as paid.

import { randomUUID } from 'node:crypto';
import { normalizeCardRateBps, cardPricing, creditedAmount } from './card-pricing.js';

const money = value => Math.round((Number(value) || 0) * 100) / 100;

export const ESTIMATE_LIFECYCLE_STATES = Object.freeze([
  'draft', 'sent', 'approved', 'rejected', 'converted', 'cancelled'
]);
export const ESTIMATE_LINE_TYPES = Object.freeze([
  'labor', 'material', 'subcontractor', 'equipment', 'discount', 'tax', 'overhead'
]);
export const DEFAULT_MARKUP_PCT = 40;

// ---------------------------------------------------------------------------
// Actor / tenant guards
// ---------------------------------------------------------------------------
export function assertActorAuthenticated(actor) {
  if (!actor || !actor.id || !actor.role) {
    throw new Error('An authenticated actor with a server-verified id and role is required. Actor identity and role must never be accepted from browser/request-body input.');
  }
}

export function assertSameCompany(a, b, label = 'This action') {
  if (a?.companyId && b?.companyId && a.companyId !== b.companyId) {
    const error = new Error(`${label} crosses a company boundary and is not permitted.`);
    error.code = 'CROSS_COMPANY_BLOCKED';
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Sequential numbering -- pure function over a durable counter the caller
// owns, scoped per company (an estimate has no job yet -- that's the whole
// point of this workflow, the job doesn't exist until conversion).
// ---------------------------------------------------------------------------
export function allocateEstimateNumber(counterState, { companyId, companyCode = 'EST' } = {}) {
  if (!companyId) throw new Error('A company ID is required to allocate an estimate number.');
  const nextSequence = (counterState?.nextSequence || 0) + 1;
  const estimateNumber = `${companyCode}-${String(nextSequence).padStart(4, '0')}`;
  return {
    estimateNumber,
    nextCounterState: { ...(counterState || {}), companyId, nextSequence }
  };
}

// ---------------------------------------------------------------------------
// Line items -- identical shape/math to the Change Orders engine, so a line
// reads and computes the same way everywhere in the app.
// ---------------------------------------------------------------------------
export function lineCost(line) {
  const qty = Number(line.qty) || (line.type === 'discount' || line.type === 'tax' ? 1 : 0);
  return money(qty * (Number(line.unitCost) || 0));
}

export function linePrice(line) {
  const cost = lineCost(line);
  const price = line.pmode === 'manual'
    ? money((Number(line.qty) || 1) * (Number(line.manualUnitPrice) || 0))
    : money(cost * (1 + (Number(line.markupPct ?? DEFAULT_MARKUP_PCT)) / 100));
  return line.type === 'discount' ? -Math.abs(price) : price;
}

export function estimateTotals(estimate) {
  let cost = 0, price = 0;
  for (const line of estimate.lines || []) { cost += lineCost(line); price += linePrice(line); }
  // Card pricing (cash-discount program — see card-pricing.js): the fee is
  // computed ONCE at the bottom, on the estimate's base total. `price`
  // stays the base/cash price — it is the margin basis (the fee passes
  // through to the processor; it is never profit). `cardPrice` is the
  // posted total the client sees and what a card payment is charged.
  // Estimates created before this feature have no cardRateBps -> 0 -> the
  // three card fields collapse to the base price, nothing shifts.
  const pricing = cardPricing(price, Number(estimate.cardRateBps) || 0);
  return {
    cost: money(cost),
    price: money(price),
    margin: money(price - cost),
    marginPct: price > 0 ? Math.round(((price - cost) / price) * 1000) / 10 : 0,
    cardRateBps: pricing.cardRateBps,
    cardFee: pricing.cardFee,
    cardPrice: pricing.cardPrice
  };
}

// ---------------------------------------------------------------------------
// Payment schedule -- percentage-based rows against the estimate total.
// Exactly one row must be flagged isDeposit:true (the real-world "Deposit
// due upon approval" row) -- that is the row approval is gated on.
// ---------------------------------------------------------------------------
export function validatePaymentSchedule(schedule) {
  const errors = [];
  if (!Array.isArray(schedule) || !schedule.length) {
    errors.push('A payment schedule needs at least one row.');
    return { valid: false, errors };
  }
  const depositRows = schedule.filter(row => row.isDeposit);
  if (depositRows.length !== 1) errors.push('Exactly one payment schedule row must be flagged as the deposit (isDeposit: true).');
  const pctSum = schedule.reduce((s, row) => s + (Number(row.pct) || 0), 0);
  if (Math.abs(pctSum - 100) > 0.01) errors.push(`Payment schedule percentages must sum to 100 (currently ${Math.round(pctSum * 100) / 100}).`);
  for (const [index, row] of schedule.entries()) {
    if (!row.label?.trim()) errors.push(`Payment schedule row ${index + 1} needs a label.`);
    if (!(Number(row.pct) > 0)) errors.push(`Payment schedule row ${index + 1} needs a percentage greater than zero.`);
  }
  return { valid: errors.length === 0, errors };
}

export function paymentScheduleAmounts(estimate) {
  const totals = estimateTotals(estimate);
  return (estimate.paymentSchedule || []).map((row, index) => ({
    ...row,
    index,
    // amount = the POSTED amount due for this row (fee included — what's
    // displayed and what a card payment must cover). cashAmount = the same
    // row paid by cash/check/ACH after the cash discount. Identical when
    // card pricing is off (cardRateBps 0 / legacy estimates).
    amount: money(totals.cardPrice * (Number(row.pct) || 0) / 100),
    cashAmount: money(totals.price * (Number(row.pct) || 0) / 100)
  }));
}

function depositRow(estimate) {
  const rows = paymentScheduleAmounts(estimate);
  return rows.find(row => row.isDeposit) || null;
}

// ---------------------------------------------------------------------------
// Validation & creation
// ---------------------------------------------------------------------------
export function validateEstimateInput(input = {}) {
  const errors = [];
  if (!input.companyId) errors.push('A company ID is required.');
  if (!input.clientId) errors.push('A client is required.');
  if (!input.requestedBy?.trim()) errors.push('A requester is required.');
  if (!Array.isArray(input.lines) || !input.lines.length) errors.push('An estimate needs at least one line item.');
  for (const [index, line] of (input.lines || []).entries()) {
    if (!ESTIMATE_LINE_TYPES.includes(line.type)) errors.push(`Line ${index + 1} needs a valid type (${ESTIMATE_LINE_TYPES.join(', ')}).`);
    if (!(Number(line.qty) > 0) && line.type !== 'discount' && line.type !== 'tax') errors.push(`Line ${index + 1} needs a quantity greater than zero.`);
  }
  const scheduleCheck = validatePaymentSchedule(input.paymentSchedule);
  if (!scheduleCheck.valid) errors.push(...scheduleCheck.errors);
  return { valid: errors.length === 0, errors };
}

function appendHistory(estimate, { type, actor, now, detail = {} }) {
  return {
    ...estimate,
    updatedAt: now,
    history: [...(estimate.history || []), { type, actorId: actor?.id || null, actorRole: actor?.role || null, at: now, detail }]
  };
}

export function createEstimate(input, actor, { counterState, now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  const validation = validateEstimateInput(input);
  if (!validation.valid) throw new Error(validation.errors.join(' '));
  if (input.companyId !== actor.companyId && actor.companyId) throw new Error('The requesting actor is not scoped to this company.');

  const allocation = input.estimateNumber
    ? { estimateNumber: input.estimateNumber, nextCounterState: counterState }
    : allocateEstimateNumber(counterState, { companyId: input.companyId, companyCode: input.companyCode });

  const lines = input.lines.map((line, index) => ({
    id: line.id || randomUUID(),
    index,
    type: line.type,
    description: line.description || '',
    qty: Number(line.qty) || 0,
    unit: line.unit || 'ea',
    unitCost: money(line.unitCost),
    pmode: line.pmode === 'manual' ? 'manual' : 'markup',
    markupPct: line.markupPct != null ? Number(line.markupPct) : DEFAULT_MARKUP_PCT,
    manualUnitPrice: line.manualUnitPrice != null ? money(line.manualUnitPrice) : null,
    owner: line.owner || null
  }));

  const paymentSchedule = input.paymentSchedule.map((row, index) => ({
    id: row.id || randomUUID(),
    index,
    label: row.label.trim(),
    pct: Number(row.pct),
    isDeposit: !!row.isDeposit,
    dueOn: row.dueOn || (row.isDeposit ? 'approval' : 'completion')
  }));

  let estimate = {
    id: randomUUID(),
    estimateNumber: allocation.estimateNumber,
    companyId: input.companyId,
    clientId: input.clientId,
    clientName: input.clientName || null,
    title: input.title || null,
    // Cash-discount program rate, snapshotted at creation (default 4.00% =
    // 400 bps — see card-pricing.js). A later program-rate change never
    // touches an existing estimate. Pass cardRateBps: 0 to turn card
    // pricing off for a specific estimate.
    cardRateBps: normalizeCardRateBps(input.cardRateBps),
    lifecycleStatus: 'draft',
    requestedBy: actor.id,
    requestedAt: now,
    sentAt: null,
    depositPaidAt: null,
    depositPayments: [],
    approvedAt: null,
    approvedBy: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectionReason: null,
    convertedAt: null,
    convertedJobId: null,
    cancelledAt: null,
    cancelReason: null,
    lines,
    paymentSchedule,
    createdAt: now,
    createdBy: actor.id,
    updatedAt: now,
    history: []
  };
  estimate = appendHistory(estimate, { type: 'created', actor, now, detail: { estimateNumber: estimate.estimateNumber } });
  return { estimate: withComputedStatus(estimate), nextCounterState: allocation.nextCounterState };
}

// ---------------------------------------------------------------------------
// Enforced state-machine transitions
// ---------------------------------------------------------------------------
function requireStatus(estimate, allowed, action) {
  if (!allowed.includes(estimate.lifecycleStatus)) {
    throw new Error(`Cannot ${action} an estimate in status "${estimate.lifecycleStatus}". Allowed from: ${allowed.join(', ')}.`);
  }
}

export function sendEstimate(estimate, actor, { now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  requireStatus(estimate, ['draft'], 'send');
  let next = { ...estimate, lifecycleStatus: 'sent', sentAt: now };
  next = appendHistory(next, { type: 'sent', actor, now, detail: {} });
  return withComputedStatus(next);
}

// Records a payment against the deposit row specifically. depositPaidAt is
// only stamped once the deposit row's full dollar amount has been recorded
// -- a partial payment moves money but does NOT satisfy the "deposit
// required to approve" gate, so approveEstimate() below still blocks.
//
// Cash-discount aware (2026-07-26): the deposit row's `amount` is the
// POSTED (card) amount. A payment by cash/check/ACH is credited against it
// at the cash-discount ratio (see creditedAmount in card-pricing.js), so
// paying the row's cashAmount by check fully satisfies the deposit — the
// discount is applied automatically, nobody does fee math by hand. Every
// payment stores both the real dollars received (amount) and what it
// counted for (creditedAmount); the gap is the cash discount given.
export function recordDepositPayment(estimate, actor, { amount, method, reference, now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  requireStatus(estimate, ['sent'], 'record a deposit payment against');
  const deposit = depositRow(estimate);
  if (!deposit) throw new Error('This estimate has no payment schedule row flagged as the deposit.');
  const paymentAmount = money(amount);
  if (!(paymentAmount > 0)) throw new Error('A payment amount greater than zero is required.');

  const totals = estimateTotals(estimate);
  const credited = creditedAmount(paymentAmount, method, { cashPrice: totals.price, cardPrice: totals.cardPrice });
  const priorCredited = money((estimate.depositPayments || []).reduce((s, p) => s + (p.creditedAmount != null ? p.creditedAmount : p.amount), 0));
  const creditedTotal = money(priorCredited + credited);
  if (creditedTotal > deposit.amount + 0.01) {
    const cashNote = deposit.cashAmount != null && deposit.cashAmount !== deposit.amount
      ? ` ($${deposit.cashAmount.toFixed(2)} by cash/check/ACH)` : '';
    throw new Error(`Payment of $${paymentAmount.toFixed(2)} would bring the deposit's credited total to $${creditedTotal.toFixed(2)}, more than the required deposit of $${deposit.amount.toFixed(2)}${cashNote}.`);
  }

  let next = {
    ...estimate,
    depositPayments: [...(estimate.depositPayments || []), {
      id: randomUUID(),
      amount: paymentAmount,
      method: method || 'unspecified',
      creditedAmount: credited,
      cashDiscountApplied: money(credited - paymentAmount),
      reference: reference || null,
      recordedBy: actor.id,
      at: now
    }]
  };
  if (creditedTotal >= deposit.amount - 0.01) next.depositPaidAt = next.depositPaidAt || now;
  next = appendHistory(next, { type: 'deposit_payment_recorded', actor, now, detail: { amount: paymentAmount, method: method || 'unspecified', creditedAmount: credited, creditedTotal, depositSatisfied: !!next.depositPaidAt } });
  return withComputedStatus(next);
}

// sent -> approved. BLOCKED until the deposit row has been fully paid --
// this is the literal rule Chris asked for: "deposit require[d] to approve
// estimate." An estimate can sit in "sent" indefinitely with a partial or
// no deposit payment; it simply cannot become "approved" until depositPaidAt
// is set.
export function approveEstimate(estimate, actor, { now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  requireStatus(estimate, ['sent'], 'approve');
  if (!estimate.depositPaidAt) {
    throw new Error('Cannot approve this estimate: the required deposit has not been paid yet.');
  }
  let next = { ...estimate, lifecycleStatus: 'approved', approvedAt: now, approvedBy: actor.id };
  next = appendHistory(next, { type: 'approved', actor, now, detail: {} });
  return withComputedStatus(next);
}

export function rejectEstimate(estimate, actor, { reason, now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  requireStatus(estimate, ['sent'], 'reject');
  let next = { ...estimate, lifecycleStatus: 'rejected', rejectedAt: now, rejectedBy: actor.id, rejectionReason: String(reason || '').trim() || null };
  next = appendHistory(next, { type: 'rejected', actor, now, detail: { reason: reason || null } });
  return withComputedStatus(next);
}

// Records that the CLIENT said yes, clicking Approve on the emailed
// estimate (api/bookkeeping/estimates/respond.js) -- 2026-08-25, jomell.
// Deliberately NOT the same thing as approveEstimate() above: that one is
// gated on a controller-role actor AND the deposit already being paid
// (Chris's spec), and a client's email click satisfies neither -- it has no
// server-verified HiveLogic identity, and "the client said yes" is not the
// same real-world event as "the deposit landed." Collapsing them would let
// an email click silently skip the deposit-gate. This only stamps the
// client's response for staff to see and act on (e.g. by sending the
// deposit request); lifecycleStatus is untouched. A client clicking Reject
// IS the same real event either way, so that goes through the real
// rejectEstimate() above instead of a parallel path here.
export function recordClientApproval(estimate, { note, now = new Date().toISOString() } = {}) {
  requireStatus(estimate, ['sent'], 'record a client approval for');
  let next = { ...estimate, clientApprovedAt: now, clientApprovalNote: String(note || '').trim() || null };
  next = appendHistory(next, {
    type: 'client_approved',
    actor: { id: 'client-email-link', role: 'client' },
    now,
    detail: { note: note || null }
  });
  return withComputedStatus(next);
}

// approved -> converted. The estimate becomes a real job; the job carries
// the REMAINING payment schedule -- every row except the deposit, which is
// already collected and settled. Each remaining row's dollar amount is
// fixed at conversion time (computed off the estimate's real total), so a
// later change order is a separate, additional activity (see
// change-orders.js) rather than a retroactive edit to this schedule.
export function convertToJob(estimate, actor, { now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  requireStatus(estimate, ['approved'], 'convert to a job');
  const scheduleWithAmounts = paymentScheduleAmounts(estimate);
  const remainingPaymentSchedule = scheduleWithAmounts.filter(row => !row.isDeposit);
  const convertedJobId = `${estimate.estimateNumber}-JOB`;
  let next = {
    ...estimate,
    lifecycleStatus: 'converted',
    convertedAt: now,
    convertedJobId,
    remainingPaymentSchedule
  };
  next = appendHistory(next, { type: 'converted', actor, now, detail: { convertedJobId, remainingRows: remainingPaymentSchedule.length } });
  return withComputedStatus(next);
}

export function cancelEstimate(estimate, actor, { reason, now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  requireStatus(estimate, ['draft', 'sent', 'approved', 'rejected'], 'cancel');
  let next = { ...estimate, lifecycleStatus: 'cancelled', cancelledAt: now, cancelReason: String(reason || '').trim() || null };
  next = appendHistory(next, { type: 'cancelled', actor, now, detail: { reason: reason || null } });
  return withComputedStatus(next);
}

// ---------------------------------------------------------------------------
// Display status
// ---------------------------------------------------------------------------
export function withComputedStatus(estimate) {
  const totals = estimateTotals(estimate);
  const deposit = depositRow(estimate);
  const depositPaidTotal = money((estimate.depositPayments || []).reduce((s, p) => s + p.amount, 0));
  const depositCreditedTotal = money((estimate.depositPayments || []).reduce((s, p) => s + (p.creditedAmount != null ? p.creditedAmount : p.amount), 0));
  const awaitingDeposit = estimate.lifecycleStatus === 'sent' && !estimate.depositPaidAt;
  return {
    ...estimate,
    displayStatus: awaitingDeposit ? 'awaiting_deposit' : estimate.lifecycleStatus,
    totals,
    // depositRequired is the POSTED (card) amount; depositRequiredCash is
    // the same row paid by cash/check/ACH. depositPaidTotal = real dollars
    // received; depositCreditedTotal = what they counted for against the
    // posted amount (the difference is cash discount given).
    depositRequired: deposit ? deposit.amount : 0,
    depositRequiredCash: deposit ? deposit.cashAmount : 0,
    depositPaidTotal,
    depositCreditedTotal,
    depositSatisfied: !!estimate.depositPaidAt
  };
}
