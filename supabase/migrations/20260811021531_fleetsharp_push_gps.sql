-- Canonical capture of sql/068_fleetsharp_push.sql into supabase/migrations.
-- Objects were already applied directly to production (2026-08-11); this file
-- records them in the migration ledger so a fresh install reproduces them.
-- Idempotent (add column if not exists) -- safe if it ever re-runs.
--
-- Adds shadow GPS columns for the FleetSharp Push API webhook
-- (api/jobber/sync-extended.js, ?resource=fleetsharp_push). This is the fix
-- for vehicle GPS on the Command Center map / Fleet GPS card going days
-- stale -- Jobber's own upstream connection to FleetSharp had failed, so
-- Vehicle.liveState.currentPosition (the existing latitude/longitude/speed/
-- status/gps_updated_at columns, still fed by the 15-minute Jobber cron) was
-- no longer moving. FleetSharp now pushes live positions directly to us,
-- matched to a vehicle by VIN, written into these separate columns so the
-- existing Jobber sync is untouched.
--
-- api/track1.js's handleCrewSchedule picks whichever of the two sets of
-- columns has the newer timestamp per vehicle -- FleetSharp wins whenever
-- it's actively pushing, Jobber only wins if FleetSharp goes quiet for that
-- specific truck. That comparison is what makes this "FleetSharp primary,
-- Jobber fallback" rather than a one-time cutover.

alter table public.vehicles add column if not exists fleetsharp_latitude numeric;
alter table public.vehicles add column if not exists fleetsharp_longitude numeric;
alter table public.vehicles add column if not exists fleetsharp_speed numeric;
alter table public.vehicles add column if not exists fleetsharp_status text;
alter table public.vehicles add column if not exists fleetsharp_updated_at timestamptz;
