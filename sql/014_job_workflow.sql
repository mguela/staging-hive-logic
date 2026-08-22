-- 014_job_workflow.sql
--
-- Job Workflow — real tracking for the pre-production steps the Jobs board
-- always claimed to show (deposit paid, job setup complete, materials
-- ordered/on site, on hold) but never actually had data for. Jobber's own
-- sync only gives us 7 statuses (unscheduled/upcoming/today/late/
-- action_required/requires_invoicing/archived) -- none of which are
-- "awaiting deposit" or "waiting on materials". This table is the missing
-- piece: one row per job, staff-updated, that the API combines with the
-- REAL Jobber status to bucket a job into a board column. No score or
-- stage is ever guessed -- every bucket is a deterministic function of
-- either a real synced field or a value staff explicitly set here.
--
-- job_ref is TEXT (jobs.jobber_id), no formal FK -- same loose-coupling
-- reasoning as client_ref elsewhere in this schema (012/013): the jobs
-- table is owned by the Jobber sync job and can be re-upserted independently.
--
-- ADDITIVE ONLY. Safe to run more than once (IF NOT EXISTS guards
-- throughout). Run once in the Supabase SQL editor, same as 002-013.

create table if not exists job_workflow (
  id uuid primary key default gen_random_uuid(),
  job_ref text not null unique,          -- jobs.jobber_id

  deposit_required numeric,              -- expected deposit amount (manual)
  deposit_paid_at timestamptz,           -- null = not yet paid
  deposit_amount numeric,                -- actual amount recorded paid

  setup_complete_at timestamptz,         -- null = job setup not done yet

  materials_status text not null default 'not_ordered',  -- not_ordered | ordered | on_site
  materials_eta date,

  on_hold_at timestamptz,                -- null = not on hold; overrides board bucket when set
  on_hold_reason text,

  notes text,
  updated_by text,                       -- staff email/name who last changed this row
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists job_workflow_job_ref_idx on job_workflow(job_ref);
create index if not exists job_workflow_on_hold_idx on job_workflow(on_hold_at);
