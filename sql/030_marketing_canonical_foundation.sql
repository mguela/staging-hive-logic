-- sql/030_marketing_canonical_foundation.sql
-- Phase 0 (M-01) of the Ultimate Marketing Suite rebuild -- canonical
-- foundation tables for platform connections and consent/suppression.
-- ADDITIVE ONLY: no existing table is altered. See
-- reina/marketing-suite-ultimate-build-spec-2026-07-25.md (Section 6,
-- "Universal account-connection architecture" and Section 8, LC-01/AD-01)
-- for the source spec this implements.
--
-- Scope discipline: this migration creates ONLY the two objects that are
-- both (a) safety-foundational per the spec and (b) will be wired to real
-- reading/writing code in this same change -- not empty placeholder
-- tables. MarketingOpportunity/CampaignProposal/LeadAttribution/Approval
-- objects described in the spec's Section 10 are real future work
-- (ST-01, ME-01, GV-02) and are deliberately NOT created here until the
-- code that actually uses them is built alongside them.

-- ---------- Platform connections (Figure 4: Connect Everything) ----------
-- Single source of truth for channel connection state, replacing the
-- hardcoded array in api/marketing.js's handleChannelsGet(). tenant_id
-- defaults to the current single-business operation; this is the seam
-- the spec's Figure 4 correction note calls for ("store customer grants,
-- selected accounts, scopes, expiry, and verification state in encrypted
-- tenant-scoped records") once HiveLogic serves more than one business.
create table if not exists marketing_platform_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  platform text not null check (platform in (
    'email','sms','google_ads','meta_ads','google_business_profile',
    'website_cms','ga4','gtm','search_console','youtube',
    'facebook_instagram','microsoft_ads','linkedin','tiktok','direct_mail'
  )),
  state text not null default 'not_connected' check (state in (
    'not_connected','setup_incomplete','reporting_verified',
    'draft_validated','launch_enabled','needs_attention'
  )),
  account_name text,
  account_id text,
  login_account_id text,
  credential_ref text,
  note text,
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, platform)
);

create index if not exists marketing_platform_connections_tenant_idx
  on marketing_platform_connections(tenant_id);

alter table marketing_platform_connections enable row level security;
create policy "service role full access marketing_platform_connections"
  on marketing_platform_connections
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ---------- Consent ledger + suppression (spec LC-01) ----------
-- No such table existed before this migration (confirmed by direct schema
-- search during M-02 inventory). consent defaults to 'granted' only for
-- an existing real customer relationship (implicit_customer_relationship)
-- -- this reflects current real practice (every send today already only
-- targets real past/current customers with a real email on file), it does
-- not invent new permission. Any future cold/prospect contact requires an
-- explicit_opt_in row, not the implicit default.
create table if not exists marketing_consent_ledger (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(jobber_id) on delete cascade,
  channel text not null check (channel in ('email','sms','review_request','media_marketing_use')),
  status text not null check (status in ('granted','revoked','unknown')),
  source text not null check (source in (
    'implicit_customer_relationship','explicit_opt_in','explicit_opt_out','owner_override'
  )),
  granted_at timestamptz,
  revoked_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, channel)
);

create index if not exists marketing_consent_ledger_client_idx
  on marketing_consent_ledger(client_id);
create index if not exists marketing_consent_ledger_status_idx
  on marketing_consent_ledger(channel, status);

alter table marketing_consent_ledger enable row level security;
create policy "service role full access marketing_consent_ledger"
  on marketing_consent_ledger
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- Suppression is deliberately a separate, simpler table from consent: a
-- suppression is a hard stop (bounce, complaint, explicit unsubscribe,
-- litigation/compliance hold) that should block a send even if a consent
-- row still says "granted" -- matching the spec's own
-- ConsentLedger/SuppressionService split (LC-01).
create table if not exists marketing_suppressions (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(jobber_id) on delete cascade,
  channel text not null check (channel in ('email','sms','review_request')),
  reason text not null check (reason in ('bounced','complained','unsubscribed','owner_override','legal_hold')),
  notes text,
  created_at timestamptz not null default now(),
  unique (client_id, channel)
);

create index if not exists marketing_suppressions_client_idx
  on marketing_suppressions(client_id);

alter table marketing_suppressions enable row level security;
create policy "service role full access marketing_suppressions"
  on marketing_suppressions
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
