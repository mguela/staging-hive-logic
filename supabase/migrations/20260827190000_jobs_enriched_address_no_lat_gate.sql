-- jomell, 2026-08-27: a client address entered directly in HiveLogic (the
-- new client-contact-info edit modal, or New Client's own address field)
-- has lat/lng left null for the existing geocoder to fill -- never guessed
-- inline. jobs_enriched's client_locations join required "cl.lat is not
-- null", which was fine for GPS map pins but also silently dropped
-- loc_street/loc_postal_code/loc_city/loc_province for every one of those
-- rows, so a real, manually-entered address never showed up in Active Jobs
-- at all until the geocoder happened to run.
--
-- Fix: join on jobber_id alone. gps_lat/gps_lng are unaffected -- they were
-- already null whenever lat itself was null; only the join match changes,
-- not the value of those two columns. Same append-only column list as
-- 20260827180000, just widening which client_locations rows can match.

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
  coalesce(j.end_at, ha.end_at) as effective_end_at,
  j.hl_closed_at,
  cl.street as loc_street,
  cl.postal_code as loc_postal_code
from public.jobs j
left join public.clients c on c.jobber_id = j.client_id
left join public.client_locations cl
  on cl.jobber_id = j.client_id
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
