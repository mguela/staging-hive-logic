-- jomell, 2026-08-25: "in active jobs, when clicking on a job, there
-- should be an option to 'close job' (meaning its done)."
--
-- jobs.job_status and jobs.completed_at are both written by the Jobber
-- sync's full-row upsert on jobber_id every run (api/jobber/sync.js's
-- mapJob()) -- writing "closed" into either of those directly for a real
-- Jobber-synced job would get silently wiped on the very next sync.
--
-- Same discipline as the phone/project_seq/division_code columns already on
-- this table: a HiveLogic-owned column the sync never touches. Nullable --
-- null means "not marked closed from HiveLogic's side" (Jobber's own status
-- is still what Active Jobs otherwise shows); a timestamp records when and
-- lets the UI show "Closed <date>" instead of just a boolean flag.

begin;

alter table public.jobs add column if not exists hl_closed_at timestamptz;

comment on column public.jobs.hl_closed_at is
  'Set by HiveLogic''s own "Close job" action (Active Jobs). Null = not closed from HiveLogic''s side. Never written by the Jobber sync -- see api/track1.js''s handleSetJobClosed.';

-- Same append-only discipline as 20260825140000 (effective_start_at/
-- effective_end_at) and 20260817235251 before that: one new trailing
-- column, the first 23 untouched.
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
  j.hl_closed_at
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
