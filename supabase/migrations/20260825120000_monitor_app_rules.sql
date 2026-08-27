-- supabase/migrations/20260825120000_monitor_app_rules.sql
-- Monitor Module Phase 5 (2026-08-25): app whitelist / productivity
-- classification. One row per foreground-app name -> category
-- (productive | neutral | unproductive). Company-wide, admin-managed via
-- api/track1.js resource=monitor_app_rules; the desktop agent
-- (hivelogic-monitor-agent) fetches the list to classify the active app
-- locally and decide when to show its own "not productive" notification.
--
-- Same pattern as the rest of monitor_* (sql/050_monitor_tables.sql /
-- MIGRATIONS.md): service-role only. RLS is enabled with NO policies --
-- every read/write goes through api/track1.js using the service key; the
-- browser and the agent never touch this table directly.

create table if not exists monitor_app_rules (
  id uuid primary key default gen_random_uuid(),
  -- One rule per app name. Plain unique (not a lower() functional index) so
  -- PostgREST's on_conflict=app_name upsert (api/track1.js
  -- handleMonitorAppRules) has a real constraint to target. Matching is
  -- exact against what getActiveAppName() reports (the OS-reported owner
  -- name, e.g. "Google Chrome") -- consistently cased per platform, so this
  -- does not need to be case-insensitive at the DB layer.
  app_name text not null unique,
  category text not null default 'neutral'
    check (category in ('productive', 'neutral', 'unproductive')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table monitor_app_rules enable row level security;
