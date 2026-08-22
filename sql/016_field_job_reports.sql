-- 016_field_job_reports.sql
--
-- End-of-JOB reports for the Field App (replaces the old day-level End of
-- Day form — Chris 2026-07-21: "EOD report should be on the clock of each
-- job, not clock out for the day" + "End of job report that allows clock
-- out"). A tech can't clock out until each of today's jobs has one.
--
-- Two report types, questions dictated by Chris verbatim:
--   service    (Repair/Service/T&M): work completed? varied from assigned?
--              client requested additional work? materials used? return
--              visit needed? notified client + requested review?
--   renovation: site cleaned? job closed up? need materials for tomorrow?
--              scope changed?
-- Answers live in the `answers` jsonb column, keyed per question.
--
-- ADDITIVE ONLY. Safe to run more than once (also safe if an earlier
-- version of this table was already created — the ALTERs below add the
-- newer columns).

create table if not exists field_job_reports (
  id uuid primary key default gen_random_uuid(),
  tech_id uuid not null,        -- profiles.id
  tech_name text,
  job_ref text,                 -- jobs.jobber_id
  visit_ref text,               -- visits.jobber_id
  client_ref text,              -- clients.jobber_id
  job_title text,
  report_type text,             -- 'service' | 'renovation'
  answers jsonb,                -- per-question answers (see header)
  tasks_completed text,         -- optional free-text "anything else" notes
  issues text,
  hours numeric,
  created_at timestamptz not null default now()
);
alter table field_job_reports add column if not exists report_type text;
alter table field_job_reports add column if not exists answers jsonb;
create index if not exists field_job_reports_tech_idx on field_job_reports (tech_id, created_at);
create index if not exists field_job_reports_job_idx on field_job_reports (job_ref);
