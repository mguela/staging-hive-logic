-- sql/052_marketing_maintenance_reminders_type.sql
-- Phase 14 lifecycle playbook: maintenance_reminders (Chris, 2026-08-01).
--
-- Additive migration on top of sql/021_campaigns.sql (original check) plus the
-- Phase 14 additions built up this session: sql/047 (post_job_thank_you),
-- sql/048 (service_anniversary), sql/049 (new_lead_followup), sql/050
-- (dormant_reactivation), sql/051 (newsletter). This adds
-- 'maintenance_reminders' to the campaigns.type CHECK constraint so the
-- maintenance-reminder lifecycle playbook can record its sends as real
-- campaigns/campaign_recipients rows.
--
-- Historical note: written on branch
-- marketing-suite-phase14-maintenance-reminders, forked fresh off origin/main
-- at a time when sql/047-051 lived on unmerged sibling branches. This file
-- therefore lists the full accumulated type set so that whichever order the
-- sibling branches were reconciled in, the final constraint ended up correct.
-- Those branches have since landed on main. See
-- reina/branch-reconciliation-plan-2026-08-01.md.
--
-- STATUS: APPLIED to production (project sqhusuuhlmcmkeowdrga), confirmed
-- 2026-08-15 by reading pg_constraint -- the live campaigns_type_check already
-- contains all 12 types below, so all 7 Phase 14 lifecycle playbooks are
-- unblocked. Re-running this file is a no-op that briefly drops and re-adds an
-- identical constraint; there is no reason to do so.
--
-- (This header previously read "NOT applied to production -- do not run this
-- against Supabase." That was accurate only while the file sat on an unmerged
-- branch, and is superseded by the STATUS line above.)

alter table campaigns drop constraint if exists campaigns_type_check;

alter table campaigns add constraint campaigns_type_check check (
  type in (
    'estimate_recovery',
    'review_request',
    'reactivation',
    'referral',
    'seasonal',
    'custom',
    'post_job_thank_you',
    'service_anniversary',
    'new_lead_followup',
    'dormant_reactivation',
    'newsletter',
    'maintenance_reminders'
  )
);
