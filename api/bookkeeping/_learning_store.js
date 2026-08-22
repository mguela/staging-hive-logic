// api/bookkeeping/_learning_store.js
//
// Persistence for Reina's approved-learning memory
// (server/bookkeeping/src/reina-learning.js). Before this file existed,
// nothing ever persisted a learning event anywhere in this app --
// api/bookkeeping/reina-accuracy.js always read a brand-new, empty
// createLearningState() on every request (confirmed by reading that route:
// `learningHealth(createLearningState())`, never anything read from
// storage), so the Reina Accuracy Lab's "approved corrections" count was
// hardcoded-zero-shaped, not a real gap in the counting logic -- there was
// simply no store behind it at all.
//
// Same "whole-object blob, versioned for optimistic concurrency" shape as
// api/bookkeeping/ledger/_store.js's getSystem/updateSystem, because the
// data itself has the same shape problem: reina-learning.js's
// ensureLearningState() operates on one whole { version, events[],
// migratedRules[] } object per company, not row-per-event -- normalizing
// events into their own relational table is a real future improvement for
// query performance at scale, but the object-based model here is exactly
// what the engine already expects and is already tested against.
//
// Deliberately simpler than ledger/_store.js in one respect: this does NOT
// also append to a second, independent witness table the way
// ledger/_store.js's updateSystem() does (recordAuditAppend). That
// independent witness matters for the ledger because
// api/bookkeeping/ledger/audit-verify.js needs to catch a wholesale-rewritten
// but internally self-consistent ledger history -- the ledger is the actual
// accounting record. This store holds Reina's *suggestion* memory, not an
// accounting fact; reina-learning.js's own verifyLearningChain() (which
// checks the state's own internal hash chain for tampering) is the
// integrity check that already exists and is already exposed via
// learningHealth().audit -- this store does not need a second one.
//
// Same fail-closed backend selection as every other bookkeeping store:
// BOOKKEEPING_LEARNING_STORE ('memory' default, 'durable' to opt in),
// production always requires durable + a confirmed migration flag,
// memory mode outside production requires NODE_ENV=test or
// BOOKKEEPING_ALLOW_MEMORY_STORE=true. See _expense_store.js for the full
// rationale -- copied verbatim because it applies identically here: an
// honest error beats real learning history silently vanishing on cold
// start.

import { supabaseRequest } from '../_lib/jobber.js';

let _load_reina_learning_cache;
async function _load_reina_learning() {
  if (!_load_reina_learning_cache) _load_reina_learning_cache = await import('../../server/bookkeeping/src/reina-learning.js');
  return _load_reina_learning_cache;
}

const MAX_CAS_RETRIES = 5;

function resolveBackend() {
  const requested = process.env.BOOKKEEPING_LEARNING_STORE === 'durable' ? 'durable' : 'memory';
  const isProduction = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';

  if (isProduction) {
    if (requested !== 'durable') {
      throw new Error(
        'FAIL_CLOSED: this is a production environment and BOOKKEEPING_LEARNING_STORE is not set to "durable". ' +
        'Refusing to start on in-memory Reina learning storage in production -- every approved learning event ' +
        'would silently vanish on every cold start. Set BOOKKEEPING_LEARNING_STORE=durable after running ' +
        'sql/024_bookkeeping_reina_learning.sql against the real Supabase project.'
      );
    }
    if (process.env.BOOKKEEPING_LEARNING_MIGRATION_CONFIRMED !== 'true') {
      throw new Error(
        'FAIL_CLOSED: production is configured for durable Reina learning storage, but ' +
        'BOOKKEEPING_LEARNING_MIGRATION_CONFIRMED is not "true". Set that flag only after you have personally ' +
        'run sql/024_bookkeeping_reina_learning.sql against this environment\'s real Supabase project.'
      );
    }
    return 'durable';
  }

  if (requested === 'memory') {
    const allowMemory = process.env.NODE_ENV === 'test' || process.env.BOOKKEEPING_ALLOW_MEMORY_STORE === 'true';
    if (!allowMemory) {
      throw new Error(
        'FAIL_CLOSED: memory-mode Reina learning storage requires an explicit development/test flag. ' +
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
const memoryStates = {};

// ---------------------------------------------------------------------------
// durable backend -- single versioned jsonb row per company in
// bookkeeping_reina_learning (see sql/024_bookkeeping_reina_learning.sql).
// ---------------------------------------------------------------------------
async function durableGetState(companyId) {
  const res = await supabaseRequest(`bookkeeping_reina_learning?company_id=eq.${encodeURIComponent(companyId)}&select=*`);
  if (!res.ok) throw new Error(`Could not read Reina's learning memory: ${await res.text()}`);
  const rows = await res.json();
  if (rows[0]) return { data: rows[0].data, version: rows[0].version };

  const { createLearningState } = await _load_reina_learning();
  const data = createLearningState();
  const insertRes = await supabaseRequest('bookkeeping_reina_learning', {
    method: 'POST',
    headers: { Prefer: 'return=representation,resolution=ignore-duplicates' },
    body: JSON.stringify([{ company_id: companyId, data, version: 1 }])
  });
  if (!insertRes.ok) throw new Error(`Could not provision Reina's learning memory: ${await insertRes.text()}`);
  const inserted = await insertRes.json();
  if (inserted[0]) return { data: inserted[0].data, version: inserted[0].version };
  // ignore-duplicates raced with a concurrent first-access -- re-read.
  return durableGetState(companyId);
}

async function durableUpdateState(companyId, expectedVersion, nextData) {
  const res = await supabaseRequest(`bookkeeping_reina_learning?company_id=eq.${encodeURIComponent(companyId)}&version=eq.${expectedVersion}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ data: nextData, version: expectedVersion + 1, updated_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error(`Could not update Reina's learning memory: ${await res.text()}`);
  const rows = await res.json();
  if (!rows.length) { const err = new Error('CONCURRENT_CONFLICT: Reina\'s learning memory was modified by someone else since it was read.'); err.code = 'CONCURRENT_CONFLICT'; throw err; }
  return rows[0].data;
}

// ---------------------------------------------------------------------------
// public interface
// ---------------------------------------------------------------------------
export function storeBackend() { return BACKEND; }

export async function getLearningState(companyId) {
  if (BACKEND === 'memory') {
    if (!memoryStates[companyId]) {
      const { createLearningState } = await _load_reina_learning();
      memoryStates[companyId] = { data: createLearningState(), version: 1 };
    }
    return structuredClone(memoryStates[companyId].data);
  }
  const { data } = await durableGetState(companyId);
  return data;
}

// mutate: (state) => nextState, where state is reina-learning.js's own
// ensureLearningState() shape. Applied via compare-and-swap under the
// durable backend; applied directly (single-threaded, no race possible)
// under the memory backend.
export async function updateLearningState(companyId, mutate) {
  if (BACKEND === 'memory') {
    if (!memoryStates[companyId]) {
      const { createLearningState } = await _load_reina_learning();
      memoryStates[companyId] = { data: createLearningState(), version: 1 };
    }
    const next = mutate(structuredClone(memoryStates[companyId].data));
    memoryStates[companyId] = { data: next, version: memoryStates[companyId].version + 1 };
    return next;
  }

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    const { data, version } = await durableGetState(companyId);
    const next = mutate(data);
    try {
      return await durableUpdateState(companyId, version, next);
    } catch (error) {
      if (error.code !== 'CONCURRENT_CONFLICT' || attempt === MAX_CAS_RETRIES - 1) throw error;
    }
  }
  throw new Error('Could not update Reina\'s learning memory after repeated concurrent-write conflicts. Please retry.');
}
