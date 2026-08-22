-- Integration test for prune_portal_auth_links() (PR #43 hygiene follow-up).
-- Run against a throwaway Postgres with minimal sub_auth_links + client_auth_links
-- tables + the prune migration. ON_ERROR_STOP=1: any RAISE aborts nonzero.
\set ON_ERROR_STOP on

-- Minimal columns (copied from the canonical baseline) for the two tables.
create table if not exists public.sub_auth_links (
  id uuid default gen_random_uuid() not null primary key,
  sub_id uuid not null default gen_random_uuid(),
  token text not null unique,
  purpose text default 'login' not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz default now() not null
);
create table if not exists public.client_auth_links (
  id uuid default gen_random_uuid() not null primary key,
  client_ref text not null default 'c',
  token text not null,
  purpose text default 'login' not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz default now() not null
);

truncate public.sub_auth_links, public.client_auth_links;

-- SEED sub_auth_links:
--  keep-1: valid unused (future expiry)                    -> KEPT
--  keep-2: reauth grant redeemed 30s ago (recent)          -> KEPT (within grace)
--  del-1 : consumed login (used_at 2 days ago)             -> DELETED
--  del-2 : reauth_consumed 2 days ago                      -> DELETED
--  del-3 : unused but expired 2 days ago                   -> DELETED
insert into public.sub_auth_links (token, purpose, expires_at, used_at) values
  ('s_keep1', 'login',  now() + interval '1 hour', null),
  ('s_keep2', 'reauth', now() + interval '5 min',  now() - interval '30 sec'),
  ('s_del1',  'login',  now() + interval '1 hour', now() - interval '2 days'),
  ('s_del2',  'reauth_consumed', now() - interval '1 hour', now() - interval '2 days'),
  ('s_del3',  'login',  now() - interval '2 days', null);

-- SEED client_auth_links:
--  keep: valid unused ; del: consumed 2 days ago ; del: expired 2 days ago
insert into public.client_auth_links (token, purpose, expires_at, used_at) values
  ('c_keep1', 'login', now() + interval '1 hour', null),
  ('c_del1',  'login', now() + interval '1 hour', now() - interval '2 days'),
  ('c_del2',  'login', now() - interval '2 days', null);

do $$
declare v_deleted integer;
begin
  v_deleted := public.prune_portal_auth_links();  -- default 1-day grace

  -- exactly the 5 dead rows removed (3 sub + 2 client)
  if v_deleted <> 5 then raise exception 'FAIL: expected 5 deleted, got %', v_deleted; end if;

  -- valid/unused + recent-reauth survive
  if not exists (select 1 from public.sub_auth_links where token='s_keep1') then raise exception 'FAIL: deleted a valid unused sub grant'; end if;
  if not exists (select 1 from public.sub_auth_links where token='s_keep2') then raise exception 'FAIL: deleted a recent reauth grant (within grace)'; end if;
  if not exists (select 1 from public.client_auth_links where token='c_keep1') then raise exception 'FAIL: deleted a valid unused client grant'; end if;

  -- spent/expired removed
  if exists (select 1 from public.sub_auth_links where token in ('s_del1','s_del2','s_del3')) then raise exception 'FAIL: a spent/expired sub grant survived'; end if;
  if exists (select 1 from public.client_auth_links where token in ('c_del1','c_del2')) then raise exception 'FAIL: a spent/expired client grant survived'; end if;

  -- idempotent: a second run deletes nothing
  if public.prune_portal_auth_links() <> 0 then raise exception 'FAIL: prune not idempotent'; end if;

  raise notice 'PASS prune: 5 spent/expired removed; valid unused + recent reauth preserved; idempotent';
end $$;

-- grants: service_role may execute; PUBLIC/anon may not.
do $$
declare sig text := 'public.prune_portal_auth_links(interval)';
begin
  if not has_function_privilege('service_role', sig, 'execute') then raise exception 'FAIL grants: service_role lacks execute'; end if;
  if has_function_privilege('anon', sig, 'execute') then raise exception 'FAIL grants: anon has execute'; end if;
  if has_function_privilege('authenticated', sig, 'execute') then raise exception 'FAIL grants: authenticated has execute'; end if;
  raise notice 'PASS grants: service_role execute only; anon and authenticated denied';
end $$;

select 'ALL_PRUNE_SCENARIOS_PASSED' as result;
