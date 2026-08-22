-- Consolidate the useful AI Workroom organization features into the existing
-- governed Boardroom. The old Workroom tables remain intact as a read-only
-- archive so no conversation history is destroyed.

create table if not exists public.boardroom_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  repository text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name)
);

alter table public.reina_council_runs
  add column if not exists project_id uuid references public.boardroom_projects(id) on delete set null,
  add column if not exists pinned boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists reina_council_runs_owner_pinned_idx
  on public.reina_council_runs (owner_id, pinned, created_at desc);
create index if not exists reina_council_runs_owner_project_idx
  on public.reina_council_runs (owner_id, project_id, created_at desc);

-- Preserve project organization already created in AI Workroom. IDs are kept
-- stable so future archive tooling can map the old threads without guessing.
insert into public.boardroom_projects (id, owner_id, name, repository, created_at, updated_at)
select id, owner_id, name, repository, created_at, updated_at
from public.ai_workroom_projects
on conflict (id) do nothing;

alter table public.boardroom_projects enable row level security;
drop policy if exists boardroom_projects_owner on public.boardroom_projects;
create policy boardroom_projects_owner on public.boardroom_projects
  for all
  to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

revoke all on table public.boardroom_projects from anon, authenticated;
grant all on table public.boardroom_projects to service_role;

comment on table public.boardroom_projects is
  'Owner-scoped organization for governed Boardroom decisions. Managed server-side.';
