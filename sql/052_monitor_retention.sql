-- sql/052_monitor_retention.sql
-- Monitor data RETENTION + deletion policy.
--
-- POLICY: monitor captures (screenshots, activity samples, sessions) and
-- pairing-attempt logs are retained for MONITOR_RETENTION_DAYS days (default
-- 90) and then permanently deleted. Rationale: the office reviews recent work;
-- there is no business need to keep screen captures of employees indefinitely,
-- and minimizing the retention window limits exposure if the store is ever
-- breached. The window is enforced two ways:
--
--   1. Screenshots + their now-empty sessions: the daily prune cron in
--      api/track1.js (resource=monitor_prune, CRON_SECRET-gated) is
--      AUTHORITATIVE. It must delete the Storage blob and the monitor_screenshots
--      row together, so it is done in JS (Postgres cannot reach Supabase
--      Storage). See pruneMonitorData() in api/_lib/monitor.js.
--
--   2. Activity samples + pairing-attempt logs have no Storage side, so this
--      SQL function prunes them directly and can also run as a backstop
--      (e.g. from a scheduled SQL job) independent of the app.
--
-- This migration only installs the MECHANISM. It does NOT delete any existing
-- prod data on apply.

-- SECURITY DEFINER so it can be granted narrowly; search_path pinned to public
-- (no user-controlled schema resolution), and execute revoked from public so
-- only explicitly-granted roles (service role / a scheduled job) can run it.
create or replace function prune_monitor_data(retention_days integer default 90)
returns table (activity_samples_deleted bigint, pair_attempts_deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff timestamptz := now() - make_interval(days => greatest(retention_days, 1));
  n_samples bigint;
  n_attempts bigint;
begin
  delete from monitor_activity_samples where sampled_at < cutoff;
  get diagnostics n_samples = row_count;

  delete from monitor_pair_attempts where attempted_at < cutoff;
  get diagnostics n_attempts = row_count;

  return query select n_samples, n_attempts;
end;
$$;

revoke all on function prune_monitor_data(integer) from public;
