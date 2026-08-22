-- sql/041_marketing_website_review_attribution.sql
-- Marketing Suite Phase 4 (sub-slice 6 of the "16 missing entities" data
-- model work) -- see reina/marketing-suite-master-build-plan-2026-07-29.md,
-- Phase 4. ADDITIVE ONLY: no existing table is altered or dropped.
--
-- NAMING NOTE (discovered 2026-07-31): origin/main independently already
-- has sql/039_jobs_enriched_view.sql and sql/040_snapshot_aggregates_fn.sql
-- (unrelated Gate-1 performance work, merged after this Marketing Suite
-- branch tree started). Several still-unmerged Marketing Suite sibling
-- branches also used sql/039/sql/040 for OwnerIdea/Attachment and
-- CampaignDraft/AuditEvent respectively. This is a real filename collision
-- across independently-developed branches that will need Chris's
-- reconciliation (renumbering one side) at actual merge time -- not
-- something to silently resolve here. This file uses sql/041, which does
-- not collide with anything on origin/main as of this branch's creation.
--
-- This sub-slice creates the final 5 of the 17 total Marketing Suite
-- entities (the original 16 plus CampaignDraft): WebsiteChange, ReviewReply
-- (Phase 13), and LeadAttribution, RevenueAttribution,
-- OptimizationRecommendation (Phase 18). Grounded in the real existing
-- tables it must not duplicate or diverge from without reason:
--   * review_requests (sql/020) -- real id uuid pk, job_id/client_id text
--     (not FKs -- jobs/clients are synced/read-only), channel constrained
--     to email/sms, deliberately no sentiment field. marketing_review_replies
--     below is scoped to an actual posted review's reply lifecycle, which
--     review_requests does not cover (review_requests only tracks whether
--     the *ask* was sent, not any reply to a review that came back).
--   * campaigns (sql/021) -- real id uuid pk. Referenced by FK wherever a
--     row is genuinely about a specific campaign.
--   * clients(jobber_id) -- the repo-wide convention (campaign_recipients,
--     marketing_consent_ledger, marketing_suppressions) for referencing a
--     client without duplicating Jobber-synced fields.
--   * marketing_platform_connections (sql/030) -- google_business_profile
--     is a real platform value there; reused verbatim in
--     marketing_review_replies.platform rather than inventing a new name.
--
-- SOFT REFERENCE NOTE: marketing_approvals (Approval, sql/038 on the
-- still-unmerged marketing-suite-phase4-approval-annotation-publication
-- branch) does not exist on origin/main yet. Both website_changes and
-- marketing_review_replies below carry an approval_id column but
-- deliberately WITHOUT a hard foreign-key constraint to marketing_approvals,
-- so this migration can be applied standalone against an origin/main-only
-- schema without requiring sql/038 first. Once sql/038 merges, a follow-up
-- migration can add the FK constraint in place (same drop/add-constraint
-- pattern sql/007 used to widen a CHECK) -- deliberately not done here.
--
-- Never rewrite review text, never invent products/prices/locations/
-- warranties/results, never fabricate attribution -- these are the same
-- "real facts only" disciplines already documented throughout this plan;
-- this migration only creates the tables, it does not yet wire any code to
-- populate them (matching every prior Phase 4 sub-slice's schema-first
-- pattern).

-- ---------- WebsiteChange (Phase 13) ----------
-- One row per proposed or applied change to an owner's website, across a
-- provider-abstracted set of CMS platforms (WordPress/Webflow/Wix + a
-- forward-compatible 'other'). content_snapshot stores the actual proposed
-- content as real structured data (never a placeholder) so a rollback can
-- restore exactly what was there, and so an approval preview can show the
-- real change rather than a description of it.
create table if not exists marketing_website_changes (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  provider text not null check (provider in ('wordpress','webflow','wix','other')),
  site_ref text,
  change_type text not null check (change_type in (
    'landing_page','promotion','service_page','portfolio_page',
    'video_embed','cta','form','local_content','technical_seo','general'
  )),
  page_path text,
  title text,
  content_snapshot jsonb,
  previous_snapshot jsonb,
  status text not null default 'draft' check (status in (
    'draft','pending_approval','approved','published','rolled_back','expired'
  )),
  approval_id uuid,
  scheduled_publish_at timestamptz,
  published_at timestamptz,
  auto_expire_at timestamptz,
  rolled_back_at timestamptz,
  rollback_reason text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_website_changes_tenant_status_idx
  on marketing_website_changes(tenant_id, status);
create index if not exists marketing_website_changes_provider_idx
  on marketing_website_changes(provider);

alter table marketing_website_changes enable row level security;
create policy "service role full access marketing_website_changes"
  on marketing_website_changes
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ---------- ReviewReply (Phase 13) ----------
-- Tracks a reply to an actual posted review (distinct from review_requests,
-- sql/020, which only tracks whether the review *ask* was sent -- it has no
-- concept of a review coming back or a reply to it). sensitivity_flag marks
-- replies that need explicit owner approval before posting (per the brief:
-- "Reina-drafted replies with owner approval for sensitive ones"), left for
-- application code to set based on real signals (e.g. rating <= 2 or
-- negative sentiment) -- never defaulted to true/false as a placeholder
-- guess here. review_text is the real, unmodified review content; never
-- rewritten, matching the explicit "never rewrite review text" rule.
create table if not exists marketing_review_replies (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  review_request_id uuid references review_requests(id) on delete set null,
  client_id text references clients(jobber_id) on delete set null,
  platform text not null check (platform in ('google_business_profile','other')),
  external_review_id text,
  reviewer_name text,
  rating integer check (rating is null or (rating between 1 and 5)),
  review_text text,
  draft_reply_text text,
  final_reply_text text,
  sensitivity_flag boolean not null default false,
  status text not null default 'draft' check (status in (
    'draft','pending_approval','approved','posted','rejected'
  )),
  approval_id uuid,
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_review_replies_tenant_status_idx
  on marketing_review_replies(tenant_id, status);
create index if not exists marketing_review_replies_review_request_idx
  on marketing_review_replies(review_request_id);
create index if not exists marketing_review_replies_client_idx
  on marketing_review_replies(client_id);

alter table marketing_review_replies enable row level security;
create policy "service role full access marketing_review_replies"
  on marketing_review_replies
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ---------- LeadAttribution (Phase 18) ----------
-- Preserves first-touch/last-touch/assisted attribution for a lead across
-- its marketing touchpoints, per Phase 18's explicit requirement not to
-- lose this once a lead becomes a job. assisted_touches is a real jsonb
-- array of {channel, campaign_id, touched_at} entries, populated only from
-- real observed touches -- never backfilled with invented ones.
create table if not exists marketing_lead_attributions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  client_id text references clients(jobber_id) on delete set null,
  lead_source_ref text,
  first_touch_channel text,
  first_touch_campaign_id uuid references campaigns(id) on delete set null,
  last_touch_channel text,
  last_touch_campaign_id uuid references campaigns(id) on delete set null,
  assisted_touches jsonb,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_lead_attributions_tenant_idx
  on marketing_lead_attributions(tenant_id);
create index if not exists marketing_lead_attributions_client_idx
  on marketing_lead_attributions(client_id);

alter table marketing_lead_attributions enable row level security;
create policy "service role full access marketing_lead_attributions"
  on marketing_lead_attributions
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ---------- RevenueAttribution (Phase 18) ----------
-- Connects a completed job's real financial outcome back to the campaign
-- (if any) that produced the lead, for Phase 18's full funnel + P&L
-- tracking. job_id is left as unconstrained text (not a FK), matching the
-- repo-wide convention that jobs is a synced/read-only table (same pattern
-- as review_requests.job_id, sql/020). Never populate estimate/sold/profit
-- fields with anything but a job's real, already-computed values -- an
-- absent value (NULL) honestly means "not yet known," not zero.
create table if not exists marketing_revenue_attributions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  job_id text,
  client_id text references clients(jobber_id) on delete set null,
  campaign_id uuid references campaigns(id) on delete set null,
  lead_attribution_id uuid references marketing_lead_attributions(id) on delete set null,
  estimate_value_cents integer check (estimate_value_cents is null or estimate_value_cents >= 0),
  sold_value_cents integer check (sold_value_cents is null or sold_value_cents >= 0),
  gross_profit_cents integer,
  cost_allocated_cents integer check (cost_allocated_cents is null or cost_allocated_cents >= 0),
  attribution_model text check (attribution_model in ('first_touch','last_touch','linear','assisted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_revenue_attributions_tenant_idx
  on marketing_revenue_attributions(tenant_id);
create index if not exists marketing_revenue_attributions_campaign_idx
  on marketing_revenue_attributions(campaign_id);
create index if not exists marketing_revenue_attributions_job_idx
  on marketing_revenue_attributions(job_id);

alter table marketing_revenue_attributions enable row level security;
create policy "service role full access marketing_revenue_attributions"
  on marketing_revenue_attributions
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ---------- OptimizationRecommendation (Phase 18) ----------
-- Reina's suggested spend/creative/audience adjustments, kept as a distinct
-- record from marketing_approvals (sql/038) -- an OptimizationRecommendation
-- is Reina's analysis output; it becomes a marketing_approvals row (a
-- BUDGET_ADJUSTMENT-type card) only once/if it's actually surfaced to the
-- owner for a decision. Keeping them separate lets Reina generate and
-- discard candidate recommendations without polluting the owner-facing
-- approval queue -- matching the existing "keep the queue free of routine
-- system activity" rule already stated in Phase 8's brief.
create table if not exists marketing_optimization_recommendations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  category text not null check (category in (
    'channel_reallocation','pause_underperformer','increase_budget',
    'decrease_budget','creative_refresh','audience_expansion','other'
  )),
  rationale text not null,
  recommended_action jsonb,
  confidence numeric,
  related_campaign_id uuid references campaigns(id) on delete set null,
  related_channel text,
  status text not null default 'suggested' check (status in (
    'suggested','accepted','dismissed','expired'
  )),
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_optimization_recommendations_tenant_status_idx
  on marketing_optimization_recommendations(tenant_id, status);
create index if not exists marketing_optimization_recommendations_campaign_idx
  on marketing_optimization_recommendations(related_campaign_id);

alter table marketing_optimization_recommendations enable row level security;
create policy "service role full access marketing_optimization_recommendations"
  on marketing_optimization_recommendations
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
