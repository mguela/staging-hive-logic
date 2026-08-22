-- Link a scheduled appointment to the job it is for (Phase 0, item 4) — 2026-08-17
--
-- hl_appointments already existed and already worked: the crew board creates,
-- moves and renders native appointments, and none of it touches Jobber. What it
-- could not do was say WHICH JOB an appointment was for. `job_no` is free text
-- a dispatcher types ("2418"), so nothing connects a scheduled visit back to a
-- job record — which means a HiveLogic job could be put on the board but the
-- board couldn't show its project number, and job costing had nothing to
-- attribute the visit to.
--
-- job_ref holds jobs.jobber_id, matching how visits.job_id already references
-- the same column. Deliberately NOT a foreign key, for the same reason
-- visits.job_id isn't one: appointments are also created for work with no job
-- at all (shop days, callbacks, estimates-in-person), and Jobber-synced jobs
-- come and go with the sync.
--
-- job_no is kept and still carries the human-readable number, so the board's
-- existing display path is unchanged — it just gets 'J-10001' instead of
-- whatever someone typed.

alter table public.hl_appointments add column if not exists job_ref text;

comment on column public.hl_appointments.job_ref is
  'jobs.jobber_id of the job this appointment is for, when there is one. job_no carries the same job''s display number (J-10001). Null for work with no job: shop days, callbacks, in-person estimates.';

create index if not exists idx_hl_appointments_job_ref
  on public.hl_appointments (job_ref)
  where job_ref is not null;
