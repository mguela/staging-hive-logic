-- 010_cart_draft_support.sql
-- ADDITIVE ONLY. Lets a Project Cart be built and saved BEFORE a job or
-- estimate is chosen (Chris's ask, 2026-07-21): "we should be able to
-- build the cart and save it and then add job/estimate details." Until
-- now, attached_to_type/attached_to_id were NOT NULL on product_snapshots,
-- so no item could be added at all without a target already picked.
--
-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New
-- query -> paste -> Run) before the new resource=materials_cart_attach /
-- the draft-cart flow in the Vendor Catalog page will work. Safe to run
-- more than once.

alter table product_snapshots alter column attached_to_type drop not null;
alter table product_snapshots alter column attached_to_id drop not null;

alter table product_snapshots add column if not exists draft_cart_id uuid;
create index if not exists product_snapshots_draft_cart_idx
  on product_snapshots (draft_cart_id) where draft_cart_id is not null;

-- A snapshot is either attached to a real target (both attached_to_* set,
-- draft_cart_id null) or sitting in an unattached draft cart (draft_cart_id
-- set, both attached_to_* null) -- never both, never neither. Wrapped in a
-- DO block since Postgres has no ADD CONSTRAINT IF NOT EXISTS.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'product_snapshots_attach_xor_draft'
  ) then
    alter table product_snapshots add constraint product_snapshots_attach_xor_draft
      check (
        (attached_to_type is not null and attached_to_id is not null and draft_cart_id is null)
        or
        (attached_to_type is null and attached_to_id is null and draft_cart_id is not null)
      );
  end if;
end $$;
