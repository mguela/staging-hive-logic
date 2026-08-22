// api/bookkeeping/estimates/create.js — Vercel serverless function.
// Creates an estimate (with its payment schedule, one row flagged as the
// deposit), using the real estimate engine
// (server/bookkeeping/src/estimates.js). Estimate numbering is allocated
// durably before calling into the engine, same pattern as purchase-orders
// and change-orders create routes.

let _load_estimates_cache;
async function _load_estimates() {
  if (!_load_estimates_cache) _load_estimates_cache = await import('../../../server/bookkeeping/src/estimates.js');
  return _load_estimates_cache;
}
import { insertEstimate, allocateEstNumber, getStore, storeBackend } from './_store.js';
import { getTrustedActor } from '../purchase-orders/_actor.js';
import { linkLeadToEstimate } from '../../_lib/lead-estimate-link.js';

export default async function handler(req, res) {
  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request. Actor identity is never accepted from the request body.' }); return; }

  try {
    const { createEstimate } = await _load_estimates();
    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const companyId = actor.companyId;
    if (!input.clientId) { res.status(422).json({ ok: false, error: 'A client is required to create an estimate.' }); return; }

    const memoryCounterState = storeBackend() === 'memory' ? getStore().getCounterState(companyId) : null;
    const { estimateNumber, nextMemoryCounterState } = await allocateEstNumber({
      companyId, companyCode: input.companyCode, memoryCounterState
    });
    if (storeBackend() === 'memory') getStore().setCounterState(companyId, nextMemoryCounterState);

    // Cash-discount program rate: an explicit per-estimate cardRateBps wins;
    // otherwise the environment's program rate (CARD_RATE_BPS); otherwise
    // the engine's default of 400 bps (4.00%). See card-pricing.js.
    const cardRateBps = input.cardRateBps != null
      ? input.cardRateBps
      : (process.env.CARD_RATE_BPS != null ? Number(process.env.CARD_RATE_BPS) : undefined);
    const { estimate } = createEstimate(
      { ...input, companyId, estimateNumber, requestedBy: actor.id, cardRateBps },
      actor,
      {}
    );
    // Which lead produced this estimate (Phase 0, item 5). createEstimate builds
    // an explicit object rather than spreading its input, so this is stamped on
    // afterwards -- passing it through the input would silently vanish.
    if (input.sourceLeadId) estimate.sourceLeadId = String(input.sourceLeadId);

    await insertEstimate(estimate);

    // The estimate is the real record and now exists. A failed link is a
    // reporting gap, not lost work, so it is reported rather than thrown --
    // never sink a saved estimate over its lead pointer. The card's stage is
    // deliberately NOT moved here: this estimate is still a draft, and the send
    // that usually follows can fail.
    let leadLink = null;
    if (estimate.sourceLeadId) {
      leadLink = await linkLeadToEstimate(estimate.sourceLeadId, estimate.id);
    }

    res.status(200).json({
      ok: true,
      estimate,
      storeBackend: storeBackend(),
      leadLinked: leadLink ? leadLink.linked : undefined,
      leadLinkError: (leadLink && !leadLink.linked) ? leadLink.reason : undefined,
      note: 'Created in draft. Send it to the client to start the deposit clock — approval is blocked until the deposit row is fully paid.'
    });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not create this estimate.' });
  }
}
