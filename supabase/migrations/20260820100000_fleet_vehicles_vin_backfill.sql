-- supabase/migrations/20260820100000_fleet_vehicles_vin_backfill.sql
--
-- HiveLogic Fleet — Slice 1 followup: backfill fleet_vehicles.vin.
--
-- fleet_vehicles was seeded with vin = null on purpose
-- (20260814192952_fleet_slice1_seed_vehicles.sql: "the roster has no VINs
-- yet... backfilling... is an operational data task, not schema work").
-- FLEET_ENABLED is now on in production, but api/fleet/detect-presence.js's
-- arrival/departure detection can never reach a vehicle until this VIN link
-- exists -- fleet_vehicles.vin == public.vehicles.vin is the documented join
-- (20260814192951_fleet_slice1_schema.sql, "VEHICLE MIRROR LINKAGE"), and
-- api/track1.js's crew_schedule (the read path feeding the Command Center
-- map's Arrived/Departed line) looks the presence data up by that VIN.
--
-- Matches on (year, lower(trim(make)), lower(trim(model))) -- the only
-- columns both tables carry natively. Only an UNAMBIGUOUS 1:1 match is
-- written: exactly one still-unlinked fleet_vehicles row, and exactly one
-- public.vehicles row with that (year, make, model) and a real vin. A
-- roster slug with zero or multiple candidates (two visually identical
-- trucks, or a Jobber name that doesn't carry year/make/model cleanly) is
-- left untouched -- the seed migration's own stance was "don't guess", and
-- that applies here too. The verification block below reports exactly
-- which roster slugs still need a human to resolve.
--
-- hl:replay-safe: every match is scoped to "fv.vin is null", so once a
-- vehicle is linked a second run of this file matches zero rows for it --
-- safe to re-run as more of public.vehicles gets VINs synced from Jobber/
-- FleetSharp over time.

with candidates as (
  select
    fv.id as fleet_vehicle_id,
    v.vin,
    count(*) over (partition by fv.id) as roster_side_matches,
    count(*) over (partition by v.vin) as mirror_side_matches
  from public.fleet_vehicles fv
  join public.vehicles v
    on v.year = fv.year
   and lower(trim(v.make)) = lower(trim(fv.make))
   and lower(trim(v.model)) = lower(trim(fv.model))
  where fv.vin is null
    and v.vin is not null
),
unambiguous as (
  select fleet_vehicle_id, vin
  from candidates
  where roster_side_matches = 1
    and mirror_side_matches = 1
)
update public.fleet_vehicles fv
set vin = u.vin,
    updated_at = now()
from unambiguous u
where fv.id = u.fleet_vehicle_id;

-- Verification: report what got linked and what still needs a human.
-- Resilient by design, matching the seed migration's own stance -- in a
-- clean local/CI reset without the GH tenant seeded, this reports and
-- returns rather than failing.
do $$
declare
  gh uuid;
  v_linked int;
  v_unlinked int;
  r record;
begin
  select id into gh from public.companies where slug = 'greenwich-handyman';
  if gh is null then
    raise notice 'Fleet VIN backfill: Greenwich Handyman tenant not present in this environment; skipping report.';
    return;
  end if;

  select count(*) into v_linked from public.fleet_vehicles where company_id = gh and vin is not null;
  select count(*) into v_unlinked from public.fleet_vehicles where company_id = gh and vin is null and status = 'active';

  raise notice 'Fleet VIN backfill: % vehicle(s) now linked to a VIN.', v_linked;
  if v_unlinked > 0 then
    raise warning 'Fleet VIN backfill: % active vehicle(s) still unlinked -- geofence presence cannot detect them until resolved by hand:', v_unlinked;
    for r in
      select roster_slug, year, make, model
      from public.fleet_vehicles
      where company_id = gh and vin is null and status = 'active'
      order by roster_slug
    loop
      raise warning '  - % (% % %)', r.roster_slug, r.year, r.make, r.model;
    end loop;
  end if;
end $$;

-- ROLLBACK (manual, if ever needed): this file only ever sets a previously-
-- null vin, so reverting means nulling out only the rows THIS run touched --
-- never a blanket "vin is not null", since some rows may already have
-- carried a hand-entered vin before this migration ran and must not be
-- nulled back out. Re-derive the list from row updated_at if needed:
--   select id, roster_slug, vin from public.fleet_vehicles
--   where updated_at >= '<time this migration was applied>' and vin is not null;
