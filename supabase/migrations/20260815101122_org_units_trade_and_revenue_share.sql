-- sql/075_org_units_trade_and_revenue_share.sql
--
-- Overhead Registries + Payroll Integration — Slice 0 (drift capture).
-- Captures the production migration `org_units_trade_and_revenue_share`
-- (applied directly to prod, no file in sql/). Written to MATCH production
-- exactly (information_schema / pg_get_viewdef, 2026-08-15). NOTHING APPLIED.
--
-- Added trade_slug / revenue_share_pct / code to org_units and created the
-- division_overhead view (overhead carried per operational division, by
-- revenue share). Depends on: 052 (org_units), 074 (trades), 077-or-071
-- (company_rates — division_overhead reads it).

begin;

alter table public.org_units add column if not exists trade_slug text;
alter table public.org_units add column if not exists revenue_share_pct numeric;
alter table public.org_units add column if not exists code text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'org_units_trade_slug_fkey') then
    alter table public.org_units
      add constraint org_units_trade_slug_fkey foreign key (trade_slug) references public.trades(slug);
  end if;
end $$;

create or replace view public.division_overhead
with (security_invoker = on) as
 with ops as (
   select o.company_id, o.id, o.name, o.code, o.trade_slug, o.status, o.revenue_share_pct,
      count(*) filter (where o.status = 'operational') over (partition by o.company_id) as ops_count
     from public.org_units o
    where o.unit_type = 'division'
  ), shares as (
   select ops.company_id, ops.id, ops.name, ops.code, ops.trade_slug, ops.status, ops.revenue_share_pct, ops.ops_count,
      coalesce(ops.revenue_share_pct / 100.0,
          case when ops.status = 'operational' and ops.ops_count > 0 then 1.0 / ops.ops_count::numeric else 0::numeric end) as share
     from ops
  )
 select s.company_id,
    s.id as division_id,
    s.name as division,
    s.code,
    s.trade_slug,
    s.status,
    round(s.share * 100::numeric, 1) as revenue_share_pct,
    round(r.overhead_total * s.share) as overhead_carried,
    case when (r.billable_hours * s.share) > 0::numeric
         then round(r.overhead_total * s.share / (r.billable_hours * s.share), 2)
         else null::numeric end as overhead_per_billable_hour,
    case when r.gross_margin_pct > 0::numeric
         then round(r.overhead_total * s.share / r.gross_margin_pct)
         else null::numeric end as breakeven_revenue
   from shares s
     left join public.company_rates r on r.company_id = s.company_id;

revoke all on public.division_overhead from anon, authenticated;
grant select on public.division_overhead to service_role;

commit;
