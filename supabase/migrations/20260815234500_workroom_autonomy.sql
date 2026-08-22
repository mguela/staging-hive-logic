-- The shared operational ledger. Messages remain the human-friendly transcript;
-- these records are the auditable source of truth for autonomous work.
create table if not exists public.workroom_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid references public.ai_workroom_threads(id) on delete set null,
  project_id uuid references public.ai_workroom_projects(id) on delete set null,
  task_key text not null check (task_key ~ '^WR-[0-9]+$'),
  title text not null check (char_length(title) between 1 and 240),
  specification text not null default '',
  lane text not null default 'green' check (lane in ('green', 'yellow', 'red')),
  status text not null default 'queued' check (status in ('queued', 'claimed', 'working', 'review', 'blocked', 'done', 'cancelled')),
  priority integer not null default 50 check (priority between 1 and 100),
  assigned_agent text check (assigned_agent is null or assigned_agent in ('codex', 'chatgpt', 'claude', 'claude_code')),
  model_tier text not null default 'economy' check (model_tier in ('economy', 'standard', 'expert')),
  estimated_cost_cents integer not null default 0 check (estimated_cost_cents >= 0),
  spent_cost_cents integer not null default 0 check (spent_cost_cents >= 0),
  requires_review boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(owner_id, task_key)
);

create table if not exists public.workroom_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.workroom_tasks(id) on delete cascade,
  actor text not null check (actor in ('user', 'codex', 'chatgpt', 'claude', 'claude_code', 'system')),
  event_type text not null check (event_type in ('created', 'claimed', 'started', 'evidence', 'review_requested', 'reviewed', 'response', 'gate_passed', 'gate_failed', 'blocked', 'completed', 'cost_escalated')),
  body text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.workroom_evidence (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.workroom_tasks(id) on delete cascade,
  actor text not null check (actor in ('codex', 'chatgpt', 'claude', 'claude_code', 'system')),
  evidence_type text not null check (evidence_type in ('test', 'crawler', 'preview', 'diff', 'review', 'deployment', 'cost')),
  verdict text not null check (verdict in ('pass', 'fail', 'risk', 'info')),
  summary text not null check (char_length(summary) between 1 and 4000),
  reference text,
  created_at timestamptz not null default now()
);

create index if not exists workroom_tasks_owner_status_idx on public.workroom_tasks(owner_id, status, priority desc, updated_at asc);
create index if not exists workroom_events_task_created_idx on public.workroom_events(task_id, created_at asc);
create index if not exists workroom_evidence_task_created_idx on public.workroom_evidence(task_id, created_at asc);
alter table public.workroom_tasks enable row level security;
alter table public.workroom_events enable row level security;
alter table public.workroom_evidence enable row level security;
create policy workroom_tasks_owner on public.workroom_tasks for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy workroom_events_owner on public.workroom_events for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy workroom_evidence_owner on public.workroom_evidence for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
