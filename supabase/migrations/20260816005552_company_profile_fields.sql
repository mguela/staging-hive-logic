-- sql/081_company_profile_fields.sql
--
-- Finish Company Setup: the companies table only carried name/slug/plan/status/dba,
-- so the onboarding wizard and the edit page had nowhere to store the real business
-- identity (address, contact, tax IDs, licensing, locale). This adds those columns
-- so both surfaces persist a full, editable company profile.
--
-- Additive only (nullable text columns + one default). Safe to apply live.

begin;

alter table public.companies add column if not exists address_line1  text;
alter table public.companies add column if not exists address_line2  text;
alter table public.companies add column if not exists city           text;
alter table public.companies add column if not exists state          text;
alter table public.companies add column if not exists postal_code    text;
alter table public.companies add column if not exists phone          text;
alter table public.companies add column if not exists email          text;
alter table public.companies add column if not exists website        text;
alter table public.companies add column if not exists ein            text;   -- federal tax ID / EIN
alter table public.companies add column if not exists license_number text;
alter table public.companies add column if not exists timezone       text default 'America/New_York';
alter table public.companies add column if not exists primary_trade  text;
alter table public.companies add column if not exists region         text;
alter table public.companies add column if not exists industry       text;

commit;
