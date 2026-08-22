-- HiveLogic Windows Agent control plane.
-- Apply through the normal Supabase migration process before enabling /api/agents/*.
create extension if not exists pgcrypto;

create table if not exists automation_enrollment_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  code_hash text not null unique,
  created_by uuid,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists automation_agents (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  display_name text not null,
  hostname text not null,
  platform text not null default 'windows',
  agent_version text,
  status text not null default 'offline'
    check (status in ('online','offline','paused','emergency_stopped','revoked')),
  paused_at timestamptz,
  emergency_stopped_at timestamptz,
  revoked_at timestamptz,
  last_heartbeat_at timestamptz,
  current_task_id uuid,
  capabilities jsonb not null default '[]'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, hostname)
);

create table if not exists automation_agent_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  agent_id uuid not null references automation_agents(id) on delete cascade,
  secret_hash text not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists automation_agent_permissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  agent_id uuid not null references automation_agents(id) on delete cascade,
  scope_type text not null check (scope_type in ('folder','repository')),
  canonical_path text not null,
  permissions jsonb not null default '["read"]'::jsonb,
  approved_by uuid,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (agent_id, canonical_path)
);

create table if not exists automation_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  agent_id uuid not null references automation_agents(id),
  task_type text not null,
  payload jsonb not null default '{}'::jsonb,
  scope_hash text not null,
  risk_tier text not null check (risk_tier in ('read_only','write','deploy')),
  status text not null default 'pending_approval'
    check (status in ('pending_approval','queued','claimed','running','succeeded','failed','cancel_requested','cancelled','blocked')),
  created_by uuid,
  approved_at timestamptz,
  claimed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  lease_expires_at timestamptz,
  result_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'automation_agents_current_task_fk'
      and conrelid = 'automation_agents'::regclass
  ) then
    alter table automation_agents
      add constraint automation_agents_current_task_fk
      foreign key (current_task_id) references automation_tasks(id)
      deferrable initially deferred;
  end if;
end
$$;

create table if not exists automation_task_approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  task_id uuid not null references automation_tasks(id) on delete cascade,
  scope_hash text not null,
  decision text not null check (decision in ('approved','rejected')),
  decided_by uuid,
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists automation_task_events (
  id bigint generated always as identity primary key,
  tenant_id text not null default 'ghgrp',
  task_id uuid references automation_tasks(id) on delete cascade,
  agent_id uuid references automation_agents(id) on delete cascade,
  event_type text not null,
  level text not null default 'info',
  message text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists automation_agents_tenant_heartbeat_idx
  on automation_agents (tenant_id, last_heartbeat_at desc);
create unique index if not exists automation_agent_credentials_secret_hash_idx
  on automation_agent_credentials (secret_hash);
create index if not exists automation_tasks_agent_status_idx
  on automation_tasks (agent_id, status, created_at);
create index if not exists automation_task_events_task_idx
  on automation_task_events (task_id, created_at);

alter table automation_enrollment_codes enable row level security;
alter table automation_agents enable row level security;
alter table automation_agent_credentials enable row level security;
alter table automation_agent_permissions enable row level security;
alter table automation_tasks enable row level security;
alter table automation_task_approvals enable row level security;
alter table automation_task_events enable row level security;

-- Serverless handlers use the service role after authenticating staff or devices.
-- No direct browser/device table access is granted.
