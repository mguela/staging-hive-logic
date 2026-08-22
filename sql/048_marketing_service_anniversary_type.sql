-- sql/048_marketing_service_anniversary_type.sql
-- Phase 14 (Lifecycle marketing playbooks) -- second playbook type.
-- ADDITIVE ONLY: widens the existing campaigns.type CHECK constraint to
-- also allow 'service_anniversary', so a real campaign row can eventually be
-- created for the service-anniversary playbook (api/marketing.js's
-- resource=lifecycle_candidates GET endpoint reads this same real column,
-- via `fetchAllRows('campaigns', '?select=id&type=eq.service_anniversary')`,
-- to detect jobs already contacted for their anniversary -- until this
-- migration is applied that query always returns zero rows, which is an
-- honest state, not a bug).
--
-- This migration is written on top of sql/047_marketing_lifecycle_playbook_types.sql
-- (which added 'post_job_thank_you'). Both are additive and independent; apply
-- in either order, or combine into one statement when the two Phase 14
-- sibling branches are reconciled.
--
-- NOT APPLIED to production. Write-only per this project's standing rule:
-- never run a migration against production Supabase autonomously. Chris
-- applies this when ready.
--
-- The constraint below assumes Postgres's default auto-generated name for
-- an inline, unnamed CHECK on campaigns.type (`campaigns_type_check`), set
-- when sql/021_campaigns.sql first created the table. Verify the real name
-- first if this errors:
--   select conname from pg_constraint
--   where conrelid = 'campaigns'::regclass and contype = 'c';

alter table campaigns drop constraint if exists campaigns_type_check;
alter table campaigns add constraint campaigns_type_check
  check (type in (
    'estimate_recovery','review_request','reactivation','referral','seasonal','custom',
    'post_job_thank_you','service_anniversary'
  ));
