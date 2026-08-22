-- sql/074_trades_taxonomy_and_fleet_fix.sql
--
-- Overhead Registries + Payroll Integration — Slice 0 (drift capture).
--
-- Captures the production migration `trades_taxonomy_and_fleet_fix`, which was
-- applied directly to prod (project sqhusuuhlmcmkeowdrga) with no file in sql/.
-- Written to MATCH production exactly (read back via information_schema /
-- pg_get_viewdef on 2026-08-15), not to improve it. NOTHING APPLIED BY CLAUDE.
--
-- Two things this migration did:
--   1. Created public.trades (63 rows, 8 categories) — the taxonomy that drives
--      setup step 1.
--   2. Fixed company_rates.fleet_cost_per_mile to sum ALL fleet/vehicle-section
--      cost (section ILIKE %fleet%/%vehicle%) instead of only the per_mile /
--      per_vehicle_mo frequencies. (Superseded later by 077, which recreates the
--      view with roster preference; kept here to reproduce the migration order.)
--
-- Depends on: 071 (company_rates, hl_set_updated_at, hl_current_company_id).

begin;

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  category_sort int not null default 100,
  name text not null,
  slug text not null unique,
  description text,
  benchmark_key text not null default 'design_build',
  benchmark_native boolean not null default false,
  sort_order int not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists trades_category_idx on public.trades (category_sort, sort_order) where (active = true);

drop trigger if exists set_updated_at on public.trades;
create trigger set_updated_at before update on public.trades
  for each row execute function public.hl_set_updated_at();

alter table public.trades enable row level security;
revoke all on public.trades from anon, authenticated;
grant all on public.trades to service_role;
grant select on public.trades to authenticated;
drop policy if exists trades_read on public.trades;
create policy trades_read on public.trades for select to authenticated using (active);

insert into public.trades
  (category, category_sort, name, slug, description, benchmark_key, benchmark_native, sort_order, active)
values
  ('General contracting', 10, 'GC — New construction, residential', 'gc-new-residential', 'Ground-up homes', 'design_build', false, 1, true),
  ('General contracting', 10, 'GC — New construction, commercial', 'gc-new-commercial', 'Ground-up commercial', 'design_build', false, 2, true),
  ('General contracting', 10, 'GC — New construction, mixed', 'gc-new-mixed', 'Residential and commercial', 'design_build', false, 3, true),
  ('General contracting', 10, 'GC — Remodeling, residential', 'gc-remodel-residential', 'Renovations and additions', 'design_build', true, 4, true),
  ('General contracting', 10, 'GC — Remodeling, commercial', 'gc-remodel-commercial', 'Tenant fit-out and retrofit', 'design_build', false, 5, true),
  ('General contracting', 10, 'GC — Remodeling, mixed', 'gc-remodel-mixed', 'Both markets', 'design_build', false, 6, true),
  ('General contracting', 10, 'Design / build', 'design-build', 'Design and construction under one roof', 'design_build', true, 7, true),
  ('Mechanical trades', 20, 'Electrical', 'electrical', 'Residential and commercial electrical', 'design_build', false, 1, true),
  ('Mechanical trades', 20, 'Plumbing', 'plumbing', 'Service, repipe, new install', 'design_build', false, 2, true),
  ('Mechanical trades', 20, 'HVAC', 'hvac', 'Heating, cooling, ventilation', 'design_build', false, 3, true),
  ('Mechanical trades', 20, 'Refrigeration', 'refrigeration', 'Commercial refrigeration', 'design_build', false, 4, true),
  ('Mechanical trades', 20, 'Low voltage & security', 'low-voltage', 'Alarms, cameras, networking', 'design_build', false, 5, true),
  ('Mechanical trades', 20, 'Solar & battery', 'solar', 'PV, storage, EV charging', 'design_build', false, 6, true),
  ('Exterior & structure', 30, 'Roofing', 'roofing', 'Shingle, flat, metal, repair', 'design_build', false, 1, true),
  ('Exterior & structure', 30, 'Siding', 'siding', 'Vinyl, fiber cement, wood', 'design_build', false, 2, true),
  ('Exterior & structure', 30, 'Gutters', 'gutters', 'Install, guards, cleaning', 'design_build', false, 3, true),
  ('Exterior & structure', 30, 'Masonry', 'masonry', 'Brick, block, stone, chimney', 'design_build', false, 4, true),
  ('Exterior & structure', 30, 'Concrete & flatwork', 'concrete', 'Slabs, drives, walks, footings', 'design_build', false, 5, true),
  ('Exterior & structure', 30, 'Foundation & waterproofing', 'foundation', 'Repair, drainage, sealing', 'design_build', false, 6, true),
  ('Exterior & structure', 30, 'Windows & doors', 'windows-doors', 'Replacement and new install', 'design_build', false, 7, true),
  ('Exterior & structure', 30, 'Exterior painting', 'painting-exterior', 'Repaint and new work', 'design_build', false, 8, true),
  ('Exterior & structure', 30, 'Framing', 'framing', 'Rough carpentry', 'design_build', false, 9, true),
  ('Interior & finish', 40, 'Interior painting', 'painting-interior', 'Repaint and new work', 'design_build', false, 1, true),
  ('Interior & finish', 40, 'Flooring', 'flooring', 'Hardwood, LVP, carpet, refinish', 'design_build', false, 2, true),
  ('Interior & finish', 40, 'Drywall & plaster', 'drywall', 'Hang, finish, repair', 'design_build', false, 3, true),
  ('Interior & finish', 40, 'Finish carpentry & trim', 'finish-carpentry', 'Trim, doors, built-ins', 'design_build', false, 4, true),
  ('Interior & finish', 40, 'Cabinetry & millwork', 'cabinetry', 'Custom and semi-custom', 'design_build', false, 5, true),
  ('Interior & finish', 40, 'Tile & stone', 'tile', 'Floor, wall, shower, backsplash', 'design_build', false, 6, true),
  ('Interior & finish', 40, 'Countertops', 'countertops', 'Fabrication and install', 'design_build', false, 7, true),
  ('Interior & finish', 40, 'Closets & storage', 'closets', 'Systems and organization', 'design_build', false, 8, true),
  ('Interior & finish', 40, 'Insulation', 'insulation', 'Batt, blown, spray foam', 'design_build', false, 9, true),
  ('Outdoor & site', 50, 'Landscaping — design & install', 'landscaping', 'Plantings, beds, grading', 'design_build', false, 1, true),
  ('Outdoor & site', 50, 'Lawn care & maintenance', 'lawn-care', 'Mowing, fertilization, cleanups', 'design_build', false, 2, true),
  ('Outdoor & site', 50, 'Tree service', 'tree-service', 'Pruning, removal, stump', 'design_build', false, 3, true),
  ('Outdoor & site', 50, 'Irrigation', 'irrigation', 'Install, service, winterize', 'design_build', false, 4, true),
  ('Outdoor & site', 50, 'Hardscape & pavers', 'hardscape', 'Patios, walls, walkways', 'design_build', false, 5, true),
  ('Outdoor & site', 50, 'Fencing', 'fencing', 'Wood, vinyl, aluminum, chain link', 'design_build', false, 6, true),
  ('Outdoor & site', 50, 'Decks & porches', 'decks', 'Build, rebuild, refinish', 'design_build', false, 7, true),
  ('Outdoor & site', 50, 'Pools & spas', 'pools', 'Install, service, maintenance', 'design_build', false, 8, true),
  ('Outdoor & site', 50, 'Snow & ice management', 'snow', 'Plowing, salting, hauling', 'design_build', false, 9, true),
  ('Outdoor & site', 50, 'Excavation & grading', 'excavation', 'Site work, drainage, utilities', 'design_build', false, 10, true),
  ('Home services', 60, 'Handyman', 'handyman', 'Repairs, punch lists, T&M', 'design_build', true, 1, true),
  ('Home services', 60, 'Appliance repair', 'appliance-repair', 'Diagnose and repair in-home', 'design_build', false, 2, true),
  ('Home services', 60, 'Pest control', 'pest-control', 'Treatment and recurring plans', 'design_build', false, 3, true),
  ('Home services', 60, 'Cleaning services', 'cleaning', 'Residential and commercial', 'design_build', false, 4, true),
  ('Home services', 60, 'Chimney & fireplace', 'chimney', 'Sweep, inspect, repair, liner', 'design_build', false, 5, true),
  ('Home services', 60, 'Garage doors', 'garage-doors', 'Install, opener, service', 'design_build', false, 6, true),
  ('Home services', 60, 'Locksmith', 'locksmith', 'Rekey, install, access control', 'design_build', false, 7, true),
  ('Home services', 60, 'Window cleaning', 'window-cleaning', 'Residential and commercial', 'design_build', false, 8, true),
  ('Home services', 60, 'Pressure washing', 'pressure-washing', 'House, drive, deck, roof', 'design_build', false, 9, true),
  ('Home services', 60, 'Junk removal & hauling', 'junk-removal', 'Cleanouts and disposal', 'design_build', false, 10, true),
  ('Home services', 60, 'Moving', 'moving', 'Local and long distance', 'design_build', false, 11, true),
  ('Specialty & restoration', 70, 'Water & fire restoration', 'restoration', 'Mitigation and rebuild', 'design_build', false, 1, true),
  ('Specialty & restoration', 70, 'Mold remediation', 'mold', 'Testing and removal', 'design_build', false, 2, true),
  ('Specialty & restoration', 70, 'Asbestos & lead abatement', 'abatement', 'Licensed removal', 'design_build', false, 3, true),
  ('Specialty & restoration', 70, 'Radon mitigation', 'radon', 'Testing and systems', 'design_build', false, 4, true),
  ('Specialty & restoration', 70, 'Septic systems', 'septic', 'Install, pump, repair', 'design_build', false, 5, true),
  ('Specialty & restoration', 70, 'Well & water treatment', 'well-water', 'Pumps, filtration, softeners', 'design_build', false, 6, true),
  ('Specialty & restoration', 70, 'Glass & glazing', 'glass', 'Storefront, shower, mirror', 'design_build', false, 7, true),
  ('Specialty & restoration', 70, 'Signs & awnings', 'signs', 'Fabricate and install', 'design_build', false, 8, true),
  ('Specialty & restoration', 70, 'Home inspection', 'home-inspection', 'Buyer, seller, warranty', 'design_build', false, 9, true),
  ('Specialty & restoration', 70, 'Elevator & lift', 'elevator', 'Residential lifts and service', 'design_build', false, 10, true),
  ('Other', 99, 'Something else', 'other', 'Tell us and we will add it', 'design_build', false, 1, true)
on conflict (slug) do nothing;

-- Fleet-cost fix (section-based). 
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
    sum(annualized) filter (
      where (section ilike '%fleet%' or section ilike '%vehicle%') and frequency <> 'target_net'
    ) as fleet_cost_total
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
