-- sql/034_marketing_channel_budgets.sql
-- Marketing Setup (owner request 2026-07-26): per-channel monthly budget
-- amounts that live UNDER the single total limit already stored in
-- marketing_budget_settings.monthly_budget_cents (sql/031). ADDITIVE ONLY.
--
-- Design: the owner sets one total monthly limit (existing table, existing
-- $2,500-$15,000 check) and may optionally split it across channels here.
-- The "sum of channel budgets <= total limit" rule is enforced in
-- api/marketing.js (resource=setup_budget) rather than as a cross-row DB
-- constraint; each row only guarantees its own amount is non-negative.
-- Channels not present (or 0) are simply unallocated -- that is honest
-- "not planned yet" state, not a placeholder.
create table if not exists marketing_channel_budgets (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  channel text not null check (channel in (
    'email','sms','google_ads','meta_ads','google_business_profile',
    'website_cms','direct_mail','other'
  )),
  monthly_budget_cents integer not null default 0 check (monthly_budget_cents >= 0),
  updated_at timestamptz not null default now(),
  updated_by text,
  unique (tenant_id, channel)
);

create index if not exists marketing_channel_budgets_tenant_idx
  on marketing_channel_budgets(tenant_id);

alter table marketing_channel_budgets enable row level security;
create policy "service role full access marketing_channel_budgets"
  on marketing_channel_budgets
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
