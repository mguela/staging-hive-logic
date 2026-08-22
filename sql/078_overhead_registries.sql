-- sql/078_overhead_registries.sql
--
-- Overhead Registries + Payroll Integration — Slice 0 (drift capture).
-- Captures the production migration `overhead_registries` (applied directly to
-- prod, no file in sql/). Written to MATCH production exactly (information_schema
-- / pg_get_viewdef, 2026-08-15). NOTHING APPLIED.
--
-- Creates insurance_policies, licenses_credentials, loans_obligations, leases,
-- vehicle_costs and the registry_overhead + compliance_calendar views.
-- company_id defaults to the Greenwich Handyman row (82cf7354-…) exactly as in
-- production. Depends on: 052 (companies/org_units), 071 (hl_set_updated_at,
-- hl_current_company_id), profiles, subscriptions (pre-existing).

begin;

create table if not exists public.insurance_policies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null default '82cf7354-e460-4863-9f01-d67b3ad05d4a'::uuid,
  policy_type text not null,
  carrier text,
  broker text,
  policy_number text,
  coverage_limit_each numeric,
  coverage_limit_aggregate numeric,
  deductible numeric,
  premium_amount numeric,
  premium_frequency text default 'mo' check (premium_frequency in ('mo','yr','wk')),
  wc_class_code text,
  wc_rate_per_100 numeric,
  experience_mod numeric,
  effective_date date,
  expiration_date date,
  additional_insured text,
  waiver_of_subrogation boolean,
  document_url text,
  status text default 'active' check (status in ('active','lapsed','pending','cancelled')),
  source text default 'manual' check (source in ('manual','extracted','confirmed')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists insurance_policies_company_idx on public.insurance_policies (company_id);

create table if not exists public.licenses_credentials (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null default '82cf7354-e460-4863-9f01-d67b3ad05d4a'::uuid,
  scope text not null default 'company' check (scope in ('company','employee','subcontractor')),
  holder_profile_id uuid references public.profiles(id),
  holder_name text,
  credential_type text not null,
  credential_number text,
  issuing_body text,
  jurisdiction text,
  classifications text,
  issue_date date,
  expiration_date date,
  renewal_fee numeric,
  renewal_frequency text default 'yr' check (renewal_frequency in ('mo','yr','wk')),
  blocks_work boolean default false,
  document_url text,
  status text default 'active' check (status in ('active','expired','pending','suspended')),
  source text default 'manual' check (source in ('manual','extracted','confirmed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists licenses_credentials_company_idx on public.licenses_credentials (company_id);

create table if not exists public.loans_obligations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null default '82cf7354-e460-4863-9f01-d67b3ad05d4a'::uuid,
  obligation_type text not null default 'loan' check (obligation_type in ('loan','lease','line_of_credit','mortgage','credit_card')),
  lender text,
  account_last4 text,
  description text,
  collateral text,
  vehicle_jobber_id text,
  original_amount numeric,
  current_balance numeric,
  payment_amount numeric,
  payment_frequency text default 'mo' check (payment_frequency in ('mo','yr','wk')),
  interest_rate numeric,
  payment_due_day int,
  maturity_date date,
  balloon_amount numeric,
  status text default 'active' check (status in ('active','paid_off','refinanced','default')),
  source text default 'manual' check (source in ('manual','extracted','confirmed')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists loans_obligations_company_idx on public.loans_obligations (company_id);

create table if not exists public.leases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null default '82cf7354-e460-4863-9f01-d67b3ad05d4a'::uuid,
  lease_type text default 'commercial' check (lease_type in ('commercial','equipment','storage','other')),
  landlord text,
  premises text,
  base_rent numeric,
  cam_charges numeric,
  rent_frequency text default 'mo' check (rent_frequency in ('mo','yr','wk')),
  escalation_pct numeric,
  escalation_date date,
  term_start date,
  term_end date,
  renewal_option text,
  option_notice_deadline date,
  security_deposit numeric,
  insurance_required text,
  document_url text,
  status text default 'active' check (status in ('active','expired','terminated','pending')),
  source text default 'manual' check (source in ('manual','extracted','confirmed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists leases_company_idx on public.leases (company_id);

-- vehicle_costs references loans_obligations + insurance_policies, so it comes last.
create table if not exists public.vehicle_costs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null default '82cf7354-e460-4863-9f01-d67b3ad05d4a'::uuid,
  vehicle_jobber_id text,
  vehicle_name text,
  vin text,
  license_plate text,
  registration_expires date,
  inspection_due date,
  odometer int,
  odometer_updated date,
  annual_miles int,
  service_interval_miles int default 5000,
  next_service_miles int,
  loan_id uuid references public.loans_obligations(id),
  insurance_policy_id uuid references public.insurance_policies(id),
  fuel_cost_per_mile numeric,
  maintenance_cost_per_mile numeric,
  replacement_reserve_per_mile numeric,
  assigned_profile_id uuid references public.profiles(id),
  division_id uuid references public.org_units(id),
  status text default 'active' check (status in ('active','out_of_service','sold','pending')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vehicle_costs_company_idx on public.vehicle_costs (company_id);

-- updated_at triggers
do $$
declare t text;
begin
  foreach t in array array['insurance_policies','licenses_credentials','loans_obligations','leases','vehicle_costs'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.hl_set_updated_at()', t);
  end loop;
end $$;

-- RLS + grants + company-isolation policies
do $$
declare t text;
begin
  foreach t in array array['insurance_policies','licenses_credentials','loans_obligations','leases','vehicle_costs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

drop policy if exists insurance_policies_isolation on public.insurance_policies;
create policy insurance_policies_isolation on public.insurance_policies for all to authenticated
  using (company_id = public.hl_current_company_id()) with check (company_id = public.hl_current_company_id());
drop policy if exists licenses_credentials_isolation on public.licenses_credentials;
create policy licenses_credentials_isolation on public.licenses_credentials for all to authenticated
  using (company_id = public.hl_current_company_id()) with check (company_id = public.hl_current_company_id());
drop policy if exists loans_obligations_isolation on public.loans_obligations;
create policy loans_obligations_isolation on public.loans_obligations for all to authenticated
  using (company_id = public.hl_current_company_id()) with check (company_id = public.hl_current_company_id());
drop policy if exists leases_isolation on public.leases;
create policy leases_isolation on public.leases for all to authenticated
  using (company_id = public.hl_current_company_id()) with check (company_id = public.hl_current_company_id());
drop policy if exists vehicle_costs_isolation on public.vehicle_costs;
create policy vehicle_costs_isolation on public.vehicle_costs for all to authenticated
  using (company_id = public.hl_current_company_id()) with check (company_id = public.hl_current_company_id());

-- registry_overhead — annualized overhead by section from the registries.
create or replace view public.registry_overhead
with (security_invoker = on) as
 select insurance_policies.company_id,
    'Insurance & bonds'::text as section,
    insurance_policies.policy_type as name,
    coalesce(insurance_policies.carrier, ''::text) as detail,
    case insurance_policies.premium_frequency
        when 'mo' then insurance_policies.premium_amount * 12::numeric
        when 'wk' then insurance_policies.premium_amount * 52::numeric
        else insurance_policies.premium_amount
    end as annual_amount,
    'insurance_policies'::text as source_table,
    insurance_policies.id as source_id
   from public.insurance_policies
  where insurance_policies.status = 'active' and insurance_policies.premium_amount is not null
union all
 select licenses_credentials.company_id,
    'Licenses, compliance & professional'::text as section,
    licenses_credentials.credential_type as name,
    coalesce(licenses_credentials.issuing_body, ''::text) as detail,
    case licenses_credentials.renewal_frequency
        when 'mo' then licenses_credentials.renewal_fee * 12::numeric
        when 'wk' then licenses_credentials.renewal_fee * 52::numeric
        else licenses_credentials.renewal_fee
    end as annual_amount,
    'licenses_credentials'::text as source_table,
    licenses_credentials.id as source_id
   from public.licenses_credentials
  where licenses_credentials.status = 'active' and licenses_credentials.renewal_fee is not null
union all
 select loans_obligations.company_id,
    case
        when loans_obligations.obligation_type = 'mortgage' then 'Facilities & occupancy'::text
        when loans_obligations.vehicle_jobber_id is not null then 'Vehicles & fleet'::text
        else 'Financial, banking & debt'::text
    end as section,
    coalesce(loans_obligations.description, loans_obligations.obligation_type) as name,
    coalesce(loans_obligations.lender, ''::text) as detail,
    case loans_obligations.payment_frequency
        when 'mo' then loans_obligations.payment_amount * 12::numeric
        when 'wk' then loans_obligations.payment_amount * 52::numeric
        else loans_obligations.payment_amount
    end as annual_amount,
    'loans_obligations'::text as source_table,
    loans_obligations.id as source_id
   from public.loans_obligations
  where loans_obligations.status = 'active' and loans_obligations.payment_amount is not null
union all
 select leases.company_id,
    'Facilities & occupancy'::text as section,
    coalesce(leases.premises, 'Lease'::text) as name,
    coalesce(leases.landlord, ''::text) as detail,
    case leases.rent_frequency
        when 'mo' then (coalesce(leases.base_rent, 0::numeric) + coalesce(leases.cam_charges, 0::numeric)) * 12::numeric
        when 'wk' then (coalesce(leases.base_rent, 0::numeric) + coalesce(leases.cam_charges, 0::numeric)) * 52::numeric
        else coalesce(leases.base_rent, 0::numeric) + coalesce(leases.cam_charges, 0::numeric)
    end as annual_amount,
    'leases'::text as source_table,
    leases.id as source_id
   from public.leases
  where leases.status = 'active'
union all
 select ( select companies.id from public.companies where companies.slug = 'greenwich-handyman' limit 1) as company_id,
    'Technology & software'::text as section,
    subscriptions.name,
    coalesce(subscriptions.category, ''::text) as detail,
    case subscriptions.billing_cycle
        when 'annual' then subscriptions.monthly_cost
        when 'yearly' then subscriptions.monthly_cost
        else coalesce(subscriptions.monthly_cost, 0::numeric) * 12::numeric
    end as annual_amount,
    'subscriptions'::text as source_table,
    subscriptions.id as source_id
   from public.subscriptions
  where coalesce(subscriptions.status, 'active') = 'active' and subscriptions.monthly_cost is not null;

revoke all on public.registry_overhead from anon, authenticated;
grant select on public.registry_overhead to service_role;

-- compliance_calendar — every dated obligation with a days_out countdown.
create or replace view public.compliance_calendar
with (security_invoker = on) as
 select insurance_policies.company_id,
    'Insurance'::text as kind,
    insurance_policies.policy_type as item,
    coalesce(insurance_policies.carrier, ''::text) as detail,
    insurance_policies.expiration_date as expires_on,
    insurance_policies.expiration_date - current_date as days_out,
    true as blocks_work,
    'insurance_policies'::text as source_table,
    insurance_policies.id as source_id
   from public.insurance_policies
  where insurance_policies.expiration_date is not null and insurance_policies.status = 'active'
union all
 select licenses_credentials.company_id,
    'License / credential'::text as kind,
    licenses_credentials.credential_type as item,
    coalesce(licenses_credentials.holder_name, licenses_credentials.issuing_body, ''::text) as detail,
    licenses_credentials.expiration_date as expires_on,
    licenses_credentials.expiration_date - current_date as days_out,
    coalesce(licenses_credentials.blocks_work, false) as blocks_work,
    'licenses_credentials'::text as source_table,
    licenses_credentials.id as source_id
   from public.licenses_credentials
  where licenses_credentials.expiration_date is not null and licenses_credentials.status = 'active'
union all
 select vehicle_costs.company_id,
    'Vehicle registration'::text as kind,
    coalesce(vehicle_costs.vehicle_name, 'Vehicle'::text) as item,
    coalesce(vehicle_costs.license_plate, ''::text) as detail,
    vehicle_costs.registration_expires as expires_on,
    vehicle_costs.registration_expires - current_date as days_out,
    true as blocks_work,
    'vehicle_costs'::text as source_table,
    vehicle_costs.id as source_id
   from public.vehicle_costs
  where vehicle_costs.registration_expires is not null and vehicle_costs.status = 'active'
union all
 select leases.company_id,
    'Lease option deadline'::text as kind,
    coalesce(leases.premises, 'Lease'::text) as item,
    coalesce(leases.landlord, ''::text) as detail,
    leases.option_notice_deadline as expires_on,
    leases.option_notice_deadline - current_date as days_out,
    false as blocks_work,
    'leases'::text as source_table,
    leases.id as source_id
   from public.leases
  where leases.option_notice_deadline is not null and leases.status = 'active'
union all
 select loans_obligations.company_id,
    'Loan maturity'::text as kind,
    coalesce(loans_obligations.description, loans_obligations.obligation_type) as item,
    coalesce(loans_obligations.lender, ''::text) as detail,
    loans_obligations.maturity_date as expires_on,
    loans_obligations.maturity_date - current_date as days_out,
    false as blocks_work,
    'loans_obligations'::text as source_table,
    loans_obligations.id as source_id
   from public.loans_obligations
  where loans_obligations.maturity_date is not null and loans_obligations.status = 'active';

revoke all on public.compliance_calendar from anon, authenticated;
grant select on public.compliance_calendar to service_role;

commit;
