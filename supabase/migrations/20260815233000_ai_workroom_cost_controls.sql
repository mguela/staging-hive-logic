-- Cost governance is append-only: every model action is attributable to a task,
-- a provider/model, a token count, and an approved budget policy.
create table if not exists public.ai_workroom_budget_policies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.ai_workroom_projects(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  default_model_tier text not null default 'economy' check (default_model_tier in ('economy', 'standard', 'expert')),
  daily_limit_cents integer not null check (daily_limit_cents >= 0),
  task_limit_cents integer not null check (task_limit_cents >= 0),
  escalation_limit_cents integer not null check (escalation_limit_cents >= 0),
  require_human_over_limit boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, project_id, name)
);

create table if not exists public.ai_workroom_model_usage (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid references public.ai_workroom_threads(id) on delete set null,
  policy_id uuid references public.ai_workroom_budget_policies(id) on delete set null,
  actor text not null check (actor in ('codex', 'chatgpt', 'claude', 'claude_code', 'system')),
  provider text not null,
  model text not null,
  model_tier text not null check (model_tier in ('economy', 'standard', 'expert')),
  purpose text not null check (char_length(purpose) between 1 and 240),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  estimated_cost_cents integer not null default 0 check (estimated_cost_cents >= 0),
  outcome text check (outcome is null or outcome in ('accepted', 'rejected', 'escalated', 'failed')),
  created_at timestamptz not null default now()
);

create index if not exists ai_workroom_usage_owner_created_idx on public.ai_workroom_model_usage (owner_id, created_at desc);
create index if not exists ai_workroom_usage_policy_created_idx on public.ai_workroom_model_usage (policy_id, created_at desc);
alter table public.ai_workroom_budget_policies enable row level security;
alter table public.ai_workroom_model_usage enable row level security;
drop policy if exists ai_workroom_budget_policies_owner on public.ai_workroom_budget_policies;
create policy ai_workroom_budget_policies_owner on public.ai_workroom_budget_policies for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
drop policy if exists ai_workroom_model_usage_owner on public.ai_workroom_model_usage;
create policy ai_workroom_model_usage_owner on public.ai_workroom_model_usage for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
