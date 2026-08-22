-- Durable, staff-only workspace for coordinating human and AI implementation work.
create table if not exists public.ai_workroom_threads (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 140),
  status text not null default 'active' check (status in ('active', 'waiting', 'done', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_workroom_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.ai_workroom_threads(id) on delete cascade,
  author_type text not null check (author_type in ('user', 'codex', 'claude', 'system')),
  author_name text not null,
  body text not null check (char_length(body) between 1 and 8000),
  kind text not null default 'message' check (kind in ('message', 'task', 'status', 'decision', 'evidence')),
  task_state text check (task_state is null or task_state in ('queued', 'claimed', 'working', 'blocked', 'done', 'cancelled')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.ai_workroom_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  repository text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_workroom_sources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('codex', 'chatgpt', 'claude', 'claude_code', 'github', 'manager_self_test')),
  status text not null default 'not_connected' check (status in ('not_connected', 'connected', 'syncing', 'error')),
  last_synced_at timestamptz,
  details jsonb not null default '{}'::jsonb,
  unique(owner_id, source)
);

alter table public.ai_workroom_threads add column if not exists project_id uuid references public.ai_workroom_projects(id) on delete set null;
alter table public.ai_workroom_threads add column if not exists pinned boolean not null default false;

create index if not exists ai_workroom_threads_owner_updated_idx on public.ai_workroom_threads (owner_id, updated_at desc);
create index if not exists ai_workroom_messages_thread_created_idx on public.ai_workroom_messages (thread_id, created_at asc);
create index if not exists ai_workroom_threads_owner_pinned_idx on public.ai_workroom_threads (owner_id, pinned, updated_at desc);
alter table public.ai_workroom_threads enable row level security;
alter table public.ai_workroom_messages enable row level security;
alter table public.ai_workroom_projects enable row level security;
alter table public.ai_workroom_sources enable row level security;
drop policy if exists ai_workroom_threads_owner on public.ai_workroom_threads;
create policy ai_workroom_threads_owner on public.ai_workroom_threads for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
drop policy if exists ai_workroom_messages_owner on public.ai_workroom_messages;
create policy ai_workroom_messages_owner on public.ai_workroom_messages for all using (exists (select 1 from public.ai_workroom_threads t where t.id = thread_id and t.owner_id = auth.uid())) with check (exists (select 1 from public.ai_workroom_threads t where t.id = thread_id and t.owner_id = auth.uid()));
drop policy if exists ai_workroom_projects_owner on public.ai_workroom_projects;
create policy ai_workroom_projects_owner on public.ai_workroom_projects for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
drop policy if exists ai_workroom_sources_owner on public.ai_workroom_sources;
create policy ai_workroom_sources_owner on public.ai_workroom_sources for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
