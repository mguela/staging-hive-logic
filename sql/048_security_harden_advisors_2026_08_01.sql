-- sql/046_security_harden_advisors_2026_08_01.sql
-- Item 7 (2026-08-01): resolve the 4 WARN-level Supabase security advisors
-- found on project sqhusuuhlmcmkeowdrga. Additive + idempotent; safe to apply
-- more than once. DO NOT run against production automatically — Chris applies
-- this after review (see MIGRATION_LEDGER.md).
--
-- Advisors addressed (INFO-level rls_enabled_no_policy is intentional — see
-- the ledger; those tables are service-role-only by design):
--
--   1) function_search_path_mutable: public.protect_locked_geocode had a
--      role-mutable search_path. A SECURITY DEFINER / trigger function with an
--      unpinned search_path can be hijacked by a caller-controlled search_path.
--      Pinning it is behavior-preserving and closes that class of attack.
--
--   2) authenticated_security_definer_function_executable (x3):
--      public.can_access_folder(uuid), public.can_see_folder(uuid),
--      public.is_admin() are SECURITY DEFINER and reachable via
--      /rest/v1/rpc/... by the anon/authenticated roles. We pin their
--      search_path AND revoke EXECUTE from anon (which must never call them).
--      The authenticated revoke is left as a REVIEWED, OPTIONAL step below,
--      because these helpers may be referenced inside RLS policies — revoking
--      EXECUTE from authenticated would break any policy that calls them.
--      Verify usage before uncommenting.

-- 1) Pin search_path on the flagged privileged functions. ALTER FUNCTION does
--    not need the body and does not change behavior.
alter function public.protect_locked_geocode() set search_path = pg_catalog, public;
alter function public.can_access_folder(uuid)   set search_path = pg_catalog, public;
alter function public.can_see_folder(uuid)      set search_path = pg_catalog, public;
alter function public.is_admin()                set search_path = pg_catalog, public;

-- 2) Revoke EXECUTE from anon (unauthenticated) — these must never be callable
--    by a signed-out request. Safe: anon is not used for RLS policy evaluation
--    of authenticated sessions.
revoke execute on function public.can_access_folder(uuid) from anon;
revoke execute on function public.can_see_folder(uuid)    from anon;
revoke execute on function public.is_admin()              from anon;

-- OPTIONAL (verify first): also revoke from the authenticated role if these
-- functions are NOT referenced inside any RLS policy. If a policy calls one of
-- them, revoking EXECUTE here will break that policy's evaluation for
-- authenticated sessions. Confirm with:
--   select polname, relname from pg_policies ... (grep the policy bodies)
-- then uncomment as appropriate:
--
-- revoke execute on function public.can_access_folder(uuid) from authenticated;
-- revoke execute on function public.can_see_folder(uuid)    from authenticated;
-- revoke execute on function public.is_admin()              from authenticated;

-- Advisor #5 (auth_leaked_password_protection) is a DASHBOARD toggle, not SQL:
--   Supabase -> Authentication -> Policies -> enable "Leaked password
--   protection" (HaveIBeenPwned). Manual step for Chris — see the ledger.
