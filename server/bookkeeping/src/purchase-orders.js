// Purchase order engine — company-controlled sequential numbering, job/vendor/
// requester/approver linkage, estimate-vs-actual tracking, idempotent receipt/
// bill matching, exception detection, enforced state transitions, and an
// append-only, hash-chained audit history.
//
// Rewritten 2026-07-21 in response to an outside review that reproduced four
// real bugs in the first version:
//   1. Planned-vs-after-the-fact was decided from receipt UPLOAD time, which
//      is trivially gamed by uploading late. Fixed: timing is now decided
//      from the PO's own immutable approval/order timestamp compared against
//      the receipt's VENDOR TRANSACTION date (the date on the vendor's own
//      document), never upload time. If no vendor transaction date exists,
//      the match is allowed but flagged for controller review rather than
//      silently treated as clean.
//   2. A draft, unapproved PO could release actual costs into job costing.
//      Fixed: approvedActualCostsForJobCosting now hard-blocks anything that
//      isn't approved (has approvedAt) and past draft/cancelled.
//   3. Matching the same receipt twice doubled received quantity/amount.
//      Fixed: every match carries a deterministic idempotency key (company +
//      evidence/document id + receipt line id + PO line id + allocation id);
//      a replayed key is a no-op, not a second application.
//   4. Sequential numbering was computed from array length, which races and
//      can reuse a number if a PO is filtered out of the array it's compared
//      against. Fixed: numbering is now a pure function over an explicit,
//      caller-supplied durable counter state — it never inspects an array of
//      existing purchase orders. The caller (API layer) is responsible for
//      reading, incrementing, and writing that counter atomically inside one
//      database transaction; this module cannot do that itself since it has
//      no I/O, but it can no longer be misused to derive a number by
//      counting rows.
//
// Also addressed per the same review: enforced state-machine transitions
// (draft/closed/cancelled reject invalid actions), split-total and
// reconciliation validation on receipt matching, weighted (not last-write)
// actual unit price, explicit server-side actor authentication requirement
// (never trust actor identity/role from request bodies), company/tenant
// scoping on every cross-entity check, controller-authorized + reasoned
// forced close with the override preserved in history, a permanent
// "notPreapproved" flag kept separate from the resolvable exceptions list,
// stronger duplicate-bill matching, configurable percent+dollar variance
// tolerances, and a QBO Purchase Order preview that follows the real schema
// constraints (DocNumber length, valid vendor/item references, required
// line-detail fields) and reports itself incomplete rather than fabricating
// a payload QBO would reject.

import { createHash, randomUUID } from 'node:crypto';

const money = value => Math.round((Number(value) || 0) * 100) / 100;
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)))
  : item);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const startOfDay = value => { const d = new Date(value); d.setUTCHours(0, 0, 0, 0); return d; };

export const PO_LINE_TYPES = Object.freeze(['material', 'labor', 'rental', 'delivery', 'discount', 'tax']);
// Internal, true life-cycle states (never skipped, never regressed except via cancel).
export const PO_LIFECYCLE_STATES = Object.freeze(['draft', 'ordered', 'partially_received', 'fully_received', 'billed', 'closed', 'cancelled']);
// Displayed states include "exception" as a computed overlay — see withComputedStatus.
export const PO_DISPLAY_STATES = Object.freeze([...PO_LIFECYCLE_STATES, 'exception']);
export const PO_ORDER_TYPES = Object.freeze(['planned', 'after_the_fact']);
export const PO_EXCEPTION_TYPES = Object.freeze([
  'duplicate_bill', 'excess_quantity', 'excess_price', 'unexpected_tax', 'missing_receipt', 'over_authorization', 'planning_unverified'
]);

export const DEFAULT_TOLERANCES = Object.freeze({ percentTolerance: 0.05, dollarTolerance: 25 });

// ---------------------------------------------------------------------------
// Actor / tenant guards — never trust client-supplied identity or role.
// The API layer must populate `actor` from a server-verified session
// (matching HiveLogic's trusted-reverse-proxy identity pattern), not from
// request body fields. These guards exist so the engine itself refuses to
// proceed without that shape, even if a caller forgets.
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
// Sequential numbering — pure function over a durable counter the caller
// owns. NEVER derives a number from counting an array of existing purchase
// orders (that races and can reuse numbers). The caller must persist
// `nextCounterState` atomically, in the same database transaction that
// inserts the new PO row (e.g. `SELECT ... FOR UPDATE` or an atomic
// increment with optimistic-concurrency retry). Because the counter only
// ever increments and is never rolled back on cancellation or deletion, a
// cancelled or deleted PO's number can never be reused.
// ---------------------------------------------------------------------------
export function allocatePurchaseOrderNumber(counterState, { jobId, companyId, companyCode = 'PO' } = {}) {
  if (!companyId) throw new Error('A company ID is required to allocate a purchase order number.');
  const key = jobId ? `job:${jobId}` : 'general';
  const counters = counterState?.counters || {};
  const nextSequence = (counters[key] || 0) + 1;
  const poNumber = jobId
    ? `${companyCode}-${jobId}-${String(nextSequence).padStart(2, '0')}`
    : `${companyCode}-GEN-${String(nextSequence).padStart(4, '0')}`;
  return {
    poNumber,
    nextCounterState: { ...(counterState || {}), companyId, counters: { ...counters, [key]: nextSequence } }
  };
}

// ---------------------------------------------------------------------------
// Creation and validation
// ---------------------------------------------------------------------------
export function validatePurchaseOrderInput(input = {}) {
  const errors = [];
  if (!input.companyId) errors.push('A company ID is required.');
  if (!input.jobId && !input.overheadCategory) errors.push('A purchase order needs a job or an overhead category.');
  if (!input.vendorName?.trim() && !input.qboVendorId) errors.push('A vendor or subcontractor is required.');
  if (!input.requestedBy?.trim()) errors.push('A requester is required.');
  if (!Array.isArray(input.lines) || !input.lines.length) errors.push('A purchase order needs at least one line.');
  for (const [index, line] of (input.lines || []).entries()) {
    if (!PO_LINE_TYPES.includes(line.type)) errors.push(`Line ${index + 1} needs a valid type (${PO_LINE_TYPES.join(', ')}).`);
    if (!(Number(line.estimatedQty) > 0) && line.type !== 'discount' && line.type !== 'tax') errors.push(`Line ${index + 1} needs an estimated quantity greater than zero.`);
    if (!(Number(line.estimatedUnitPrice) >= 0)) errors.push(`Line ${index + 1} needs an estimated unit price.`);
  }
  if (input.orderType && !PO_ORDER_TYPES.includes(input.orderType)) errors.push('Order type must be "planned" or "after_the_fact".');
  if (input.orderType === 'after_the_fact' && !String(input.afterTheFactReason || '').trim()) errors.push('An after-the-fact purchase requires a reason since no PO existed before the purchase.');
  return { valid: errors.length === 0, errors };
}

export function lineEstimatedAmount(line) {
  const qty = Number(line.estimatedQty) || (line.type === 'discount' || line.type === 'tax' ? 1 : 0);
  const amount = money(qty * (Number(line.estimatedUnitPrice) || 0));
  return line.type === 'discount' ? -Math.abs(amount) : amount;
}

export function purchaseOrderEstimatedTotal(po) {
  return money((po.lines || []).reduce((sum, line) => sum + lineEstimatedAmount(line), 0));
}

export function createPurchaseOrder(input, actor, { counterState, now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  const validation = validatePurchaseOrderInput(input);
  if (!validation.valid) throw new Error(validation.errors.join(' '));
  if (input.companyId !== actor.companyId && actor.companyId) throw new Error('The requesting actor is not scoped to this company.');

  const orderType = input.orderType || 'planned';
  const allocation = input.poNumber
    ? { poNumber: input.poNumber, nextCounterState: counterState }
    : allocatePurchaseOrderNumber(counterState, { jobId: input.jobId, companyId: input.companyId, companyCode: input.companyCode });

  const lines = input.lines.map((line, index) => ({
    id: line.id || randomUUID(),
    index,
    type: line.type,
    description: line.description || '',
    estimatedQty: Number(line.estimatedQty) || 0,
    estimatedUnitPrice: money(line.estimatedUnitPrice),
    estimatedAmount: lineEstimatedAmount(line),
    taxable: !!line.taxable,
    qboItemId: line.qboItemId || null,
    qboAccountId: line.qboAccountId || null,
    receivedQty: 0,
    receivedAmount: 0,
    actualUnitPrice: null,
    appliedMatches: []
  }));

  let po = {
    id: randomUUID(),
    poNumber: allocation.poNumber,
    companyId: input.companyId,
    jobId: input.jobId || null,
    overheadCategory: input.overheadCategory || null,
    vendorName: input.vendorName || '',
    qboVendorId: input.qboVendorId || null,
    requestedBy: input.requestedBy,
    approverId: null,
    orderType,
    // Immutable from creation onward. Never toggled, never cleared by approval
    // or closure — an approved emergency purchase still shows this forever.
    notPreapproved: orderType === 'after_the_fact',
    afterTheFactReason: orderType === 'after_the_fact' ? String(input.afterTheFactReason || '').trim() : null,
    lifecycleStatus: 'draft',
    // Resolvable flags — cleared or added as receiving/approval progresses.
    // Distinct from notPreapproved, which never changes.
    exceptions: [],
    appliedMatchKeys: [],
    lines,
    receiptIds: [],
    billIds: [],
    cancelled: false,
    cancelReason: null,
    closedForced: false,
    closeOverrideReason: null,
    closeOverrideBy: null,
    requestedAt: now,
    approvedAt: null,
    orderedAt: null,
    createdAt: now,
    createdBy: actor.id,
    updatedAt: now,
    history: []
  };
  po = appendHistory(po, { type: 'created', actor, now, detail: { orderType, poNumber: po.poNumber } });
  return { purchaseOrder: withComputedStatus(po), nextCounterState: allocation.nextCounterState };
}

// ---------------------------------------------------------------------------
// Display status — "exception" is a computed overlay over the true lifecycle
// state, not a lifecycle state itself. This lets an approved, in-progress PO
// keep advancing normally (ordered → received → billed → closed) even while
// carrying resolvable exceptions or the permanent notPreapproved flag, and
// still satisfies "show ... exception" as one of the states a user sees.
// ---------------------------------------------------------------------------
export function withComputedStatus(po) {
  const status = (po.exceptions || []).length > 0 ? 'exception' : po.lifecycleStatus;
  return { ...po, status };
}

// ---------------------------------------------------------------------------
// Append-only, hash-chained history
// ---------------------------------------------------------------------------
function appendHistory(po, event) {
  const previousHash = po.history.at(-1)?.hash || null;
  const record = { id: randomUUID(), previousHash, at: event.now, actorId: event.actor?.id || null, actorRole: event.actor?.role || null, type: event.type, detail: event.detail || {} };
  record.hash = digest({ previousHash, record: { ...record, hash: undefined } });
  return { ...po, history: [...po.history, record], updatedAt: event.now };
}

export function verifyPurchaseOrderHistory(po) {
  let previousHash = null;
  for (const record of po.history || []) {
    const expected = digest({ previousHash, record: { ...record, hash: undefined } });
    if (record.previousHash !== previousHash || record.hash !== expected) return { valid: false, brokenAt: record.id };
    previousHash = record.hash;
  }
  return { valid: true, records: (po.history || []).length };
}

// Round 3 correction #8: every mutating function must verify the existing
// history chain BEFORE applying its own change, not just leave
// verifyPurchaseOrderHistory as a function nothing actually calls. A PO
// whose stored history has been tampered with (a record edited or removed,
// e.g. by a direct database write bypassing this module) must be refused
// further mutation until a human investigates -- silently accepting more
// history on top of an already-broken chain would let the tampering hide
// behind a longer, plausible-looking trail.
function assertHistoryIntact(po) {
  const result = verifyPurchaseOrderHistory(po);
  if (!result.valid) {
    const error = new Error(
      `Purchase order ${po.poNumber || po.id}'s history chain has been tampered with or corrupted (broken at record ${result.brokenAt}). ` +
      'Refusing to apply further mutations until this is investigated.'
    );
    error.code = 'HISTORY_CHAIN_BROKEN';
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Approval requirement and enforcement
// ---------------------------------------------------------------------------
export function requiresApproval(po, { requesterLimit = 0 } = {}) {
  if (po.orderType === 'after_the_fact') return true;
  const total = purchaseOrderEstimatedTotal(po);
  return requesterLimit > 0 && total > requesterLimit;
}

export function approvePurchaseOrder(po, actor, { now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  assertSameCompany(po, actor, 'Approving this purchase order');
  assertHistoryIntact(po);
  if (!['approver', 'controller', 'bookkeeper'].includes(actor.role)) throw new Error('Only an approver, controller, or bookkeeper can approve a purchase order.');
  if (actor.id === po.requestedBy) throw new Error('The requester cannot approve their own purchase order.');
  if (po.lifecycleStatus !== 'draft') throw new Error(`A purchase order in "${po.lifecycleStatus}" status cannot be approved again.`);
  const next = { ...po, approverId: actor.id, approvedAt: now, orderedAt: now, lifecycleStatus: 'ordered' };
  return withComputedStatus(appendHistory(next, { type: 'approved', actor, now }));
}

export function rejectPurchaseOrder(po, actor, reason, { now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  assertSameCompany(po, actor, 'Rejecting this purchase order');
  assertHistoryIntact(po);
  if (!['approver', 'controller', 'bookkeeper'].includes(actor.role)) throw new Error('Only an approver, controller, or bookkeeper can reject a purchase order.');
  if (po.lifecycleStatus !== 'draft') throw new Error(`A purchase order in "${po.lifecycleStatus}" status cannot be rejected.`);
  if (!String(reason || '').trim()) throw new Error('A reason is required to reject a purchase order.');
  const next = { ...po, lifecycleStatus: 'cancelled', cancelled: true, cancelReason: `Rejected: ${reason}` };
  return withComputedStatus(appendHistory(next, { type: 'rejected', actor, now, detail: { reason } }));
}

// Round 3 correction #7: only these fields describe what was actually
// requested/planned and can be legitimately edited while a PO is still a
// draft. Everything else -- lifecycle, approval, history, identity,
// matching, audit, and creation fields -- is never editable through a
// revision, no matter what a caller's `changes` object contains. The
// previous implementation spread `changes` onto the PO wholesale and only
// pinned back a handful of fields (id/poNumber/companyId/orderType/
// notPreapproved) -- everything else, including lifecycleStatus, history,
// approverId, exceptions, appliedMatchKeys, receiptIds, billIds, requestedBy,
// and cancelled/closedForced, could be silently overwritten by a caller.
const DRAFT_REVISABLE_FIELDS = ['jobId', 'overheadCategory', 'vendorName', 'qboVendorId', 'lines', 'afterTheFactReason'];

export function revisePurchaseOrder(po, actor, changes, { now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  assertSameCompany(po, actor, 'Revising this purchase order');
  assertHistoryIntact(po);
  if (po.lifecycleStatus !== 'draft') throw new Error('Only a draft purchase order can be revised. Approved purchase orders require a new, separately numbered PO that references this one.');

  const attempted = Object.keys(changes || {});
  const rejected = attempted.filter(key => !DRAFT_REVISABLE_FIELDS.includes(key));
  if (rejected.length) {
    throw new Error(
      `revisePurchaseOrder cannot change ${rejected.join(', ')}. Only ${DRAFT_REVISABLE_FIELDS.join(', ')} may be edited on a draft purchase order -- ` +
      'lifecycle, approval, history, identity, matching, audit, and creation fields are never editable through a revision.'
    );
  }

  const allowed = {};
  for (const field of DRAFT_REVISABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(changes || {}, field)) allowed[field] = changes[field];
  }

  // Lines are rebuilt through the same normalization createPurchaseOrder
  // uses, and every matching-related sub-field is always carried over from
  // the ORIGINAL line by id, never taken from the caller's input. A draft PO
  // can't have received anything yet (assertCanReceive blocks matching until
  // a PO is approved and ordered), so this is a structural guarantee, not an
  // incidental one.
  if (allowed.lines) {
    const originalById = new Map(po.lines.map(l => [l.id, l]));
    allowed.lines = allowed.lines.map((line, index) => {
      const original = line.id ? originalById.get(line.id) : null;
      return {
        id: (original && original.id) || randomUUID(),
        index,
        type: line.type,
        description: line.description || '',
        estimatedQty: Number(line.estimatedQty) || 0,
        estimatedUnitPrice: money(line.estimatedUnitPrice),
        estimatedAmount: lineEstimatedAmount(line),
        taxable: !!line.taxable,
        qboItemId: line.qboItemId || null,
        qboAccountId: line.qboAccountId || null,
        receivedQty: original ? original.receivedQty : 0,
        receivedAmount: original ? original.receivedAmount : 0,
        actualUnitPrice: original ? original.actualUnitPrice : null,
        appliedMatches: original ? original.appliedMatches : []
      };
    });
  }

  const next = { ...po, ...allowed, id: po.id, poNumber: po.poNumber, companyId: po.companyId, orderType: po.orderType, notPreapproved: po.notPreapproved };

  // Round 5 fix: the field allowlist (correction #7) stopped a revision from
  // forging protected fields, but never re-ran the same business-rule
  // validation createPurchaseOrder enforces -- a revision could legally
  // empty out the vendor, job, overhead category, or every line and produce
  // a structurally invalid PO. Every revision must still be a valid PO.
  const validation = validatePurchaseOrderInput(next);
  if (!validation.valid) throw new Error(`This revision would make the purchase order invalid: ${validation.errors.join(' ')}`);

  return withComputedStatus(appendHistory(next, { type: 'revised', actor, now, detail: { changedFields: Object.keys(allowed) } }));
}

// ---------------------------------------------------------------------------
// Enforced state-machine guards for receiving
// ---------------------------------------------------------------------------
function assertCanReceive(po) {
  if (po.cancelled || po.lifecycleStatus === 'cancelled') throw new Error(`Purchase order ${po.poNumber} is cancelled and cannot receive goods or match bills.`);
  if (po.lifecycleStatus === 'closed') throw new Error(`Purchase order ${po.poNumber} is closed and cannot receive goods or match bills.`);
  if (po.lifecycleStatus === 'draft') throw new Error(`Purchase order ${po.poNumber} must be approved and ordered before it can receive goods or match bills.`);
}

// ---------------------------------------------------------------------------
// Timing verification — the actual hard rule from the review. Compares the
// PO's own immutable orderedAt timestamp (set only once, at approval) against
// the receipt's VENDOR transaction date (the date on the vendor's document),
// never the file's upload time. Upload time is not read anywhere in this
// function, so uploading a receipt late cannot retroactively legitimize a PO.
// ---------------------------------------------------------------------------
// A vendor-stamped timestamp that lands exactly on UTC midnight is
// indistinguishable from a bare calendar date with no real time-of-day
// attached (most receipt/vendor feeds do exactly this when they only have a
// date, not a POS clock time) -- it cannot be trusted as proof of exactly
// when in the day the purchase happened.
function hasAuthoritativeTimeOfDay(iso) {
  const d = new Date(iso);
  return !(d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0);
}

export function evaluateOrderTiming(po, receipt) {
  if (!po.orderedAt) return { blocked: true, reason: `Purchase order ${po.poNumber} has not been approved and ordered yet.` };
  if (!receipt.vendorTransactionDate) {
    return {
      blocked: false,
      requiresControllerReview: true,
      reason: 'No vendor transaction date is available on this receipt, so ordering cannot be verified against the purchase order\'s approval date. Flagged for controller review rather than assumed planned.'
    };
  }

  const purchaseDay = startOfDay(receipt.vendorTransactionDate);
  const orderedDay = startOfDay(po.orderedAt);

  if (purchaseDay < orderedDay) {
    return {
      blocked: true,
      reason: `This purchase happened on ${receipt.vendorTransactionDate.slice(0, 10)}, before ${po.poNumber} was approved and ordered on ${po.orderedAt.slice(0, 10)}. It cannot be recorded as a planned, preapproved purchase — record it as an after-the-fact purchase instead.`
    };
  }

  if (purchaseDay > orderedDay) {
    // A later calendar day is unambiguous proof the purchase followed
    // ordering -- no time-of-day precision is needed to trust this.
    return { blocked: false, requiresControllerReview: false };
  }

  // Round 3 correction #6: same calendar day is NOT, by itself, proof that
  // approval actually came before the purchase within that day -- the
  // previous logic treated "not an earlier calendar day" as fully verified,
  // which is exactly the loophole the review reproduced (approve and
  // purchase minutes apart, in either order, on the same day, and it always
  // passed as planned). Only a genuine, non-midnight vendor timestamp that
  // is provably at or after the PO's own orderedAt instant counts as real
  // proof; anything else on a same-day match is unverified.
  const purchaseHasRealTime = hasAuthoritativeTimeOfDay(receipt.vendorTransactionDate);
  if (purchaseHasRealTime) {
    const purchaseInstant = new Date(receipt.vendorTransactionDate).getTime();
    const orderedInstant = new Date(po.orderedAt).getTime();
    if (purchaseInstant < orderedInstant) {
      return {
        blocked: true,
        reason: `This purchase happened at ${receipt.vendorTransactionDate}, before ${po.poNumber} was approved and ordered at ${po.orderedAt}, even though both fall on the same calendar day. It cannot be recorded as a planned, preapproved purchase — record it as an after-the-fact purchase instead.`
      };
    }
    return { blocked: false, requiresControllerReview: false };
  }

  return {
    blocked: false,
    requiresControllerReview: true,
    reason: `This purchase and ${po.poNumber}'s approval both fall on ${po.orderedAt.slice(0, 10)}. Same-day timing cannot be treated as verified without an authoritative purchase timestamp proving approval came first — flagged for controller review.`
  };
}

function assertNotRetroactive(po, receipt) {
  if (po.orderType !== 'planned') return { requiresControllerReview: false };
  const timing = evaluateOrderTiming(po, receipt);
  if (timing.blocked) {
    const error = new Error(timing.reason);
    error.code = 'RETROACTIVE_PLANNING_BLOCKED';
    throw error;
  }
  return timing;
}

// Kept for backward compatibility with earlier callers/tests; delegates to
// the timing-based check above rather than the old, gameable upload-time check.
export function assertNotRetroactivePlanning(po, receipt) {
  assertNotRetroactive(po, receipt);
}

export function assertOrderTypeImmutable(po, nextOrderType) {
  if (nextOrderType && nextOrderType !== po.orderType) {
    throw new Error('A purchase order\'s order type cannot be changed after creation. Record a new, corrected purchase order and reference this one instead.');
  }
}

// ---------------------------------------------------------------------------
// Receipt / bill matching — many-to-many, idempotent, split-validated,
// company-scoped, weighted-price. One receipt can cover multiple POs, one PO
// can receive multiple receipts, and one receipt line can split across
// multiple PO lines (jobs/owners) as long as the splits total exactly 100%
// and the matched dollar amount reconciles to the receipt line.
// ---------------------------------------------------------------------------
export function matchReceiptToPurchaseOrders(purchaseOrders, receipt, matches, actor, { now = new Date().toISOString(), tolerances = DEFAULT_TOLERANCES, existingBills = [] } = {}) {
  assertActorAuthenticated(actor);
  if (!receipt?.id) throw new Error('A receipt with an id is required to match.');
  if (!receipt.companyId) throw new Error('The receipt must carry a company ID.');
  if (!matches?.length) throw new Error('At least one purchase order line match is required.');
  // Round 3 correction #8: verify every PO this call could touch BEFORE
  // applying any match to any of them -- a tampered history on even one PO
  // in a multi-PO batch must block the whole batch, not just that one PO.
  for (const po of purchaseOrders) assertHistoryIntact(po);
  for (const match of matches) {
    if (!match.receiptLineId) throw new Error('Each match requires a receiptLineId.');
    if (!match.poId || !match.lineId) throw new Error('Each match requires a poId and lineId.');
  }
  // Round 5 fix: quantity, unit price, and splitPortion were only ever
  // coerced with `Number(x) || 0` -- a negative number is truthy and passes
  // straight through unchanged, so a negative quantity/price was silently
  // accepted and could produce a "fully received" PO with a negative
  // receivedQty/receivedAmount. Every one of these must be a finite,
  // non-negative number (splitPortion additionally capped at 1, since a
  // share of a receipt line can never exceed the whole line).
  for (const match of matches) {
    const quantity = Number(match.quantity);
    const unitPrice = Number(match.unitPrice);
    const portion = match.splitPortion != null ? Number(match.splitPortion) : 1;
    if (!Number.isFinite(quantity) || quantity < 0) throw new Error(`Match for receipt line ${match.receiptLineId} has an invalid quantity (must be a finite number >= 0).`);
    if (match.unitPrice != null && (!Number.isFinite(unitPrice) || unitPrice < 0)) throw new Error(`Match for receipt line ${match.receiptLineId} has an invalid unit price (must be a finite number >= 0).`);
    if (!Number.isFinite(portion) || portion <= 0 || portion > 1) throw new Error(`Match for receipt line ${match.receiptLineId} has an invalid splitPortion (must be > 0 and <= 1).`);
  }

  // Splits for a given receipt line must total exactly 100% and reconcile to
  // the receipt line's own recorded amount, if the receipt carries lines.
  const byReceiptLine = new Map();
  for (const m of matches) byReceiptLine.set(m.receiptLineId, [...(byReceiptLine.get(m.receiptLineId) || []), m]);
  for (const [receiptLineId, group] of byReceiptLine) {
    const totalPortion = group.reduce((sum, m) => sum + (m.splitPortion != null ? Number(m.splitPortion) : 1), 0);
    if (Math.abs(totalPortion - 1) > 0.0005) throw new Error(`Splits for receipt line ${receiptLineId} must total exactly 100% (got ${(totalPortion * 100).toFixed(2)}%).`);
    const receiptLine = (receipt.lines || []).find(l => l.id === receiptLineId);
    if (receiptLine) {
      // Round 3 correction #3: this must apply each match's splitPortion --
      // a 60/40 split across two matches both carry the SAME quantity (the
      // full receipt-line quantity) with different portions (see appliedQty
      // / appliedAmount below, which already do this correctly). Without
      // multiplying by portion here, summing two full-quantity amounts for
      // what is really one split receipt line would double-count it and
      // never reconcile to the receipt line's real amount.
      const matchedTotal = money(group.reduce((sum, m) => {
        const portion = m.splitPortion != null ? Number(m.splitPortion) : 1;
        return sum + money((Number(m.quantity) || 0) * (Number(m.unitPrice) || 0) * portion);
      }, 0));
      if (Math.abs(matchedTotal - money(receiptLine.amount)) > 0.01) {
        throw new Error(`Matched amounts for receipt line ${receiptLineId} ($${matchedTotal.toFixed(2)}) must reconcile exactly to the receipt line amount ($${money(receiptLine.amount).toFixed(2)}).`);
      }
    }
  }

  const byId = new Map(purchaseOrders.map(po => [po.id, po]));
  const touched = new Set();

  for (const match of matches) {
    const po = byId.get(match.poId);
    if (!po) throw new Error(`Purchase order ${match.poId} was not found.`);
    assertSameCompany(po, receipt, 'Matching this receipt');
    assertSameCompany(po, actor, 'Matching this receipt');
    assertCanReceive(po);
    const line = po.lines.find(l => l.id === match.lineId);
    if (!line) throw new Error(`Purchase order line ${match.lineId} was not found on ${po.poNumber}.`);

    // Idempotency key: replaying the exact same match (e.g. a retried request,
    // a duplicate webhook, a user double-click) is a safe no-op, not a second
    // application of the same quantity/amount.
    const matchKey = [po.companyId, receipt.evidenceDocumentId || receipt.id, match.receiptLineId, match.lineId, match.allocationId ?? '0'].join('::');
    if (po.appliedMatchKeys.includes(matchKey)) { touched.add(po.id); continue; }

    const timing = assertNotRetroactive(po, receipt);
    const exceptions = new Set(po.exceptions);
    if (timing.requiresControllerReview) exceptions.add('planning_unverified');

    const quantity = Number(match.quantity) || 0;
    const unitPrice = Number(match.unitPrice ?? line.estimatedUnitPrice) || 0;
    const portion = match.splitPortion != null ? Number(match.splitPortion) : 1;
    const appliedQty = money(quantity * portion);
    const appliedAmount = money(quantity * unitPrice * portion);
    const appliedMatch = { matchKey, receiptId: receipt.id, receiptLineId: match.receiptLineId, quantity: appliedQty, unitPrice, amount: appliedAmount, at: now };

    const nextAppliedMatches = [...line.appliedMatches, appliedMatch];
    const receivedQty = money(nextAppliedMatches.reduce((sum, m) => sum + m.quantity, 0));
    const receivedAmount = money(nextAppliedMatches.reduce((sum, m) => sum + m.amount, 0));
    // Weighted average actual unit price across every applied match — never
    // just the most recent match's price.
    const actualUnitPrice = receivedQty > 0 ? money(receivedAmount / receivedQty) : null;

    const nextLine = { ...line, appliedMatches: nextAppliedMatches, receivedQty, receivedAmount, actualUnitPrice };
    const nextLines = po.lines.map(l => l.id === line.id ? nextLine : l);
    const receiptIds = [...new Set([...po.receiptIds, receipt.id])];

    let next = { ...po, lines: nextLines, receiptIds, appliedMatchKeys: [...po.appliedMatchKeys, matchKey] };
    const detected = detectExceptions(next, { receipt, existingBills, tolerances });
    next.exceptions = [...new Set([...exceptions, ...detected])];
    next.lifecycleStatus = computeReceivingLifecycle(next);
    next = appendHistory(next, { type: 'receipt_matched', actor, now, detail: { receiptId: receipt.id, lineId: line.id, quantity, unitPrice, matchKey } });

    byId.set(po.id, next);
    touched.add(po.id);
  }

  return [...touched].map(id => withComputedStatus(byId.get(id)));
}

export function computeReceivingLifecycle(po) {
  if (po.cancelled || po.lifecycleStatus === 'cancelled') return 'cancelled';
  if (po.billIds?.length) return 'billed';
  const estimated = purchaseOrderEstimatedTotal(po);
  const received = money((po.lines || []).reduce((sum, line) => sum + (line.receivedAmount || 0), 0));
  if (received <= 0) return po.lifecycleStatus === 'draft' ? 'draft' : 'ordered';
  if (received >= estimated - 0.01) return 'fully_received';
  return 'partially_received';
}

// Retained for compatibility with earlier callers.
export function computeReceivingState(po) { return computeReceivingLifecycle(po); }

// ---------------------------------------------------------------------------
// Exception detection — configurable percent AND dollar tolerance (both must
// be exceeded to flag a price/quantity variance, so a 10%-over-estimate $4
// bag of screws doesn't trip the same alarm as a 10%-over-estimate $4,000
// lumber order).
// ---------------------------------------------------------------------------
export function detectExceptions(po, { receipt, existingBills = [], tolerances = DEFAULT_TOLERANCES } = {}) {
  const flags = new Set(po.exceptions?.filter(e => e === 'planning_unverified') || []);

  for (const line of po.lines || []) {
    if (line.estimatedQty > 0 && line.receivedQty > 0) {
      const qtyVariancePct = (line.receivedQty - line.estimatedQty) / line.estimatedQty;
      if (qtyVariancePct > tolerances.percentTolerance) flags.add('excess_quantity');
    }
    if (line.actualUnitPrice != null && line.estimatedUnitPrice > 0) {
      const priceVariancePct = (line.actualUnitPrice - line.estimatedUnitPrice) / line.estimatedUnitPrice;
      const dollarImpact = Math.abs(line.actualUnitPrice - line.estimatedUnitPrice) * (line.receivedQty || line.estimatedQty);
      if (priceVariancePct > tolerances.percentTolerance && dollarImpact > tolerances.dollarTolerance) flags.add('excess_price');
    }
    if (!line.taxable && line.type === 'tax' && line.receivedAmount > 0) flags.add('unexpected_tax');
  }

  if (receipt) {
    // Round 3 correction #9: standardized on `amount` (not `total`) as the
    // one canonical field name for a bill/receipt's dollar value -- this now
    // matches the storage layer's own naming (_store.js / po_seen_bills.amount)
    // exactly, so a bill round-tripped through the durable or memory store
    // arrives here in the shape this check actually expects, rather than
    // silently never matching because of a total-vs-amount naming mismatch.
    const vendorMatches = existingBills.some(bill =>
      bill.companyId === po.companyId &&
      (receipt.qboVendorId || po.qboVendorId ? bill.qboVendorId === (receipt.qboVendorId || po.qboVendorId) : bill.vendorName === (receipt.vendorName || po.vendorName)) &&
      bill.invoiceNumber && receipt.invoiceNumber && bill.invoiceNumber === receipt.invoiceNumber &&
      (bill.currency || 'USD') === (receipt.currency || 'USD') &&
      Math.abs(money(bill.amount) - money(receipt.amount)) < 0.01
    );
    if (vendorMatches) flags.add('duplicate_bill');
  }

  const billedWithoutReceipt = (po.billIds?.length || 0) > 0 && (po.receiptIds?.length || 0) === 0;
  if (billedWithoutReceipt) flags.add('missing_receipt');

  return [...flags];
}

// ---------------------------------------------------------------------------
// Billing, closing, cancelling — enforced transitions throughout
// ---------------------------------------------------------------------------
export function markBilled(po, actor, billId, { now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  assertSameCompany(po, actor, 'Billing this purchase order');
  assertHistoryIntact(po);
  // Round 5 fix: this had NO role check at all -- any authenticated actor,
  // including a field/crew requester, could mark any PO billed. Billing is
  // an accounting action, not a field action.
  if (!['approver', 'controller', 'bookkeeper'].includes(actor.role)) {
    throw new Error('Only an approver, controller, or bookkeeper can mark a purchase order billed.');
  }
  if (!['ordered', 'partially_received', 'fully_received'].includes(po.lifecycleStatus)) {
    throw new Error(`Purchase order ${po.poNumber} cannot be billed from status "${po.lifecycleStatus}".`);
  }
  if (!billId) throw new Error('A bill ID is required.');
  const billIds = [...new Set([...po.billIds, billId])];
  const next = { ...po, billIds, lifecycleStatus: 'billed' };
  const detected = detectExceptions(next, {});
  next.exceptions = [...new Set([...po.exceptions, ...detected])];
  return withComputedStatus(appendHistory(next, { type: 'billed', actor, now, detail: { billId } }));
}

export function closePurchaseOrder(po, actor, { now = new Date().toISOString(), force = false, reason } = {}) {
  assertActorAuthenticated(actor);
  assertSameCompany(po, actor, 'Closing this purchase order');
  assertHistoryIntact(po);
  // Round 5 fix: plain (non-forced) close had no role check -- a field/crew
  // requester could close out any ordinary PO. Closing is an accounting
  // decision (it's what releases actual costs into job costing), so it's
  // restricted the same way billing is. Force-close stays controller-only,
  // as before.
  if (!['approver', 'controller', 'bookkeeper'].includes(actor.role)) {
    throw new Error('Only an approver, controller, or bookkeeper can close a purchase order.');
  }
  if (po.lifecycleStatus === 'closed') throw new Error(`Purchase order ${po.poNumber} is already closed.`);
  if (po.lifecycleStatus === 'cancelled') throw new Error(`A cancelled purchase order cannot be closed.`);
  if (po.lifecycleStatus === 'draft') throw new Error(`Purchase order ${po.poNumber} must be approved before it can be closed.`);
  if ((po.exceptions || []).length && !force) {
    throw new Error(`This purchase order has unresolved exceptions (${po.exceptions.join(', ')}) and cannot be closed without an authorized controller override.`);
  }
  if (force) {
    if (actor.role !== 'controller') throw new Error('Only a controller can force-close a purchase order with unresolved exceptions.');
    if (!String(reason || '').trim()) throw new Error('A written reason is required to force-close a purchase order with unresolved exceptions.');
  }
  const unresolvedAtClose = po.exceptions || [];
  // Closing (forced or not) resolves whatever was open — the override itself
  // is the resolution. The exceptions array means "still open, needs a
  // decision"; once closed there's nothing left open. The historical record
  // (unresolvedExceptionsAtClose below) is what permanently preserves what
  // was overridden and why — display status must read "closed", not
  // "exception", once this returns.
  const next = { ...po, lifecycleStatus: 'closed', exceptions: [], closedForced: !!force, closeOverrideReason: force ? reason : null, closeOverrideBy: force ? actor.id : null };
  return withComputedStatus(appendHistory(next, { type: 'closed', actor, now, detail: { forced: !!force, reason: force ? reason : null, unresolvedExceptionsAtClose: force ? unresolvedAtClose : [] } }));
}

// Whether a PO has any real financial activity posted against it yet --
// anything received or billed. Once true, it can no longer be silently
// cancelled (see cancelPurchaseOrder / voidPostedPurchaseOrder below).
function hasPostedActivity(po) {
  if (po.lifecycleStatus === 'billed') return true;
  return (po.lines || []).some(line => (line.receivedAmount || 0) > 0);
}

export function cancelPurchaseOrder(po, actor, reason, { now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  assertSameCompany(po, actor, 'Cancelling this purchase order');
  assertHistoryIntact(po);
  if (!reason?.trim()) throw new Error('A cancellation reason is required.');
  if (po.lifecycleStatus === 'closed') throw new Error('A closed purchase order cannot be cancelled.');
  if (po.lifecycleStatus === 'cancelled') throw new Error(`Purchase order ${po.poNumber} is already cancelled.`);
  // Round 5 fix: this had no role check and no distinction between
  // cancelling a harmless, never-received draft/ordered PO versus one that
  // already has real received/billed cost against it. A crew/field user
  // could previously cancel a billed PO and its $100 actual cost would
  // simply disappear from job costing (approvedActualCostsForJobCosting
  // excludes cancelled POs) -- with nothing left behind but a reason string.
  // Posted activity must go through voidPostedPurchaseOrder instead, which
  // preserves the original cost and records an explicit, equal-and-opposite
  // reversal rather than erasing it.
  if (hasPostedActivity(po)) {
    throw new Error(
      `${po.poNumber} already has received or billed activity against it and cannot be plain-cancelled -- ` +
      'call voidPostedPurchaseOrder instead, which preserves the original cost and records a reversal rather than erasing it.'
    );
  }
  const isOwnRequest = actor.id === po.requestedBy;
  if (!isOwnRequest && !['approver', 'controller', 'bookkeeper'].includes(actor.role)) {
    throw new Error('Only the original requester, an approver, a controller, or a bookkeeper can cancel this purchase order.');
  }
  const next = { ...po, cancelled: true, cancelReason: reason, lifecycleStatus: 'cancelled' };
  return withComputedStatus(appendHistory(next, { type: 'cancelled', actor, now, detail: { reason } }));
}

// Round 5 addition: the controller-only, audit-preserving reversal path for
// a PO that already has real received/billed cost against it. Unlike
// cancelPurchaseOrder, this does NOT change lifecycleStatus and does NOT
// touch any line's receivedAmount/receivedQty -- the original activity stays
// exactly as it was, forever. It only sets a `voided` flag + reason, which
// approvedActualCostsForJobCosting reads to emit an equal-and-opposite
// reversal line alongside the original -- so job costing shows both the
// original cost and its reversal (net zero), never silence.
export function voidPostedPurchaseOrder(po, actor, reason, { now = new Date().toISOString() } = {}) {
  assertActorAuthenticated(actor);
  assertSameCompany(po, actor, 'Voiding this purchase order');
  assertHistoryIntact(po);
  if (actor.role !== 'controller') throw new Error('Only a controller can void a purchase order that already has received or billed activity.');
  if (!String(reason || '').trim()) throw new Error('A written reason is required to void posted activity.');
  if (po.lifecycleStatus === 'cancelled') throw new Error(`Purchase order ${po.poNumber} is already cancelled.`);
  if (po.voided) throw new Error(`Purchase order ${po.poNumber} has already been voided.`);
  if (!hasPostedActivity(po)) {
    throw new Error(`${po.poNumber} has no received or billed activity yet -- use cancelPurchaseOrder for a plain cancellation instead.`);
  }
  const next = { ...po, voided: true, voidedAt: now, voidedBy: actor.id, voidReason: reason };
  return withComputedStatus(appendHistory(next, { type: 'voided', actor, now, detail: { reason } }));
}

// ---------------------------------------------------------------------------
// Job costing / bookkeeping feed — only approved actual costs, never a draft,
// never estimates, never while exceptions are unresolved unless closure was
// explicitly, auditably forced by a controller.
// ---------------------------------------------------------------------------
export function approvedActualCostsForJobCosting(po) {
  if (po.lifecycleStatus === 'draft') return { ready: false, reason: 'A draft, unapproved purchase order cannot release actual costs into job costing.', lines: [] };
  if (po.lifecycleStatus === 'cancelled') return { ready: false, reason: 'A cancelled purchase order cannot release actual costs into job costing.', lines: [] };
  if (!po.approvedAt) return { ready: false, reason: 'This purchase order has not been approved.', lines: [] };
  if ((po.exceptions || []).length && po.lifecycleStatus !== 'closed') {
    return { ready: false, reason: 'Unresolved exceptions must be cleared, or closure must be explicitly forced by a controller, before actual costs feed job costing.', lines: [] };
  }
  const originalLines = (po.lines || []).filter(line => line.receivedAmount > 0).map(line => ({
    jobId: po.jobId, poNumber: po.poNumber, lineId: line.id, type: line.type, description: line.description, amount: line.receivedAmount, notPreapproved: po.notPreapproved
  }));
  // Round 5 fix: a voided PO's original cost must stay visible, not vanish.
  // Every original line gets an equal-and-opposite reversal line alongside
  // it -- job costing shows both the original charge and its reversal
  // (net zero), with the reason and who voided it, rather than the cost
  // simply disappearing the way cancelling used to make it disappear.
  const lines = po.voided
    ? originalLines.flatMap(line => [line, {
        ...line, lineId: `${line.lineId}::reversal`, amount: -line.amount,
        description: `Reversal of "${line.description}" -- voided: ${po.voidReason || 'no reason given'}`,
        reversalOf: line.lineId, voidedBy: po.voidedBy, voidedAt: po.voidedAt
      }])
    : originalLines;
  return { ready: true, lines, total: money(lines.reduce((sum, l) => sum + l.amount, 0)) };
}

// ---------------------------------------------------------------------------
// QBO-compatible preview — never written live. Follows the real QBO Purchase
// Order schema constraints closely enough to be a meaningful preview: 21-char
// DocNumber limit, a real vendor reference (or an explicit incomplete flag if
// none is mapped yet), item- vs. account-based line detail depending on
// whether a QBO item is mapped, and a TxnDate.
// ---------------------------------------------------------------------------
export function toQboPurchaseOrderPreview(po) {
  const missingFields = [];
  if (!po.qboVendorId) missingFields.push('qboVendorId');
  const lines = (po.lines || []).map((line, index) => {
    const hasItem = !!line.qboItemId;
    if (!hasItem && !line.qboAccountId) missingFields.push(`line ${index + 1}: qboAccountId or qboItemId`);
    return {
      Id: String(index + 1),
      Amount: money(line.estimatedAmount),
      Description: line.description || '',
      DetailType: hasItem ? 'ItemBasedExpenseLineDetail' : 'AccountBasedExpenseLineDetail',
      ...(hasItem
        ? { ItemBasedExpenseLineDetail: { ItemRef: { value: line.qboItemId }, Qty: line.estimatedQty, UnitPrice: line.estimatedUnitPrice, TaxCodeRef: { value: 'NON' } } }
        : { AccountBasedExpenseLineDetail: { AccountRef: { value: line.qboAccountId || '' }, TaxCodeRef: { value: 'NON' } } })
    };
  });
  return {
    DocNumber: String(po.poNumber).slice(0, 21),
    TxnDate: po.orderedAt ? po.orderedAt.slice(0, 10) : undefined,
    VendorRef: po.qboVendorId ? { value: po.qboVendorId } : undefined,
    POStatus: po.lifecycleStatus === 'closed' ? 'Closed' : 'Open',
    PrivateNote: [`HiveLogic PO ${po.poNumber}`, po.notPreapproved ? `AFTER-THE-FACT PURCHASE — not preapproved. Reason: ${po.afterTheFactReason}` : null].filter(Boolean).join(' | ').slice(0, 4000),
    Line: lines,
    incomplete: missingFields.length > 0,
    missingFields
  };
}
