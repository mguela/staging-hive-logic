-- Two holes found by auditing production on 2026-08-23, after Chris asked how
-- bank details and client data are kept from being stolen.
--
-- The bank answer was already good: sub_banking never holds a real account or
-- routing number, only a masked display value and an opaque provider token, and
-- the API rejects anything that is not already masked. Nothing to fix there.
-- These are the two things that were actually wrong.
--
-- APPLIED TO PRODUCTION 2026-08-23 on Chris's explicit sign-off, via the
-- Supabase migration API, which recorded it as version 20260823131948 -- this
-- file is named to match that version exactly so the repo and the production
-- ledger do not drift apart.

-- ---------------------------------------------------------------------------
-- 1. Five tables in `public` had RLS switched off.
-- ---------------------------------------------------------------------------
--
-- The anon key ships inside public/index.html, which is correct and normal for
-- Supabase -- it is a PUBLIC key, and the only thing standing between it and a
-- table is row level security. Every sensitive table in this database has RLS
-- on with no permissive policy, which denies anon and authenticated outright
-- and leaves the service key (server-side only) as the way in. That is the
-- right shape, and it is why the broad `GRANT ... TO anon` in the baseline is
-- harmless everywhere else.
--
-- These five never had it switched on, so the grant was the whole story and
-- anyone who read the page source could select from them:
--
--   ops_events                      118 rows -- client_name, client_id,
--                                               job_title, detail, facts
--   employee_roles_backup_20260821   30 rows -- employee ids, roles,
--                                               permission_roles, crew labels
--   ops_detector_runs                40 rows -- detector run stats
--   client_flags                      0 rows -- client_id + reason
--   ops_event_mutes                   0 rows -- client/job/vehicle ids
--
-- The first two are real business data about real clients and real employees.
-- The empty two are the same hole waiting for its first row.
--
-- NO POLICIES ARE ADDED, deliberately. Every one of these tables is read only
-- by api/ through the service key, which bypasses RLS -- verified by grepping
-- the whole repo: zero frontend references to any of them. So "RLS on, no
-- policy" is exactly right: it closes anon and authenticated completely and
-- changes nothing about how the app works. A policy here would be inventing an
-- access path nobody asked for.

alter table public.ops_events                     enable row level security;
alter table public.ops_event_mutes                enable row level security;
alter table public.ops_detector_runs              enable row level security;
alter table public.client_flags                   enable row level security;
alter table public.employee_roles_backup_20260821 enable row level security;

comment on table public.employee_roles_backup_20260821 is
  'Snapshot taken during the 2026-08-21 permission_roles_v2 work. Nothing in the repo reads it. RLS enabled 2026-08-23 because it was publicly readable; it is a candidate to DROP once the permission migration is confirmed settled -- left in place here because deleting data is not this migration''s job.';

-- ---------------------------------------------------------------------------
-- 2. is_admin() did not know what a superadmin is.
-- ---------------------------------------------------------------------------
--
-- `public.profiles.role` has three staff values in production: 'crew',
-- 'admin' and 'superadmin'. is_admin() tested `role = 'admin'` only, so the
-- HIGHEST-privileged users in the system -- including Chris -- failed it.
--
-- It gates nine policies:
--   documents      SELECT (the sensitivity gate), UPDATE, DELETE
--   folders        INSERT, UPDATE, DELETE
--   folder_access  SELECT, INSERT, DELETE
-- and is also the first branch of can_access_folder(), which can_see_folder()
-- calls in turn. So one wrong comparison quietly narrowed all of them.
--
-- HOW IT SHOWED UP. A subcontractor's COI is filed `sensitive = true`. The
-- Documents tab reads `documents` straight from the browser under RLS, so the
-- sensitivity gate hid the file from a superadmin. Meanwhile /api/hivedoc runs
-- on the service key and applies canSee() in code, where SENSITIVE_ROLES is
-- ['admin', 'superadmin'] -- so the same file was visible through search and
-- invisible in the list, to the same person, at the same moment.
--
-- That is the same failure this codebase produced twice already this week: two
-- halves each internally consistent, disagreeing about who someone is. The
-- database was the half that was wrong -- 'superadmin' is by definition not
-- less than 'admin' -- so it moves to match the application, rather than the
-- application being narrowed to match a typo.
--
-- Widening is safe in a way narrowing would not be: superadmin already holds
-- every capability admin does through the application layer, so this grants no
-- reach that role did not already have by design. Only through the browser's
-- direct reads, where it was being wrongly denied.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('admin', 'superadmin')
  );
$function$;

comment on function public.is_admin() is
  'True for staff whose profiles.role is admin or superadmin. Kept in step with SENSITIVE_ROLES in api/_lib/hivedoc-search.js -- if one list changes, so must the other, or the same file becomes visible one way and hidden the other.';

-- Unchanged and deliberately not widened: execute stays with the roles that
-- already had it. This function is callable over /rest/v1/rpc by any signed-in
-- user, which the advisor flags. It leaks nothing -- it answers only "am I an
-- admin", about the caller, and never about anybody else -- so it is left as
-- it is rather than broken to quiet a warning.
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;
