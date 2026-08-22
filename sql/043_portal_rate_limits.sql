-- sql/043_portal_rate_limits.sql
-- Rate-limit ledger for the public portal recovery endpoints (2026-08-01,
-- Item 1 stabilization). api/_lib/portal-auth.js#checkRateLimit inserts one
-- row per attempt (keyed "<bucket>:<ip|identifier>") and counts rows inside a
-- sliding window to decide whether to throttle. The limiter fails OPEN if this
-- table is absent, so shipping the code before this migration is applied is
-- safe — it just means "no throttle yet".
--
-- Service-role only (RLS enabled, no policies) — same pattern as
-- webhook_events / the other infra tables. Only the service key (which
-- bypasses RLS) ever reads or writes it.

create table if not exists portal_rate_limits (
  id bigint generated always as identity primary key,
  bucket text not null,
  created_at timestamptz not null default now()
);

-- Window queries filter by bucket + created_at; this index serves both.
create index if not exists portal_rate_limits_bucket_time_idx
  on portal_rate_limits (bucket, created_at);

alter table portal_rate_limits enable row level security;

-- Housekeeping helper: prune rows older than a day. Safe to call from a cron
-- or manually; the limiter never needs anything older than its widest window.
-- search_path pinned per hardening guidance (Item 7) so the function body
-- can't be hijacked by a caller-controlled search_path.
create or replace function prune_portal_rate_limits()
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  delete from public.portal_rate_limits where created_at < now() - interval '1 day';
$$;

revoke all on function prune_portal_rate_limits() from public;
