-- sql/046_marketing_lead_revenue_attribution.sql
-- Marketing Suite Phase 18 (Results around profitable jobs) -- LeadAttribution
-- and RevenueAttribution, the two of Phase 4 sub-slice 6's five entities this
-- slice's application code actually reads/writes. ADDITIVE ONLY: no existing
-- table is altered or dropped.
--
-- RENUMBERING NOTE (2026-08-01): these two tables were originally defined,
-- alongside WebsiteChange/ReviewReply/OptimizationRecommendation, in
-- sql/041_marketing_website_review_attribution.sql on the still-unmerged
-- marketing-suite-phase4-website-review-attribution branch. That branch was
-- created before origin/main gained its OWN, unrelated sql/041_webhook_events.sql
-- (shipped 2026-08-01, a different feature entirely) -- so cherry-picking the
-- original sql/041 filename onto a fresh origin/main branch today would
-- collide. This file is renumbered to sql/046 (next free number as of this
-- branch's creation -- 042/043/044/045 are all claimed by other unmerged
-- work per reina/marketing-suite-sql043-collision-resolved-2026-08-01.md)
-- and scoped to ONLY the two tables this branch's code actually uses.
-- WebsiteChange/ReviewReply/OptimizationRecommendation are deliberately NOT
-- duplicated here -- they already exist, unchanged, on the original
-- sql/041-numbered branch and on Phase 13's application-code branches; this
-- file does not touch or supersede those. Reconciling the two migrations'
-- overlapping table definitions (both create marketing_lead_attributions the
-- same way) at actual merge time is Chris's call, same as every other
-- documented filename/content collision in this project -- flagged here, not
-- silently resolved.
--
-- Table definitions below are byte-for-byte identical to the original
-- sql/041 file's LeadAttribution/RevenueAttribution sections -- no schema
-- change, only the file name/number and this header changed.

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
