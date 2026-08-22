-- sql/050_marketing_dormant_reactivation_type.sql
-- Phase 14 (Lifecycle marketing playbooks) -- dormant reactivation playbook.
-- ADDITIVE ONLY: widens the existing campaigns.type CHECK constraint to
-- also allow 'dormant_reactivation', so a real campaign row can eventually
-- be created for this playbook (api/marketing.js's resource=lifecycle_candidates
-- GET endpoint reads this same real column, via
-- `fetchAllRows('campaigns', '?select=id&type=eq.dormant_reactivation')`, to
-- detect clients already contacted for this playbook -- until this migration
-- is applied that query always returns zero rows, which is an honest state,
-- not a bug).
--
-- This is a DIFFERENT type from the existing 'reactivation' value already in
-- the CHECK constraint (used by the Opportunity Engine's reactivate_customers
-- card, a 6-24 month lapsed window). This playbook targets a much longer
-- dormancy window (24-60 months) and needs its own type so the two campaigns
-- never share a dedup trail and a client isn't silently treated as "already
-- contacted" by the wrong playbook.
--
-- This migration is written on top of sql/047 (added 'post_job_thank_you'),
-- sql/048 (added 'service_anniversary'), and sql/049 (added
-- 'new_lead_followup'). All four are additive and independent; apply in any
-- order, or combine into one statement when the Phase 14 sibling branches
-- are reconciled.
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
    'post_job_thank_you','service_anniversary','new_lead_followup','dormant_reactivation'
  ));
