// api/bookkeeping/estimates/_store.js
//
// Same two-backend pattern as purchase-orders/_store.js and
// change-orders/_store.js:
//
// - "memory": module-level in-memory arrays. Local/demo/test use only.
// - "durable": real Postgres via Supabase's REST (PostgREST) endpoint.
//   Backed by sql/019_estimates.sql — run that migration in the Supabase
//   SQL editor once before switching backends.
//
// Controlled by BOOKKEEPING_EST_STORE ('memory' default, 'durable' to opt
// in). Fails CLOSED in production the same way every other store here does:
// production must be durable and must carry an explicit human confirmation
// that the migration has actually been run.

import { supabaseRequest } from '../../_lib/jobber.js';
import { allocateProjectSequence, estimateRef, PROJECT_SEQUENCE_START } from '../../_lib/project-numbers.js';

function resolveBackend() {
  const requested = process.env.BOOKKEEPING_EST_STORE === 'durable' ? 'durable' : 'memory';
  const isProduction = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';

  if (isProduction) {
    if (requested !== 'durable') {
      throw new Error(
        'FAIL_CLOSED: this is a production environment and BOOKKEEPING_EST_STORE is not set to "durable". ' +
        'Refusing to start on in-memory estimate storage in production — real estimate/deposit data would ' +
        'silently vanish on every cold start. Set BOOKKEEPING_EST_STORE=durable after running ' +
        'sql/019_estimates.sql against the real Supabase project.'
      );
    }
    if (process.env.BOOKKEEPING_EST_MIGRATION_CONFIRMED !== 'true') {
      throw new Error(
        'FAIL_CLOSED: production is configured for durable estimate storage, but ' +
        'BOOKKEEPING_EST_MIGRATION_CONFIRMED is not "true". Set that flag only after you have personally run ' +
        'sql/019_estimates.sql against this environment\'s real Supabase project.'
      );
    }
    return 'durable';
  }

  if (requested === 'memory') {
    const allowMemory = process.env.NODE_ENV === 'test' || process.env.BOOKKEEPING_ALLOW_MEMORY_STORE === 'true';
    if (!allowMemory) {
      throw new Error(
        'FAIL_CLOSED: memory-mode estimate storage requires an explicit development/test flag. ' +
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
let memEstimates = [];
let memCounterStateByCompany = {};

function memGetStore() {
  return {
    estimates: memEstimates,
    getCounterState: companyId => memCounterStateByCompany[companyId],
    setCounterState: (companyId, state) => { memCounterStateByCompany[companyId] = state; }
  };
}

export function getStore() { return memGetStore(); }

// ---------------------------------------------------------------------------
// durable backend
// ---------------------------------------------------------------------------
const MAX_CAS_RETRIES = 5;

function rowToEstimate(row) {
  return { ...row.data, __storeId: row.id, __storeVersion: row.version };
}

async function durableListEstimates(companyId, { clientId } = {}) {
  let query = `estimates?company_id=eq.${encodeURIComponent(companyId)}&select=*`;
  if (clientId) query += `&client_id=eq.${encodeURIComponent(clientId)}`;
  const res = await supabaseRequest(query);
  if (!res.ok) throw new Error(`Could not list estimates: ${await res.text()}`);
  const rows = await res.json();
  return rows.map(rowToEstimate);
}

async function durableGetEstimate(companyId, estimateId) {
  const res = await supabaseRequest(`estimates?company_id=eq.${encodeURIComponent(companyId)}&data->>id=eq.${encodeURIComponent(estimateId)}&select=*`);
  if (!res.ok) throw new Error(`Could not read estimate: ${await res.text()}`);
  const rows = await res.json();
  return rows.length ? rowToEstimate(rows[0]) : null;
}

async function durableInsertEstimate(estimate) {
  const res = await supabaseRequest('estimates', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      company_id: estimate.companyId,
      estimate_number: estimate.estimateNumber,
      client_id: estimate.clientId,
      lifecycle_status: estimate.lifecycleStatus,
      data: estimate
    }])
  });
  if (!res.ok) throw new Error(`Could not save new estimate: ${await res.text()}`);
  const rows = await res.json();
  return rowToEstimate(rows[0]);
}

async function durableUpdateEstimate(companyId, estimateId, mutate) {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const current = await durableGetEstimate(companyId, estimateId);
    if (!current) throw new Error('Estimate not found.');
    const currentVersion = current.__storeVersion;
    const next = mutate(current);

    const res = await supabaseRequest(
      `estimates?company_id=eq.${encodeURIComponent(companyId)}&data->>id=eq.${encodeURIComponent(estimateId)}&version=eq.${currentVersion}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          estimate_number: next.estimateNumber,
          client_id: next.clientId,
          lifecycle_status: next.lifecycleStatus,
          data: next,
          version: currentVersion + 1,
          updated_at: new Date().toISOString()
        })
      }
    );
    if (!res.ok) throw new Error(`Could not update estimate: ${await res.text()}`);
    const rows = await res.json();
    if (rows.length) return rowToEstimate(rows[0]);
    // zero rows back = someone else updated this row between our read and
    // our write — loop and retry against the now-current row.
  }
  throw new Error('Could not update estimate after repeated concurrent-write conflicts. Please retry.');
}

// Estimate numbers come from the PROJECT counter, not a counter of their own
// (2026-08-17). An estimate is the first document of a project, so the number
// it is raised under is the number the whole project keeps: E-10001 becomes
// J-10001, then CO-10001-1 and INV-10001-1.
//
// The older allocate_estimate_number RPC (which produced 'GH-0001' from its own
// est_counters sequence) is left in place but no longer called from here —
// nothing was ever numbered by it, so there is no history to preserve.
async function durableAllocateEstimateNumber({ companyId }) {
  const seq = await allocateProjectSequence(companyId);
  return estimateRef(seq);
}

// ---------------------------------------------------------------------------
// Public interface — same shape regardless of backend.
// ---------------------------------------------------------------------------
export async function listEstimates(companyId, opts = {}) {
  if (BACKEND === 'durable') return durableListEstimates(companyId, opts);
  return memGetStore().estimates.filter(e => e.companyId === companyId && (!opts.clientId || e.clientId === opts.clientId));
}

export async function getEstimate(companyId, estimateId) {
  if (BACKEND === 'durable') return durableGetEstimate(companyId, estimateId);
  return memGetStore().estimates.find(e => e.companyId === companyId && e.id === estimateId) || null;
}

export async function insertEstimate(estimate) {
  if (BACKEND === 'durable') return durableInsertEstimate(estimate);
  memGetStore().estimates.push(estimate);
  return estimate;
}

// mutate: (currentEstimate) => nextEstimate
export async function updateEstimate(companyId, estimateId, mutate) {
  if (BACKEND === 'durable') return durableUpdateEstimate(companyId, estimateId, mutate);
  const store = memGetStore();
  const index = store.estimates.findIndex(e => e.companyId === companyId && e.id === estimateId);
  if (index === -1) throw new Error('Estimate not found.');
  const next = mutate(store.estimates[index]);
  store.estimates[index] = next;
  return next;
}

export async function allocateEstNumber({ companyId, companyCode, memoryCounterState }) {
  if (BACKEND === 'durable') {
    const estimateNumber = await durableAllocateEstimateNumber({ companyId });
    return { estimateNumber, nextMemoryCounterState: null };
  }
  // The in-memory backend (dev/tests) must produce the SAME shape as durable,
  // or a test would prove something production never does. It borrows the
  // engine's counter for sequencing, then formats to the project scheme so the
  // first estimate is E-10000 in both backends.
  const { allocateEstimateNumber } = await import('../../../server/bookkeeping/src/estimates.js');
  const { nextCounterState } = allocateEstimateNumber(memoryCounterState, { companyId, companyCode });
  const seq = (PROJECT_SEQUENCE_START - 1) + nextCounterState.nextSequence;
  return { estimateNumber: estimateRef(seq), nextMemoryCounterState: nextCounterState };
}
