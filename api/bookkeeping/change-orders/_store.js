// api/bookkeeping/change-orders/_store.js
//
// Same two-backend pattern as api/bookkeeping/purchase-orders/_store.js:
//
// - "memory": module-level in-memory arrays. Local/demo/test use only.
// - "durable": real Postgres via Supabase's REST (PostgREST) endpoint, using
//   the same supabaseRequest() helper the PO store and the Jobber
//   integration already use. Backed by sql/018_change_orders.sql — run that
//   migration in the Supabase SQL editor once before switching backends.
//
// Controlled by BOOKKEEPING_CO_STORE ('memory' default, 'durable' to opt
// in) — a deliberate, explicit switch, never a silent flip just because
// Supabase env vars happen to be present. Fails CLOSED in production the
// same way the PO store does: production must be durable and must carry an
// explicit human confirmation that the migration has actually been run.

import { supabaseRequest } from '../../_lib/jobber.js';

function resolveBackend() {
  const requested = process.env.BOOKKEEPING_CO_STORE === 'durable' ? 'durable' : 'memory';
  const isProduction = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';

  if (isProduction) {
    if (requested !== 'durable') {
      throw new Error(
        'FAIL_CLOSED: this is a production environment and BOOKKEEPING_CO_STORE is not set to "durable". ' +
        'Refusing to start on in-memory change-order storage in production — real change order data would ' +
        'silently vanish on every cold start. Set BOOKKEEPING_CO_STORE=durable after running ' +
        'sql/018_change_orders.sql against the real Supabase project.'
      );
    }
    if (process.env.BOOKKEEPING_CO_MIGRATION_CONFIRMED !== 'true') {
      throw new Error(
        'FAIL_CLOSED: production is configured for durable change-order storage, but ' +
        'BOOKKEEPING_CO_MIGRATION_CONFIRMED is not "true". Set that flag only after you have personally run ' +
        'sql/018_change_orders.sql against this environment\'s real Supabase project.'
      );
    }
    return 'durable';
  }

  if (requested === 'memory') {
    const allowMemory = process.env.NODE_ENV === 'test' || process.env.BOOKKEEPING_ALLOW_MEMORY_STORE === 'true';
    if (!allowMemory) {
      throw new Error(
        'FAIL_CLOSED: memory-mode change-order storage requires an explicit development/test flag. ' +
        'Set BOOKKEEPING_ALLOW_MEMORY_STORE=true for local/demo use, or run under NODE_ENV=test for automated tests.'
      );
    }
  }
  return requested;
}

const BACKEND = resolveBackend();
export function storeBackend() { return BACKEND; }

// ---------------------------------------------------------------------------
// memory backend
// ---------------------------------------------------------------------------
let memChangeOrders = [];
let memCounterStateByCompany = {};

function memGetStore() {
  return {
    changeOrders: memChangeOrders,
    getCounterState: companyId => memCounterStateByCompany[companyId],
    setCounterState: (companyId, state) => { memCounterStateByCompany[companyId] = state; }
  };
}

export function getStore() { return memGetStore(); }

// ---------------------------------------------------------------------------
// durable backend
// ---------------------------------------------------------------------------
const MAX_CAS_RETRIES = 5;

function rowToCo(row) {
  return { ...row.data, __storeId: row.id, __storeVersion: row.version };
}

async function durableListChangeOrders(companyId, { jobId } = {}) {
  let query = `change_orders?company_id=eq.${encodeURIComponent(companyId)}&select=*`;
  if (jobId) query += `&job_id=eq.${encodeURIComponent(jobId)}`;
  const res = await supabaseRequest(query);
  if (!res.ok) throw new Error(`Could not list change orders: ${await res.text()}`);
  const rows = await res.json();
  return rows.map(rowToCo);
}

async function durableGetChangeOrder(companyId, coId) {
  const res = await supabaseRequest(`change_orders?company_id=eq.${encodeURIComponent(companyId)}&data->>id=eq.${encodeURIComponent(coId)}&select=*`);
  if (!res.ok) throw new Error(`Could not read change order: ${await res.text()}`);
  const rows = await res.json();
  return rows.length ? rowToCo(rows[0]) : null;
}

async function durableInsertChangeOrder(co) {
  const res = await supabaseRequest('change_orders', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      company_id: co.companyId,
      co_number: co.coNumber,
      job_id: co.jobId,
      kind: co.kind,
      lifecycle_status: co.lifecycleStatus,
      auto_approved: !!co.autoApproved,
      data: co
    }])
  });
  if (!res.ok) throw new Error(`Could not save new change order: ${await res.text()}`);
  const rows = await res.json();
  return rowToCo(rows[0]);
}

async function durableUpdateChangeOrder(companyId, coId, mutate) {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const current = await durableGetChangeOrder(companyId, coId);
    if (!current) throw new Error('Change order not found.');
    const currentVersion = current.__storeVersion;
    const next = mutate(current);

    const res = await supabaseRequest(
      `change_orders?company_id=eq.${encodeURIComponent(companyId)}&data->>id=eq.${encodeURIComponent(coId)}&version=eq.${currentVersion}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          co_number: next.coNumber,
          job_id: next.jobId,
          kind: next.kind,
          lifecycle_status: next.lifecycleStatus,
          auto_approved: !!next.autoApproved,
          data: next,
          version: currentVersion + 1,
          updated_at: new Date().toISOString()
        })
      }
    );
    if (!res.ok) throw new Error(`Could not update change order: ${await res.text()}`);
    const rows = await res.json();
    if (rows.length) return rowToCo(rows[0]);
    // zero rows back = someone else updated this row between our read and
    // our write — loop and retry against the now-current row.
  }
  throw new Error('Could not update change order after repeated concurrent-write conflicts. Please retry.');
}

async function durableAllocateCoNumber({ companyId, jobId, companyCode = 'CO' }) {
  const res = await supabaseRequest('rpc/allocate_co_number', {
    method: 'POST',
    body: JSON.stringify({ p_company_id: companyId, p_job_id: jobId, p_company_code: companyCode })
  });
  if (!res.ok) throw new Error(`Could not allocate a change order number: ${await res.text()}`);
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : rows;
  return row.co_number;
}

// ---------------------------------------------------------------------------
// Public interface — same shape regardless of backend.
// ---------------------------------------------------------------------------
export async function listChangeOrders(companyId, opts = {}) {
  if (BACKEND === 'durable') return durableListChangeOrders(companyId, opts);
  return memGetStore().changeOrders.filter(co => co.companyId === companyId && (!opts.jobId || co.jobId === opts.jobId));
}

export async function getChangeOrder(companyId, coId) {
  if (BACKEND === 'durable') return durableGetChangeOrder(companyId, coId);
  return memGetStore().changeOrders.find(co => co.companyId === companyId && co.id === coId) || null;
}

export async function insertChangeOrder(co) {
  if (BACKEND === 'durable') return durableInsertChangeOrder(co);
  memGetStore().changeOrders.push(co);
  return co;
}

// mutate: (currentCo) => nextCo
export async function updateChangeOrder(companyId, coId, mutate) {
  if (BACKEND === 'durable') return durableUpdateChangeOrder(companyId, coId, mutate);
  const store = memGetStore();
  const index = store.changeOrders.findIndex(co => co.companyId === companyId && co.id === coId);
  if (index === -1) throw new Error('Change order not found.');
  const next = mutate(store.changeOrders[index]);
  store.changeOrders[index] = next;
  return next;
}

export async function allocateCoNumber({ companyId, jobId, companyCode, memoryCounterState }) {
  if (BACKEND === 'durable') {
    const coNumber = await durableAllocateCoNumber({ companyId, jobId, companyCode });
    return { coNumber, nextMemoryCounterState: null };
  }
  const { allocateChangeOrderNumber } = await import('../../../server/bookkeeping/src/change-orders.js');
  const { coNumber, nextCounterState } = allocateChangeOrderNumber(memoryCounterState, { companyId, jobId, companyCode });
  return { coNumber, nextMemoryCounterState: nextCounterState };
}
