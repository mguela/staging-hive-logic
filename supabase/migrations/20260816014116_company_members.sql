-- sql/082_company_members.sql
--
-- Multi-tenant Phase 1 — the tenancy spine.
--
-- Until now HiveLogic was single-tenant: every API resolved "which company?"
-- by hardcoding `companies.slug = 'greenwich-handyman'`. To sell subscriptions
-- to many companies, the company must be derived from the signed-in USER. This
-- table is that link: one row per person-per-company.
--
-- The API resolver (api/_lib/tenant.js) reads this first, and falls back to the
-- sole company only while exactly one company exists — so nothing changes today,
-- and the fallback disappears automatically the moment a second company is created.
--
-- Additive: new table + backfill of existing profiles into the one company.

begin;

create table if not exists public.company_members (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id    uuid not null,                    -- = auth.users.id = profiles.id
  role       text not null default 'member',   -- owner | admin | member
  status     text not null default 'active',   -- active | invited | removed
  created_at timestamptz not null default now(),
  unique (company_id, user_id)
);

-- The resolver looks up active memberships by user.
create index if not exists company_members_user_active_idx
  on public.company_members (user_id) where status = 'active';

-- Membership is the tenant authorization spine.  Browser clients may read
-- only their own membership rows; all membership writes remain service-role
-- only because allowing users to create or edit rows would permit tenant and
-- role escalation.
alter table public.company_members enable row level security;

drop policy if exists company_members_read_self on public.company_members;
create policy company_members_read_self on public.company_members
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Backfill: in the single-tenant world every existing profile belongs to the
-- one company. Map their profile role onto a membership role; superadmin/owner
-- become the company owner (Chris is superadmin).
insert into public.company_members (company_id, user_id, role)
select c.id, p.id,
  case
    when lower(coalesce(p.role, '')) in ('owner', 'superadmin', 'super_admin') then 'owner'
    when lower(coalesce(p.role, '')) = 'admin' then 'admin'
    else 'member'
  end
from public.profiles p
cross join (select id from public.companies order by created_at asc limit 1) c
on conflict (company_id, user_id) do nothing;

commit;
