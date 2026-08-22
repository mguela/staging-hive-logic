-- 001_tasks_core.sql
-- HiveConnect Tasks -- Phase 1 core schema
-- Target: HiveConnect Supabase project (ref mzyngawgpxzpsxphswmc) -- NOT hivelogic-live's project.
-- Branch: feature/tasks-v1 (cut from feature/embed-hiveconnect)
--
-- STATUS: DRAFT -- pending Chris approval. Do not run in Supabase SQL Editor
-- until sign-off. Additive only (creates new tables), safe to run once approved.
--
-- Depends on existing HiveConnect tables: profiles (internal team members),
-- channels (also doubles as "team" for owner_type='team'), contacts (external
-- vendors/subs/clients), messages (source links for Create-Task-from-message).
--
-- Rollback (children before parent): task_status_history, task_source_links,
-- task_roles, then tasks.

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,

  status text not null default 'not_started' check (status in (
    'draft','unassigned','not_started','in_progress','waiting','blocked',
    'submitted_for_review','revision_required','approved','completed','cancelled'
  )),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),

  owner_type text not null check (owner_type in ('employee','team','vendor','sub','client')),
  owner_profile_id uuid references profiles(id),
  owner_channel_id uuid references channels(id),
  owner_contact_id uuid references contacts(id),
  internal_accountability_owner_id uuid references profiles(id),

  check (
    (owner_type = 'employee' and owner_profile_id is not null and owner_channel_id is null and owner_contact_id is null) or
    (owner_type = 'team' and owner_channel_id is not null and owner_profile_id is null and owner_contact_id is null) or
    (owner_type in ('vendor','sub','client') and owner_contact_id is not null and owner_profile_id is null and owner_channel_id is null)
  ),
  check (owner_type not in ('vendor','sub') or internal_accountability_owner_id is not null),

  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  start_date date,
  deliverable_date date,
  completion_date timestamptz,
  percent_complete int not null default 0 check (percent_complete between 0 and 100),

  job_ref text,
  client_ref text,

  waiting_reason text check (waiting_reason in (
    'client','vendor','material','payment','permit','inspection',
    'internal_approval','information','schedule'
  )),
  blocked_reason text,
  blocked_blocking_party text,
  blocked_date date,
  blocked_followup_date date,
  blocked_escalation_owner_id uuid references profiles(id)
);

create index if not exists tasks_status_idx on tasks(status);
create index if not exists tasks_owner_profile_idx on tasks(owner_profile_id);
create index if not exists tasks_deliverable_date_idx on tasks(deliverable_date);
create index if not exists tasks_job_ref_idx on tasks(job_ref);
create index if not exists tasks_client_ref_idx on tasks(client_ref);

create table if not exists task_roles (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  role text not null check (role in ('collaborator','reviewer','approver','observer','notify','escalation_owner')),
  profile_id uuid references profiles(id),
  contact_id uuid references contacts(id),
  created_at timestamptz not null default now(),
  check ((profile_id is not null) <> (contact_id is not null))
);
create index if not exists task_roles_task_idx on task_roles(task_id);
create index if not exists task_roles_profile_idx on task_roles(profile_id);

create table if not exists task_source_links (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  source_type text not null check (source_type in ('email','message','channel_post','thread_reply')),
  source_message_id uuid references messages(id),
  source_channel_id uuid references channels(id),
  external_ref text,
  snapshot_subject text,
  snapshot_sender text,
  snapshot_preview text,
  created_at timestamptz not null default now()
);
create index if not exists task_source_links_task_idx on task_source_links(task_id);

create table if not exists task_status_history (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  from_status text,
  to_status text not null,
  changed_by uuid references profiles(id),
  changed_at timestamptz not null default now(),
  note text
);
create index if not exists task_status_history_task_idx on task_status_history(task_id);

alter table tasks enable row level security;
alter table task_roles enable row level security;
alter table task_source_links enable row level security;
alter table task_status_history enable row level security;

create policy "team members full access" on tasks for all
  using (auth.uid() is not null) with check (auth.uid() is not null);
create policy "team members full access" on task_roles for all
  using (auth.uid() is not null) with check (auth.uid() is not null);
create policy "team members full access" on task_source_links for all
  using (auth.uid() is not null) with check (auth.uid() is not null);
create policy "team members full access" on task_status_history for all
  using (auth.uid() is not null) with check (auth.uid() is not null);
