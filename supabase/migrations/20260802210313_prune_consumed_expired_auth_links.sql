-- Portal auth hygiene: purge spent / expired magic-link + reauth grants.
--
-- Follow-up to PR #43. Single-use magic links and banking reauth grants are
-- consumed (`used_at` set, or `purpose='reauth_consumed'`) or simply expire, but
-- nothing deleted the dead rows, so `sub_auth_links` / `client_auth_links` grow
-- unbounded. Consumed / expired rows are no longer usable as credentials (and
-- the token is stored hashed), so deleting them beyond a short grace window is a
-- pure cleanup that preserves every still-valid, unused grant.
--
-- Mirrors the existing prune_portal_rate_limits() / prune_oauth_states()
-- pattern (SECURITY DEFINER, fixed search_path, service_role executable) so the
-- same scheduled-cron mechanism can call it. Data-preserving:
--   * keeps any row that is unused AND not past expiry;
--   * deletes rows consumed (used_at set, or reauth_consumed) or expired more
--     than the grace window ago (default 1 day) so recent audit-adjacent rows
--     linger briefly before removal.

create or replace function public.prune_portal_auth_links(p_grace interval default interval '1 day')
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_deleted integer := 0;
  v_n integer;
begin
  delete from public.sub_auth_links
   where (used_at is not null and used_at < now() - p_grace)
      or (purpose = 'reauth_consumed' and coalesce(used_at, created_at) < now() - p_grace)
      or (used_at is null and expires_at < now() - p_grace);
  get diagnostics v_n = row_count; v_deleted := v_deleted + v_n;

  delete from public.client_auth_links
   where (used_at is not null and used_at < now() - p_grace)
      or (used_at is null and expires_at < now() - p_grace);
  get diagnostics v_n = row_count; v_deleted := v_deleted + v_n;

  return v_deleted;
end;
$$;

comment on function public.prune_portal_auth_links(interval)
  is 'Deletes spent (used/consumed) or expired sub_auth_links + client_auth_links rows older than the grace window (default 1 day). Preserves every still-valid unused grant. Data-preserving cleanup; call from the existing prune cron. Added for PR #43.';

revoke all on function public.prune_portal_auth_links(interval) from public;
revoke all on function public.prune_portal_auth_links(interval) from anon;
revoke all on function public.prune_portal_auth_links(interval) from authenticated;
grant execute on function public.prune_portal_auth_links(interval) to service_role;
