-- 018_change_orders.sql
-- ADDITIVE ONLY. Safe to run more than once (IF NOT EXISTS guards throughout).
-- Run once in the Supabase SQL editor before setting BOOKKEEPING_CO_STORE=durable.
--
-- Durable storage for the real Change Orders feature (server/bookkeeping/src/
-- change-orders.js), replacing the static three-row mockup that used to live
-- directly in public/index.html. Same jsonb-document convention as
-- sql/010_purchase_orders.sql: the full change order object the engine
-- produces/consumes is stored as one jsonb document per row, with a handful
-- of columns pulled out for fast indexing/filtering.

create table if not exists change_orders (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  co_number text not null,
  job_id text not null,               -- always chained to a parent job — never null
  kind text not null,                  -- 'estimate' | 'invoice'
  lifecycle_status text not null,      -- mirrors co.lifecycleStatus
  auto_approved boolean not null default false,
  version integer not null default 1,
  data jsonb not null,                 -- the full change order object exactly as the engine produces/consumes it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A company can never have two change orders sharing a number.
create unique index if not exists change_orders_company_number_uidx
  on change_orders (company_id, co_number);

create index if not exists change_orders_company_idx on change_orders (company_id);
create index if not exists change_orders_company_job_idx on change_orders (company_id, job_id);
create index if not exists change_orders_company_status_idx on change_orders (company_id, lifecycle_status);

-- Durable, atomic per-company/per-job sequence for CO numbering (mirrors
-- allocate_po_number() in sql/010_purchase_orders.sql). A change order is
-- always chained to a job, so there is no "general" scope here — p_job_id
-- is required.
create table if not exists co_counters (
  company_id text not null,
  job_id text not null,
  next_sequence integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (company_id, job_id)
);

create or replace function allocate_co_number(p_company_id text, p_job_id text, p_company_code text default 'CO')
returns table(co_number text, sequence_no integer) as $$
declare
  v_seq integer;
begin
  if p_job_id is null or p_job_id = '' then
    raise exception 'A change order must be chained to a job — p_job_id is required.';
  end if;

  insert into co_counters (company_id, job_id, next_sequence)
    values (p_company_id, p_job_id, 1)
  on conflict (company_id, job_id)
    do update set next_sequence = co_counters.next_sequence + 1, updated_at = now()
  returning next_sequence into v_seq;

  if v_seq is null then
    v_seq := 1;
  end if;

  co_number := p_company_code || '-' || p_job_id || '-' || lpad(v_seq::text, 2, '0');
  sequence_no := v_seq;
  return next;
end;
$$ language plpgsql;
