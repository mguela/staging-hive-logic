-- 009_product_nicknames.sql
-- ADDITIVE ONLY. Lets a user tag any Vendor Catalog search result with a
-- personal nickname (e.g. "the good GFCI", "kitchen fan we always use"),
-- then find it again by searching that nickname instead of re-typing the
-- vendor's own product title. A lightweight companion to the Phase 0
-- materials_search flow (reina/material-catalog-phase0-live-2026-07-20.md)
-- -- not part of the Product Master / vendor_offers schema (008) since a
-- nickname is a personal label on a live search hit, not a standardized
-- catalog record. No FK into products/vendor_offers -- those only exist
-- once something is actually added to a job/estimate (Phase 1+).
--
-- Run once in the Supabase SQL editor. Safe to run more than once
-- (IF NOT EXISTS guards).

create table if not exists product_nicknames (
  id uuid primary key default gen_random_uuid(),
  vendor_key text not null,              -- 'homedepot', 'ferguson', etc. -- matches vendor_offers.vendor_key convention (008)
  vendor_sku text not null,
  nickname text not null,
  vendor_title text not null,            -- vendor's raw title at the moment it was tagged, verbatim (same fidelity rule as vendor_offers.vendor_title in 008)
  brand text,
  unit_price numeric,
  image_url text,
  product_url text,
  created_at timestamptz not null default now(),
  created_by_user_id uuid                -- references auth.users.id (Supabase Auth); nullable if attribution unknown, same convention as product_snapshots.captured_by_user_id (008)
);

-- Case-insensitive nickname lookup is the whole point of this table --
-- indexed on lower(nickname) so `ilike` search stays fast as it grows.
create index if not exists product_nicknames_nickname_idx on product_nicknames (lower(nickname));
create index if not exists product_nicknames_vendor_sku_idx on product_nicknames (vendor_key, vendor_sku);
