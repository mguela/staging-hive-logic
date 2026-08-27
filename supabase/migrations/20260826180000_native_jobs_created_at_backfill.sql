-- supabase/migrations/20260826180000_native_jobs_created_at_backfill.sql
--
-- jomell, 2026-08-26: "where is the 'division' and 'created' supposed to be
-- set?" -- the Active Jobs modal's "Created" field reads jobs.jobber_created_at,
-- which (despite the name) every consumer already treats as "when this job
-- came into being" (growth-facts.js, ops-detectors.js, the sync/webhook
-- paths). It was only ever stamped by the Jobber sync/webhook -- a job
-- created natively in HiveLogic (api/_lib/native-job.js's createNativeJob,
-- jobber_id = 'HL-JOB-*') never got one written, so "Created" showed blank
-- for every HiveLogic-native job. createNativeJob now stamps it going
-- forward; this backfills the jobs that already exist.
--
-- jobs.synced_at defaults to now() and is not otherwise touched by native
-- job creation, so for an HL-JOB-* row it IS the real row-insert time --
-- not a guess standing in for an unknown fact (Law 1).
--
-- hl:replay-safe: scoped to "jobber_created_at is null", so once a row is
-- backfilled a second run matches zero rows for it.

update public.jobs
set jobber_created_at = synced_at
where jobber_id like 'HL-JOB-%'
  and jobber_created_at is null
  and synced_at is not null;

-- Verification: report what got backfilled and flag anything that still
-- couldn't be (a native row with no synced_at at all would be unexpected,
-- but this is resilient rather than failing the migration over it).
do $$
declare
  v_backfilled int;
  v_still_null int;
begin
  select count(*) into v_backfilled
  from public.jobs
  where jobber_id like 'HL-JOB-%' and jobber_created_at is not null;

  select count(*) into v_still_null
  from public.jobs
  where jobber_id like 'HL-JOB-%' and jobber_created_at is null;

  raise notice 'Native jobs created_at backfill: % native job(s) now have a Created date.', v_backfilled;
  if v_still_null > 0 then
    raise warning 'Native jobs created_at backfill: % native job(s) still have no Created date (no synced_at to backfill from):', v_still_null;
  end if;
end $$;

-- ROLLBACK (manual, if ever needed): this file only ever sets a previously-
-- null jobber_created_at, so reverting means nulling out only the rows THIS
-- run touched -- re-derive from synced_at equality if needed:
--   update public.jobs set jobber_created_at = null
--   where jobber_id like 'HL-JOB-%' and jobber_created_at = synced_at;
