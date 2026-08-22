-- Live migration version 20260817235251. Repair the partially applied project-numbering migration.
--
-- 20260817210000 added the counter and jobs columns, then attempted to insert
-- new columns into the middle of jobs_enriched with CREATE OR REPLACE VIEW.
-- PostgreSQL only permits new view columns at the end, so the live view kept
-- its old shape while the earlier statements remained applied. The counter
-- also inherited broad Data API privileges and the allocator inherited
-- EXECUTE from PUBLIC. Both are server-only implementation details.

begin;

alter table public.project_counters enable row level security;

revoke all on table public.project_counters from PUBLIC, anon, authenticated;
grant select, insert, update, delete on table public.project_counters to service_role;

alter function public.allocate_project_number(text)
  set search_path = pg_catalog, public;
revoke all on function public.allocate_project_number(text) from PUBLIC, anon, authenticated;
grant execute on function public.allocate_project_number(text) to service_role;

-- Preserve the 19 existing view columns in their original order and append the
-- two project-number fields. This is legal for CREATE OR REPLACE VIEW and does
-- not invalidate consumers that depend on the established column positions.
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
  j.division_code
from public.jobs j
left join public.clients c on c.jobber_id = j.client_id
left join public.client_locations cl
  on cl.jobber_id = j.client_id and cl.lat is not null;

alter view public.jobs_enriched owner to postgres;
revoke all on table public.jobs_enriched from PUBLIC, anon, authenticated;
grant all on table public.jobs_enriched to service_role;

commit;
