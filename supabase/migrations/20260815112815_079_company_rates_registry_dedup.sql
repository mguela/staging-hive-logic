-- sql/079_company_rates_registry_dedup.sql
--
-- Overhead Registries + Payroll Integration — Slice 2 (stop the double-count).
--
-- Recreates company_rates so that, PER SECTION, when registry_overhead has rows
-- for that section, the benchmark cost_lines in that section (source = 'benchmark'
-- only) are excluded from overhead_total and the real registry amount is used
-- instead. Confirmed / imported / manual lines always count. Adds
-- overhead_from_registry so the UI can show how much overhead is now real.
--
-- This mirrors the existing wages_from_roster behaviour (benchmark labor lines
-- are zeroed when a roster exists) — same shape, applied to overhead sections.
--
-- CREATE OR REPLACE (only appends overhead_from_registry at the end), so the
-- dependent division_overhead view is left intact. NOTHING APPLIED BY CLAUDE.
-- Depends on: 077 (company_rates roster), 078 (registry_overhead).

begin;

create or replace view public.company_rates
with (security_invoker = on) as
 with a as (
   select ca.company_id,
      coalesce(ca.annual_revenue, 0::numeric) as revenue,
      coalesce(ca.field_headcount, 0) as field_headcount,
      coalesce(ca.office_headcount, 0) as office_headcount,
      coalesce(ca.owner_headcount, 0) as owner_headcount,
      coalesce(ca.paid_hours_per_year, 2080) as paid_hours_per_year,
      coalesce(ca.pto_days, 15) as pto_days,
      coalesce(ca.nonbillable_pct, 18::numeric) as nonbillable_pct,
      coalesce(ca.vehicle_count, 0) as vehicle_count,
      coalesce(ca.fleet_miles_per_year, 0) as fleet_miles_per_year,
      coalesce(ca.workdays_per_year, 250) as workdays_per_year,
      coalesce(ca.target_net_pct, 10::numeric) as target_net_pct
     from public.cost_assumptions ca
  ), roster as (
   select employee_loaded_cost.company_id,
      count(*) filter (where employee_loaded_cost.is_field) as field_people,
      sum(employee_loaded_cost.annual_wage) filter (where employee_loaded_cost.is_field) as roster_wages,
      sum(employee_loaded_cost.annual_burden) filter (where employee_loaded_cost.is_field) as roster_burden
     from public.employee_loaded_cost
    group by employee_loaded_cost.company_id
  ), reg_sec as (
   select company_id, section from public.registry_overhead group by company_id, section
  ), reg_co as (
   select company_id, sum(annual_amount) as reg_total from public.registry_overhead group by company_id
  ), d as (
   select a.company_id, a.revenue, a.field_headcount, a.office_headcount, a.owner_headcount,
      a.paid_hours_per_year, a.pto_days, a.nonbillable_pct, a.vehicle_count, a.fleet_miles_per_year,
      a.workdays_per_year, a.target_net_pct,
      coalesce(r.field_people, 0::bigint) as roster_field_people,
      coalesce(r.roster_wages, 0::numeric) as roster_wages,
      coalesce(r.roster_burden, 0::numeric) as roster_burden,
      greatest(a.field_headcount::bigint, coalesce(r.field_people, 0::bigint)) * (a.paid_hours_per_year - a.pto_days * 8) as field_paid_hours,
      (greatest(a.field_headcount::bigint, coalesce(r.field_people, 0::bigint)) * (a.paid_hours_per_year - a.pto_days * 8))::numeric * (1::numeric - a.nonbillable_pct / 100.0) as billable_hours,
      a.field_headcount + a.office_headcount + a.owner_headcount as total_headcount
     from a
       left join roster r on r.company_id = a.company_id
  ), bench_fw as (
   select l.company_id, sum(l.amount * d.field_paid_hours::numeric) as bench_wages
     from public.cost_lines l
       join d on d.company_id = l.company_id
    where l.frequency = 'per_field_hour' and coalesce(l.archived, false) = false
    group by l.company_id
  ), d2 as (
   select d.company_id, d.revenue, d.field_headcount, d.office_headcount, d.owner_headcount,
      d.paid_hours_per_year, d.pto_days, d.nonbillable_pct, d.vehicle_count, d.fleet_miles_per_year,
      d.workdays_per_year, d.target_net_pct, d.roster_field_people, d.roster_wages, d.roster_burden,
      d.field_paid_hours, d.billable_hours, d.total_headcount,
      d.roster_field_people > 0 as from_roster,
      case when d.roster_field_people > 0 then d.roster_wages else coalesce(bf.bench_wages, 0::numeric) end as fw
     from d
       left join bench_fw bf on bf.company_id = d.company_id
  ), bench_burden as (
   select l.company_id, sum(l.amount / 100.0 * d2.fw) as bench_burden
     from public.cost_lines l
       join d2 on d2.company_id = l.company_id
    where l.frequency = 'pct_field_wages' and coalesce(l.archived, false) = false
    group by l.company_id
  ), d3 as (
   select d2.company_id, d2.revenue, d2.field_headcount, d2.office_headcount, d2.owner_headcount,
      d2.paid_hours_per_year, d2.pto_days, d2.nonbillable_pct, d2.vehicle_count, d2.fleet_miles_per_year,
      d2.workdays_per_year, d2.target_net_pct, d2.roster_field_people, d2.roster_wages, d2.roster_burden,
      d2.field_paid_hours, d2.billable_hours, d2.total_headcount, d2.from_roster, d2.fw,
      case when d2.from_roster then d2.roster_burden else coalesce(bb.bench_burden, 0::numeric) end as fb
     from d2
       left join bench_burden bb on bb.company_id = d2.company_id
  ), ann as (
   select l.company_id, l.cost_type, l.frequency, l.section, l.source, (rs.section is not null) as has_reg,
      case l.frequency
          when 'mo' then l.amount * 12::numeric
          when 'yr' then l.amount
          when 'wk' then l.amount * 52::numeric
          when 'per_employee_mo' then l.amount * d3.total_headcount::numeric * 12::numeric
          when 'per_vehicle_mo' then l.amount * d3.vehicle_count::numeric * 12::numeric
          when 'pct_revenue' then l.amount / 100.0 * d3.revenue
          when 'per_mile' then l.amount * d3.fleet_miles_per_year::numeric
          when 'per_billable_hour' then l.amount * d3.billable_hours
          when 'per_field_hour' then case when d3.from_roster then 0::numeric else l.amount * d3.field_paid_hours::numeric end
          when 'pct_field_wages' then case when d3.from_roster then 0::numeric else l.amount / 100.0 * d3.fw end
          when 'target_net' then d3.target_net_pct / 100.0 * d3.revenue
          else 0::numeric
      end as annualized
     from public.cost_lines l
       join d3 on d3.company_id = l.company_id
       left join reg_sec rs on rs.company_id = l.company_id and rs.section = l.section
    where coalesce(l.archived, false) = false
  ), agg as (
   select ann.company_id,
      sum(ann.annualized) filter (where ann.frequency = 'target_net') as profit_target,
      sum(ann.annualized) filter (where ann.cost_type = 'direct' and ann.frequency <> 'target_net') as line_direct,
      sum(ann.annualized) filter (where ann.cost_type = 'reserve' and ann.frequency <> 'target_net') as reserve_total,
      sum(ann.annualized) filter (where ann.cost_type = any (array['fixed','variable']) and not (ann.source = 'benchmark' and ann.has_reg)) as overhead_total,
      sum(ann.annualized) filter (where (ann.section ilike '%fleet%' or ann.section ilike '%vehicle%') and ann.frequency <> 'target_net') as fleet_cost_total
     from ann
    group by ann.company_id
  ), f as (
   select d3.company_id, d3.revenue, d3.field_headcount, d3.office_headcount, d3.owner_headcount,
      d3.paid_hours_per_year, d3.pto_days, d3.nonbillable_pct, d3.vehicle_count, d3.fleet_miles_per_year,
      d3.workdays_per_year, d3.target_net_pct, d3.roster_field_people, d3.roster_wages, d3.roster_burden,
      d3.field_paid_hours, d3.billable_hours, d3.total_headcount, d3.from_roster, d3.fw, d3.fb,
      coalesce(agg.line_direct, 0::numeric) + case when d3.from_roster then d3.fw + d3.fb else 0::numeric end as direct_total,
      coalesce(agg.overhead_total, 0::numeric) + coalesce(rc.reg_total, 0::numeric) as overhead_total,
      coalesce(rc.reg_total, 0::numeric) as overhead_from_registry,
      coalesce(agg.reserve_total, 0::numeric) as reserve_total,
      coalesce(agg.profit_target, 0::numeric) as profit_target,
      coalesce(agg.fleet_cost_total, 0::numeric) as fleet_cost_total
     from d3
       left join agg on agg.company_id = d3.company_id
       left join reg_co rc on rc.company_id = d3.company_id
  )
 select company_id,
    from_roster as wages_from_roster,
    billable_hours,
    fw as field_wages,
    fb as field_burden,
    case when billable_hours > 0::numeric then (fw + fb) / billable_hours else null::numeric end as loaded_labor_rate,
    direct_total,
    overhead_total,
    reserve_total,
    profit_target,
    case when revenue > 0::numeric then (revenue - direct_total) / revenue else null::numeric end as gross_margin_pct,
    case when revenue > 0::numeric then (revenue - direct_total - overhead_total) / revenue else null::numeric end as net_pct,
    case when revenue > 0::numeric and (revenue - direct_total) > 0::numeric then overhead_total / ((revenue - direct_total) / revenue) else null::numeric end as breakeven_revenue,
    case when billable_hours > 0::numeric then overhead_total / billable_hours else null::numeric end as overhead_per_billable_hour,
    case when billable_hours > 0::numeric then (fw + fb) / billable_hours + overhead_total / billable_hours else null::numeric end as breakeven_hourly_rate,
    case when direct_total > 0::numeric then overhead_total / direct_total * 100::numeric else null::numeric end as min_markup_pct,
    case when workdays_per_year > 0 then overhead_total / workdays_per_year::numeric else null::numeric end as overhead_per_workday,
    case when fleet_miles_per_year > 0 then fleet_cost_total / fleet_miles_per_year::numeric else null::numeric end as fleet_cost_per_mile,
    overhead_from_registry
   from f;

revoke all on public.company_rates from anon, authenticated;
grant select on public.company_rates to service_role;

commit;
