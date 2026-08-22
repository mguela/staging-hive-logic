-- 039: jobs_enriched view — Gate 1 of the API-load root-cause fix.
--
-- Problem: api/jobs.js joined client names + geocoded locations onto jobs
-- IN NODE, by paginating the ENTIRE clients table (~8.7k rows, 9 requests)
-- and the ENTIRE client_locations table (9 more) on EVERY /api/jobs call —
-- ~19 PostgREST round-trips per hit, even for a single-job ?id= lookup.
-- This view does that join once, in the database, so the handler needs
-- exactly one request.
--
-- Name logic mirrors api/jobs.js fetchAllClientNames() / api/clients.js:
--   name -> "first last" -> company_name (JS || semantics: falsy skipped).
-- Location rows mirror fetchAllClientLocations(): only lat IS NOT NULL.
-- client_locations is 1 row per client in production (verified 2026-07-30:
-- 8,667 rows = 8,667 clients, 0 clients with multiple geocoded rows).
--
-- SECURITY (do not simplify this away):
--   * security_invoker = true  -> the view runs with the CALLER's rights,
--     so the underlying tables' RLS still applies. Without this, a default
--     (definer) view owned by postgres would BYPASS RLS and re-open the
--     anonymous-PII leak closed in the 2026-07-29/30 P0 rounds.
--   * explicit REVOKE from anon/authenticated -> the app reads it via the
--     service role only (same trust model as the tables today).

create or replace view public.jobs_enriched
with (security_invoker = true) as
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
    nullif(c.name, ''),
    nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''),
    nullif(c.company_name, '')
  ) as client_name,
  cl.lat  as gps_lat,
  cl.lng  as gps_lng,
  cl.city as loc_city,
  cl.province as loc_province
from public.jobs j
left join public.clients c
  on c.jobber_id = j.client_id
left join public.client_locations cl
  on cl.jobber_id = j.client_id and cl.lat is not null;

revoke all on public.jobs_enriched from anon, authenticated;
