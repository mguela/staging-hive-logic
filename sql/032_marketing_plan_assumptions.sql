-- sql/032_marketing_plan_assumptions.sql
-- Marketing Suite Phase 2 (ST-01/ST-02/ST-04: real Opportunity Engine forecast) --
-- Stores the owner's own planning assumptions (Figure 2's "Interactive Budget
-- Planner" inputs) so the Command Center's Plan screen can turn a budget into
-- a real conservative/expected/upside lead range instead of a permanent "not
-- yet" placeholder. ADDITIVE ONLY.
--
-- Scope discipline: none of gross margin, qualified-lead rate, or close rate
-- are computable from real data today (job costing has no margin fields yet;
-- there is no marketing-attributed lead/conversion history at all -- 0 rows
-- in lead_pipeline and review_requests). Per the spec's own note under
-- Figure 2, these are owner-supplied planning inputs, not something the
-- system should estimate on its own. avg_job_value_cents is optional here
-- because a real default already exists (live average of priced jobs synced
-- from Jobber) -- this column only overrides that real default if the owner
-- wants to plan around a different number.
create table if not exists marketing_plan_assumptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null unique default 'ghgrp',
  gross_margin_pct numeric(5,2) check (gross_margin_pct is null or (gross_margin_pct >= 0 and gross_margin_pct <= 100)),
  qualified_lead_rate_per_100 numeric(8,2) check (qualified_lead_rate_per_100 is null or qualified_lead_rate_per_100 >= 0),
  close_rate_pct numeric(5,2) check (close_rate_pct is null or (close_rate_pct >= 0 and close_rate_pct <= 100)),
  max_new_jobs_per_month integer check (max_new_jobs_per_month is null or max_new_jobs_per_month >= 0),
  avg_job_value_cents integer check (avg_job_value_cents is null or avg_job_value_cents >= 0),
  risk_posture text not null default 'balanced' check (risk_posture in ('conservative','balanced','aggressive')),
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table marketing_plan_assumptions enable row level security;

create policy "service role full access marketing_plan_assumptions"
  on marketing_plan_assumptions
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
