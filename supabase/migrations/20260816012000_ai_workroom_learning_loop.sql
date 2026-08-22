-- Expand the Workroom to include the full council and durable Reina lessons.
alter table public.ai_workroom_messages drop constraint if exists ai_workroom_messages_author_type_check;
alter table public.ai_workroom_messages add constraint ai_workroom_messages_author_type_check check (author_type in ('user', 'codex', 'chatgpt', 'claude', 'grok', 'reina', 'system'));
alter table public.ai_workroom_sources drop constraint if exists ai_workroom_sources_source_check;
alter table public.ai_workroom_sources add constraint ai_workroom_sources_source_check check (source in ('codex', 'chatgpt', 'claude', 'claude_code', 'grok', 'reina', 'github', 'manager_self_test'));

create table if not exists public.ai_workroom_lessons (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 180),
  lesson text not null check (char_length(lesson) between 1 and 5000),
  product_area text,
  intended_purpose text,
  observed_behavior text,
  value_assessment text check (value_assessment is null or value_assessment in ('valuable', 'needs_improvement', 'not_useful', 'unknown')),
  confidence integer not null check (confidence between 0 and 100),
  status text not null default 'hypothesis' check (status in ('hypothesis', 'active', 'retired')),
  applies_to text,
  evidence_count integer not null default 0 check (evidence_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_workroom_lessons_owner_updated_idx on public.ai_workroom_lessons(owner_id, updated_at desc);
alter table public.ai_workroom_lessons enable row level security;
create policy ai_workroom_lessons_owner on public.ai_workroom_lessons for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
