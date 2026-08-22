-- sql/050_monitor_tables.sql
-- HiveLogic Monitor (WebWork-replacement desktop screen/activity tracker).
-- These tables were originally applied directly to prod out-of-band; this
-- migration brings them under repo control for DB reproducibility. It is the
-- authoritative CREATE for all monitor_* tables (a separate DB-reproducibility
-- stabilization item explicitly defers the monitor tables to this file).
--
-- All statements are `create table if not exists` / `create index if not
-- exists`, so re-running against the existing prod database is a no-op; on a
-- fresh database it reproduces the full monitor schema.
--
-- Service-role only: RLS is enabled with NO policies (same pattern as
-- sql/041_webhook_events.sql). Every read/write goes through api/track1.js
-- using the Supabase service key; the browser never touches these tables
-- directly.

-- Desktop agents, one row per paired device. See api/track1.js
-- handleMonitorPair / getRequestingAgent. The bearer credential is stored as a
-- SHA-256 hash in agent_token_hash (added in sql/051) -- never in plaintext.
create table if not exists monitor_agents (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null,
  device_name text,
  platform text,
  agent_version text,
  pairing_code text,
  pairing_code_expires_at timestamptz,
  paired_at timestamptz,
  last_seen_at timestamptz,
  status text not null default 'pending', -- pending | active | revoked
  agent_token text,       -- legacy plaintext column; no longer written (see sql/051)
  pair_attempts integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists monitor_agents_employee_status_idx
  on monitor_agents (employee_id, status);
create index if not exists monitor_agents_pending_idx
  on monitor_agents (employee_id)
  where status = 'pending';

-- One monitor session per clock-in. Opened/closed server-side from the
-- workforce time-session state on every heartbeat; consent starts 'pending'
-- and only capture once the employee answers 'allowed' for THIS session.
create table if not exists monitor_sessions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null,
  agent_id uuid not null,
  workforce_session_id uuid,
  consent text not null default 'pending', -- pending | allowed | denied
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists monitor_sessions_agent_open_idx
  on monitor_sessions (agent_id, started_at desc)
  where ended_at is null;
create index if not exists monitor_sessions_employee_idx
  on monitor_sessions (employee_id, started_at desc);
create index if not exists monitor_sessions_workforce_idx
  on monitor_sessions (workforce_session_id);

-- Periodic activity samples (activity %, idle seconds, foreground app).
create table if not exists monitor_activity_samples (
  id uuid primary key default gen_random_uuid(),
  monitor_session_id uuid not null,
  activity_level integer,
  idle_seconds integer,
  active_app text,
  display_count integer,
  sampled_at timestamptz not null default now()
);

create index if not exists monitor_activity_samples_session_idx
  on monitor_activity_samples (monitor_session_id, sampled_at desc);
-- Supports the retention prune (sql/052) scanning by age.
create index if not exists monitor_activity_samples_sampled_idx
  on monitor_activity_samples (sampled_at);

-- Screenshot metadata; the image bytes live in the `monitor-screenshots`
-- Storage bucket at storage_path (image contents are validated server-side
-- before upload -- magic-byte PNG/JPEG sniff, see handleMonitorScreenshotUpload).
create table if not exists monitor_screenshots (
  id uuid primary key default gen_random_uuid(),
  monitor_session_id uuid not null,
  display_index integer,
  storage_path text not null,
  width integer,
  height integer,
  captured_at timestamptz not null default now()
);

create index if not exists monitor_screenshots_session_idx
  on monitor_screenshots (monitor_session_id, captured_at desc);
-- Supports the retention prune (sql/052) scanning by age.
create index if not exists monitor_screenshots_captured_idx
  on monitor_screenshots (captured_at);

-- Per-IP pairing attempt log for the flat rate limit on monitor_pair.
create table if not exists monitor_pair_attempts (
  id uuid primary key default gen_random_uuid(),
  ip text,
  attempted_at timestamptz not null default now()
);

create index if not exists monitor_pair_attempts_ip_idx
  on monitor_pair_attempts (ip, attempted_at);

alter table monitor_agents           enable row level security;
alter table monitor_sessions         enable row level security;
alter table monitor_activity_samples enable row level security;
alter table monitor_screenshots      enable row level security;
alter table monitor_pair_attempts    enable row level security;
