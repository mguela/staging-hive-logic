-- 017_field_job_activity.sql
--
-- Field App active-job flow (Chris's mockup spec, 2026-07-21):
--   - job_time_entries: every block of tracked time, per tech, per job.
--     kind: travel | supplies | onsite | lunch | break. "Picking Up
--     Supplies" tracks time against the job with NO client notification;
--     "onsite" powers the job timer / allotted-time meter. Starting a new
--     entry always closes the tech's previous open one (enforced in
--     api/fieldops.js), so a tech has at most one running clock.
--   - field_requests: everything a tech fires at the office from the job
--     screen — need more time, materials/equipment requests, client-
--     requested extra work, office messages, client messages (also
--     delivered into the Client Portal thread), and stop-job status.
--     payload is jsonb, shaped per kind.
--
-- ADDITIVE ONLY. Safe to run more than once.

create table if not exists job_time_entries (
  id uuid primary key default gen_random_uuid(),
  tech_id uuid not null,          -- profiles.id
  tech_name text,
  job_ref text,                   -- jobs.jobber_id
  visit_ref text,                 -- visits.jobber_id
  client_ref text,                -- clients.jobber_id
  kind text not null,             -- travel | supplies | onsite | lunch | break
  whole_team boolean not null default false,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists job_time_entries_tech_open_idx on job_time_entries (tech_id, ended_at);
create index if not exists job_time_entries_visit_idx on job_time_entries (visit_ref);
create index if not exists job_time_entries_job_idx on job_time_entries (job_ref, started_at);

create table if not exists field_requests (
  id uuid primary key default gen_random_uuid(),
  tech_id uuid not null,
  tech_name text,
  job_ref text,
  visit_ref text,
  client_ref text,
  kind text not null,             -- more_time | materials | extra_work | office_msg | client_msg | job_status | note
  payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists field_requests_kind_idx on field_requests (kind, created_at);
create index if not exists field_requests_job_idx on field_requests (job_ref);
