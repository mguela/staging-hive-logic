// api/bookkeeping/_expense_store.js
//
// Two backends behind one interface, mirroring the exact pattern already
// proven (and already shipped) in api/bookkeeping/purchase-orders/_store.js:
//
// - "memory": a module-level in-memory array. Safe for local preview/demo
//   use; resets on every cold start; not shared across concurrent
//   serverless instances; provides no real durability. This was, until now,
//   the ONLY thing api/bookkeeping/expenses.js did -- and it didn't even
//   have the array; it validated and returned a preview, then discarded the
//   expense entirely. Every "Saved as draft" response was true only for
//   validation, never for storage.
//
// - "durable": real Postgres via Supabase's REST (PostgREST) endpoint,
//   using the same supabaseRequest() helper api/_lib/jobber.js already uses
//   for the Jobber integration (no new client library, no new env vars
//   beyond SUPABASE_URL / SUPABASE_SERVICE_KEY, already required elsewhere
//   in this app). Backed by sql/021_bookkeeping_expenses.sql -- run that
//   migration in the Supabase SQL editor once before switching backends.
//
// Which backend is active is controlled by BOOKKEEPING_EXPENSE_STORE
// ('memory' by default, 'durable' to opt in) -- a deliberate, explicit
// switch, not something that flips silently just because Supabase env vars
// happen to be present, for the same reason purchase-orders/_store.js gives:
// moving a company's real expense data onto a new storage backend is
// Chris's decision to make with his eyes open, after he's run the
// migration himself.
//
// Fail-closed production rule -- copied verbatim from
// purchase-orders/_store.js's own reasoning, because the reasoning applies
// identically here: letting memory-mode be a silent, unguarded default in
// production would mean real expense data vanishes on every cold start with
// no error and no warning. That is strictly worse than an honest error, so:
//
// 1. In production (VERCEL_ENV or NODE_ENV === 'production'), memory mode is
//    never allowed -- BOOKKEEPING_EXPENSE_STORE must be 'durable'.
// 2. Still in production, durable mode requires an explicit human
//    confirmation that sql/021_bookkeeping_expenses.sql has actually been
//    run -- BOOKKEEPING_EXPENSE_MIGRATION_CONFIRMED must be 'true'.
// 3. Outside production, memory mode requires the same opt-in dev/test flag
//    purchase-orders/_store.js already uses: NODE_ENV=test or
//    BOOKKEEPING_ALLOW_MEMORY_STORE=true. (Reused, not duplicated -- it's a
//    generic "allow memory-mode bookkeeping storage locally" switch, not
//    specific to purchase orders.)
//
// Practical consequence Chris should know: until
// sql/021_bookkeeping_expenses.sql is run AND BOOKKEEPING_EXPENSE_STORE=durable
// AND BOOKKEEPING_EXPENSE_MIGRATION_CONFIRMED=true are set in production,
// Expense Entry saves will return a clear 500 error instead of the old fake
// 200 "saved" response. That is intentional -- an honest error beats a
// silent data loss dressed up as success -- and mirrors exactly the state
// purchase orders have already been shipped in.

import { supabaseRequest } from '../_lib/jobber.js';

function resolveBackend() {
  const requested = process.env.BOOKKEEPING_EXPENSE_STORE === 'durable' ? 'durable' : 'memory';
  const isProduction = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';

  if (isProduction) {
    if (requested !== 'durable') {
      throw new Error(
        'FAIL_CLOSED: this is a production environment and BOOKKEEPING_EXPENSE_STORE is not set to "durable". ' +
        'Refusing to start on in-memory expense storage in production -- real expense data would silently ' +
        'vanish on every cold start. Set BOOKKEEPING_EXPENSE_STORE=durable after running ' +
        'sql/021_bookkeeping_expenses.sql against the real Supabase project.'
      );
    }
    if (process.env.BOOKKEEPING_EXPENSE_MIGRATION_CONFIRMED !== 'true') {
      throw new Error(
        'FAIL_CLOSED: production is configured for durable expense storage, but ' +
        'BOOKKEEPING_EXPENSE_MIGRATION_CONFIRMED is not "true". Set that flag only after you have personally run ' +
        'sql/021_bookkeeping_expenses.sql against this environment\'s real Supabase project -- this is a ' +
        'deliberate human checkpoint before real financial data depends on that schema existing.'
      );
    }
    return 'durable';
  }

  if (requested === 'memory') {
    const allowMemory = process.env.NODE_ENV === 'test' || process.env.BOOKKEEPING_ALLOW_MEMORY_STORE === 'true';
    if (!allowMemory) {
      throw new Error(
        'FAIL_CLOSED: memory-mode expense storage requires an explicit development/test flag. ' +
        'Set BOOKKEEPING_ALLOW_MEMORY_STORE=true for local/demo use, or run under NODE_ENV=test for automated ' +
        'tests. This prevents memory mode from ever being a silent, un-opted-into default.'
      );
    }
  }
  return requested;
}

const BACKEND = resolveBackend();

// ---------------------------------------------------------------------------
// memory backend
// ---------------------------------------------------------------------------
let memExpenses = [];

// ---------------------------------------------------------------------------
// durable backend
// ---------------------------------------------------------------------------

// The engine/route's own object (payload + validation + qboPreview) is the
// source of truth; the indexed columns exist for querying, not as a second
// copy of the data callers should read from.
function rowToExpense(row) {
  return { ...row.data, id: row.id, __storeVersion: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}

async function durableInsertExpense(expense) {
  const res = await supabaseRequest('bookkeeping_expenses', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      company_id: expense.companyId,
      status: expense.status,
      transaction_kind: expense.transactionKind || null,
      qbo_vendor_id: expense.qboVendorId || null,
      vendor_name: expense.vendor || null,
      transaction_date: expense.transactionDate || null,
      due_date: expense.dueDate || null,
      payment_account_id: expense.paymentAccountId || null,
      payment_type: expense.paymentType || null,
      receipt_subtotal: expense.receiptSubtotal ?? null,
      sales_tax_total: expense.salesTaxTotal ?? null,
      total: expense.total ?? null,
      data: expense,
      created_by: expense.createdBy || null
    }])
  });
  if (!res.ok) throw new Error(`Could not save this expense: ${await res.text()}`);
  const rows = await res.json();
  return rowToExpense(rows[0]);
}

async function durableListExpenses(companyId) {
  const res = await supabaseRequest(`bookkeeping_expenses?company_id=eq.${encodeURIComponent(companyId)}&select=*&order=created_at.desc`);
  if (!res.ok) throw new Error(`Could not list expenses: ${await res.text()}`);
  const rows = await res.json();
  return rows.map(rowToExpense);
}

async function durableGetExpense(companyId, expenseId) {
  const res = await supabaseRequest(`bookkeeping_expenses?company_id=eq.${encodeURIComponent(companyId)}&id=eq.${encodeURIComponent(expenseId)}&select=*`);
  if (!res.ok) throw new Error(`Could not read this expense: ${await res.text()}`);
  const rows = await res.json();
  return rows.length ? rowToExpense(rows[0]) : null;
}

// Added for the bank-feed match confirmation flow (confirmBankMatch() in
// server/bookkeeping/src/banking.js sets expense.bankTransactionId, but that
// only mutates the in-memory object the caller happened to pass in -- this
// store never had any update path at all before this, since every prior
// consumer only ever inserted/listed/read expenses, never patched one after
// the fact). No optimistic-concurrency check on update (mirrors this
// store's existing simplification: insert never had CAS/version conflict
// handling either -- this is a genuinely new capability, not a regression
// from a stricter guarantee that used to exist).
async function durableUpdateExpense(companyId, expenseId, mutate) {
  const existing = await durableGetExpense(companyId, expenseId);
  if (!existing) return null;
  const { id, __storeVersion, createdAt, updatedAt, ...rest } = existing;
  const next = mutate({ ...rest, id, companyId });
  const res = await supabaseRequest(`bookkeeping_expenses?id=eq.${encodeURIComponent(expenseId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      status: next.status,
      transaction_kind: next.transactionKind || null,
      qbo_vendor_id: next.qboVendorId || null,
      vendor_name: next.vendor || null,
      transaction_date: next.transactionDate || null,
      due_date: next.dueDate || null,
      payment_account_id: next.paymentAccountId || null,
      payment_type: next.paymentType || null,
      receipt_subtotal: next.receiptSubtotal ?? null,
      sales_tax_total: next.salesTaxTotal ?? null,
      total: next.total ?? null,
      data: next
    })
  });
  if (!res.ok) throw new Error(`Could not update this expense: ${await res.text()}`);
  const rows = await res.json();
  return rows.length ? rowToExpense(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Public interface -- expenses.js (and any future list/detail route) goes
// through this, never the two backends directly, so swapping
// BOOKKEEPING_EXPENSE_STORE never touches route code.
// ---------------------------------------------------------------------------
export function storeBackend() {
  return BACKEND;
}

export async function insertExpense(expense) {
  if (BACKEND === 'memory') {
    const stored = { ...expense, id: `mem_${memExpenses.length + 1}_${Date.now()}`, __storeVersion: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    memExpenses.push(stored);
    return stored;
  }
  return durableInsertExpense(expense);
}

export async function listExpenses(companyId) {
  if (BACKEND === 'memory') return memExpenses.filter(e => e.companyId === companyId);
  return durableListExpenses(companyId);
}

export async function getExpense(companyId, expenseId) {
  if (BACKEND === 'memory') return memExpenses.find(e => e.id === expenseId && e.companyId === companyId) || null;
  return durableGetExpense(companyId, expenseId);
}

// mutate: (expense) => patchedExpense. Returns the updated, stored expense,
// or null if no expense with that id exists for this company.
export async function updateExpense(companyId, expenseId, mutate) {
  if (BACKEND === 'memory') {
    const index = memExpenses.findIndex(e => e.id === expenseId && e.companyId === companyId);
    if (index === -1) return null;
    const next = mutate({ ...memExpenses[index] });
    next.updatedAt = new Date().toISOString();
    memExpenses[index] = next;
    return next;
  }
  return durableUpdateExpense(companyId, expenseId, mutate);
}
