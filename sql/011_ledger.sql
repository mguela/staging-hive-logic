-- 011_ledger.sql
-- ADDITIVE ONLY. Safe to run more than once (IF NOT EXISTS guards throughout).
-- Run once in the Supabase SQL editor before setting BOOKKEEPING_PO_STORE=durable
-- for the ledger engine (same env var as 010_purchase_orders.sql -- one Vercel
-- deploy uses one storage backend for the whole bookkeeping module).
--
-- Backs api/bookkeeping/ledger/_store.js. Design mirrors 010's: the ported
-- general-ledger/reporting/banking/close/controls engine
-- (server/bookkeeping/src/ledger.js + controls.js) operates on one whole
-- in-memory object per company -- not one row per journal entry -- so this
-- table stores that whole object (ledger + controls) as a single jsonb
-- document per company, versioned for optimistic concurrency, same CAS
-- pattern as purchase_orders. This is a deliberate simplification: it keeps
-- the durable store a faithful, zero-drift mirror of the already-tested
-- engine's own data shape rather than inventing a parallel relational schema
-- that could silently diverge from what the engine actually produces.
-- Normalizing into per-entry/per-line tables is a real future improvement
-- for query performance at real scale, not a correctness requirement today.

create table if not exists ledger_systems (
  id uuid primary key default gen_random_uuid(),
  company_id text not null unique,
  version integer not null default 1,
  data jsonb not null,               -- { ledger: {...}, controls: {...} } exactly as the engine produces/consumes it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ledger_systems_company_idx on ledger_systems (company_id);
