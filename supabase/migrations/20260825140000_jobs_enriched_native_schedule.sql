-- jomell, 2026-08-25: "i just booked a schedule and it reflected in the
-- schedule or calendar... this should also reflect in 'active jobs' tab."
--
-- Active Jobs' "Scheduled" pill (public/index.html's ajxIsScheduled(j)) only
-- ever checks jobs.start_at, which is written EXCLUSIVELY by the Jobber sync
-- (api/jobber/sync.js's mapJob()). Booking a job on the crew board writes a
-- real row into hl_appointments (api/schedule/hl.js's create_appointment),
-- correctly linked via hl_appointments.job_ref = jobs.jobber_id
-- (20260817223000_appointment_job_link.sql) -- but nothing ever read that
-- link back into jobs_enriched, so a HiveLogic-scheduled job still showed
-- "Not booked" until Jobber independently learned about it, which for a
-- HiveLogic-native job never happens at all.
--
-- Same append-only discipline as 20260817235251 (added project_seq/
-- division_code at the end, never touching the first 19 columns): two new
-- trailing columns, coalescing Jobber's own start/end with the earliest
-- non-canceled hl_appointments row for that job. jobs.start_at itself is
-- untouched -- still exactly what Jobber says, still subject to the same
-- hourly-sync overwrite as ever. This view is the one place that blends it
-- with the HiveLogic-native fact, not a write to a Jobber-owned column.

begin;

create or replace view public.jobs_enriched with (security_invoker = true) as
select
  j.jobber_id,
  j.client_id,
  j.job_number,
  j.title,
  j.job_status,
  j.job_type,
  j.total,
  j.start_at,
  j.end_at,
  j.completed_at,
  j.jobber_web_uri,
  j.jobber_created_at,
  j.jobber_updated_at,
  j.synced_at,
  coalesce(
    nullif(c.name, ''::text),
    nullif(trim(both from concat_ws(' '::text, c.first_name, c.last_name)), ''::text),
    nullif(c.company_name, ''::text)
  ) as client_name,
  cl.lat as gps_lat,
  cl.lng as gps_lng,
  cl.city as loc_city,
  cl.province as loc_province,
  j.project_seq,
  j.division_code,
  coalesce(j.start_at, ha.start_at) as effective_start_at,
  coalesce(j.end_at, ha.end_at) as effective_end_at
from public.jobs j
left join public.clients c on c.jobber_id = j.client_id
left join public.client_locations cl
  on cl.jobber_id = j.client_id and cl.lat is not null
left join lateral (
  select a.start_at, a.end_at
  from public.hl_appointments a
  where a.job_ref = j.jobber_id and a.canceled = false
  order by a.start_at asc
  limit 1
) ha on true;

alter view public.jobs_enriched owner to postgres;
revoke all on table public.jobs_enriched from PUBLIC, anon, authenticated;
grant all on table public.jobs_enriched to service_role;

commit;
