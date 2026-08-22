// api/bookkeeping/reina-suggest.js
//
// Suggest-only. Returns what Reina's approved-learning memory
// (server/bookkeeping/src/reina-learning.js) would recommend for one or more
// expense-entry lines, given a vendor/sku/description/context -- it never
// writes an expense, never changes a line, and never auto-applies anything.
// A human must click "Use" in the browser to actually copy a suggestion into
// a line's real fields (see public/app-bookkeeping.js).
//
// POST body: { vendor, lines: [{ lineId?, sku?, description?, paymentAccountId?, taxState? }, ...] }
// or, for a single line, just { vendor, sku?, description?, paymentAccountId?, taxState? }
// (no lines array -- treated as one line with lineId null).
//
// Deliberate divergence from the reference's own default: the reference
// treats HIVELOGIC_REINA_LEARNING_AUTOFILL_ENABLED as ON by default outside
// production (only OFF if explicitly set to 'false'). This app's standing
// safety rule for the "we are doing it all now" pivot is off-by-default in
// EVERY environment until Chris flips it -- so here the flag must be
// LITERALLY 'true' to enable auto_fill-strength suggestions, mirroring
// HIVELOGIC_QBO_WRITE_ENABLED's exact same strict-equality gate from task 5.
//
// When the flag is off, this does NOT hide suggestions -- it uses the
// reference's own real technique for capping strength: passing a policy
// object with autoFill raised to an impossible confidence (2, confidence is
// always 0..1) into suggestFromApprovedLearning()/confidenceDecision(), so a
// match that would otherwise reach "auto_fill" is honestly reported as
// "review" instead. Nothing is ever silently auto-applied by this route
// either way -- "auto_fill" from the engine is a confidence label the
// browser can choose to pre-check a box with, not a server-side action.

import { getLearningState } from './_learning_store.js';
import { getTrustedActor } from './purchase-orders/_actor.js';
import { guardBookkeepingRequest } from './_security.js';

let _load_reina_learning_cache;
async function _load_reina_learning() {
  if (!_load_reina_learning_cache) _load_reina_learning_cache = await import('../../server/bookkeeping/src/reina-learning.js');
  return _load_reina_learning_cache;
}

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { suggestFromApprovedLearning, learningHealth, REINA_CONFIDENCE_POLICY } = await _load_reina_learning();
    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const vendor = String(input.vendor || '').trim();
    if (!vendor) { res.status(200).json({ ok: true, enabled: true, autoFillEnabled: false, suggestions: [], note: 'A vendor is needed before Reina can suggest anything.' }); return; }

    const autoFillEnabled = process.env.HIVELOGIC_REINA_LEARNING_AUTOFILL_ENABLED === 'true';
    const policy = autoFillEnabled ? REINA_CONFIDENCE_POLICY : { ...REINA_CONFIDENCE_POLICY, autoFill: 2 };

    const lines = Array.isArray(input.lines) && input.lines.length
      ? input.lines
      : [{ lineId: null, sku: input.sku, description: input.description, paymentAccountId: input.paymentAccountId, taxState: input.taxState }];

    const learning = await getLearningState(actor.companyId);
    const suggestions = lines.map(line => ({
      lineId: line.lineId ?? null,
      ...suggestFromApprovedLearning(learning, {
        companyId: actor.companyId,
        vendor,
        sku: line.sku,
        description: line.description,
        paymentAccountId: line.paymentAccountId,
        taxState: line.taxState
      }, policy)
    }));

    res.status(200).json({ ok: true, enabled: true, autoFillEnabled, suggestions, learning: learningHealth(learning) });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not check Reina\'s learning memory.' });
  }
}
