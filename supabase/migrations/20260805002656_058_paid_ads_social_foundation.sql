-- sql/058_paid_ads_social_foundation.sql
-- Foundation for paid-ad and social platform connections (Meta, Google Ads,
-- TikTok). ADDITIVE ONLY. NOT APPLIED to production yet.
--
-- Separate from the existing campaigns table (email/sms/mail only) -- ad
-- platforms have a different shape: external campaign ids, platform-reported
-- spend, targeting, creative assets, review states.

create table if not exists ad_platform_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  platform text not null check (platform in ('meta','google_ads','tiktok')),
  -- Real authorization material for each platform lives only in Vercel
  -- environment variables, never in this database. This column just names
  -- which environment variable the app should read for this connection.
  env_var_name text not null,
  business_account_id text,
  ad_account_id text,
  -- Meta-specific: the Page to publish ads from. Null for platforms
  -- that do not use a Page concept (Google Ads, TikTok).
  page_id text,
  -- Same 10-state vocabulary as the existing Phase 15 Universal
  -- Connections state machine (marketing_platform_connections) --
  -- not reinvented, so both tables can share one transition validator.
  state text not null default 'not_connected' check (state in (
    'not_connected','setup_incomplete','reporting_verified','draft_validated',
    'launch_enabled','needs_attention','needs_reauth','policy_blocked',
    'billing_blocked','external_approval_pending'
  )),
  scopes text[],
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id, platform)
);

alter table ad_platform_connections enable row level security;
drop policy if exists "service role full access ad_platform_connections" on ad_platform_connections;
create policy "service role full access ad_platform_connections"
  on ad_platform_connections
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
-- ---------- ad_campaigns ----------
create table if not exists ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  platform text not null check (platform in ('meta','google_ads','tiktok')),
  external_campaign_id text,
  objective text not null check (objective in ('lead_gen','traffic','awareness','conversions')),
  name text not null,
  status text not null default 'draft' check (status in (
    'draft','pending_review','active','paused','completed','rejected'
  )),
  daily_budget_cents integer check (daily_budget_cents is null or daily_budget_cents >= 0),
  targeting_summary jsonb,
  creative_asset_ids uuid[],
  -- Generated or owner-authored ad copy: { headline, primaryText, description, cta }.
  -- Grounded only in real business facts -- see api/_lib/ad-copy-grounding.js.
  ad_copy jsonb,
  created_by text not null default 'reina' check (created_by in ('reina','owner')),
  approved_by text,
  approved_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ad_campaigns_tenant_idx on ad_campaigns(tenant_id);
create index if not exists ad_campaigns_platform_idx on ad_campaigns(platform);

alter table ad_campaigns enable row level security;
drop policy if exists "service role full access ad_campaigns" on ad_campaigns;
create policy "service role full access ad_campaigns"
  on ad_campaigns
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
-- ---------- ad_spend_ledger ----------
-- Real spend pulled from each platform's own reporting endpoint. Never
-- estimated or invented -- rows only get written from a platform's real
-- reported number. This is what the budget governor sums against the cap.
create table if not exists ad_spend_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  platform text not null check (platform in ('meta','google_ads','tiktok')),
  ad_campaign_id uuid references ad_campaigns(id) on delete set null,
  spend_date date not null,
  spend_cents integer not null check (spend_cents >= 0),
  reported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(tenant_id, platform, ad_campaign_id, spend_date)
);

create index if not exists ad_spend_ledger_tenant_date_idx on ad_spend_ledger(tenant_id, spend_date);

alter table ad_spend_ledger enable row level security;
drop policy if exists "service role full access ad_spend_ledger" on ad_spend_ledger;
create policy "service role full access ad_spend_ledger"
  on ad_spend_ledger
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
-- ---------- ad_budget_caps ----------
-- The hard ceiling Reina operates under. One row per tenant. Enforcement
-- happens in application code, before any spend-creating API call is made:
-- sum this month's ad_spend_ledger rows, refuse to raise/create budget if
-- projected spend would exceed cap_cents.
create table if not exists ad_budget_caps (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp' unique,
  cap_cents integer not null check (cap_cents >= 0),
  autonomy_level text not null default 'auto_within_cap' check (autonomy_level in (
    'draft_only','auto_within_cap','full_autonomy'
  )),
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table ad_budget_caps enable row level security;
drop policy if exists "service role full access ad_budget_caps" on ad_budget_caps;
create policy "service role full access ad_budget_caps"
  on ad_budget_caps
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- Seed Chris's starting cap: $1,500/mo, auto-run within cap (per his
-- 2026-08-03 decision). This is a real row, not a placeholder default --
-- change cap_cents here if the number changes.
insert into ad_budget_caps (tenant_id, cap_cents, autonomy_level, updated_by)
values ('ghgrp', 150000, 'auto_within_cap', 'chris_2026-08-03_chat')
on conflict (tenant_id) do nothing;
