// api/bookkeeping/catalog.js
// The materials/reusable-expense catalog: items Reina has learned from past
// receipts (nickname, vendor, SKU, default unit price), searchable from
// expense entry and browsable here. Uses the already-ported, already-tested
// server/bookkeeping/src/catalog.js normalization helpers via
// ./_catalog_store.js's dual-backend (memory default / durable opt-in) store
// -- the same pattern api/bookkeeping/expenses.js and
// api/bookkeeping/purchase-orders/* already use.
//
// Previously this route always returned a hardcoded empty list -- an honest
// admission that no store existed yet, not a fake success. Now that
// ./_catalog_store.js + sql/021_bookkeeping_catalog.sql exist, GET actually
// lists/searches the catalog and POST actually saves to it.
//
// Still-honest remaining gap: Reina's server-side receipt-extraction
// learning is not wired to auto-populate this catalog (see reina-accuracy.js)
// -- every item here is added by a human clicking "Update materials catalog"
// / "Save as reusable expense" in Expense Entry, not by AI extraction yet.

import { getTrustedActor } from './purchase-orders/_actor.js';
import { listCatalog, saveCatalogItem, storeBackend } from './_catalog_store.js';
import { guardBookkeepingRequest } from './_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false, items: [] }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  if (req.method === 'GET') {
    try {
      const { q, type } = req.query || {};
      const items = await listCatalog(actor.companyId, { query: q, type });
      res.status(200).json({ ok: true, enabled: true, items, storeBackend: storeBackend() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || 'Could not read the materials catalog.' });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const result = await saveCatalogItem(actor.companyId, input);
      res.status(200).json({
        ok: true,
        item: result.item,
        created: result.created,
        storeBackend: storeBackend(),
        note: `Saved to the materials catalog (${storeBackend()} backend).`
      });
    } catch (error) {
      const status = error.code === 'CATALOG_NICKNAME_CONFLICT' ? 409 : 400;
      res.status(status).json({ ok: false, error: error.message || 'Could not save this catalog item.' });
    }
    return;
  }

  res.status(405).json({ ok: false, error: 'Only GET and POST are supported for this route.' });
}
