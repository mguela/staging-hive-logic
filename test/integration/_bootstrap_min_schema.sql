-- Minimal, faithful bootstrap for the banking-reauth transactional test.
-- Column definitions, the unique index, and the foreign keys are copied from
-- the canonical baseline (supabase/migrations/20260802140000_remote_baseline.sql)
-- for exactly the three tables the RPC touches. This avoids depending on the
-- full Supabase bootstrap (vault/pgsodium/pg_read_file), which races container
-- init — the transactional semantics under test are identical either way.
\set ON_ERROR_STOP on

-- Supabase roles. Present on the supabase/postgres image; created here so the
-- migration's GRANT and the role-execution tests work on any Postgres.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  -- An extra unprivileged role used to prove PUBLIC has no execute grant.
  if not exists (select 1 from pg_roles where rolname = 'nobody_test') then create role nobody_test; end if;
end $$;

create table if not exists public.subs (
    id uuid default gen_random_uuid() not null primary key,
    company_name text not null,
    accepts_cc boolean,
    status text default 'invited' not null,
    created_at timestamptz default now() not null
);

create table if not exists public.sub_auth_links (
    id uuid default gen_random_uuid() not null primary key,
    sub_id uuid not null,
    token text not null unique,
    purpose text default 'login' not null,
    expires_at timestamptz not null,
    used_at timestamptz,
    created_at timestamptz default now() not null
);

create table if not exists public.sub_banking (
    id uuid default gen_random_uuid() not null primary key,
    sub_id uuid not null,
    provider text,
    provider_ref text,
    masked_account text,
    accepts_ach boolean default false not null,
    updated_at timestamptz default now() not null
);

-- The unique index the upsert's ON CONFLICT (sub_id) depends on (baseline: sub_banking_sub_uidx).
create unique index if not exists sub_banking_sub_uidx on public.sub_banking using btree (sub_id);

-- REAL foreign keys from the baseline (both ON DELETE CASCADE), so the tests
-- exercise the same referential integrity production has.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sub_auth_links_sub_id_fkey') then
    alter table public.sub_auth_links
      add constraint sub_auth_links_sub_id_fkey foreign key (sub_id) references public.subs(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sub_banking_sub_id_fkey') then
    alter table public.sub_banking
      add constraint sub_banking_sub_id_fkey foreign key (sub_id) references public.subs(id) on delete cascade;
  end if;
end $$;

-- Table access for the SECURITY INVOKER function's caller. In production the
-- service role has full access (RLS-bypassing); here we grant it explicitly so
-- `SET ROLE service_role; select consume_...()` exercises real invoker access.
-- anon/authenticated are intentionally NOT granted (they must not execute the
-- function anyway).
grant usage on schema public to service_role, anon, authenticated;
grant select, insert, update, delete on public.subs, public.sub_auth_links, public.sub_banking to service_role;
