-- sql/071_company_setup_cost_model.sql
--
-- Company Setup + Cost Model V1 — Slice 0 (schema).
--
-- Builds the real backend behind the `csx` (Company Setup) view, which today
-- is a static mockup with zero API calls: the cost-model ledger (loaded labor,
-- overhead recovery, break-even) and the owner/employee onboarding state.
--
-- MIGRATION NUMBER: 071. The run-sheet warns that 043 is double-claimed and
-- must never be reused; the highest number actually present in sql/ (across the
-- root and subdirs) is 070 (070_inventory_stock.sql), so this continues at 071.
--
-- Multi-tenancy note (Guardrail 10): every company-scoped table below is born
-- with company_id uuid NOT NULL defaulting to the Greenwich Handyman row, so it
-- is correct from day one and is NOT part of the later multi-tenant remediation
-- debt. The companies table + the 8 Greenwich Handyman divisions already exist
-- (sql/052_gate1b_companies_org_tenant.sql) — this migration only references
-- companies(id); it does not re-seed them.
--
-- NOTHING IN THIS FILE IS APPLIED TO ANY DATABASE BY CLAUDE. Chris reviews and
-- applies it. All statements are additive (create table if not exists / create
-- or replace view); rollback is `drop` on the newly-added objects.

begin;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Keeps updated_at honest on every mutation.
create or replace function public.hl_set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- The tenant seam for RLS. Multi-tenancy is not built yet: there is one
-- company (Greenwich Handyman) and every signed-in employee is an admin of it.
-- This returns the caller's company from a JWT `company_id` claim when one is
-- present (forward-compatible with real multi-tenancy), otherwise the single
-- Greenwich Handyman row. Used only by the defense-in-depth RLS policies below;
-- the API itself runs as service_role (which bypasses RLS) exactly like every
-- other table in this app.
create or replace function public.hl_current_company_id()
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'company_id', '')::uuid,
    (select id from public.companies where slug = 'greenwich-handyman' limit 1)
  );
$$;

-- ---------------------------------------------------------------------------
-- cost_assumptions — one row per company
-- ---------------------------------------------------------------------------
create table if not exists public.cost_assumptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  annual_revenue numeric,
  field_headcount int,
  office_headcount int,
  owner_headcount int,
  paid_hours_per_year int default 2080,
  pto_days int default 15,
  nonbillable_pct numeric default 18,
  vehicle_count int,
  fleet_miles_per_year int,
  workdays_per_year int default 250,
  target_net_pct numeric default 10,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id)
);

-- ---------------------------------------------------------------------------
-- cost_lines — the ledger rows
-- ---------------------------------------------------------------------------
create table if not exists public.cost_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  section text not null,
  name text not null,
  note text,
  amount numeric not null default 0,
  frequency text not null check (frequency in (
    'mo','yr','wk','per_employee_mo','per_vehicle_mo','pct_revenue',
    'per_mile','per_billable_hour','per_field_hour','pct_field_wages','target_net'
  )),
  cost_type text not null check (cost_type in ('fixed','variable','direct','reserve')),
  source text not null default 'benchmark' check (source in ('benchmark','imported','confirmed','manual')),
  confidence int,
  sort_order int,
  archived boolean default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cost_lines_company_idx on public.cost_lines(company_id) where archived = false;
create index if not exists cost_lines_section_idx on public.cost_lines(company_id, section);

-- ---------------------------------------------------------------------------
-- cost_benchmarks — GLOBAL seed data, NO company_id, read-only to tenants
-- ---------------------------------------------------------------------------
create table if not exists public.cost_benchmarks (
  id uuid primary key default gen_random_uuid(),
  trade text,
  size_band text,
  region text,
  section text,
  name text,
  note text,
  amount numeric,
  frequency text,
  cost_type text,
  sort_order int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cost_benchmarks_lookup_idx on public.cost_benchmarks(trade, size_band, region);

-- ---------------------------------------------------------------------------
-- onboarding_sessions
-- ---------------------------------------------------------------------------
create table if not exists public.onboarding_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  actor_type text check (actor_type in ('company','employee','subcontractor')),
  actor_id uuid,
  current_step text,
  status text check (status in ('not_started','in_progress','complete','abandoned')),
  started_at timestamptz,
  completed_at timestamptz,
  confidence_score int default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists onboarding_sessions_company_idx on public.onboarding_sessions(company_id);
create index if not exists onboarding_sessions_actor_idx on public.onboarding_sessions(actor_type, actor_id);

-- ---------------------------------------------------------------------------
-- onboarding_steps
-- ---------------------------------------------------------------------------
create table if not exists public.onboarding_steps (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  session_id uuid references public.onboarding_sessions(id) on delete cascade,
  step_key text,
  status text check (status in ('pending','skipped','complete')),
  payload jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, step_key)
);

-- ---------------------------------------------------------------------------
-- invites — token stored HASHED (never the raw token), per the run-sheet
-- ---------------------------------------------------------------------------
create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  -- The column named `token` in the run-sheet spec is stored as a hash of a
  -- 32-byte CSPRNG token; the raw token is returned to the creator once and
  -- never persisted or logged. Named token_hash to make that unmistakable.
  token_hash text unique not null,
  actor_type text,
  email text,
  phone text,
  role text,
  payload jsonb,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists invites_email_idx on public.invites(email);
create index if not exists invites_expires_idx on public.invites(expires_at);

-- ---------------------------------------------------------------------------
-- Column defaults for company_id (set after create, because a DEFAULT cannot
-- contain a subquery) + updated_at triggers. Same DO-block pattern as
-- sql/052_gate1b_companies_org_tenant.sql.
-- ---------------------------------------------------------------------------
do $$
declare gh uuid;
begin
  select id into gh from public.companies where slug = 'greenwich-handyman' limit 1;
  if gh is null then
    raise exception 'Greenwich Handyman company row not found — apply 052_gate1b_companies_org_tenant.sql first.';
  end if;
  execute format('alter table public.cost_assumptions   alter column company_id set default %L', gh);
  execute format('alter table public.cost_lines         alter column company_id set default %L', gh);
  execute format('alter table public.onboarding_sessions alter column company_id set default %L', gh);
  execute format('alter table public.onboarding_steps   alter column company_id set default %L', gh);
  execute format('alter table public.invites            alter column company_id set default %L', gh);
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'cost_assumptions','cost_lines','cost_benchmarks',
    'onboarding_sessions','onboarding_steps','invites'
  ] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function public.hl_set_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RLS + grants
--   * Every table: RLS enabled, REVOKE ALL from anon+authenticated, service_role
--     (the API role) keeps full access and bypasses RLS.
--   * Company-scoped tables get a defense-in-depth policy keyed on company_id
--     (active for any future grant to authenticated; today authenticated is
--     revoked, so the API's service_role path is the only way in).
--   * cost_benchmarks is global, read-only to tenants: authenticated may SELECT.
-- ---------------------------------------------------------------------------
alter table public.cost_assumptions   enable row level security;
alter table public.cost_lines         enable row level security;
alter table public.cost_benchmarks    enable row level security;
alter table public.onboarding_sessions enable row level security;
alter table public.onboarding_steps   enable row level security;
alter table public.invites            enable row level security;

revoke all on public.cost_assumptions    from anon, authenticated;
revoke all on public.cost_lines          from anon, authenticated;
revoke all on public.cost_benchmarks     from anon, authenticated;
revoke all on public.onboarding_sessions from anon, authenticated;
revoke all on public.onboarding_steps    from anon, authenticated;
revoke all on public.invites             from anon, authenticated;

grant all on public.cost_assumptions    to service_role;
grant all on public.cost_lines          to service_role;
grant all on public.cost_benchmarks     to service_role;
grant all on public.onboarding_sessions to service_role;
grant all on public.onboarding_steps    to service_role;
grant all on public.invites             to service_role;

-- cost_benchmarks: tenants may read the global library (no company_id on it).
grant select on public.cost_benchmarks to authenticated;

do $$
declare rec record;
begin
  for rec in
    select unnest(array[
      'cost_assumptions','cost_lines',
      'onboarding_sessions','onboarding_steps','invites'
    ]) as tbl
  loop
    execute format('drop policy if exists %I on public.%I', rec.tbl || '_company_isolation', rec.tbl);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (company_id = public.hl_current_company_id())
         with check (company_id = public.hl_current_company_id())',
      rec.tbl || '_company_isolation', rec.tbl);
  end loop;

  drop policy if exists cost_benchmarks_read on public.cost_benchmarks;
  create policy cost_benchmarks_read on public.cost_benchmarks
    for select to authenticated using (true);
end $$;

-- ---------------------------------------------------------------------------
-- company_rates — the single source of truth for every derived figure.
-- security_invoker = on so it runs with the caller's rights (never the view
-- owner's). REVOKE from anon+authenticated; the API reads it as service_role.
--
-- Formulas implemented EXACTLY as specified in the run-sheet's Slice 0. Two
-- extra output columns (overhead_per_workday, fleet_cost_per_mile) are not in
-- the formula list; their definitions are the conservative reading noted in
-- REPORT.md under "Assumptions made".
-- ---------------------------------------------------------------------------
create or replace view public.company_rates
with (security_invoker = on) as
with a as (
  select
    ca.company_id,
    coalesce(ca.annual_revenue, 0)       as revenue,
    coalesce(ca.field_headcount, 0)      as field_headcount,
    coalesce(ca.office_headcount, 0)     as office_headcount,
    coalesce(ca.owner_headcount, 0)      as owner_headcount,
    coalesce(ca.paid_hours_per_year, 2080) as paid_hours_per_year,
    coalesce(ca.pto_days, 15)            as pto_days,
    coalesce(ca.nonbillable_pct, 18)     as nonbillable_pct,
    coalesce(ca.vehicle_count, 0)        as vehicle_count,
    coalesce(ca.fleet_miles_per_year, 0) as fleet_miles_per_year,
    coalesce(ca.workdays_per_year, 250)  as workdays_per_year,
    coalesce(ca.target_net_pct, 10)      as target_net_pct
  from public.cost_assumptions ca
),
d as (
  select
    a.*,
    (a.paid_hours_per_year - (a.pto_days * 8))                        as base_hours,
    (a.field_headcount * (a.paid_hours_per_year - (a.pto_days * 8)))  as field_paid_hours,
    (a.field_headcount * (a.paid_hours_per_year - (a.pto_days * 8))
       * (1 - a.nonbillable_pct / 100.0))                            as billable_hours,
    (a.field_headcount + a.office_headcount + a.owner_headcount)      as total_headcount
  from a
),
fw as (
  select l.company_id, sum(l.amount * d.field_paid_hours) as field_wages
  from public.cost_lines l
  join d on d.company_id = l.company_id
  where l.frequency = 'per_field_hour' and coalesce(l.archived, false) = false
  group by l.company_id
),
d2 as (
  select d.*, coalesce(fw.field_wages, 0) as field_wages
  from d left join fw on fw.company_id = d.company_id
),
burden as (
  select l.company_id, sum(l.amount / 100.0 * d2.field_wages) as field_burden
  from public.cost_lines l
  join d2 on d2.company_id = l.company_id
  where l.frequency = 'pct_field_wages' and coalesce(l.archived, false) = false
  group by l.company_id
),
ann as (
  select
    l.company_id,
    l.cost_type,
    l.frequency,
    l.section,
    case l.frequency
      when 'mo'                then l.amount * 12
      when 'yr'                then l.amount
      when 'wk'                then l.amount * 52
      when 'per_employee_mo'   then l.amount * d2.total_headcount * 12
      when 'per_vehicle_mo'    then l.amount * d2.vehicle_count * 12
      when 'pct_revenue'       then l.amount / 100.0 * d2.revenue
      when 'per_mile'          then l.amount * d2.fleet_miles_per_year
      when 'per_billable_hour' then l.amount * d2.billable_hours
      when 'per_field_hour'    then l.amount * d2.field_paid_hours
      when 'pct_field_wages'   then l.amount / 100.0 * d2.field_wages
      when 'target_net'        then d2.target_net_pct / 100.0 * d2.revenue
      else 0
    end as annualized
  from public.cost_lines l
  join d2 on d2.company_id = l.company_id
  where coalesce(l.archived, false) = false
),
agg as (
  select
    company_id,
    sum(annualized) filter (where frequency = 'target_net')                                    as profit_target,
    sum(annualized) filter (where cost_type = 'direct'  and frequency <> 'target_net')          as direct_total,
    sum(annualized) filter (where cost_type = 'reserve' and frequency <> 'target_net')          as reserve_total,
    sum(annualized) filter (where cost_type in ('fixed','variable'))                            as overhead_total,
    -- Fleet cost is ALL annualized cost in a fleet/vehicle section — not just the
    -- two per_mile/per_vehicle_mo frequencies. The frequency-only version missed
    -- monthly (loan/lease, insurance) and annual (tires, repairs, registration)
    -- fleet lines and under-reported fleet_cost_per_mile by ~64%. Matches the
    -- live production view (verified via pg_get_viewdef 2026-08-14).
    sum(annualized) filter (
      where (section ilike '%fleet%' or section ilike '%vehicle%') and frequency <> 'target_net'
    )                                                                                            as fleet_cost_total
  from ann
  group by company_id
)
select
  d2.company_id,
  d2.billable_hours,
  d2.field_wages,
  coalesce(burden.field_burden, 0) as field_burden,
  case when d2.billable_hours > 0
       then (d2.field_wages + coalesce(burden.field_burden, 0)) / d2.billable_hours
  end as loaded_labor_rate,
  coalesce(agg.direct_total, 0)   as direct_total,
  coalesce(agg.overhead_total, 0) as overhead_total,
  coalesce(agg.reserve_total, 0)  as reserve_total,
  coalesce(agg.profit_target, 0)  as profit_target,
  case when d2.revenue > 0
       then (d2.revenue - coalesce(agg.direct_total, 0)) / d2.revenue
  end as gross_margin_pct,
  case when d2.revenue > 0
       then (d2.revenue - coalesce(agg.direct_total, 0) - coalesce(agg.overhead_total, 0)) / d2.revenue
  end as net_pct,
  -- breakeven_revenue = overhead_total / gross_margin_pct
  case when d2.revenue > 0 and (d2.revenue - coalesce(agg.direct_total, 0)) > 0
       then coalesce(agg.overhead_total, 0)
            / ((d2.revenue - coalesce(agg.direct_total, 0)) / d2.revenue)
  end as breakeven_revenue,
  case when d2.billable_hours > 0
       then coalesce(agg.overhead_total, 0) / d2.billable_hours
  end as overhead_per_billable_hour,
  -- breakeven_hourly = loaded_labor_rate + overhead_per_billable_hour
  case when d2.billable_hours > 0
       then ((d2.field_wages + coalesce(burden.field_burden, 0)) / d2.billable_hours)
            + (coalesce(agg.overhead_total, 0) / d2.billable_hours)
  end as breakeven_hourly_rate,
  case when coalesce(agg.direct_total, 0) > 0
       then coalesce(agg.overhead_total, 0) / agg.direct_total * 100
  end as min_markup_pct,
  case when d2.workdays_per_year > 0
       then coalesce(agg.overhead_total, 0) / d2.workdays_per_year
  end as overhead_per_workday,
  case when d2.fleet_miles_per_year > 0
       then coalesce(agg.fleet_cost_total, 0) / d2.fleet_miles_per_year
  end as fleet_cost_per_mile
from d2
left join burden on burden.company_id = d2.company_id
left join agg    on agg.company_id    = d2.company_id;

revoke all on public.company_rates from anon, authenticated;
grant select on public.company_rates to service_role;

commit;
