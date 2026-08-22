-- HiveDoc function privilege/search-path hardening.
-- Target project: xxxutmorfqjdiugcavti
-- Status: APPLIED 2026-08-17 as hivedoc_function_privilege_hardening_20260817.

begin;

alter function public.can_access_folder(uuid) set search_path = pg_catalog, public;
alter function public.can_see_folder(uuid) set search_path = pg_catalog, public;
alter function public.is_admin() set search_path = pg_catalog, public;
alter function public.handle_new_user() set search_path = pg_catalog, public;
alter function public.apply_sensitive_default() set search_path = pg_catalog, public;

-- Remove PostgreSQL's inherited PUBLIC execute grant before rebuilding the
-- exact role matrix.
revoke execute on function public.can_access_folder(uuid) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.can_see_folder(uuid) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.is_admin() from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.handle_new_user() from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.apply_sensitive_default() from PUBLIC, anon, authenticated, service_role;

-- Live RLS policies call these three helpers while evaluating authenticated
-- requests, so authenticated must retain EXECUTE. They remain SECURITY
-- DEFINER with pinned search paths.
grant execute on function public.can_access_folder(uuid) to authenticated, service_role;
grant execute on function public.can_see_folder(uuid) to authenticated, service_role;
grant execute on function public.is_admin() to authenticated, service_role;

-- handle_new_user and apply_sensitive_default are trigger-only. Their owner
-- retains execution; no API-facing role needs to invoke them directly.

commit;
