-- sql/036_marketing_shared_workspace_plan_opportunity_variant.sql
-- Marketing Suite Phase 4 (sub-slice 1 of the "16 missing entities" data
-- model work) -- see reina/marketing-suite-master-build-plan-2026-07-29.md,
-- Phase 4. ADDITIVE ONLY: no existing table is altered or dropped.
--
-- This sub-slice creates the 3 entities Phase 6 (Plan generation) most
-- directly depends on: MarketingPlan, MarketingOpportunity, CampaignVariant.
-- The remaining 13 entities (MediaAsset, GeneratedAsset, SourceEvidence,
-- OwnerIdea, Attachment, Annotation, Approval, Publication, WebsiteChange,
-- ReviewReply, LeadAttribution, RevenueAttribution, OptimizationRecommendation,
-- AuditEvent, CampaignDraft) are deliberately NOT created here -- they belong
-- to later Phase 4 sub-slices, sequenced alongside the phases that will
-- actually read/write them (Phase 8/9/10/11/13), so nothing here is an
-- empty placeholder table with no real caller.
--
-- Scope note on the 5 entities that already exist and are NOT recreated:
-- Campaign (sql/021 campaigns), MarketingBudget (sql/031 + sql/034),
-- MarketingAccountConnection (sql/030 marketing_platform_connections),
-- SuppressionRecord (sql/030 marketing_suppressions), ReviewRequest
-- (sql/020). The 2 partial entities (ChannelAllocation ->
-- marketing_channel_budgets, Client/ContactMarketingConsent ->
-- marketing_consent_ledger) are also left untouched in this sub-slice --
-- extending them is separate, scoped work, not part of this migration.

-- ---------- MarketingPlan ----------
-- A generated planning snapshot for a period (today: rolling 90-day window,
-- per Phase 5/6). Distinct from marketing_plan_assumptions (sql/032, the
-- owner's raw planning INPUTS) -- this table is the resulting PLAN itself:
-- a snapshot of the assumptions used, the forecast computed from them
-- (same conservative/expected/upside shape as the existing computeForecast()
-- in api/marketing.js), and a plain-English rationale, so Phase 5's
-- dashboard and Phase 6's "explain why it selected what it selected"
-- requirement have a real, persisted record to read instead of recomputing
-- silently on every page load with no history.
create table if not exists marketing_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  status text not null default 'draft' check (status in ('draft','active','superseded','archived')),
  period_start date not null,
  period_end date not null check (period_end >= period_start),
  objective text,
  budget_cents integer check (budget_cents is null or budget_cents >= 0),
  assumptions_snapshot jsonb,
  forecast jsonb,
  forecast_state text check (forecast_state is null or forecast_state in ('blocked_no_channel','blocked_assumptions','ready')),
  blocked_reasons jsonb,
  rationale text,
  generated_by text not null default 'system' check (generated_by in ('system','owner')),
  superseded_by uuid references marketing_plans(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only one plan may be the tenant's current active plan at a time; a new
-- plan supersedes the old one explicitly (via superseded_by) rather than
-- ever deleting history.
create unique index if not exists marketing_plans_one_active_per_tenant
  on marketing_plans(tenant_id) where (status = 'active');

create index if not exists marketing_plans_tenant_status_idx
  on marketing_plans(tenant_id, status);
create index if not exists marketing_plans_period_idx
  on marketing_plans(tenant_id, period_start, period_end);

alter table marketing_plans enable row level security;
create policy "service role full access marketing_plans"
  on marketing_plans
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ---------- MarketingOpportunity ----------
-- Today, opportunity cards (handleOpportunitiesGet in api/marketing.js) are
-- computed live on every GET with zero persistence -- there is no record of
-- what was surfaced, when, or whether the owner acted on it. This table
-- gives each surfaced opportunity a real identity across time. It does NOT
-- replace the live computation (that stays the source of truth for current
-- numbers); it is the historical/audit layer the live computation writes
-- into when a card is actually shown, and Phase 5's dashboard and Phase 8's
-- Ready-for-You queue can read from.
--
-- opportunity_key values match OPPORTUNITY_ELIGIBILITY's real keys in
-- api/marketing.js verbatim (unsold_estimates, review_requests,
-- reactivate_customers, seasonal_promotion, neighborhood_expansion,
-- referral_opportunities) -- test/marketing-phase4-schema.test.mjs asserts
-- this list can never silently drift from the real code constant.
create table if not exists marketing_opportunities (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  plan_id uuid references marketing_plans(id) on delete set null,
  opportunity_key text not null check (opportunity_key in (
    'unsold_estimates','review_requests','reactivate_customers',
    'seasonal_promotion','neighborhood_expansion','referral_opportunities'
  )),
  title text,
  signal jsonb,
  actionable boolean not null default false,
  actionable_reason text,
  required_integration text,
  status text not null default 'surfaced' check (status in ('surfaced','acted_on','dismissed','expired')),
  campaign_id uuid references campaigns(id) on delete set null,
  surfaced_at timestamptz not null default now(),
  acted_at timestamptz,
  dismissed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_opportunities_tenant_key_idx
  on marketing_opportunities(tenant_id, opportunity_key, surfaced_at desc);
create index if not exists marketing_opportunities_plan_idx
  on marketing_opportunities(plan_id);
create index if not exists marketing_opportunities_campaign_idx
  on marketing_opportunities(campaign_id);
create index if not exists marketing_opportunities_status_idx
  on marketing_opportunities(tenant_id, status);

alter table marketing_opportunities enable row level security;
create policy "service role full access marketing_opportunities"
  on marketing_opportunities
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ---------- CampaignVariant ----------
-- Alternative drafted content for a campaign before one version is picked
-- (subject-line/creative variants, e.g. an AI-drafted option vs. an
-- owner-edited option) -- the CampaignProposal/CampaignVariant object from
-- the spec's core data objects list. References the existing real
-- `campaigns` table (sql/021); does not duplicate it. CampaignDraft
-- (handleDraftPostPost's currently-nonexistent persistence layer) is a
-- separate, not-yet-built entity tracked under a later Phase 4/9 sub-slice
-- -- this table is deliberately scoped to "variants of a campaign that
-- already exists," not "the first draft of unsent AI copy."
create table if not exists campaign_variants (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  campaign_id uuid not null references campaigns(id) on delete cascade,
  opportunity_id uuid references marketing_opportunities(id) on delete set null,
  label text,
  channel text not null default 'email' check (channel in ('email','sms','mail')),
  subject text,
  body text,
  media_refs jsonb,
  generated_by text not null default 'ai' check (generated_by in ('ai','owner')),
  status text not null default 'proposed' check (status in ('proposed','selected','rejected','sent')),
  selected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaign_variants_campaign_idx
  on campaign_variants(campaign_id);
create index if not exists campaign_variants_status_idx
  on campaign_variants(tenant_id, status);

alter table campaign_variants enable row level security;
create policy "service role full access campaign_variants"
  on campaign_variants
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
