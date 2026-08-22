-- sql/044_lead_pipeline_referred_by.sql
-- Closes a gap flagged directly in api/marketing.js's own comments: the
-- referral_opportunities campaign type has been hard-blocked from email
-- sending (OPPORTUNITY_ELIGIBILITY.referral_opportunities.emailEligible
-- = false) because "Referral sources do not yet have a real recipient
-- list wired up -- no candidate query exists for this opportunity type
-- yet." The real reason: lead_pipeline tracks lead_source = referral (a
-- category) but never captured WHICH existing customer made the
-- referral, so there was no way to build a real thank-you/reward
-- recipient list. This migration adds that one real, additive column.
--
-- ADDITIVE ONLY: nullable, no backfill (no existing data can honestly
-- populate this -- it must be entered by staff going forward, via the
-- new Referred By field on the Lead modal). No existing column altered
-- or dropped.

alter table lead_pipeline
  add column if not exists referred_by_client_id text references clients(jobber_id) on delete set null;

create index if not exists lead_pipeline_referred_by_idx
  on lead_pipeline(referred_by_client_id)
  where referred_by_client_id is not null;
