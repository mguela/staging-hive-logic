-- supabase/migrations/20260814192952_fleet_slice1_seed_vehicles.sql
--
-- HiveLogic Fleet — Slice 1: seed the 12-vehicle pilot roster (spec §5) into fleet_vehicles.
--
-- Idempotent: ON CONFLICT (company_id, roster_slug) DO NOTHING — safe to re-run.
-- Notes baked in from the roster and the locked decisions:
--   * tracking_policy = 'always' for every GH vehicle (spec §7).
--   * The two Ram 1500 pickups (Rich, Chris) seed as tracker_state='untracked' — no hardware
--     fitted yet. 'untracked' is a valid transient state, not a fault (spec §5 note).
--   * Sandro's two vehicles: Silverado 1500 is primary (is_primary_for_assigned_driver=true),
--     Ram 5500 dump is secondary (false) — spec §5.1.
--   * Division resolved to public.org_units (seeded in 052_gate1b): 'Greenwich Handyman' and
--     'GH Electric' both exist. LEFT JOIN so a name mismatch can never silently drop a vehicle;
--     division_org_unit_id is nullable and simply stays null if unmatched (surfaced by the
--     verification block below rather than losing the row).
--   * VIN and home_base_profile_id are intentionally left NULL: the roster has no VINs, and
--     names (Dave/Rich/…) are not yet resolved to a profile (public.profiles.id). Backfilling both — and the
--     fleet_vehicles<->public.vehicles VIN/external_refs linkage — is an operational data task
--     (admin UI, Slice 5A), not schema work.

insert into public.fleet_vehicles
  (company_id, roster_slug, division_org_unit_id, year, make, model, trim, vehicle_class,
   home_base_type, tracker_state, tracking_policy, is_primary_for_assigned_driver, status)
select
  c.id,
  v.roster_slug,
  ou.id,
  v.year, v.make, v.model, v.trim, v.vehicle_class,
  v.home_base_type, v.tracker_state, 'always', v.is_primary, 'active'
from public.companies c
cross join (values
  ('smart-fortwo-2012-quinn',            2012, 'Smart',     'fortwo',         null,     'car',    'Greenwich Handyman', 'shop', 'tracked',   true ),
  ('ram-5500-dump-2014-sandro',          2014, 'Ram',       '5500',           'dump',   'heavy',  'Greenwich Handyman', 'shop', 'tracked',   false),
  ('chevy-silverado-1500-2018-sandro',   2018, 'Chevrolet', 'Silverado 1500', null,     'pickup', 'Greenwich Handyman', 'shop', 'tracked',   true ),
  ('ram-promaster-2500-2019-steve',      2019, 'Ram',       'ProMaster 2500', null,     'van',    'Greenwich Handyman', 'shop', 'tracked',   true ),
  ('jeep-renegade-2021-dave',            2021, 'Jeep',      'Renegade',       null,     'car',    'Greenwich Handyman', 'home', 'tracked',   true ),
  ('ram-promaster-2500-2021-unassigned', 2021, 'Ram',       'ProMaster 2500', null,     'van',    'Greenwich Handyman', 'shop', 'tracked',   true ),
  ('ram-promaster-2500-2024-danny',      2024, 'Ram',       'ProMaster 2500', null,     'van',    'Greenwich Handyman', 'shop', 'tracked',   true ),
  ('ram-1500-2024-rich',                 2024, 'Ram',       '1500',           null,     'pickup', 'Greenwich Handyman', 'home', 'untracked', true ),
  ('ram-1500-2025-chris',                2025, 'Ram',       '1500',           null,     'pickup', 'Greenwich Handyman', 'home', 'untracked', true ),
  ('ram-promaster-2500-2025-sami',       2025, 'Ram',       'ProMaster 2500', null,     'van',    'Greenwich Handyman', 'home', 'tracked',   true ),
  ('ram-promaster-2500-2025-jeff',       2025, 'Ram',       'ProMaster 2500', null,     'van',    'GH Electric',        'home', 'tracked',   true ),
  ('ram-promaster-1500-2025-einer',      2025, 'Ram',       'ProMaster 1500', null,     'van',    'Greenwich Handyman', 'shop', 'tracked',   true )
) as v(roster_slug, year, make, model, trim, vehicle_class, division_name, home_base_type, tracker_state, is_primary)
left join public.org_units ou
  on ou.company_id = c.id and ou.unit_type = 'division' and ou.name = v.division_name
where c.slug = 'greenwich-handyman'
on conflict (company_id, roster_slug) do nothing;

-- Verification: confirm all 12 seeded and every division resolved.
-- Resilient by design — in production the GH tenant is seeded (asserts 12); in a clean local /
-- CI `supabase db reset` the tenant seed (legacy sql/052) may not be present, in which case the
-- INSERT above is a harmless no-op and this block skips rather than failing the reset.
do $$
declare
  gh uuid;
  v_total int;
  v_no_division int;
begin
  select id into gh from public.companies where slug = 'greenwich-handyman';
  if gh is null then
    raise notice 'Fleet seed: Greenwich Handyman tenant not present in this environment; skipping seed verification.';
    return;
  end if;

  select count(*) into v_total from public.fleet_vehicles where company_id = gh;
  select count(*) into v_no_division
    from public.fleet_vehicles
    where company_id = gh and roster_slug is not null and division_org_unit_id is null;

  if v_total < 12 then
    raise exception 'Fleet seed: expected >= 12 vehicles for GH, found %', v_total;
  end if;
  if v_no_division > 0 then
    raise warning 'Fleet seed: % roster vehicle(s) have an unresolved division_org_unit_id — check org_units names.', v_no_division;
  end if;
  raise notice 'Fleet seed OK: % vehicles present for Greenwich Handyman.', v_total;
end $$;
