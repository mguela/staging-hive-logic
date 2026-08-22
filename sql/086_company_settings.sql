-- sql/086_company_settings.sql
-- Company Setup (csx): the settings that had NO backing table anywhere.
--
-- ✅ APPLIED to production (sqhusuuhlmcmkeowdrga) 2026-08-17, on Chris's explicit
-- go-ahead ("apply the migration to prod"), via Supabase MCP apply_migration as
-- version 20260817225146 / 086_company_settings. The outer begin/commit below is
-- not sent to apply_migration, which runs its own transaction; every statement is
-- idempotent so the file re-runs cleanly either way.
--
-- Verified after applying: 7 columns, 0 rows, RLS enabled, 3 policies, 2 indexes,
-- 2 check constraints, 1 trigger, acl = {postgres, service_role, authenticated=arw}
-- with anon absent (has_table_privilege('anon',…,'SELECT') = false), and no new
-- security-advisor findings. The unique index, the section check, the jsonb-object
-- check and the updated_at trigger were each exercised against production with
-- probe inserts inside a DO block that raises at the end, so every probe rolled
-- back — re-confirmed 0 rows afterwards.
--
-- Note for anyone re-testing the trigger: comparing two now() readings inside one
-- transaction always reports "did not fire", because now() is the transaction
-- timestamp. Write a bogus updated_at and check the trigger overwrites it instead.
--
-- Before it was applied, api/settings.js returned ok:true with defaults and
-- `table_missing:true`, and the Company Setup page showed those sections
-- read-only with a "not saved yet — migration pending" banner. That path stays
-- in the code as the fresh-install behaviour.
--
-- SCOPE — deliberately narrow. Most of what the Company Setup page shows is
-- ALREADY backed and live in production, and this migration does NOT duplicate
-- any of it:
--   company profile (address/phone/EIN/tax/timezone) → companies + sql/081
--   rate cards & burden                             → cost_assumptions, company_rates view (sql/071)
--   brands / divisions                              → org_units (sql/052)
--   roles & permissions                             → company_members (sql/082)
--   overhead                                        → division_overhead, registry_overhead (sql/078)
-- Adding a second home for any of those would create two competing sources of
-- truth. This table covers ONLY the four groups with nothing behind them today:
-- business hours, payment terms, the numbering law, and the automation toggles.
--
-- NUMBERING: the repo's sql/ tree tops out at 085_command_center_layouts.sql.
-- Production (`schema_migrations` on sqhusuuhlmcmkeowdrga, checked 2026-08-17)
-- tops out at 20260818020000 boardroom_atomic_project_attach, whose highest
-- NUMBERED entry is 20260816135101 / 085_command_center_layouts. Nothing
-- numbered 086 exists in either place, so 086 is free. (043 is permanently
-- off-limits per the migration ledger; not a factor at 086.)
--
-- SHAPE — one row per (company, section), value as JSONB.
-- Chosen over a key/value row-per-setting because the page saves by SECTION:
-- each card on Company Setup has its own Save button, so a section save is one
-- upsert rather than a multi-row transaction, and a section's fields can gain
-- or lose keys without a migration per field. The trade-off — you cannot query
-- an individual setting with a plain column predicate — does not matter here,
-- because every read is "give me this company's settings" in full.
--
-- Rollback: drop table public.company_settings cascade;
--           drop function public.company_settings_touch();

begin;

create table if not exists public.company_settings (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  -- One of the SECTION keys below. Constrained so a typo in a client payload
  -- can't silently create a phantom section that nothing ever reads.
  section    text not null,
  value      jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint company_settings_section_known check (
    section in ('hours', 'payment_terms', 'numbering', 'automations')
  ),
  constraint company_settings_value_is_object check (jsonb_typeof(value) = 'object')
);

comment on table public.company_settings is
  'Company Setup sections that have no other backing table: business hours, payment terms, numbering law, automation toggles. Profile/rates/divisions/roles/overhead live in their own tables — never mirror them here.';
comment on column public.company_settings.section is
  'hours | payment_terms | numbering | automations — one row per company per section.';
comment on column public.company_settings.value is
  'The whole section as a JSON object. Shape is owned by api/settings.js (SECTION_DEFAULTS).';

-- One row per company per section; this is what makes the API's upsert an
-- ON CONFLICT rather than a read-then-write race between two open tabs.
create unique index if not exists company_settings_company_section_idx
  on public.company_settings (company_id, section);

-- updated_at maintenance (same pattern as 085).
create or replace function public.company_settings_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.company_settings_touch() from anon, authenticated;

drop trigger if exists company_settings_touch on public.company_settings;
create trigger company_settings_touch
  before update on public.company_settings
  for each row execute function public.company_settings_touch();

-- RLS. The app reaches this table through api/settings.js with the service key
-- (which bypasses RLS and scopes by company_id itself — the repo's established
-- pattern, same as 085). These policies are what protects the table from a
-- direct PostgREST call made with a user's own anon-key session.
alter table public.company_settings enable row level security;

-- Read: any active member of the company.
drop policy if exists company_settings_select_member on public.company_settings;
create policy company_settings_select_member
  on public.company_settings for select
  to authenticated
  using (exists (
    select 1 from public.company_members m
    where m.company_id = company_settings.company_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  ));

-- Write: owner/admin of that company only. Mirrors the admin-only gate in
-- api/settings.js so the rule holds even if the API is bypassed.
drop policy if exists company_settings_insert_admin on public.company_settings;
create policy company_settings_insert_admin
  on public.company_settings for insert
  to authenticated
  with check (exists (
    select 1 from public.company_members m
    where m.company_id = company_settings.company_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('owner', 'admin')
  ));

drop policy if exists company_settings_update_admin on public.company_settings;
create policy company_settings_update_admin
  on public.company_settings for update
  to authenticated
  using (exists (
    select 1 from public.company_members m
    where m.company_id = company_settings.company_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('owner', 'admin')
  ))
  with check (exists (
    select 1 from public.company_members m
    where m.company_id = company_settings.company_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('owner', 'admin')
  ));

-- No delete policy: a section is cleared by saving it empty, never removed.
-- Absent policy = no delete for `authenticated`, which is the intent.

revoke all on public.company_settings from anon, authenticated;
grant select, insert, update on public.company_settings to authenticated;

-- No views are added by this migration, so there is nothing here needing
-- security_invoker = on; noted so a later view over this table doesn't miss it.

commit;
