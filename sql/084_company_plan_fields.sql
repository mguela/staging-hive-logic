-- sql/084_company_plan_fields.sql
--
-- Phase 3 groundwork — plan/subscription state on companies, so the app can
-- report entitlements (which modules a plan includes, seat caps, trial status).
--
-- REPORT-ONLY for now: nothing enforces these yet. Additive columns only.
-- `plan` already exists (the founding company is 'primary' = unlimited).

begin;

alter table public.companies add column if not exists plan_status  text not null default 'active';  -- active | trialing | past_due | canceled
alter table public.companies add column if not exists trial_ends_at timestamptz;
alter table public.companies add column if not exists seats         integer;  -- purchased seat count; null = plan default / unlimited

commit;
