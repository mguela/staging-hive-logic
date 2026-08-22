// api/bookkeeping/expenses.js — Vercel serverless function.
// Validates and durably stores a draft/submitted expense using the ported
// accounting engine (server/bookkeeping/src/accounting.js — same
// validateExpense/distributeSalesTax logic verified by the ported tests).
//
// Storage: goes through api/bookkeeping/_expense_store.js, the same
// dual-backend (memory default / durable opt-in via Supabase) pattern
// already proven in api/bookkeeping/purchase-orders/_store.js. Until this
// migrates to the durable backend in production (see that file's header
// comment for the exact two steps required), this route fails closed with
// a clear error rather than silently discarding data — the previous
// behavior, where every request returned a fake "saved" response and threw
// the expense away, is gone.
//
// QBO writes and bank-feed writes are NOT connected here regardless of
// BOOKKEEPING_ENABLED. A submitted expense now opens a real, tracked QBO
// approval request (server/bookkeeping/src/controls.js) — see the QBO
// approval bridge below — but nothing calls the real QuickBooks write
// client from this route, ever. That only happens later, from
// api/bookkeeping/controls/qbo-sync.js, and only when
// HIVELOGIC_QBO_WRITE_ENABLED=true.
//
// General-ledger bridge: once an expense is actually submitted (not just
// saved as a draft), this also creates a matching pending-approval journal
// entry in the ported general-ledger engine (server/bookkeeping/src/ledger.js
// via api/bookkeeping/ledger/_store.js), using the exact same QBO account ids
// the expense's allocations already carry (see api/bookkeeping/ledger/_store.js's
// defaultChartOfAccounts() header comment — the chart is deliberately keyed
// by those same ids). This is intentionally best-effort: the expense has
// already been durably saved by the time this runs, so a failure here is
// caught and reported honestly in the response's `note`, never allowed to
// undo or mask the successful expense save.

import { insertExpense, storeBackend, updateExpense } from './_expense_store.js';
import { getTrustedActor } from './purchase-orders/_actor.js';
import { guardBookkeepingRequest } from './_security.js';

let _load_accounting_cache;
async function _load_accounting() {
  if (!_load_accounting_cache) _load_accounting_cache = await import('../../server/bookkeeping/src/accounting.js');
  return _load_accounting_cache;
}

// Lazy-loaded (not imported at module top level) so that merely loading this
// route never triggers the ledger store's fail-closed backend checks
// (api/bookkeeping/ledger/_store.js's resolveBackend() throws if the ledger
// storage backend isn't configured) — those checks should only ever surface
// as a caught, reported failure for the one submitted expense being saved
// right now, never as an unrelated 500 for every expense request including
// drafts.
let _load_ledger_engine_cache;
async function _load_ledger_engine() {
  if (!_load_ledger_engine_cache) _load_ledger_engine_cache = await import('../../server/bookkeeping/src/ledger.js');
  return _load_ledger_engine_cache;
}
let _load_ledger_store_cache;
async function _load_ledger_store() {
  if (!_load_ledger_store_cache) _load_ledger_store_cache = await import('./ledger/_store.js');
  return _load_ledger_store_cache;
}

// Same lazy-load reasoning as the ledger loaders above, and the same reason
// this app's QBO controls engine (server/bookkeeping/src/controls.js) is
// loaded lazily here too: merely loading this route must never trigger any
// of these engines' own fail-closed backend checks.
let _load_controls_cache;
async function _load_controls() {
  if (!_load_controls_cache) _load_controls_cache = await import('../../server/bookkeeping/src/controls.js');
  return _load_controls_cache;
}

// Same lazy-load reasoning as the ledger loaders above: merely loading this
// route must never trigger the purchase-order store's own backend checks.
// This is used by the best-effort PO-link block below, which only runs when
// a submitted expense actually carries a poId.
let _load_po_engine_cache;
async function _load_po_engine() {
  if (!_load_po_engine_cache) _load_po_engine_cache = await import('../../server/bookkeeping/src/purchase-orders.js');
  return _load_po_engine_cache;
}
let _load_po_store_cache;
async function _load_po_store() {
  if (!_load_po_store_cache) _load_po_store_cache = await import('./purchase-orders/_store.js');
  return _load_po_store_cache;
}

// server/bookkeeping/src/ledger.js has its own role vocabulary
// (submitter/approver/bookkeeper/controller/auditor), distinct from the
// purchase-order engine's (approver/controller/bookkeeper/field) that
// purchase-orders/_actor.js's getTrustedActor() maps HiveLogic's real
// profiles.role (‘admin’ | ‘crew’) into. Reusing the SAME verified actor
// identity (never re-authenticating, never a synthetic "system" actor) but
// re-deriving the role in the ledger engine's own vocabulary — exactly the
// mapping api/bookkeeping/ledger/_actor.js already uses for the same
// underlying hivelogicRole — is required for the ledger's requirePermission()
// (and controls.js's own role checks, which use this same vocabulary) to
// recognize the role at all ('field' isn't a key in either engine's roles).
function ledgerRoleFor(actor) {
  return actor.hivelogicRole === 'admin' ? 'controller' : 'submitter';
}

// Builds the one journal entry a submitted expense implies: one debit line
// per allocation (the same qboAccountId/amount already validated by
// validateExpense) plus one closing credit line for the bank/card account
// (transactionKind 'paid') or Accounts Payable (transactionKind 'bill' —
// validateExpense already enforces paymentAccountId can only be '2000' or
// empty for bills, so '2000' is always correct here regardless of what
// paymentAccountId holds).
function buildJournalEntryInput(expense, storedExpenseId) {
  const allocationLines = expense.allocations.map(allocation => ({
    accountId: allocation.qboAccountId,
    debit: allocation.amount,
    credit: 0,
    memo: allocation.description || allocation.memo || ''
  }));
  const totalCents = expense.allocations.reduce((sum, allocation) => sum + Math.round((Number(allocation.amount) || 0) * 100), 0);
  const closingAccountId = expense.transactionKind === 'bill' ? '2000' : expense.paymentAccountId;
  return {
    companyId: expense.companyId,
    date: expense.transactionDate,
    description: `${expense.vendor} — ${expense.transactionKind === 'bill' ? 'Bill' : 'Expense'}`,
    memo: expense.memo || '',
    kind: 'standard',
    source: 'expense',
    sourceId: storedExpenseId,
    lines: [...allocationLines, { accountId: closingAccountId, debit: 0, credit: totalCents / 100 }]
  };
}

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) {
    res.status(200).json({ ok: true, enabled: false, note: 'Bookkeeping preview is disabled. Set BOOKKEEPING_ENABLED=true to try the expense-entry validation gate.' });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST is supported for this preview endpoint.' });
    return;
  }

  // Real, server-verified identity — never accepted from the request body.
  // Same trusted-actor pattern purchase orders already use (see
  // purchase-orders/_actor.js's header comment for why: a spoofable
  // x-hivelogic-* header was the previous, rejected approach).
  const actor = await getTrustedActor(req);
  if (!actor) {
    res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request. Sign in and try again.' });
    return;
  }

  try {
    const { validateExpense, distributeSalesTax, toQboPurchase, qboExpenseEntityType } = await _load_accounting();
    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const allocationsWithTax = (input.allocations || []).map((line, index, all) => {
      const shares = distributeSalesTax(all, Number(input.salesTaxTotal) || 0);
      const salesTaxAmount = shares[index] || 0;
      const subtotal = Number(line.subtotal) || 0;
      return { ...line, salesTaxAmount, amount: Math.round((subtotal + salesTaxAmount) * 100) / 100 };
    });

    const expense = {
      ...input,
      allocations: allocationsWithTax,
      // Bug fix (2026-08-14, jomell: "Receipt or supporting document is
      // required" on every submission, even with a file attached): the
      // client (app-bookkeeping.js's buildPayload()) sends the uploaded
      // receipt's id as `evidenceId`, never as `receiptAttached` -- this was
      // reading a field name the client never sends, so it was always false
      // regardless of what the user actually attached.
      receiptAttached: !!input.evidenceId,
      qboVendorId: input.qboVendorId || null,
      poId: input.poId || null,
      // companyId is never accepted from the client, same reasoning as
      // purchase-orders/create.js — every verified actor already carries
      // the one real companyId in this single-tenant app.
      companyId: actor.companyId,
      status: input.status === 'submitted' ? 'submitted_for_review' : 'draft_saved',
      createdBy: actor.id
    };

    const validation = validateExpense(expense);
    if (!validation.valid) {
      res.status(422).json({ ok: false, error: validation.errors[0], errors: validation.errors, note: 'Nothing was saved. This preview never writes to QBO or your bank regardless of validation result.' });
      return;
    }

    let qboPreview = null;
    try { qboPreview = toQboPurchase(expense); } catch { qboPreview = null; }

    const stored = await insertExpense({ ...expense, qboPreview });

    // General-ledger bridge — only for real submissions, never drafts. Best-
    // effort: the expense above is already durably saved by this point, so
    // any failure here is caught and reported, never allowed to fail this
    // request or imply the expense itself wasn't saved.
    let journalEntry = null;
    let ledgerNote = null;
    if (expense.status === 'submitted_for_review') {
      try {
        const { createEntry } = await _load_ledger_engine();
        const { updateSystem } = await _load_ledger_store();
        const entryInput = buildJournalEntryInput(expense, stored.id);
        const entryActor = { id: actor.id, role: ledgerRoleFor(actor) };
        let created = null;
        await updateSystem(actor.companyId, system => {
          created = createEntry(system.ledger, entryInput, entryActor);
          return system;
        });
        journalEntry = created;
        ledgerNote = 'A pending-approval journal entry was also created in the General Ledger — a different admin needs to approve and post it.';
      } catch (ledgerError) {
        ledgerNote = `The expense was saved, but a General Ledger journal entry could not be auto-created (${ledgerError.message || 'unknown error'}). Create one manually in the General Ledger tab if needed.`;
      }
    }

    // QuickBooks approval bridge — only for real submissions with a real
    // QBO preview payload, never drafts. This does NOT write to QuickBooks —
    // it opens a real, tracked approval request in server/bookkeeping/src/
    // controls.js (the same engine api/bookkeeping/controls/*.js operates
    // on). A different admin must separately approve it (see
    // controls/decide-approval.js, which then queues it for sync), and a
    // bookkeeper/controller must separately trigger the actual sync (see
    // controls/qbo-sync.js) — and that route is itself a no-op unless
    // HIVELOGIC_QBO_WRITE_ENABLED=true for this whole deployment. Best-
    // effort, same reasoning as the ledger bridge above: a failure here is
    // caught and reported, never allowed to fail this request or undo
    // already-saved work.
    //
    // approvalsRequired mirrors the reference's own high-value threshold
    // policy, simplified: the reference reads its threshold from
    // automation.js (a scheduler/policy engine this app has deliberately
    // never ported — see the Phase 3 disclosure that automation has no
    // backend here at all), so this uses a plain, honestly-documented
    // environment variable instead of an unbuilt policy engine.
    let qboApproval = null;
    let qboNote = null;
    if (expense.status === 'submitted_for_review' && qboPreview) {
      try {
        const { requestApproval } = await _load_controls();
        const { updateSystem } = await _load_ledger_store();
        const entryActor = { id: actor.id, role: ledgerRoleFor(actor) };
        const highValueThreshold = Number(process.env.HIVELOGIC_QBO_HIGH_VALUE_THRESHOLD) || 2500;
        let created = null;
        await updateSystem(actor.companyId, system => {
          created = requestApproval(system.controls, {
            companyId: actor.companyId,
            entityType: qboExpenseEntityType(expense),
            entityId: stored.id,
            payload: qboPreview,
            requiredRoles: ['approver', 'controller'],
            approvalsRequired: (Number(expense.total) || 0) >= highValueThreshold ? 2 : 1
          }, entryActor);
          return system;
        });
        qboApproval = created;
        await updateExpense(actor.companyId, stored.id, current => ({ ...current, qboApprovalRequestId: created.id }));
        qboNote = 'A QuickBooks sync approval request was also opened — a different admin needs to approve it before this expense can be queued for QuickBooks. No QuickBooks write has occurred.';
      } catch (qboError) {
        qboNote = `The expense was saved, but a QuickBooks approval request could not be opened (${qboError.message || 'unknown error'}).`;
      }
    }

    // Purchase-order link bridge — only for real submissions that name a
    // poId, and only best-effort: the expense above is already durably
    // saved and its own ledger entry (if any) already created by this
    // point, so a failure here is caught and reported, never allowed to
    // fail this request or undo the expense/ledger work already done. The
    // dollar amount and account mapping still come entirely from the
    // expense's own allocations above — this is a status/traceability
    // update on the PO side only, never a second posting of money.
    let linkedPurchaseOrder = null;
    let poLinkNote = null;
    if (expense.status === 'submitted_for_review' && expense.poId) {
      try {
        const { markBilled } = await _load_po_engine();
        const { getPurchaseOrder, updatePurchaseOrder } = await _load_po_store();
        const existingPo = await getPurchaseOrder(actor.companyId, expense.poId);
        if (!existingPo) {
          poLinkNote = `The expense was saved, but purchase order ${expense.poId} was not found in this company — nothing was linked.`;
        } else {
          const updated = await updatePurchaseOrder(actor.companyId, expense.poId, po => markBilled(po, actor, stored.id));
          linkedPurchaseOrder = updated;
          poLinkNote = `Linked to purchase order ${updated.poNumber} and marked billed.`;
        }
      } catch (poError) {
        poLinkNote = `The expense was saved, but could not be linked to purchase order ${expense.poId} (${poError.message || 'unknown error'}). Mark it billed manually in Purchase Orders if needed.`;
      }
    }

    res.status(200).json({
      ok: true,
      status: expense.status,
      expenseId: stored.id,
      storeBackend: storeBackend(),
      validation,
      qboPreview,
      qboWritesEnabled: process.env.HIVELOGIC_QBO_WRITE_ENABLED === 'true',
      qboApproval,
      journalEntry,
      linkedPurchaseOrder,
      note: [`Validated against the accounting engine and saved (${storeBackend()} backend). No QBO or bank write occurred.`, ledgerNote, qboNote, poLinkNote].filter(Boolean).join(' ')
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || 'Could not process this expense.' });
  }
}
