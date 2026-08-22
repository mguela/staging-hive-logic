-- Captured verbatim from prod supabase_migrations.schema_migrations (version 20260814223052).
-- HiveLogic-native scheduling (mirror-only preserved: NOTHING here touches Jobber).
-- Additive: three new tables. Server writes via service role; RLS on with no public policies.

create table if not exists public.hl_appointments (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'field',
  title text,
  client text,
  crew_jids jsonb not null default '[]'::jsonb,   -- assigned employee jobber ids
  lead_jid text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  division text,
  job_no text,
  lat numeric,
  lng numeric,
  details jsonb not null default '{}'::jsonb,      -- type-specific intake fields
  status text not null default 'scheduled',
  canceled boolean not null default false,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists hl_appointments_start_idx on public.hl_appointments (start_at);

create table if not exists public.hl_clock (
  id uuid primary key default gen_random_uuid(),
  employee_jid text not null,
  target_kind text not null default 'jobber_visit',  -- 'jobber_visit' | 'hl_appointment'
  target_id text,                                     -- visit jobber id or hl_appointment id
  label text,
  clock_in timestamptz not null default now(),
  clock_out timestamptz,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists hl_clock_emp_open_idx on public.hl_clock (employee_jid) where clock_out is null;

create table if not exists public.hl_crew_overrides (
  id uuid primary key default gen_random_uuid(),
  visit_jid text not null unique,                    -- the Jobber visit being re-crewed
  add_jids jsonb not null default '[]'::jsonb,       -- employees chained on in HiveLogic
  remove_jids jsonb not null default '[]'::jsonb,    -- employees peeled off in HiveLogic
  updated_by text,
  updated_at timestamptz not null default now()
);

alter table public.hl_appointments enable row level security;
alter table public.hl_clock enable row level security;
alter table public.hl_crew_overrides enable row level security;
-- No policies: only the service-role (server endpoints) can read/write. Direct client access blocked.
