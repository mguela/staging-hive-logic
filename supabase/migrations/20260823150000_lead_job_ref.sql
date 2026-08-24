-- The lead a job came from, and the job a lead became.
--
-- Chris, 2026-08-23, walking the workflow: NEW LEAD > T&M JOB > SCHEDULE >
-- TECHS COMPLETE > INVOICE > PAYMENT. Every link in that chain existed except
-- the first one. A lead could become an ESTIMATE (rlmStartEstimate, which
-- writes lead_pipeline.estimate_id) but never a job, so the T&M half of the
-- business -- the half that skips the estimate entirely -- had no way out of
-- the pipeline at all. The lead just sat there while someone typed the job in
-- again from scratch.
--
-- One nullable text column, matching estimate_id beside it: the jobber_id of
-- the job this opportunity turned into. Additive and reversible; nothing reads
-- it until the button that writes it ships.
alter table lead_pipeline add column if not exists job_ref text;

comment on column lead_pipeline.job_ref is
  'jobs.jobber_id of the job this lead became. Set when a lead is converted straight to work (T&M), the way estimate_id is set when it becomes an estimate.';
