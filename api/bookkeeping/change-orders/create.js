// api/bookkeeping/change-orders/create.js — Vercel serverless function.
// Creates a Change Order (estimate or invoice kind), chained to an existing
// job, using the real change-order engine (server/bookkeeping/src/change-orders.js).
//
// CO numbering is allocated durably BEFORE calling into the engine, then
// handed to createChangeOrder() as a pre-assigned input.coNumber — same
// pattern as purchase-orders/create.js.
//
// QBO writes are never made here.

let _load_change_orders_cache;
async function _load_change_orders() {
  if (!_load_change_orders_cache) _load_change_orders_cache = await import('../../../server/bookkeeping/src/change-orders.js');
  return _load_change_orders_cache;
}
import { insertChangeOrder, allocateCoNumber, getStore, storeBackend } from './_store.js';
import { getTrustedActor } from '../purchase-orders/_actor.js';

export default async function handler(req, res) {
  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request. Actor identity is never accepted from the request body.' }); return; }

  try {
    const { createChangeOrder } = await _load_change_orders();
    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const companyId = actor.companyId;
    if (!input.jobId) { res.status(422).json({ ok: false, error: 'A change order must be chained to an existing job (jobId is required).' }); return; }

    const memoryCounterState = storeBackend() === 'memory' ? getStore().getCounterState(companyId) : null;
    const { coNumber, nextMemoryCounterState } = await allocateCoNumber({
      companyId, jobId: input.jobId, companyCode: input.companyCode, memoryCounterState
    });
    if (storeBackend() === 'memory') getStore().setCounterState(companyId, nextMemoryCounterState);

    // Cash-discount program rate: explicit per-CO cardRateBps wins; else the
    // environment's program rate (CARD_RATE_BPS); else the engine default of
    // 400 bps (4.00%). See server/bookkeeping/src/card-pricing.js.
    const cardRateBps = input.cardRateBps != null
      ? input.cardRateBps
      : (process.env.CARD_RATE_BPS != null ? Number(process.env.CARD_RATE_BPS) : undefined);
    const { changeOrder } = createChangeOrder(
      { ...input, companyId, coNumber, requestedBy: actor.id, cardRateBps },
      actor,
      {}
    );
    await insertChangeOrder(changeOrder);

    res.status(200).json({
      ok: true,
      changeOrder,
      qboWritesEnabled: false,
      storeBackend: storeBackend(),
      note: changeOrder.kind === 'invoice'
        ? 'Created as a Change Order Invoice for already-completed work. Auto-approved (no client-approval step) and permanently flagged as such — it will never be shown as a client approval.'
        : 'Created as a Change Order Estimate, in draft. Send it to move it to "sent" and start the client-approval clock.'
    });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not create this change order.' });
  }
}
