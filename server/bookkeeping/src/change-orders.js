// server/bookkeeping/src/change-orders.js
//
// Change order engine — real, tested, no mockup data. Mirrors the reviewed
// conventions already established in purchase-orders.js: this module does
// no I/O, never trusts client-supplied actor identity/company, uses a
// durable counter the CALLER owns for numbering, enforces state-machine
// transitions, and keeps an append-only audit history on every record.
//
// Chris's spec (2026-07-22):
//   "Change orders need toggle at the top. Change order Estimate or Change
//   order invoice. They should have line items/activities the same as
//   building an estimate form. Workflow: Additional work requested > Change
//   Order Est Created + sent > Approval + payment > convert to Change order
//   Job. All along chained to the original job, it becomes an additional
//   activity on the reporting side when calculating profitability but also
//   can be drilled down into for a closer reporting of just the change
//   order itself."
//
// "Change Order Invoice" is modeled as the after-the-fact sibling of
// "Change Order Estimate" — exactly like purchase-orders.js's planned vs.
// after_the_fact split: the work already happened, so the approval-before-
// work step is skipped and the CO goes straight to being invoiced. That
// keeps ONE state machine instead of two, and keeps the skipped-approval
// fact permanent and visible (autoApproved), the same way a PO's
// notPreapproved flag is permanent and never silently upgraded.

import { randomUUID } from 'node:crypto';
import { normalizeCardRateBps, cardPricing, creditedAmount } from './card-pricing.js';

const money = value => Math.round((Number(value) || 0) * 100) / 100;

export const CO_KINDS = Object.freeze(['estimate', 'invoice']);
// estimate: additional work requested -> CO estimate created + sent ->
//   client approves or rejects -> (if approved) payment recorded -> converted
//   into its own Change Order Job, chained to the original job.
// invoice: work already completed -> CO invoice created + sent -> payment
//   recorded -> converted. No client-approval step: approvedAt is stamped
//   automatically at send time and the record is permanently flagged
//   autoApproved so it can never be confused with a client's real approval.
export const CO_LIFECYCLE_STATES = Object.freeze([
  'draft', 'sent', 'approved', 'rejected', 'paid', 'converted', 'cancelled'
]);
export const CO_LINE_TYPES = Object.freeze([
  'labor', 'material', 'subcontractor', 'equipment', 'discount', 'tax', 'overhead'
]);
export const CO_REASON_CATEGORIES = Object.freeze([
  'client_request', 'unforeseen_condition', 'code_requirement', 'design_change', 'scope_clarification', 'other'
]);

export const DEFAULT_MARKUP_PCT = 40;

// ---------------------------------------------------------------------------
// Actor / tenant guards — never trust client-supplied identity or role.
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
// Sequential numbering — a pure function over a durable counter the caller
// owns, scoped per job (mirrors "CO-231-004-01" / "CO-2412-02" conventions
// already used in HiveLogic's Reina copy and the existing CO mockup). NEVER
// derives a number by counting an array of existing change orders — that
// races and can reuse a number. The caller persists nextCounterState
// atomically in the same transaction that inserts the new row.
// ---------------------------------------------------------------------------
export function allocateChangeOrderNumber(counterState, { jobId, companyId, companyCode = 'CO' } = {}) {
  if (!companyId) throw new Error('A company ID is required to allocate a change order number.');
  if (!jobId) throw new Error('A change order must be chained to a job — jobId is required to allocate its number.');
  const key = `job:${jobId}`;
  const counters = counterState?.counters || {};
  const nextSequence = (counters[key] || 0) + 1;
  const coNumber = `${companyCode}-${jobId}-${String(nextSequence).padStart(2, '0')}`;
  return {
    coNumber,
    nextCounterState: { ...(counterState || {}), companyId, counters: { ...counters, [key]: nextSequence } }
  };
}

// ---------------------------------------------------------------------------
// Line items — same shape and math as the Estimate Builder (qty * unit cost
// for cost, either a markup% or a manual price for the client-facing price),
// so a Change Order line reads and computes exactly like an estimate line.
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

export function validateChangeOrderInput(input = {}) {
  const errors = [];
  if (!input.companyId) errors.push('A company ID is required.');
  if (!input.jobId) errors.push('A change order must be chained to an existing job.');
  if (!CO_KINDS.includes(input.kind)) errors.push(`kind must be one of ${CO_KINDS.join(', ')}.`);
  if (!input.requestedBy?.trim()) errors.push('A requester is required.');
  if (!input.description?.trim()) errors.push('A description of the additional work is required.');
  if (!Array.isArray(input.lines) || !input.lines.length) errors.push('A change order needs at least one line item.');
  for (const [index, line] of (input.lines || []).entries()) {
    if (!CO_LINE_TYPES.includes(line.type)) errors.push(`Line ${index + 1} needs a valid type (${CO_LINE_TYPES.join(', ')}).`);
    if (!(Number(line.qty) > 0) && line.type !== 'discount' && line.type !== 'tax') errors.push(`Line ${index + 1} needs a quantity greater than zero.`);
  }
  if (input.reasonCategory && !CO_REASON_CATEGORIES.includes(input.reasonCategory)) errors.push(`reasonCategory must be one of ${CO_REASON_CATEGORIES.join(', ')}.`);
  return { valid: errors.length === 0, errors };
}

export function changeOrderTotals(co) {
  let cost = 0, price = 0;
  for (const line of co.lines || []) { cost += lineCost(line); price += linePrice(line); }
  // Card pricing (cash-discount program — see card-pricing.js): identical
  // semantics to estimateTotals. `price` stays the base/cash price (margin
  // basis); `cardPrice` is the posted total. Legacy COs (no cardRateBps)
  // collapse to base — nothing shifts.
  const pricing = cardPricing(price, Number(co.cardRateBps) || 0);
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

function appendHistory(co, { type, actor, now, detail = {} }) {
  return {
    ...co,
    updatedAt: now,
    history: [...(co.history || []), { type, actorId: actor?.id || null, actorRole: actor?.role || null, at: now, detail }]
  };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------
export function createChangeOrder(input, actor, { counterState, now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  const validation = validateChangeOrderInput(input);
  if (!validation.valid) throw new Error(validation.errors.join(' '));
  if (input.companyId !== actor.companyId && actor.companyId) throw new Error('The requesting actor is not scoped to this company.');

  const allocation = input.coNumber
    ? { coNumber: input.coNumber, nextCounterState: counterState }
    : allocateChangeOrderNumber(counterState, { jobId: input.jobId, companyId: input.companyId, companyCode: input.companyCode });

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

  let co = {
    id: randomUUID(),
    coNumber: allocation.coNumber,
    companyId: input.companyId,
    jobId: input.jobId,
    jobLabel: input.jobLabel || null,
    kind: input.kind,
    description: input.description.trim(),
    reasonCategory: input.reasonCategory || 'other',
    // Cash-discount program rate, snapshotted at creation (default 4.00% —
    // see card-pricing.js). cardRateBps: 0 turns card pricing off for this CO.
    cardRateBps: normalizeCardRateBps(input.cardRateBps),
    lifecycleStatus: 'draft',
    // Permanent from creation onward, mirroring notPreapproved on a PO —
    // never toggled, never cleared later. Only ever true for kind==='invoice'.
    autoApproved: input.kind === 'invoice',
    scheduleImpactDays: Number(input.scheduleImpactDays) || 0,
    approvalRequiredFrom: input.kind === 'invoice' ? null : (input.approvalRequiredFrom || 'client'),
    targetApprovalBy: input.targetApprovalBy || null,
    requestedBy: actor.id,
    requestedAt: now,
    sentAt: null,
    approvedAt: null,
    approvedBy: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectionReason: null,
    payments: [],
    paidTotal: 0,
    convertedAt: null,
    convertedJobId: null,
    cancelledAt: null,
    cancelReason: null,
    lines,
    createdAt: now,
    createdBy: actor.id,
    updatedAt: now,
    history: []
  };
  co = appendHistory(co, { type: 'created', actor, now, detail: { kind: co.kind, coNumber: co.coNumber, jobId: co.jobId } });
  return { changeOrder: withComputedStatus(co), nextCounterState: allocation.nextCounterState };
}

// ---------------------------------------------------------------------------
// Enforced state-machine transitions. Every function takes the current
// record and returns the next record — no I/O, no persistence — the API
// layer is responsible for reading the current record, calling one of
// these, and writing the result back (with optimistic-concurrency retry,
// same pattern as the PO store).
// ---------------------------------------------------------------------------
function requireStatus(co, allowed, action) {
  if (!allowed.includes(co.lifecycleStatus)) {
    throw new Error(`Cannot ${action} a change order in status "${co.lifecycleStatus}". Allowed from: ${allowed.join(', ')}.`);
  }
}

// draft -> sent. An "invoice" kind change order auto-approves itself the
// moment it's sent (the work already happened; there is no client approval
// gate to wait on) — but autoApproved stays permanently on the record so
// this can never be displayed or reported as if a client actually approved
// it.
export function sendChangeOrder(co, actor, { now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  requireStatus(co, ['draft'], 'send');
  let next = { ...co, lifecycleStatus: co.kind === 'invoice' ? 'approved' : 'sent', sentAt: now };
  if (co.kind === 'invoice') { next = { ...next, approvedAt: now, approvedBy: actor.id }; }
  next = appendHistory(next, { type: 'sent', actor, now, detail: { kind: co.kind, autoApproved: co.kind === 'invoice' } });
  return withComputedStatus(next);
}

// sent -> approved | rejected. Only meaningful for kind==='estimate' — an
// invoice-kind CO is never in "sent" state (sendChangeOrder already moves it
// straight to "approved").
export function recordApproval(co, actor, { approved, reason, now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  requireStatus(co, ['sent'], approved ? 'approve' : 'reject');
  let next = approved
    ? { ...co, lifecycleStatus: 'approved', approvedAt: now, approvedBy: actor.id }
    : { ...co, lifecycleStatus: 'rejected', rejectedAt: now, rejectedBy: actor.id, rejectionReason: String(reason || '').trim() || null };
  next = appendHistory(next, { type: approved ? 'approved' : 'rejected', actor, now, detail: { reason: reason || null } });
  return withComputedStatus(next);
}

// draft/sent -> same status, description only. A label fix before anything
// has been decided against the change order -- once approved/paid/rejected/
// converted/cancelled, the description describes what was actually decided,
// so a dispute after that point gets a NEW change order, never a silent
// rewrite of this one's history.
export function updateChangeOrderDescription(co, actor, { description, now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  requireStatus(co, ['draft', 'sent'], 'edit the description of');
  const trimmed = String(description || '').trim();
  if (!trimmed) throw new Error('A description of the additional work is required.');
  if (trimmed === co.description) return withComputedStatus(co);
  let next = appendHistory({ ...co, description: trimmed }, { type: 'description_edited', actor, now, detail: { from: co.description, to: trimmed } });
  return withComputedStatus(next);
}

// approved -> paid (first payment) or stays "paid" while accepting further
// partial payments. amount is the payment being recorded right now, not a
// running total — paidTotal is accumulated here.
// Cash-discount aware (2026-07-26): the CO's posted total is
// totals.cardPrice (fee included). A payment by cash/check/ACH is credited
// at the cash-discount ratio (see creditedAmount in card-pricing.js), so
// paying totals.price by check settles the CO in full — the discount is
// automatic. paidTotal remains real dollars received; paidCreditedTotal is
// what those dollars counted for against the posted total.
export function recordPayment(co, actor, { amount, method, reference, now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  requireStatus(co, ['approved', 'paid'], 'record a payment against');
  const paymentAmount = money(amount);
  if (!(paymentAmount > 0)) throw new Error('A payment amount greater than zero is required.');
  const totals = changeOrderTotals(co);
  const credited = creditedAmount(paymentAmount, method, { cashPrice: totals.price, cardPrice: totals.cardPrice });
  const paidTotal = money((co.paidTotal || 0) + paymentAmount);
  const paidCreditedTotal = money((co.paidCreditedTotal != null ? co.paidCreditedTotal : (co.paidTotal || 0)) + credited);
  if (paidCreditedTotal > totals.cardPrice + 0.01) {
    const cashNote = totals.cardPrice !== totals.price ? ` ($${totals.price.toFixed(2)} by cash/check/ACH)` : '';
    throw new Error(`Payment of $${paymentAmount.toFixed(2)} would bring the credited total to $${paidCreditedTotal.toFixed(2)}, more than the change order's total of $${totals.cardPrice.toFixed(2)}${cashNote}.`);
  }
  let next = {
    ...co,
    lifecycleStatus: 'paid',
    paidTotal,
    paidCreditedTotal,
    payments: [...(co.payments || []), { id: randomUUID(), amount: paymentAmount, method: method || 'unspecified', creditedAmount: credited, cashDiscountApplied: money(credited - paymentAmount), reference: reference || null, recordedBy: actor.id, at: now }]
  };
  next = appendHistory(next, { type: 'payment_recorded', actor, now, detail: { amount: paymentAmount, method: method || 'unspecified', creditedAmount: credited, paidTotal, paidCreditedTotal } });
  return withComputedStatus(next);
}

// paid -> converted. This is the moment the change order becomes its own
// Change Order Job — chained to the original job via parentJobId, its own
// number for drill-down reporting, still rolling up into the parent job's
// profitability as an additional activity (see changeOrderProfitabilityForJob).
export function convertToChangeOrderJob(co, actor, { now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  requireStatus(co, ['paid'], 'convert to a job');
  const convertedJobId = `${co.jobId}-${co.coNumber.split('-').pop()}`;
  let next = { ...co, lifecycleStatus: 'converted', convertedAt: now, convertedJobId };
  next = appendHistory(next, { type: 'converted', actor, now, detail: { convertedJobId, parentJobId: co.jobId } });
  return withComputedStatus(next);
}

// Any non-terminal state -> cancelled. A controller/admin override, always
// reasoned and preserved in history — mirrors the PO engine's forced-close
// pattern rather than a silent delete.
export function cancelChangeOrder(co, actor, { reason, now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  requireStatus(co, ['draft', 'sent', 'approved', 'rejected'], 'cancel');
  let next = { ...co, lifecycleStatus: 'cancelled', cancelledAt: now, cancelReason: String(reason || '').trim() || null };
  next = appendHistory(next, { type: 'cancelled', actor, now, detail: { reason: reason || null } });
  return withComputedStatus(next);
}

// ---------------------------------------------------------------------------
// Display status — "overdue" is a computed overlay over the true lifecycle
// state (mirrors the PO engine's "exception" overlay), so an approval that's
// running late is visibly flagged without inventing a new lifecycle state
// for it or losing the underlying true status.
// ---------------------------------------------------------------------------
export function withComputedStatus(co) {
  const today = new Date().toISOString().slice(0, 10);
  const overdue = co.lifecycleStatus === 'sent' && co.targetApprovalBy && co.targetApprovalBy < today;
  const totals = changeOrderTotals(co);
  return { ...co, displayStatus: overdue ? 'overdue' : co.lifecycleStatus, totals };
}

// ---------------------------------------------------------------------------
// Reporting — the two views Chris asked for: change orders rolled into the
// parent job's profitability as an additional activity, AND a standalone
// drill-down into just the change order itself.
// ---------------------------------------------------------------------------

// Committed dollars (paid or converted) count toward the job's actual
// profitability. Approved-but-unpaid and sent/draft are shown as pipeline —
// visible, but never blended into the committed total, the same discipline
// the PO engine uses to keep preapproved vs. after-the-fact separate.
const COMMITTED_STATES = Object.freeze(['paid', 'converted']);

export function changeOrderProfitabilityForJob(changeOrders, jobId) {
  const forJob = (changeOrders || []).filter(co => co.jobId === jobId);
  const committed = forJob.filter(co => COMMITTED_STATES.includes(co.lifecycleStatus));
  const pipeline = forJob.filter(co => !COMMITTED_STATES.includes(co.lifecycleStatus) && co.lifecycleStatus !== 'rejected' && co.lifecycleStatus !== 'cancelled');

  const sum = list => list.reduce((acc, co) => {
    const t = changeOrderTotals(co);
    return { cost: acc.cost + t.cost, price: acc.price + t.price };
  }, { cost: 0, price: 0 });

  const committedTotals = sum(committed);
  const pipelineTotals = sum(pipeline);

  return {
    jobId,
    changeOrderCount: forJob.length,
    committed: {
      count: committed.length,
      additionalCost: money(committedTotals.cost),
      additionalRevenue: money(committedTotals.price),
      additionalMargin: money(committedTotals.price - committedTotals.cost)
    },
    pipeline: {
      count: pipeline.length,
      potentialRevenue: money(pipelineTotals.price)
    },
    changeOrders: forJob.map(co => ({ coNumber: co.coNumber, kind: co.kind, lifecycleStatus: co.lifecycleStatus, displayStatus: withComputedStatus(co).displayStatus, totals: changeOrderTotals(co) }))
  };
}

// Standalone drill-down for a single change order — its own P&L, independent
// of the parent job's blended numbers.
export function changeOrderDrilldown(co) {
  const totals = changeOrderTotals(co);
  return {
    coNumber: co.coNumber,
    jobId: co.jobId,
    kind: co.kind,
    lifecycleStatus: co.lifecycleStatus,
    displayStatus: withComputedStatus(co).displayStatus,
    description: co.description,
    reasonCategory: co.reasonCategory,
    scheduleImpactDays: co.scheduleImpactDays,
    totals,
    paidTotal: co.paidTotal || 0,
    paidCreditedTotal: co.paidCreditedTotal != null ? co.paidCreditedTotal : (co.paidTotal || 0),
    // balanceDue is against the POSTED (card) total; balanceDueCash is the
    // same balance settled by cash/check/ACH (cash discount applied).
    balanceDue: money(totals.cardPrice - (co.paidCreditedTotal != null ? co.paidCreditedTotal : (co.paidTotal || 0))),
    balanceDueCash: totals.cardPrice > 0
      ? money((totals.cardPrice - (co.paidCreditedTotal != null ? co.paidCreditedTotal : (co.paidTotal || 0))) * (totals.price / totals.cardPrice))
      : 0,
    lines: (co.lines || []).map(line => ({ ...line, cost: lineCost(line), price: linePrice(line) })),
    payments: co.payments || [],
    history: co.history || [],
    convertedJobId: co.convertedJobId || null
  };
}
