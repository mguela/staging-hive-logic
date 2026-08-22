// api/bookkeeping/reina-accuracy.js
// The Reina Accuracy Lab — proves Reina's receipt/document extraction stays
// safe (uncertain fields held for a human, no wrong critical value silently
// auto-filled) using the ported, curriculum-based benchmark
// (server/bookkeeping/src/reina-benchmark.js) plus the real, persisted
// approved-learning memory state (api/bookkeeping/_learning_store.js, wired
// up as of task 6 -- previously this always read a brand-new, empty
// createLearningState() on every single request, so "approved corrections"
// was zero-shaped regardless of how many expenses had actually been
// approved) and permissioned real-document benchmark registry.
//
// Reina's autonomous, server-side document extraction/OCR remains
// hard-disabled in this app by design (see reina/expense-and-po-review-
// checklist-2026-07-21.md items 42/43 and task 8's not-yet-built status) --
// so the "real permissioned benchmark" section below is honestly
// empty/zero rather than fabricated: no controller has authorized a real
// company document into the benchmark registry. The learning memory,
// however, is real as of task 6: an admin approving an expense really does
// record an approved classification (see controls/decide-approval.js), and
// this route reads that same real, persisted state -- not a fresh empty one.

let _load_reina_benchmark_cache;
async function _load_reina_benchmark() {
  if (!_load_reina_benchmark_cache) _load_reina_benchmark_cache = await import('../../server/bookkeeping/src/reina-benchmark.js');
  return _load_reina_benchmark_cache;
}
let _load_reina_learning_cache;
async function _load_reina_learning() {
  if (!_load_reina_learning_cache) _load_reina_learning_cache = await import('../../server/bookkeeping/src/reina-learning.js');
  return _load_reina_learning_cache;
}
import { getLearningState } from './_learning_store.js';
import { getTrustedActor } from './purchase-orders/_actor.js';
import { guardBookkeepingRequest } from './_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { runReinaBenchmark, createBenchmarkRegistry, evaluatePermissionedBenchmark } = await _load_reina_benchmark();
    const { learningHealth } = await _load_reina_learning();
    const benchmark = runReinaBenchmark();
    // autoFillEnabled is a policy flag, not something the engine computes --
    // Reina's autonomous autofill stays off in every environment until Chris
    // sets HIVELOGIC_REINA_LEARNING_AUTOFILL_ENABLED=true (same strict
    // gate as HIVELOGIC_QBO_WRITE_ENABLED from task 5 -- was previously
    // hardcoded false here regardless of the real flag's value).
    const autoFillEnabled = process.env.HIVELOGIC_REINA_LEARNING_AUTOFILL_ENABLED === 'true';
    const learningState = await getLearningState(actor.companyId);
    const learning = { ...learningHealth(learningState), autoFillEnabled };
    const realBenchmark = {
      ...evaluatePermissionedBenchmark(createBenchmarkRegistry(), actor.companyId),
      note: 'No real company document has been authorized into this benchmark yet -- that requires a controller to explicitly opt a document in, per the standing rule that Reina server-side extraction stays unconnected until authorized.'
    };
    res.status(200).json({ ok: true, benchmark, learning, realBenchmark });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'The accuracy lab could not run.' });
  }
}
