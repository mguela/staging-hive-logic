-- 008_material_catalog.sql
--
-- This migration was NOT written from a spec doc -- it's reverse-engineered
-- from code that's already committed and merged into main (commit 3b3b20d,
-- "Project Cart: real job/estimate material lists (Phase 1)"). That commit
-- added api/track1.js's upsertProductAndOffer(), handleMaterialsCartAdd/Get/
-- Remove(), handleMaterialsNicknameSave(), and findNicknameMatches() --
-- all of it already live on main, all of it already calling a
-- products/vendor_offers/product_snapshots schema that this repo's sql/
-- directory never actually got a migration for (the same gap
-- 009_product_nicknames.sql's own comments already flagged, referencing
-- "008" as if it existed).
--
-- Every column below is taken directly from what that already-shipped code
-- reads or writes -- not guessed, not from the (unread) Jovie handoff doc
-- Part 2. Cross-check against api/track1.js's upsertProductAndOffer /
-- handleMaterialsCartAdd / handleMaterialsCartGet if anything here looks
-- wrong; that function bodies are the actual source of truth this was
-- built from.
--
-- ADDITIVE ONLY. Safe to run more than once (IF NOT EXISTS guards throughout).
-- Run once in the Supabase SQL editor -- this is what's currently blocking
-- the already-deployed Project Cart feature from working at all (every
-- materials_cart_* / materials_nickname_save call fails with a
-- table-does-not-exist error from Supabase until this runs).

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  standard_name text,
  name_confidence numeric,          -- always null in the current code (no AI naming pass wired up yet) -- reserved for that later pass
  name_reviewed boolean not null default false,
  manufacturer text,
  category text,
  unit_of_measure text,
  spec_attributes jsonb,
  image_primary text,
  created_from text,                -- e.g. 'vendor-import'
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists vendor_offers (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id),
  vendor_key text not null,         -- 'homedepot', 'lowes', 'ferguson', 'ringsend', ... -- matches every adapter's normalize().vendor_key
  connector_type text,              -- 'api' | 'punchout' | 'feed' | 'document_import' -- copied from the adapters/index.js registry
  vendor_sku text,
  store_sku text,
  vendor_title text not null,
  manufacturer_model_number text,
  brand text,
  package_qty numeric,
  unit_price numeric,
  bulk_price_tiers jsonb,
  product_url text,
  image_url text,
  currency text not null default 'USD',
  source text not null,             -- e.g. 'homedepot:serpapi', 'lowes:api' -- matches every adapter's normalize().source
  last_verified_at timestamptz,     -- touched on every re-add of an already-known (vendor_key, vendor_sku) pair
  created_at timestamptz not null default now()
);
-- upsertProductAndOffer()'s own comment states this uniqueness is assumed
-- to already exist ("there's a unique index on that pair already, sql/008") --
-- making it real here, since nothing else ever created it.
create unique index if not exists vendor_offers_vendor_key_sku_uidx on vendor_offers (vendor_key, vendor_sku);

create table if not exists product_snapshots (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id),
  vendor_offer_id uuid references vendor_offers(id),
  attached_to_type text not null,   -- 'JOB_MATERIAL_LIST' | 'ESTIMATE_LINE_ITEM' -- matches the Vendor Catalog UI's vcCartTarget values exactly
  attached_to_id text not null,     -- Jobber job id or quote id (text, not uuid)
  title text,
  vendor_title text not null,
  image_url text,
  sku text,
  model_number text,
  spec_attributes jsonb,
  package_qty numeric,
  quantity numeric not null default 1,
  quoted_price numeric,             -- frozen unit price at the moment this was added -- never rewritten by a later live price
  source_url text,
  captured_at timestamptz not null default now(),
  captured_by_user_id uuid          -- references auth.users.id (Supabase Auth); nullable if attribution unknown, same convention as product_nicknames.created_by_user_id (009)
);
create index if not exists product_snapshots_attached_idx on product_snapshots (attached_to_type, attached_to_id);
