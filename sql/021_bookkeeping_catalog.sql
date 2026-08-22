-- 021_bookkeeping_catalog.sql
-- ADDITIVE ONLY. Safe to run more than once (IF NOT EXISTS guards throughout).
-- Run once in the Supabase SQL editor before setting BOOKKEEPING_CATALOG_STORE=durable.
--
-- Fixes a real, verified gap: api/bookkeeping/catalog.js always returned an
-- honest empty list because there was no durable store behind it at all --
-- "Update materials catalog" / "Save as reusable expense" in Expense Entry
-- had nothing to write to, so the buttons could only ever be a stub. This
-- table, plus the dual-backend store in api/bookkeeping/_catalog_store.js,
-- is the fix -- same convention already proven for expenses in
-- sql/018_bookkeeping_expenses.sql and for purchase orders in
-- sql/010_purchase_orders.sql.
--
-- Design: the full catalog item, exactly as normalized by the already-ported,
-- already-tested server/bookkeeping/src/catalog.js (normalizeCatalogTerm /
-- upsertCatalogItem / searchCatalog), is stored as one jsonb document per
-- row -- same convention this repo already uses for bookkeeping_expenses.data.
-- type/name/nickname/sku are pulled out of that jsonb body as real columns
-- so lookups (by nickname, by sku, by type) don't need a jsonb path query on
-- every keystroke of Expense Entry's catalog search.
--
-- NOTE: this is a DIFFERENT catalog from sql/008_material_catalog.sql /
-- sql/009_product_nicknames.sql -- those back the separate Vendor Catalog /
-- Project Cart feature (shopping from a vendor's own price list: vendor-
-- owned SKUs, bulk price tiers). This table is the bookkeeping-side "items
-- Reina has learned from past receipts" catalog that Expense Entry's line
-- items read from and write to. Confirmed by reading both existing
-- migrations before writing this one -- reusing them would have been the
-- wrong table for a structurally different problem.
--
-- version column: optimistic concurrency, same pattern already used by
-- purchase_orders and bookkeeping_expenses.

create table if not exists bookkeeping_catalog_items (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  type text not null check (type in ('material', 'expense')),
  name text not null,
  nickname text,
  sku text,
  version integer not null default 1,
  data jsonb not null,                    -- the full catalog item exactly as normalized by upsertCatalogItem()
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bookkeeping_catalog_items_company_idx on bookkeeping_catalog_items (company_id);
create index if not exists bookkeeping_catalog_items_company_type_idx on bookkeeping_catalog_items (company_id, type);
