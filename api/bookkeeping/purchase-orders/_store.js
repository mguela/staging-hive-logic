// api/bookkeeping/purchase-orders/_store.js
//
// Two backends behind one interface:
//
// - "memory": the original module-level in-memory arrays. Default. Safe for
//   local preview/demo use; resets on cold start; not shared across
//   concurrent serverless instances; provides no real atomic guarantee.
//
// - "durable": real Postgres via Supabase's REST (PostgREST) endpoint, using
//   the same supabaseRequest() helper api/_lib/jobber.js already uses for the
//   Jobber integration (no new client library, no new env vars beyond the
//   ones already required for that integration to work: SUPABASE_URL,
//   SUPABASE_SERVICE_KEY). This is what actually answers the outside
//   review's corrective requirement: "Replace the separate in-memory
//   serverless stores with durable transactional storage." Backed by
//   sql/010_purchase_orders.sql -- run that migration in the Supabase SQL
//   editor once before switching backends.
//
// Which backend is active is controlled by BOOKKEEPING_PO_STORE ('memory' by
// default, 'durable' to opt in). This is a deliberate, explicit switch -- not
// something that flips silently just because Supabase env vars happen to be
// present -- because moving a company's real purchase-order data onto a new
// storage backend is exactly the kind of decision Chris should make with his
// eyes open, after he's run the migration himself, not something a rewrite
// decides quietly on his behalf.
//
// Every "durable" function below does its own optimistic-concurrency retry:
// each row carries a `version` column; an update is WHERE version = <value
// just read>, and a zero-row result means someone else moved first, so the
// caller re-reads and re-applies. This is the actual fix for the real-world
// version of the "two people click Approve at the same time" concern the
// review raised under a real (not in-memory, not single-threaded) store.

import { supabaseRequest } from '../../_lib/jobber.js';

// ---------------------------------------------------------------------------
// Round 3 correction #2 (fail closed): the old logic let memory-mode be a
// silent, unguarded default everywhere, including in production if
// BOOKKEEPING_PO_STORE simply wasn't set on a deploy. Real purchase-order
// and receipt data would then vanish on every cold start with no error and
// no warning -- exactly the "fails open" behavior the review flagged.
//
// Rules now enforced at module load (fail CLOSED -- a misconfigured
// environment throws and every route request in it errors, rather than
// quietly running on unsafe storage):
//
// 1. In production (VERCEL_ENV or NODE_ENV === 'production'), memory mode is
//    never allowed, full stop -- BOOKKEEPING_PO_STORE must be 'durable'.
// 2. Still in production, durable mode itself requires an explicit
//    human confirmation that sql/010_purchase_orders.sql has actually been
//    run against that environment's real Supabase project --
//    BOOKKEEPING_PO_MIGRATION_CONFIRMED must be 'true'. There is no way for
//    this module to verify a migration ran short of querying for the tables,
//    which would itself be a false sense of safety (the tables could exist
//    with a stale schema) -- an explicit human flag is the honest control.
// 3. Outside production, memory mode requires an explicit development/test
//    flag -- either NODE_ENV=test (automated test runs) or
//    BOOKKEEPING_ALLOW_MEMORY_STORE=true (local/demo use) -- so memory mode
//    is always something a developer opted into, never a silent fallback.
function resolveBackend() {
  const requested = process.env.BOOKKEEPING_PO_STORE === 'durable' ? 'durable' : 'memory';
  const isProduction = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';

  if (isProduction) {
    if (requested !== 'durable') {
      throw new Error(
        'FAIL_CLOSED: this is a production environment and BOOKKEEPING_PO_STORE is not set to "durable". ' +
        'Refusing to start on in-memory purchase-order storage in production -- real PO/receipt data would ' +
        'silently vanish on every cold start. Set BOOKKEEPING_PO_STORE=durable after running ' +
        'sql/010_purchase_orders.sql against the real Supabase project.'
      );
    }
    if (process.env.BOOKKEEPING_PO_MIGRATION_CONFIRMED !== 'true') {
      throw new Error(
        'FAIL_CLOSED: production is configured for durable purchase-order storage, but ' +
        'BOOKKEEPING_PO_MIGRATION_CONFIRMED is not "true". Set that flag only after you have personally run ' +
        'sql/010_purchase_orders.sql against this environment\'s real Supabase project -- this is a deliberate ' +
        'human checkpoint before real financial data depends on that schema existing.'
      );
    }
    return 'durable';
  }

  if (requested === 'memory') {
    const allowMemory = process.env.NODE_ENV === 'test' || process.env.BOOKKEEPING_ALLOW_MEMORY_STORE === 'true';
    if (!allowMemory) {
      throw new Error(
        'FAIL_CLOSED: memory-mode purchase-order storage requires an explicit development/test flag. ' +
        'Set BOOKKEEPING_ALLOW_MEMORY_STORE=true for local/demo use, or run under NODE_ENV=test for automated ' +
        'tests. This prevents memory mode from ever being a silent, un-opted-into default.'
      );
    }
  }
  return requested;
}

const BACKEND = resolveBackend();

// ---------------------------------------------------------------------------
// memory backend (unchanged behavior from the previous preview store)
// ---------------------------------------------------------------------------
let memPurchaseOrders = [];
let memCounterStateByCompany = {};
let memExistingBills = [];

function memGetStore() {
  return {
    purchaseOrders: memPurchaseOrders,
    getCounterState: companyId => memCounterStateByCompany[companyId],
    setCounterState: (companyId, state) => { memCounterStateByCompany[companyId] = state; },
    existingBills: memExistingBills
  };
}

// ---------------------------------------------------------------------------
// durable backend
// ---------------------------------------------------------------------------
const MAX_CAS_RETRIES = 5;

function rowToPo(row) {
  // The engine's own object is the source of truth; the indexed columns
  // (company_id, po_number, etc.) exist for querying, not as a second copy
  // of the data callers should read from -- always return row.data, with
  // version/id merged in so callers can update() it back.
  return { ...row.data, __storeId: row.id, __storeVersion: row.version };
}

async function durableListPurchaseOrders(companyId) {
  const res = await supabaseRequest(`purchase_orders?company_id=eq.${encodeURIComponent(companyId)}&select=*`);
  if (!res.ok) throw new Error(`Could not list purchase orders: ${await res.text()}`);
  const rows = await res.json();
  return rows.map(rowToPo);
}

async function durableGetPurchaseOrder(companyId, poId) {
  // poId here is the engine's own po.id (stored inside data), not the row's
  // Postgres id -- callers only ever know the engine's id.
  const res = await supabaseRequest(`purchase_orders?company_id=eq.${encodeURIComponent(companyId)}&data->>id=eq.${encodeURIComponent(poId)}&select=*`);
  if (!res.ok) throw new Error(`Could not read purchase order: ${await res.text()}`);
  const rows = await res.json();
  return rows.length ? rowToPo(rows[0]) : null;
}

async function durableInsertPurchaseOrder(po) {
  const res = await supabaseRequest('purchase_orders', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      company_id: po.companyId,
      po_number: po.poNumber,
      job_id: po.jobId || null,
      overhead_category: po.overheadCategory || null,
      order_type: po.orderType,
      lifecycle_status: po.lifecycleStatus,
      not_preapproved: !!po.notPreapproved,
      data: po
    }])
  });
  if (!res.ok) throw new Error(`Could not save new purchase order: ${await res.text()}`);
  const rows = await res.json();
  return rowToPo(rows[0]);
}

// Optimistic-concurrency update: `mutate(currentPo) => nextPo` is applied
// against whatever is currently stored, retried from scratch if another
// writer won the race in between our read and our write.
async function durableUpdatePurchaseOrder(companyId, poId, mutate) {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const current = await durableGetPurchaseOrder(companyId, poId);
    if (!current) throw new Error('Purchase order not found.');
    const currentVersion = current.__storeVersion;
    const next = mutate(current);

    const res = await supabaseRequest(
      `purchase_orders?company_id=eq.${encodeURIComponent(companyId)}&data->>id=eq.${encodeURIComponent(poId)}&version=eq.${currentVersion}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          po_number: next.poNumber,
          job_id: next.jobId || null,
          overhead_category: next.overheadCategory || null,
          order_type: next.orderType,
          lifecycle_status: next.lifecycleStatus,
          not_preapproved: !!next.notPreapproved,
          data: next,
          version: currentVersion + 1,
          updated_at: new Date().toISOString()
        })
      }
    );
    if (!res.ok) throw new Error(`Could not update purchase order: ${await res.text()}`);
    const rows = await res.json();
    if (rows.length) return rowToPo(rows[0]);
    // zero rows back = someone else updated this row between our read and
    // our write (version no longer matches) -- loop and retry against the
    // now-current row rather than silently overwriting their change.
  }
  throw new Error('Could not update purchase order after repeated concurrent-write conflicts. Please retry.');
}

// Atomic, durable, per-company/per-scope sequence -- see
// sql/010_purchase_orders.sql's allocate_po_number() function. A single
// round trip; Postgres's own row locking is what prevents two concurrent
// callers from ever getting the same number, and the counter only ever goes
// up, so a cancelled PO's number can never be handed out again.
async function durableAllocatePoNumber({ companyId, jobId, companyCode = 'PO' }) {
  const scopeKey = jobId ? `job:${jobId}` : 'general';
  const res = await supabaseRequest('rpc/allocate_po_number', {
    method: 'POST',
    body: JSON.stringify({ p_company_id: companyId, p_scope_key: scopeKey, p_job_id: jobId || null, p_company_code: companyCode })
  });
  if (!res.ok) throw new Error(`Could not allocate a purchase order number: ${await res.text()}`);
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : rows;
  return row.po_number;
}

// Round 3 correction #5: commit every PO touched by one receipt-match
// request in a single atomic database transaction (see apply_po_batch_update
// in sql/010_purchase_orders.sql) so a mid-batch failure can never leave a
// receipt half-posted (some POs updated, others silently left as they were).
// `updates` is [{ po, expectedVersion }] -- `po` is the engine's already-
// computed next state for that PO, `expectedVersion` is the version it was
// read at (the version compare-and-swap check runs inside the SQL function).
// Round 5 fix (task #25): seenBill is optional and, when present, is passed
// through to apply_po_batch_update's new p_seen_bill parameter so the
// duplicate-bill fingerprint is recorded in the SAME database transaction as
// every PO update in this batch -- see the comment on apply_po_batch_update
// in sql/010_purchase_orders.sql for why a separate, later recordSeenBill()
// call was a real gap (a receipt could get durably matched but never
// recorded for duplicate detection if the process died in between).
async function durableApplyReceiptMatchBatch(updates, seenBill) {
  const res = await supabaseRequest('rpc/apply_po_batch_update', {
    method: 'POST',
    body: JSON.stringify({
      p_updates: updates.map(({ po, expectedVersion }) => ({
        po_id: po.id,
        company_id: po.companyId,
        po_number: po.poNumber,
        job_id: po.jobId || null,
        overhead_category: po.overheadCategory || null,
        order_type: po.orderType,
        lifecycle_status: po.lifecycleStatus,
        not_preapproved: !!po.notPreapproved,
        data: po,
        expected_version: expectedVersion
      })),
      p_seen_bill: seenBill ? {
        company_id: seenBill.companyId,
        qbo_vendor_id: seenBill.qboVendorId || null,
        vendor_name: seenBill.vendorName || null,
        invoice_number: seenBill.invoiceNumber || null,
        currency: seenBill.currency || null,
        amount: seenBill.amount ?? null,
        evidence_hash: seenBill.evidenceHash || null,
        source_transaction_id: seenBill.sourceTransactionId || null
      } : null
    })
  });
  if (!res.ok) {
    const text = await res.text();
    const conflict = /CONCURRENT_CONFLICT/.test(text);
    const err = new Error(conflict ? `CONCURRENT_CONFLICT: ${text}` : `Could not apply this batch of purchase order updates: ${text}`);
    err.code = conflict ? 'CONCURRENT_CONFLICT' : undefined;
    throw err;
  }
  const rows = await res.json();
  return rows.map(rowToPo);
}

// Round 3 correction #9: rows come back from PostgREST with the table's own
// snake_case column names -- this maps them into EXACTLY the camelCase shape
// server/bookkeeping/src/purchase-orders.js's detectExceptions() reads
// (companyId, qboVendorId, vendorName, invoiceNumber, currency, amount).
// Without this mapping, duplicate-bill detection against the durable
// backend would silently never match anything (bill.companyId, bill.amount,
// etc. would all be undefined on a raw row), which is exactly the bug this
// correction targets.
function rowToSeenBill(row) {
  return {
    companyId: row.company_id,
    qboVendorId: row.qbo_vendor_id,
    vendorName: row.vendor_name,
    invoiceNumber: row.invoice_number,
    currency: row.currency,
    amount: row.amount,
    evidenceHash: row.evidence_hash,
    sourceTransactionId: row.source_transaction_id
  };
}

async function durableExistingBills(companyId) {
  const res = await supabaseRequest(`po_seen_bills?company_id=eq.${encodeURIComponent(companyId)}&select=*`);
  if (!res.ok) throw new Error(`Could not read prior bill records: ${await res.text()}`);
  const rows = await res.json();
  return rows.map(rowToSeenBill);
}

async function durableRecordSeenBill(companyId, bill) {
  // on_conflict + resolution=ignore-duplicates is what makes this idempotent
  // against po_seen_bills_source_txn_uidx (company_id, source_transaction_id)
  // -- a retried request or duplicate webhook recording the same receipt as
  // a seen bill twice is a safe no-op, not a second row that would itself
  // look like a second, distinct bill the next time duplicate detection runs.
  const res = await supabaseRequest('po_seen_bills?on_conflict=company_id,source_transaction_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify([{
      company_id: companyId,
      qbo_vendor_id: bill.qboVendorId || null,
      vendor_name: bill.vendorName || null,
      invoice_number: bill.invoiceNumber || null,
      currency: bill.currency || null,
      amount: bill.amount ?? null,
      evidence_hash: bill.evidenceHash || null,
      source_transaction_id: bill.sourceTransactionId || null
    }])
  });
  if (!res.ok) throw new Error(`Could not record this bill for duplicate detection: ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Public interface -- every route file goes through this, never the two
// backends directly, so swapping BOOKKEEPING_PO_STORE never touches route code.
// ---------------------------------------------------------------------------
export function storeBackend() {
  return BACKEND;
}

export async function listPurchaseOrders(companyId) {
  if (BACKEND === 'memory') return memGetStore().purchaseOrders.filter(po => po.companyId === companyId);
  return durableListPurchaseOrders(companyId);
}

export async function getPurchaseOrder(companyId, poId) {
  if (BACKEND === 'memory') return memGetStore().purchaseOrders.find(po => po.id === poId && po.companyId === companyId) || null;
  return durableGetPurchaseOrder(companyId, poId);
}

export async function insertPurchaseOrder(po) {
  if (BACKEND === 'memory') { memGetStore().purchaseOrders.push(po); return po; }
  return durableInsertPurchaseOrder(po);
}

// mutate: (currentPo) => nextPo. Applied via compare-and-swap under the
// durable backend; applied directly (single-threaded, no race possible) under
// the memory backend.
export async function updatePurchaseOrder(companyId, poId, mutate) {
  if (BACKEND === 'memory') {
    const store = memGetStore();
    const index = store.purchaseOrders.findIndex(p => p.id === poId && p.companyId === companyId);
    if (index < 0) throw new Error('Purchase order not found.');
    const next = mutate(store.purchaseOrders[index]);
    store.purchaseOrders[index] = next;
    return next;
  }
  return durableUpdatePurchaseOrder(companyId, poId, mutate);
}

// Bulk read for the atomic multi-PO match flow: fetch every PO the receipt
// touches, in one shot, before any engine computation happens. Memory-mode
// POs don't carry a real version, so callers there should treat
// __storeVersion as a placeholder (the memory apply below never checks it --
// there is nothing to race against with a single-threaded, in-process store).
export async function getPurchaseOrders(companyId, poIds) {
  if (BACKEND === 'memory') {
    const store = memGetStore();
    return poIds.map(id => {
      const po = store.purchaseOrders.find(p => p.id === id && p.companyId === companyId);
      return po ? { ...po, __storeVersion: 1 } : null;
    });
  }
  return Promise.all(poIds.map(id => durableGetPurchaseOrder(companyId, id)));
}

// Round 3 correction #5: apply every PO update produced by ONE
// matchReceiptToPurchaseOrders() call atomically -- either all of them land
// or none do. `updates` is [{ po, expectedVersion }]. Retries the whole
// recompute-and-write cycle (via `recompute`, which re-reads current state
// and re-runs the engine call) if another writer touched any of the same
// POs in between -- exactly the single-PO CAS retry, just batched so a
// receipt can never end up half-posted across multiple purchase orders.
// Round 5 fix (task #25): seenBill is an optional 5th argument -- when the
// caller (match.js) has a duplicate-bill fingerprint worth recording, it's
// applied atomically with the PO updates instead of via a separate, later
// recordSeenBill() call. See durableApplyReceiptMatchBatch and
// apply_po_batch_update in sql/010_purchase_orders.sql for the durable-mode
// mechanics; the memory-mode branch below mirrors recordSeenBill's own
// idempotency check (safe no-op on a repeat sourceTransactionId).
export async function applyReceiptMatchBatch(companyId, poIds, computeUpdates, seenBill) {
  if (BACKEND === 'memory') {
    // Single-threaded -- no concurrent writer can interleave here, so one
    // read-compute-write pass is already atomic in effect.
    const current = await getPurchaseOrders(companyId, poIds);
    const updates = computeUpdates(current); // array of next-state PO objects, straight from the engine
    const store = memGetStore();
    for (const po of updates) {
      const index = store.purchaseOrders.findIndex(p => p.id === po.id && p.companyId === companyId);
      if (index < 0) throw new Error(`Purchase order ${po.id} not found.`);
      store.purchaseOrders[index] = po;
    }
    if (seenBill && !(seenBill.sourceTransactionId && store.existingBills.some(b => b.companyId === companyId && b.sourceTransactionId === seenBill.sourceTransactionId))) {
      store.existingBills.push({ companyId, ...seenBill });
    }
    return updates;
  }

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const current = await getPurchaseOrders(companyId, poIds);
    if (current.some(po => !po)) throw new Error('One or more purchase orders in this batch were not found.');
    const updates = computeUpdates(current).map(po => ({ po, expectedVersion: current.find(c => c.id === po.id).__storeVersion }));
    try {
      return await durableApplyReceiptMatchBatch(updates, seenBill);
    } catch (err) {
      if (err.code === 'CONCURRENT_CONFLICT' && attempt < MAX_CAS_RETRIES - 1) continue;
      throw err;
    }
  }
  throw new Error('Could not apply this batch of purchase order updates after repeated concurrent-write conflicts. Please retry.');
}

export async function allocatePoNumber({ companyId, jobId, companyCode, memoryCounterState }) {
  if (BACKEND === 'memory') {
    // Mirrors the engine's own allocatePurchaseOrderNumber() so memory-mode
    // demos still exercise realistic numbering, just without DB durability.
    const key = jobId ? `job:${jobId}` : 'general';
    const counters = memoryCounterState?.counters || {};
    const nextSequence = (counters[key] || 0) + 1;
    const poNumber = jobId
      ? `${companyCode || 'PO'}-${jobId}-${String(nextSequence).padStart(2, '0')}`
      : `${companyCode || 'PO'}-GEN-${String(nextSequence).padStart(4, '0')}`;
    return { poNumber, nextMemoryCounterState: { ...(memoryCounterState || {}), companyId, counters: { ...counters, [key]: nextSequence } } };
  }
  const poNumber = await durableAllocatePoNumber({ companyId, jobId, companyCode });
  return { poNumber, nextMemoryCounterState: null };
}

export async function getExistingBills(companyId) {
  // Company-scoped even in memory mode -- the durable backend already
  // scopes by company_id in its WHERE clause; the previous memory-mode
  // implementation returned every recorded bill across every company.
  if (BACKEND === 'memory') return memGetStore().existingBills.filter(b => b.companyId === companyId);
  return durableExistingBills(companyId);
}

export async function recordSeenBill(companyId, bill) {
  if (BACKEND === 'memory') {
    const store = memGetStore();
    // Idempotent on (companyId, sourceTransactionId), mirroring
    // po_seen_bills_source_txn_uidx on the durable backend -- a retried
    // request recording the same receipt twice must be a safe no-op.
    if (bill.sourceTransactionId && store.existingBills.some(b => b.companyId === companyId && b.sourceTransactionId === bill.sourceTransactionId)) return;
    store.existingBills.push({ companyId, ...bill });
    return;
  }
  return durableRecordSeenBill(companyId, bill);
}

// Retained for any code (tests, older callers) still expecting the original
// synchronous shape -- memory-mode only, throws under the durable backend
// since there is no "the whole store" to hand back from a real database.
export function getStore() {
  if (BACKEND !== 'memory') throw new Error('getStore() is memory-backend-only; durable-backend callers must use the async functions above.');
  return memGetStore();
}
