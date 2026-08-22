// api/bookkeeping/_catalog_store.js
//
// Two backends behind one interface, mirroring the exact pattern already
// proven (and already shipped) in api/bookkeeping/_expense_store.js and
// api/bookkeeping/purchase-orders/_store.js:
//
// - "memory": a module-level in-memory array per company. Safe for local
//   preview/demo use; resets on every cold start; not shared across
//   concurrent serverless instances; provides no real durability. This was,
//   until now, not even wired up -- api/bookkeeping/catalog.js always
//   returned an honest, hardcoded empty list because there was no store of
//   any kind behind it.
//
// - "durable": real Postgres via Supabase's REST (PostgREST) endpoint, using
//   the same supabaseRequest() helper api/_lib/jobber.js already uses.
//   Backed by sql/021_bookkeeping_catalog.sql -- run that migration in the
//   Supabase SQL editor once before switching backends.
//
// Which backend is active is controlled by BOOKKEEPING_CATALOG_STORE
// ('memory' by default, 'durable' to opt in) -- the same deliberate,
// explicit switch every other bookkeeping store in this app uses, for the
// same reason: moving a company's real catalog data onto a new storage
// backend is Chris's decision to make with his eyes open, after he's run
// the migration himself.
//
// Fail-closed production rule -- copied verbatim from _expense_store.js's
// own reasoning, because it applies identically here:
//
// 1. In production (VERCEL_ENV or NODE_ENV === 'production'), memory mode is
//    never allowed -- BOOKKEEPING_CATALOG_STORE must be 'durable'.
// 2. Still in production, durable mode requires an explicit human
//    confirmation that sql/021_bookkeeping_catalog.sql has actually been
//    run -- BOOKKEEPING_CATALOG_MIGRATION_CONFIRMED must be 'true'.
// 3. Outside production, memory mode requires the same opt-in dev/test flag
//    every other bookkeeping store already uses: NODE_ENV=test or
//    BOOKKEEPING_ALLOW_MEMORY_STORE=true (reused, not duplicated -- it's
//    already a generic "allow memory-mode bookkeeping storage locally"
//    switch, not specific to expenses or purchase orders).
//
// Practical consequence Chris should know: until
// sql/021_bookkeeping_catalog.sql is run AND BOOKKEEPING_CATALOG_STORE=durable
// AND BOOKKEEPING_CATALOG_MIGRATION_CONFIRMED=true are set in production,
// "Update materials catalog" / "Save as reusable expense" will return a
// clear error instead of a fake success. That is intentional.

import { supabaseRequest } from '../_lib/jobber.js';
import { randomUUID } from 'node:crypto';
let _load_catalog_cache;
async function _load_catalog() {
  if (!_load_catalog_cache) _load_catalog_cache = await import('../../server/bookkeeping/src/catalog.js');
  return _load_catalog_cache;
}

function resolveBackend() {
  const requested = process.env.BOOKKEEPING_CATALOG_STORE === 'durable' ? 'durable' : 'memory';
  const isProduction = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';

  if (isProduction) {
    if (requested !== 'durable') {
      throw new Error(
        'FAIL_CLOSED: this is a production environment and BOOKKEEPING_CATALOG_STORE is not set to "durable". ' +
        'Refusing to start on in-memory catalog storage in production -- real catalog data would silently ' +
        'vanish on every cold start. Set BOOKKEEPING_CATALOG_STORE=durable after running ' +
        'sql/021_bookkeeping_catalog.sql against the real Supabase project.'
      );
    }
    if (process.env.BOOKKEEPING_CATALOG_MIGRATION_CONFIRMED !== 'true') {
      throw new Error(
        'FAIL_CLOSED: production is configured for durable catalog storage, but ' +
        'BOOKKEEPING_CATALOG_MIGRATION_CONFIRMED is not "true". Set that flag only after you have personally run ' +
        'sql/021_bookkeeping_catalog.sql against this environment\'s real Supabase project -- this is a ' +
        'deliberate human checkpoint before real catalog data depends on that schema existing.'
      );
    }
    return 'durable';
  }

  if (requested === 'memory') {
    const allowMemory = process.env.NODE_ENV === 'test' || process.env.BOOKKEEPING_ALLOW_MEMORY_STORE === 'true';
    if (!allowMemory) {
      throw new Error(
        'FAIL_CLOSED: memory-mode catalog storage requires an explicit development/test flag. ' +
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
const memCatalogByCompany = {};
function memItems(companyId) {
  return memCatalogByCompany[companyId] || (memCatalogByCompany[companyId] = []);
}

// ---------------------------------------------------------------------------
// durable backend
// ---------------------------------------------------------------------------
function rowToItem(row) {
  // The engine's own object (upsertCatalogItem's output) is the source of
  // truth; the indexed columns exist for querying, not as a second copy of
  // the data callers should read from.
  return { ...row.data, id: row.id, __storeVersion: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}

async function durableListItems(companyId) {
  const res = await supabaseRequest(`bookkeeping_catalog_items?company_id=eq.${encodeURIComponent(companyId)}&select=*&order=updated_at.desc`);
  if (!res.ok) throw new Error(`Could not list catalog items: ${await res.text()}`);
  const rows = await res.json();
  return rows.map(rowToItem);
}

async function durableInsertItem(companyId, item) {
  const res = await supabaseRequest('bookkeeping_catalog_items', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      id: item.id,
      company_id: companyId,
      type: item.type,
      name: item.name,
      nickname: item.nickname || null,
      sku: item.sku || null,
      data: item
    }])
  });
  if (!res.ok) throw new Error(`Could not save this catalog item: ${await res.text()}`);
  const rows = await res.json();
  return rowToItem(rows[0]);
}

// Optimistic-concurrency update, same compare-and-swap shape
// purchase-orders/_store.js's durableUpdatePurchaseOrder uses: a zero-row
// result means someone else saved a change to this same item between our
// read and our write, so the caller re-reads and re-runs upsertCatalogItem()
// from scratch rather than silently overwriting their change.
async function durableUpdateItem(companyId, storeId, expectedVersion, item) {
  const res = await supabaseRequest(
    `bookkeeping_catalog_items?company_id=eq.${encodeURIComponent(companyId)}&id=eq.${encodeURIComponent(storeId)}&version=eq.${expectedVersion}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        type: item.type,
        name: item.name,
        nickname: item.nickname || null,
        sku: item.sku || null,
        data: item,
        version: expectedVersion + 1,
        updated_at: new Date().toISOString()
      })
    }
  );
  if (!res.ok) throw new Error(`Could not update this catalog item: ${await res.text()}`);
  const rows = await res.json();
  return rows.length ? rowToItem(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Public interface -- api/bookkeeping/catalog.js goes through this, never
// the two backends directly, so swapping BOOKKEEPING_CATALOG_STORE never
// touches route code.
// ---------------------------------------------------------------------------
export function storeBackend() {
  return BACKEND;
}

export async function listCatalog(companyId, { query, type } = {}) {
  const { searchCatalog } = await _load_catalog();
  const items = BACKEND === 'memory' ? memItems(companyId).slice() : await durableListItems(companyId);
  return (query || type) ? searchCatalog(items, query, { type }) : items;
}

// Runs the already-ported, already-tested upsertCatalogItem() pure function
// (nickname-conflict checking, dedupe-by-name, alias merge) against the
// company's current catalog, then persists exactly the result -- the same
// "pure engine function, thin store wrapper" split every other bookkeeping
// route in this app already uses (accounting.js / ledger.js /
// purchase-orders.js are never re-implemented inline in a route or store).
export async function saveCatalogItem(companyId, input) {
  const { normalizeCatalogTerm, upsertCatalogItem } = await _load_catalog();
  if (BACKEND === 'memory') {
    const items = memItems(companyId);
    const result = upsertCatalogItem(items, input, { id: randomUUID() });
    memCatalogByCompany[companyId] = result.items;
    return result;
  }

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const items = await durableListItems(companyId);
    const existing = input.id
      ? items.find(item => item.id === input.id)
      : items.find(item => item.type === input.type && normalizeCatalogTerm(item.name) === normalizeCatalogTerm(input.name || ''));
    const result = upsertCatalogItem(items, input, { id: randomUUID() });

    if (!existing) {
      const stored = await durableInsertItem(companyId, result.item);
      return { item: stored, created: true };
    }
    const stored = await durableUpdateItem(companyId, existing.id, existing.__storeVersion, result.item);
    if (stored) return { item: stored, created: false };
    // zero rows back = someone else updated this item between our read and
    // our write -- loop and retry against the now-current catalog rather
    // than silently overwriting their change.
  }
  throw new Error('Could not save this catalog item after repeated concurrent-write conflicts. Please retry.');
}
