-- sql/076_employee_pay_and_reina_cost_proposals.sql
--
-- Overhead Registries + Payroll Integration — Slice 0 (drift capture).
-- Captures the production migration `employee_pay_and_reina_cost_proposals`
-- (applied directly to prod, no file in sql/). Written to MATCH production
-- exactly (information_schema / pg_get_viewdef, 2026-08-15). NOTHING APPLIED.
--
-- company_id defaults to the Greenwich Handyman row (82cf7354-…) exactly as in
-- production. Depends on: 052 (companies/org_units), 071 (cost_assumptions,
-- hl_set_updated_at, hl_current_company_id), profiles.

begin;

create table if not exists public.employee_pay (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null default '82cf7354-e460-4863-9f01-d67b3ad05d4a'::uuid,
  profile_id uuid references public.profiles(id),
  user_id uuid,
  division_id uuid references public.org_units(id),
  display_name text,
  pay_class text not null default 'w2' check (pay_class in ('w2','1099','owner')),
  pay_type text not null default 'hourly' check (pay_type in ('hourly','salary')),
  base_rate numeric not null default 0,
  is_field boolean not null default true,
  overtime_multiplier numeric default 1.5,
  wc_class_code text,
  wc_rate_per_100 numeric default 0,
  payroll_tax_pct numeric default 7.65,
  unemployment_pct numeric default 1.2,
  retirement_match_pct numeric default 0,
  other_burden_pct numeric default 0,
  health_monthly numeric default 0,
  effective_from date not null default current_date,
  effective_to date,
  source text not null default 'manual' check (source in ('manual','imported','confirmed','reina_proposed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists employee_pay_company_idx on public.employee_pay (company_id) where (effective_to is null);
create index if not exists employee_pay_field_idx on public.employee_pay (company_id, is_field) where (effective_to is null);

create table if not exists public.reina_cost_proposals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null default '82cf7354-e460-4863-9f01-d67b3ad05d4a'::uuid,
  source text not null check (source in ('qbo_import','payroll_sync','spend_observation','manual')),
  proposal_type text not null check (proposal_type in ('overhead_line','burden_rate','allocation','assumption','reclassify')),
  target_table text,
  target_id uuid,
  current_value jsonb,
  proposed_value jsonb not null,
  rationale text not null,
  evidence jsonb,
  confidence int check (confidence >= 0 and confidence <= 100),
  status text not null default 'pending' check (status in ('pending','approved','rejected','superseded')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reina_cost_proposals_pending_idx on public.reina_cost_proposals (company_id, status) where (status = 'pending');

do $$
declare t text;
begin
  foreach t in array array['employee_pay','reina_cost_proposals'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.hl_set_updated_at()', t);
  end loop;
end $$;

alter table public.employee_pay enable row level security;
alter table public.reina_cost_proposals enable row level security;
revoke all on public.employee_pay from anon, authenticated;
revoke all on public.reina_cost_proposals from anon, authenticated;
grant all on public.employee_pay to service_role;
grant all on public.reina_cost_proposals to service_role;
drop policy if exists employee_pay_company_isolation on public.employee_pay;
create policy employee_pay_company_isolation on public.employee_pay for all to authenticated
  using (company_id = public.hl_current_company_id()) with check (company_id = public.hl_current_company_id());
drop policy if exists reina_cost_proposals_company_isolation on public.reina_cost_proposals;
create policy reina_cost_proposals_company_isolation on public.reina_cost_proposals for all to authenticated
  using (company_id = public.hl_current_company_id()) with check (company_id = public.hl_current_company_id());

-- employee_loaded_cost — annual wage + burden + loaded hourly rate per active
-- employee_pay row (effective_to is null). company_rates (077) reads this to
-- prefer roster wages over benchmark lines.
create or replace view public.employee_loaded_cost
with (security_invoker = on) as
 select e.company_id,
    e.id as employee_pay_id,
    e.display_name,
    e.division_id,
    e.pay_class,
    e.pay_type,
    e.is_field,
    e.base_rate,
    e.wc_class_code,
    coalesce(a.paid_hours_per_year, 2080) - coalesce(a.pto_days, 15) * 8 as paid_hours,
    case when e.pay_type = 'hourly'
         then e.base_rate * (coalesce(a.paid_hours_per_year, 2080) - coalesce(a.pto_days, 15) * 8)::numeric
         else e.base_rate end as annual_wage,
    e.payroll_tax_pct + e.unemployment_pct + e.wc_rate_per_100 + e.retirement_match_pct + e.other_burden_pct as burden_pct,
    case when e.pay_type = 'hourly'
         then e.base_rate * (coalesce(a.paid_hours_per_year, 2080) - coalesce(a.pto_days, 15) * 8)::numeric
         else e.base_rate end
      * (e.payroll_tax_pct + e.unemployment_pct + e.wc_rate_per_100 + e.retirement_match_pct + e.other_burden_pct) / 100.0
      + e.health_monthly * 12::numeric as annual_burden,
    case when e.pay_type = 'hourly'
         then e.base_rate * (1::numeric + (e.payroll_tax_pct + e.unemployment_pct + e.wc_rate_per_100 + e.retirement_match_pct + e.other_burden_pct) / 100.0)
              + case when (coalesce(a.paid_hours_per_year, 2080) - coalesce(a.pto_days, 15) * 8) > 0
                     then e.health_monthly * 12::numeric / (coalesce(a.paid_hours_per_year, 2080) - coalesce(a.pto_days, 15) * 8)::numeric
                     else 0::numeric end
         else null::numeric end as loaded_hourly_rate
   from public.employee_pay e
     left join public.cost_assumptions a on a.company_id = e.company_id
  where e.effective_to is null;

revoke all on public.employee_loaded_cost from anon, authenticated;
grant select on public.employee_loaded_cost to service_role;

commit;
