-- 020_estimates.sql
-- ADDITIVE ONLY. Safe to run more than once (IF NOT EXISTS guards throughout).
-- Run once in the Supabase SQL editor before setting BOOKKEEPING_EST_STORE=durable.
--
-- Durable storage for the real, native HiveLogic Estimates engine
-- (server/bookkeeping/src/estimates.js) — built per the standing rule
-- (2026-07-22): HiveLogic is the destination system, Jobber is only an
-- interim data feed. This table has no dependency on Jobber's quote or
-- payment-schedule shapes. Same jsonb-document convention as
-- sql/010_purchase_orders.sql / sql/018_change_orders.sql: the full
-- estimate object the engine produces/consumes is stored as one jsonb
-- document per row, with a handful of columns pulled out for fast
-- indexing/filtering.

create table if not exists estimates (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  estimate_number text not null,
  client_id text not null,
  lifecycle_status text not null,      -- mirrors estimate.lifecycleStatus
  version integer not null default 1,
  data jsonb not null,                 -- the full estimate object exactly as the engine produces/consumes it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A company can never have two estimates sharing a number.
create unique index if not exists estimates_company_number_uidx
  on estimates (company_id, estimate_number);

create index if not exists estimates_company_idx on estimates (company_id);
create index if not exists estimates_company_client_idx on estimates (company_id, client_id);
create index if not exists estimates_company_status_idx on estimates (company_id, lifecycle_status);

-- Durable, atomic per-company sequence for estimate numbering (mirrors
-- allocate_po_number() / allocate_co_number()). An estimate has no job yet
-- (that's the point of this workflow), so numbering is company-scoped, not
-- job-scoped.
create table if not exists est_counters (
  company_id text not null,
  next_sequence integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (company_id)
);

create or replace function allocate_estimate_number(p_company_id text, p_company_code text default 'EST')
returns table(estimate_number text, sequence_no integer) as $$
declare
  v_seq integer;
begin
  insert into est_counters (company_id, next_sequence)
    values (p_company_id, 1)
  on conflict (company_id)
    do update set next_sequence = est_counters.next_sequence + 1, updated_at = now()
  returning next_sequence into v_seq;

  if v_seq is null then
    v_seq := 1;
  end if;

  estimate_number := p_company_code || '-' || lpad(v_seq::text, 4, '0');
  sequence_no := v_seq;
  return next;
end;
$$ language plpgsql;
