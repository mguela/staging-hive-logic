// api/bookkeeping/purchase-orders/list.js — Vercel serverless function.
// Lists purchase orders scoped to the requesting actor's own company only.
// See _store.js for the memory/durable backend split and _actor.js for
// identity rules.

import { listPurchaseOrders, storeBackend } from './_store.js';
import { getTrustedActor } from './_actor.js';
import { guardBookkeepingRequest } from '../_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false, purchaseOrders: [] }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const purchaseOrders = await listPurchaseOrders(actor.companyId);
    res.status(200).json({ ok: true, enabled: true, purchaseOrders, storeBackend: storeBackend() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Could not list purchase orders.' });
  }
}
