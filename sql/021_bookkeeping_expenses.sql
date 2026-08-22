-- 021_bookkeeping_expenses.sql
-- ADDITIVE ONLY. Safe to run more than once (IF NOT EXISTS guards throughout).
-- Run once in the Supabase SQL editor before setting BOOKKEEPING_EXPENSE_STORE=durable.
--
-- Fixes a real, verified gap: api/bookkeeping/expenses.js validates an
-- expense against the accounting engine and returns a QBO preview, but never
-- writes it anywhere durable -- every "Saved as draft" / "Submitted for
-- review" response was true only for validation, never for storage. Data
-- was silently lost on every request. This table, plus the dual-backend
-- store in api/bookkeeping/_expense_store.js, is the fix -- same convention
-- already proven for purchase orders in sql/010_purchase_orders.sql.
--
-- Design: the full expense object (allocations, tax distribution, evidence
-- link, QBO preview) is stored as one jsonb document per row, same
-- convention this repo already uses for purchase_orders.data and
-- spec_attributes/bulk_price_tiers in sql/008_material_catalog.sql. A
-- handful of top-level columns are pulled out of that jsonb body so
-- Postgres can index/filter directly without jsonb path queries on every
-- list call.
--
-- Optimistic concurrency: a `version` column, same pattern as
-- purchase_orders -- no update path is wired to the API yet (expenses have
-- no edit/approve flow today), but the column is here so that a future
-- edit/approve flow doesn't require a second migration to add it.

create table if not exists bookkeeping_expenses (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  status text not null check (status in ('draft_saved', 'submitted_for_review')),
  transaction_kind text,
  qbo_vendor_id text,
  vendor_name text,
  transaction_date date,
  due_date date,
  payment_account_id text,
  payment_type text,
  receipt_subtotal numeric,
  sales_tax_total numeric,
  total numeric,
  version integer not null default 1,
  data jsonb not null,                    -- the full expense object exactly as submitted + validated + the QBO preview
  created_by uuid,                        -- the verified actor's profile id (see purchase-orders/_actor.js), never client-supplied
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bookkeeping_expenses_company_idx on bookkeeping_expenses (company_id);
create index if not exists bookkeeping_expenses_company_status_idx on bookkeeping_expenses (company_id, status);
create index if not exists bookkeeping_expenses_company_date_idx on bookkeeping_expenses (company_id, transaction_date);

alter table bookkeeping_expenses enable row level security;
-- No permissive policies -- matches every other table in this app: only the
-- service-role key (server-side only, via api/bookkeeping/expenses.js) can
-- read/write. Without this, the table would be open by default to the
-- anon/authenticated keys if either was ever pointed at it directly.
