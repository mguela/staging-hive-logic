-- sql/083_integrations_company_id.sql
--
-- Multi-tenant Phase 1 — give the integrations table a company_id.
--
-- The integrations table (Jobber/Gusto/QBO/Microsoft/TikTok OAuth token storage)
-- was global: one row per `key`, no tenant. This adds company_id so connection
-- status can be reported per company, and lays the column every future
-- per-company OAuth connection will write.
--
-- Scope note: this migration is ADDITIVE only. It does NOT change the existing
-- unique-by-`key` constraint, because the token-refresh writers run in
-- background/cron context and there is not yet a per-company "Connect" flow.
-- Turning integrations into true per-company connections (unique (company_id,key)
-- + per-company OAuth + per-company sync jobs) is a Phase 2 feature, not a column
-- add — doing it here would risk the live company's Jobber/Gusto/QBO sync.

begin;

alter table public.integrations
  add column if not exists company_id uuid references public.companies(id) on delete cascade;

-- Backfill: every existing integration belongs to the sole company today.
update public.integrations
   set company_id = (select id from public.companies order by created_at asc limit 1)
 where company_id is null;

create index if not exists integrations_company_idx on public.integrations (company_id);

commit;
