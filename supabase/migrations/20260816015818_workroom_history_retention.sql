-- Preserve external AI conversation history without duplicates and keep a
-- durable per-conversation cursor so interrupted imports can resume.
alter table public.ai_workroom_messages
  add column if not exists source text,
  add column if not exists source_conversation_id text,
  add column if not exists source_message_id text;

alter table public.ai_workroom_messages
  drop constraint if exists ai_workroom_messages_author_type_check;
alter table public.ai_workroom_messages
  add constraint ai_workroom_messages_author_type_check
  check (author_type in ('user', 'codex', 'chatgpt', 'claude', 'claude_code', 'grok', 'reina', 'system'));

alter table public.ai_workroom_messages
  drop constraint if exists ai_workroom_messages_source_check;
alter table public.ai_workroom_messages
  add constraint ai_workroom_messages_source_check
  check (source is null or source in ('codex', 'chatgpt', 'claude', 'claude_code', 'grok', 'reina', 'github', 'manager_self_test'));

alter table public.ai_workroom_messages
  drop constraint if exists ai_workroom_messages_source_identity_key;
alter table public.ai_workroom_messages
  add constraint ai_workroom_messages_source_identity_key
  unique (thread_id, source, source_message_id);

create index if not exists ai_workroom_messages_source_conversation_idx
  on public.ai_workroom_messages (source, source_conversation_id, created_at asc);

create table if not exists public.ai_workroom_import_checkpoints (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.ai_workroom_threads(id) on delete cascade,
  source text not null check (source in ('codex', 'chatgpt', 'claude', 'claude_code', 'grok', 'reina', 'github', 'manager_self_test')),
  source_conversation_id text not null,
  cursor text,
  imported_count bigint not null default 0 check (imported_count >= 0),
  history_started_at timestamptz,
  history_ended_at timestamptz,
  last_synced_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, source, source_conversation_id)
);

create index if not exists ai_workroom_import_checkpoints_owner_synced_idx
  on public.ai_workroom_import_checkpoints (owner_id, last_synced_at desc);

alter table public.ai_workroom_import_checkpoints enable row level security;
revoke all on table public.ai_workroom_import_checkpoints from anon, authenticated;
grant select, insert, update, delete on table public.ai_workroom_import_checkpoints to service_role;

drop policy if exists ai_workroom_import_checkpoints_owner on public.ai_workroom_import_checkpoints;
create policy ai_workroom_import_checkpoints_owner
  on public.ai_workroom_import_checkpoints
  for all
  to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
