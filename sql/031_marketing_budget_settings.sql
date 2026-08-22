-- sql/031_marketing_budget_settings.sql
-- Marketing Suite Phase 1 (UX-01 Command Center, ST-03 budget slider) --
-- persists the owner's monthly marketing budget setting so "Adjust Your
-- Budget" (Figure 1, screen 2) has a real value to show/change instead of
-- an in-memory-only slider that resets on reload. ADDITIVE ONLY.
--
-- Scope discipline: this table stores ONLY the owner's chosen budget
-- number. It deliberately does NOT store a fabricated channel-allocation
-- plan -- the real Reina Opportunity Engine (ST-01/ST-02) that would
-- compute a trustworthy 90-day plan from margin/capacity/seasonality is
-- future work (see reina/marketing-suite-phase1-command-center-shipped
-- for the honest state of what the Command Center can and cannot compute
-- today). Building that table now, before the engine exists, would be
-- exactly the kind of placeholder infrastructure the project's "no
-- placeholder features" rule prohibits.
create table if not exists marketing_budget_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null unique default 'ghgrp',
  monthly_budget_cents integer not null default 250000 check (monthly_budget_cents between 250000 and 1500000),
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table marketing_budget_settings enable row level security;
create policy "service role full access marketing_budget_settings"
  on marketing_budget_settings
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
