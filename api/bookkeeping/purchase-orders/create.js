// api/bookkeeping/purchase-orders/create.js — Vercel serverless function.
// Creates a purchase order (planned or after-the-fact) using the rewritten
// PO engine (server/bookkeeping/src/purchase-orders.js — 81/81 tests across
// the bookkeeping engine, including the fixes for all four bugs the outside
// review reproduced).
//
// PO numbering is allocated durably (see _store.js allocatePoNumber / the
// durable backend's allocate_po_number() Postgres function) BEFORE calling
// into the engine, then handed to createPurchaseOrder() as a pre-assigned
// input.poNumber — this is the one supported way to bypass the engine's own
// in-memory-counterState numbering path, so a real atomic sequence and the
// engine's validation/state-machine logic are never in tension.
//
// QBO writes are never made here — only a QBO-compatible preview, generated
// on demand from other routes.

let _load_purchase_orders_cache;
async function _load_purchase_orders() {
  if (!_load_purchase_orders_cache) _load_purchase_orders_cache = await import('../../../server/bookkeeping/src/purchase-orders.js');
  return _load_purchase_orders_cache;
}
import { insertPurchaseOrder, allocatePoNumber, getStore, storeBackend } from './_store.js';
import { getTrustedActor } from './_actor.js';
import { guardBookkeepingRequest } from '../_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request. Actor identity is never accepted from the request body.' }); return; }

  try {
    const { createPurchaseOrder } = await _load_purchase_orders();
        const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    // companyId is never accepted from the client either -- same reasoning
    // as requestedBy above. In this single-tenant app every verified actor
    // already carries the one real companyId; a client-supplied override
    // would be a second, unnecessary trust-the-request vector.
    const companyId = actor.companyId;

    const memoryCounterState = storeBackend() === 'memory' ? getStore().getCounterState(companyId) : null;
    const { poNumber, nextMemoryCounterState } = await allocatePoNumber({
      companyId, jobId: input.jobId, companyCode: input.companyCode, memoryCounterState
    });
    if (storeBackend() === 'memory') getStore().setCounterState(companyId, nextMemoryCounterState);

    // Round 3 correction #12: requestedBy must bind to the authenticated
    // actor's own id. There is no delegation workflow (audited or otherwise)
    // in this app yet, so a client-supplied requestedBy is never honored --
    // previously `input.requestedBy || actor.id` let a client silently win
    // by simply supplying its own value on the request body.
    const { purchaseOrder } = createPurchaseOrder(
      { ...input, companyId, poNumber, requestedBy: actor.id },
      actor,
      {}
    );
    await insertPurchaseOrder(purchaseOrder);

    res.status(200).json({
      ok: true,
      purchaseOrder,
      qboWritesEnabled: false,
      storeBackend: storeBackend(),
      note: purchaseOrder.notPreapproved
        ? 'Recorded as after-the-fact and permanently flagged not preapproved. It will never be silently upgraded to a planned, preapproved purchase order.'
        : 'Created as a planned purchase order awaiting approval. No QBO write occurred.'
    });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not create this purchase order.' });
  }
}
