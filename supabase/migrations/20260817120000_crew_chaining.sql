-- Crew chaining: chain secondary techs to a lead, group clock the whole crew,
-- and let a tech unchain themselves from a job (which asks dispatch to rechain).
--
-- Two jobs in one file:
--   1. Capture hl_appointments / hl_clock / hl_crew_overrides. These were created
--      directly on prod by the 2026-08-14 native write path and never landed in a
--      migration, so a fresh install had no scheduling write path at all. The
--      create-if-not-exists blocks below reproduce prod exactly (verified against
--      information_schema on sqhusuuhlmcmkeowdrga) and are inert on prod itself.
--   2. Add the columns crew chaining needs on top.
--
-- Tenancy follows the rest of the hl_* surface: RLS on with no policies, because
-- every reader goes through the service key in api/schedule/hl.js.

-- ---------------------------------------------------------------- 1. capture
create table if not exists public.hl_appointments (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'field',
  title text,
  client text,
  crew_jids jsonb not null default '[]'::jsonb,
  lead_jid text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  division text,
  job_no text,
  lat numeric,
  lng numeric,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'scheduled',
  canceled boolean not null default false,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.hl_clock (
  id uuid primary key default gen_random_uuid(),
  employee_jid text not null,
  target_kind text not null default 'jobber_visit',
  target_id text,
  label text,
  clock_in timestamptz not null default now(),
  clock_out timestamptz,
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists public.hl_crew_overrides (
  id uuid primary key default gen_random_uuid(),
  visit_jid text not null unique,
  add_jids jsonb not null default '[]'::jsonb,
  remove_jids jsonb not null default '[]'::jsonb,
  updated_by text,
  updated_at timestamptz not null default now()
);

alter table public.hl_appointments enable row level security;
alter table public.hl_clock enable row level security;
alter table public.hl_crew_overrides enable row level security;

-- ------------------------------------------------------- 2. crew chaining
-- Lead is a property of the PERSON, set once in user setup -- not per job.
alter table public.employee_roles
  add column if not exists is_lead boolean not null default false;

-- Seed it from the convention the crew_label column already encodes: the roster
-- reads "Team 3" for the lead and "Team 3 helper" for the person riding with them
-- ("helper" is the word the crew actually uses). Anyone on a field lens with a
-- crew label that is NOT a helper starts as a lead; a solo person is trivially
-- the lead of their own job, so this is safe to over-apply. Dispatch can correct
-- any of it in user setup afterwards -- this only sets the starting point, and
-- only for rows that are still at the default.
update public.employee_roles
set is_lead = true
where lens in ('crew', 'sub')
  and crew_label is not null
  and crew_label !~* 'helper'
  and is_lead = false;

-- ...but when two leads land on the same job, dispatch elects one of them for
-- that job only. Null = fall back to the person-level is_lead flag.
alter table public.hl_crew_overrides
  add column if not exists lead_jid text;

-- Group clock-in writes one row per crew member (payroll needs a record per
-- person). These columns record how that row was created and whether the
-- person was actually where they claimed to be.
--   source        'board' (dispatch) | 'field' (a lead's phone)
--   chained_to    the lead whose tap produced this row; null = clocked in alone
--   lat/lng       the DEVICE position of whoever tapped, at tap time
--   proximity_m   metres between this person's last known position and the lead,
--                 or NULL when we could not place one of them at all
--   proximity_flag true ONLY when we measured a real distance and it was too far.
--                 Unverifiable (null proximity_m) is never a flag -- a helper
--                 riding in the lead's truck has no GPS of their own.
alter table public.hl_clock
  add column if not exists source text not null default 'board',
  add column if not exists chained_to text,
  add column if not exists lat numeric,
  add column if not exists lng numeric,
  add column if not exists proximity_m numeric,
  add column if not exists proximity_flag boolean not null default false;

-- The open-session lookup (clock_out is null) runs on every board load.
create index if not exists hl_clock_open_idx
  on public.hl_clock (employee_jid) where clock_out is null;

-- A tech can unchain themselves from a JOB (never from the crew). Doing so
-- files this request so dispatch can put them back on, or place them elsewhere.
create table if not exists public.hl_rechain_requests (
  id uuid primary key default gen_random_uuid(),
  target_kind text not null default 'jobber_visit',
  target_id text not null,
  employee_jid text not null,
  lead_jid text,
  reason text,
  status text not null default 'open',
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.hl_rechain_requests enable row level security;

-- Dispatch's queue only ever asks for the open ones.
create index if not exists hl_rechain_requests_open_idx
  on public.hl_rechain_requests (created_at desc) where status = 'open';
