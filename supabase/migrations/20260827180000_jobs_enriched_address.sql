-- jomell, 2026-08-27: Active Jobs doesn't show a client address anywhere,
-- on the list or in the job detail panel.
--
-- jobs_enriched already joins client_locations for GPS pins (loc_city,
-- loc_province) but never selected the street or postal code -- they exist
-- on the same row, just not carried through. Same append-only discipline as
-- 20260825140000 (effective_start_at/effective_end_at) and 20260825160000
-- (hl_closed_at) before it: two new trailing columns, the first 25 untouched.

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
