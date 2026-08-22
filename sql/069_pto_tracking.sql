-- sql/069_pto_tracking.sql
--
-- Real PTO tracking (2026-08-11), replacing the fully-mock "PTO Tracking"
-- page and the disconnected Employee Portal PTO request mockup -- neither
-- had any backend or database concept of PTO before this, and the
-- approve/decline buttons fabricated success toasts ("Day board updated,
-- Steve notified") with zero real effect.
--
-- Deliberately a simple yearly-allowance model (admin sets e.g. "15 days
-- for 2026" per employee, approved requests deduct from it) rather than
-- real accrual-from-payroll math -- the mock UI's own copy already admitted
-- "Gusto sync planned, not built yet," so this doesn't invent monthly-
-- accrual precision the app has no real payroll data to back up. Real
-- accrual can replace this later if Gusto ever gets connected.

create table if not exists public.pto_requests (
  id uuid primary key default gen_random_uuid(),
  employee_jobber_id text not null,
  employee_name text,
  start_date date not null,
  end_date date not null,
  request_type text not null default 'vacation' check (request_type in ('vacation','personal','sick')),
  status text not null default 'pending' check (status in ('pending','approved','declined')),
  note text,
  requested_by_email text,
  requested_at timestamptz not null default now(),
  decided_by_email text,
  decided_at timestamptz,
  decision_note text,
  constraint pto_requests_date_order check (end_date >= start_date)
);
create index if not exists pto_requests_employee_idx on public.pto_requests(employee_jobber_id);
create index if not exists pto_requests_status_idx on public.pto_requests(status);

create table if not exists public.pto_allowances (
  employee_jobber_id text not null,
  year integer not null,
  allowance_days numeric not null default 0,
  updated_at timestamptz not null default now(),
  updated_by_email text,
  primary key (employee_jobber_id, year)
);

alter table public.pto_requests enable row level security;
alter table public.pto_allowances enable row level security;
-- No permissive policies -- only the service-role key (server-side only,
-- via api/track1.js's pto_* resources) can read/write. All real auth
-- (signed-in check, owner-only approve/decline/allowance-set) happens in
-- the API layer, same as every other table in this app.
