-- One protected, traceable home for verified application findings.  Sources
-- (browser self-test, CI, monitors, and future integrations) write through
-- server-side handlers; people use the Dev To-Do view to triage the work.

create table if not exists public.app_status_findings (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source ~ '^[a-z0-9_-]{1,64}$'),
  fingerprint text not null check (length(fingerprint) between 8 and 128),
  title text not null check (length(title) between 1 and 280),
  detail text,
  severity text not null default 'medium' check (severity in ('critical', 'high', 'medium', 'low', 'info')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'ignored')),
  evidence jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  status_note text,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, fingerprint)
);

create index if not exists app_status_findings_active_idx
  on public.app_status_findings (status, severity, last_seen_at desc);
create index if not exists app_status_findings_source_idx
  on public.app_status_findings (source, last_seen_at desc);

alter table public.app_status_findings enable row level security;
revoke all on table public.app_status_findings from public, anon, authenticated;
grant select, insert, update, delete on table public.app_status_findings to service_role;

create table if not exists public.app_status_events (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.app_status_findings(id) on delete cascade,
  event_type text not null check (event_type in ('observed', 'status_changed', 'note_added')),
  detail text,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists app_status_events_finding_idx
  on public.app_status_events (finding_id, created_at desc);

alter table public.app_status_events enable row level security;
revoke all on table public.app_status_events from public, anon, authenticated;
grant select, insert, update, delete on table public.app_status_events to service_role;
