-- Captured verbatim from prod supabase_migrations.schema_migrations (version 20260809102229).
-- Security hardening: these SECURITY DEFINER maintenance functions were
-- callable by unauthenticated (anon) and any signed-in (authenticated) user
-- via PostgREST RPC, enabling unauthenticated data deletion / DoS.
-- Restrict to service_role (used by the server-side cron) only.

REVOKE EXECUTE ON FUNCTION public.prune_monitor_data(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prune_oauth_states() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prune_portal_rate_limits() FROM PUBLIC, anon, authenticated;

-- Ensure the server-side path retains access.
GRANT EXECUTE ON FUNCTION public.prune_monitor_data(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_oauth_states() TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_portal_rate_limits() TO service_role;
