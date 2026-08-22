-- sql/051_marketing_newsletter_type.sql
-- Phase 14 lifecycle playbook: newsletter (Chris, 2026-08-01).
--
-- Additive migration on top of sql/021_campaigns.sql (original check) plus the
-- Phase 14 additions built up this session: sql/047 (post_job_thank_you),
-- sql/048 (service_anniversary), sql/049 (new_lead_followup), sql/050
-- (dormant_reactivation). This adds 'newsletter' to the campaigns.type
-- CHECK constraint so the newsletter lifecycle playbook can record its sends
-- as real campaigns/campaign_recipients rows.
--
-- Written on this branch (marketing-suite-phase14-newsletter), forked fresh
-- off origin/main -- sql/047-050 do not exist on this branch's history since
-- they live on their own sibling branches, not yet merged to main. This file
-- lists the full accumulated type set so that whichever order the sibling
-- branches are eventually reconciled in, the final constraint ends up
-- correct. See reina/branch-reconciliation-plan-2026-08-01.md.
--
-- NOT applied to production. Write only -- do not run this against Supabase.

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
    'newsletter'
  )
);
