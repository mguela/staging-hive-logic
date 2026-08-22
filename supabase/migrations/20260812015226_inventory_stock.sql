-- Canonical capture of sql/070_inventory_stock.sql into supabase/migrations.
-- Objects were already applied directly to production (2026-08-12); this file
-- records them in the migration ledger so a fresh install reproduces them.
-- Idempotent -- safe if it ever re-runs. Depends on public.vehicles only by
-- convention (location_key strings), not by foreign key.
--
-- Real Inventory & Truck Stock (2026-08-12), replacing a fully-mock page
-- that hardcoded a $38,420 "stock value," fabricated SKU counts, and --
-- worst of all -- a purple "Reina" banner claiming an AI agent had already
-- compared vendor pricing and drafted a real purchase order overnight, plus
-- a "TRUCK STOCK -- LIVE (FIELD REQUESTS AUTO-DECREMENT)" label implying a
-- real-time consumption pipeline. None of that existed anywhere -- every
-- number and claim on the page was static HTML.
--
-- Phase 1 scope (deliberately manual, not automated): a real stock-item
-- catalog and a real on-hand ledger per location (the single warehouse, or
-- a specific truck/vehicle), adjusted by hand by an admin, with every
-- adjustment logged. No automatic decrement on job completion exists yet
-- (there is no "materials used on a job" concept anywhere in this schema to
-- hook into), and no AI-driven reorder drafting -- low-stock items are
-- flagged by a plain threshold check, not narrated.
--
-- Trucks are NOT a new table here -- they're the existing real `vehicles`
-- table (from the FleetSharp integration). A location is either the single
-- implicit warehouse or a specific vehicle, encoded as a location_key
-- string ('warehouse' or 'truck:<vehicles.jobber_id>') rather than a
-- separate locations table, since vehicles.jobber_id is already the real,
-- unique identity for a truck.

create table if not exists public.stock_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sku text,
  category text,
  unit_of_measure text,
  reorder_threshold numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_email text
);
create index if not exists stock_items_name_idx on public.stock_items (name);

create table if not exists public.stock_on_hand (
  stock_item_id uuid not null references public.stock_items(id),
  location_key text not null,
  quantity numeric not null default 0,
  updated_at timestamptz not null default now(),
  updated_by_email text,
  primary key (stock_item_id, location_key)
);

create table if not exists public.stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  stock_item_id uuid not null references public.stock_items(id),
  location_key text not null,
  delta numeric not null,
  quantity_after numeric not null,
  reason text,
  adjusted_by_email text,
  adjusted_at timestamptz not null default now()
);
create index if not exists stock_adjustments_item_idx on public.stock_adjustments (stock_item_id);
create index if not exists stock_adjustments_adjusted_at_idx on public.stock_adjustments (adjusted_at desc);

alter table public.stock_items enable row level security;
alter table public.stock_on_hand enable row level security;
alter table public.stock_adjustments enable row level security;
-- No permissive policies -- only the service-role key (server-side only,
-- via api/track1.js's inventory_* resources) can read/write. Matches the
-- convention for every other table in this app.
