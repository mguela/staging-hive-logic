-- Transactional integration test for consume_sub_reauth_and_apply_banking.
-- Run against a throwaway Postgres loaded with the bootstrap (tables + FKs +
-- roles) + the migration. ON_ERROR_STOP=1: any RAISE EXCEPTION aborts nonzero.
--
-- Token hashes must be 64-hex (the function validates the format), so tests use
-- repeat('a',64) etc. as stand-in hashes.
\set ON_ERROR_STOP on
\timing off

-- Fixed sub id 11111111-…; canonical grant id 22222222-…
create or replace function _reset(
  p_used    timestamptz,
  p_purpose text default 'reauth',
  p_expires timestamptz default now() + interval '5 min',
  p_accepts_cc boolean default null
) returns void language plpgsql as $$
begin
  delete from public.sub_banking   where sub_id = '11111111-1111-1111-1111-111111111111';
  delete from public.sub_auth_links where sub_id = '11111111-1111-1111-1111-111111111111';
  delete from public.subs          where id     = '11111111-1111-1111-1111-111111111111';
  insert into public.subs (id, company_name, accepts_cc)
    values ('11111111-1111-1111-1111-111111111111', 'Test Sub', p_accepts_cc);
  insert into public.sub_auth_links (id, sub_id, token, purpose, expires_at, used_at)
    values ('22222222-2222-2222-2222-222222222222',
            '11111111-1111-1111-1111-111111111111',
            repeat('a',64), p_purpose, p_expires, p_used);
end $$;

-- ============================ 1. VALID ============================
select _reset(now() - interval '30 sec');
do $$
declare r jsonb;
begin
  r := public.consume_sub_reauth_and_apply_banking(
    '11111111-1111-1111-1111-111111111111', repeat('a',64),
    'ach', 'ref-1', '****1234', true, true);
  if (r->>'ok') <> 'true' then raise exception 'FAIL 1: rpc not ok: %', r; end if;
  if (r->'banking'->>'sub_id') <> '11111111-1111-1111-1111-111111111111' then raise exception 'FAIL 1: banking.sub_id mismatch'; end if;
  if (select purpose from public.sub_auth_links where id='22222222-2222-2222-2222-222222222222') <> 'reauth_consumed' then raise exception 'FAIL 1: grant not consumed'; end if;
  if (select accepts_cc from public.subs where id='11111111-1111-1111-1111-111111111111') is not true then raise exception 'FAIL 1: accepts_cc not applied'; end if;
  if (select masked_account from public.sub_banking where sub_id='11111111-1111-1111-1111-111111111111') <> '****1234' then raise exception 'FAIL 1: masked_account not written'; end if;
  if (select accepts_ach from public.sub_banking where sub_id='11111111-1111-1111-1111-111111111111') is not true then raise exception 'FAIL 1: accepts_ach not true'; end if;
  raise notice 'PASS 1: valid reauth updates everything and consumes the grant once';
end $$;

-- ============ 3a/3b/4. FAILURE at each stage => full rollback ============
create or replace function _boom() returns trigger language plpgsql as $$ begin raise exception 'boom_x'; end $$;

select _reset(now() - interval '30 sec');
create trigger _t_boom_bank before insert or update on public.sub_banking for each row execute function _boom();
do $$
declare r jsonb;
begin
  begin
    r := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', repeat('a',64), 'ach', null, '****1234', true, true);
    raise exception 'FAIL 3a: expected banking-write failure, got %', r;
  exception when others then if sqlerrm not like '%boom_x%' then raise; end if; end;
  if (select purpose from public.sub_auth_links where id='22222222-2222-2222-2222-222222222222') <> 'reauth' then raise exception 'FAIL 3a: grant consumed despite banking-write failure'; end if;
  if exists(select 1 from public.sub_banking where sub_id='11111111-1111-1111-1111-111111111111') then raise exception 'FAIL 3a: partial sub_banking row remains'; end if;
  if (select accepts_cc from public.subs where id='11111111-1111-1111-1111-111111111111') is not null then raise exception 'FAIL 3a: accepts_cc changed despite rollback'; end if;
  raise notice 'PASS 3a: failure during sub_banking write rolls back everything';
end $$;
drop trigger _t_boom_bank on public.sub_banking;

select _reset(now() - interval '30 sec');
create trigger _t_boom_subs before update on public.subs for each row execute function _boom();
do $$
declare r jsonb;
begin
  begin
    r := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', repeat('a',64), 'ach', null, '****1234', true, true);
    raise exception 'FAIL 3b: expected subs-write failure, got %', r;
  exception when others then if sqlerrm not like '%boom_x%' then raise; end if; end;
  if (select purpose from public.sub_auth_links where id='22222222-2222-2222-2222-222222222222') <> 'reauth' then raise exception 'FAIL 3b: grant consumed despite subs-write failure'; end if;
  if exists(select 1 from public.sub_banking where sub_id='11111111-1111-1111-1111-111111111111') then raise exception 'FAIL 3b: sub_banking written despite rollback'; end if;
  raise notice 'PASS 3b: failure during subs.accepts_cc write rolls back everything';
end $$;
drop trigger _t_boom_subs on public.subs;

select _reset(now() - interval '30 sec');
create trigger _t_boom_link before update on public.sub_auth_links for each row execute function _boom();
do $$
declare r jsonb;
begin
  begin
    r := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', repeat('a',64), 'ach', null, '****1234', true, true);
    raise exception 'FAIL 4: expected consume failure, got %', r;
  exception when others then if sqlerrm not like '%boom_x%' then raise; end if; end;
  if (select purpose from public.sub_auth_links where id='22222222-2222-2222-2222-222222222222') <> 'reauth' then raise exception 'FAIL 4: grant changed despite consume failure'; end if;
  if exists(select 1 from public.sub_banking where sub_id='11111111-1111-1111-1111-111111111111') then raise exception 'FAIL 4: sub_banking written despite consume failure'; end if;
  raise notice 'PASS 4/5: failure while consuming the grant rolls back everything (no partial state)';
end $$;
drop trigger _t_boom_link on public.sub_auth_links;

-- ============ 7. REUSE fails ============
select _reset(now() - interval '30 sec');
do $$
declare r1 jsonb; r2 jsonb;
begin
  r1 := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', repeat('a',64), 'ach', null, '****1234', false, false);
  r2 := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', repeat('a',64), 'wells', null, '****9999', false, false);
  if (r1->>'ok') <> 'true' then raise exception 'FAIL 7: first call not ok'; end if;
  if (r2->>'ok') <> 'false' then raise exception 'FAIL 7: reuse unexpectedly succeeded: %', r2; end if;
  if (select masked_account from public.sub_banking where sub_id='11111111-1111-1111-1111-111111111111') <> '****1234' then raise exception 'FAIL 7: reuse mutated banking'; end if;
  raise notice 'PASS 7: reusing a consumed token fails and does not mutate banking';
end $$;

-- ============ 8. FORGED token fails ============
select _reset(now() - interval '30 sec');
do $$
declare r jsonb;
begin
  r := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', repeat('b',64), 'ach', null, '****1234', true, true);
  if (r->>'ok') <> 'false' then raise exception 'FAIL 8: forged token accepted'; end if;
  if (select purpose from public.sub_auth_links where id='22222222-2222-2222-2222-222222222222') <> 'reauth' then raise exception 'FAIL 8: real grant touched'; end if;
  if exists(select 1 from public.sub_banking where sub_id='11111111-1111-1111-1111-111111111111') then raise exception 'FAIL 8: banking written for forged token'; end if;
  raise notice 'PASS 8: forged token fails without changing banking data';
end $$;

-- ============ 9. EXPIRED (expires_at in the past) fails ============
select _reset(now() - interval '30 sec', 'reauth', now() - interval '1 min');
do $$
declare r jsonb;
begin
  r := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', repeat('a',64), 'ach', null, '****1234', true, true);
  if (r->>'ok') <> 'false' then raise exception 'FAIL 9: expired link accepted'; end if;
  if (select purpose from public.sub_auth_links where id='22222222-2222-2222-2222-222222222222') <> 'reauth' then raise exception 'FAIL 9: expired grant consumed'; end if;
  raise notice 'PASS 9: expired expires_at fails without changing banking data';
end $$;

-- ============ FUTURE used_at fails (used_at <= now()) ============
select _reset(now() + interval '5 min');
do $$
declare r jsonb;
begin
  r := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', repeat('a',64), 'ach', null, '****1234', true, true);
  if (r->>'ok') <> 'false' then raise exception 'FAIL future-used_at: accepted a future-dated redemption'; end if;
  if (select purpose from public.sub_auth_links where id='22222222-2222-2222-2222-222222222222') <> 'reauth' then raise exception 'FAIL future-used_at: grant consumed'; end if;
  raise notice 'PASS future-used_at: a future-dated used_at is rejected';
end $$;

-- ============ OLD token (redeemed > 10 min ago) fails ============
select _reset(now() - interval '11 min');
do $$
declare r jsonb;
begin
  r := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', repeat('a',64), 'ach', null, '****1234', true, true);
  if (r->>'ok') <> 'false' then raise exception 'FAIL old-token: accepted a stale (>10m) redemption'; end if;
  raise notice 'PASS old-token: a redemption older than the hard-coded 10m window is rejected';
end $$;

-- ============ BOUNDARY timestamps ============
select _reset(now() - interval '9 minutes 55 seconds');
do $$
declare r jsonb;
begin
  r := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', repeat('a',64), 'ach', null, '****1234', false, false);
  if (r->>'ok') <> 'true' then raise exception 'FAIL boundary-inside: just-inside-window rejected: %', r; end if;
  raise notice 'PASS boundary-inside: used_at just inside 10m window is accepted';
end $$;
select _reset(now() - interval '10 minutes 5 seconds');
do $$
declare r jsonb;
begin
  r := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', repeat('a',64), 'ach', null, '****1234', false, false);
  if (r->>'ok') <> 'false' then raise exception 'FAIL boundary-outside: just-outside-window accepted'; end if;
  raise notice 'PASS boundary-outside: used_at just outside 10m window is rejected';
end $$;

-- ============ 10. WRONG-PURPOSE token fails ============
select _reset(now() - interval '30 sec', 'login');
do $$
declare r jsonb;
begin
  r := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', repeat('a',64), 'ach', null, '****1234', true, true);
  if (r->>'ok') <> 'false' then raise exception 'FAIL 10: wrong-purpose accepted'; end if;
  if (select purpose from public.sub_auth_links where id='22222222-2222-2222-2222-222222222222') <> 'login' then raise exception 'FAIL 10: wrong-purpose grant mutated'; end if;
  raise notice 'PASS 10: wrong-purpose token fails without changing banking data';
end $$;

-- ============ WRONG subcontractor fails ============
select _reset(now() - interval '30 sec');
do $$
declare r jsonb;
begin
  r := public.consume_sub_reauth_and_apply_banking('99999999-9999-9999-9999-999999999999', repeat('a',64), 'ach', null, '****1234', true, true);
  if (r->>'ok') <> 'false' then raise exception 'FAIL wrong-sub: accepted grant for a different sub'; end if;
  if (select purpose from public.sub_auth_links where id='22222222-2222-2222-2222-222222222222') <> 'reauth' then raise exception 'FAIL wrong-sub: real grant consumed'; end if;
  raise notice 'PASS wrong-sub: a grant bound to another sub is rejected';
end $$;

-- ============ INVALID DB INPUT raises, consumes nothing ============
select _reset(now() - interval '30 sec');
do $$
declare r jsonb; n int := 0;
begin
  begin r := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', 'not-a-hash', 'ach', null, '****1234', true, true); exception when others then if sqlerrm like '%invalid_banking_input%' then n := n+1; else raise; end if; end;
  begin r := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', repeat('a',64), 'ach', null, '123456789', true, true); exception when others then if sqlerrm like '%invalid_banking_input%' then n := n+1; else raise; end if; end;
  begin r := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', repeat('a',64), repeat('x',65), null, '****1234', true, true); exception when others then if sqlerrm like '%invalid_banking_input%' then n := n+1; else raise; end if; end;
  begin r := public.consume_sub_reauth_and_apply_banking(null, repeat('a',64), 'ach', null, '****1234', true, true); exception when others then if sqlerrm like '%invalid_banking_input%' then n := n+1; else raise; end if; end;
  if n <> 4 then raise exception 'FAIL invalid-input: expected 4 rejections, got %', n; end if;
  if (select purpose from public.sub_auth_links where id='22222222-2222-2222-2222-222222222222') <> 'reauth' then raise exception 'FAIL invalid-input: grant consumed by invalid input'; end if;
  if exists(select 1 from public.sub_banking where sub_id='11111111-1111-1111-1111-111111111111') then raise exception 'FAIL invalid-input: banking written by invalid input'; end if;
  raise notice 'PASS invalid-input: bad sub_id/hash/mask/length all raise and change nothing';
end $$;

-- ============ OMITTED fields preserve existing values ============
select _reset(now() - interval '30 sec');
do $$
declare r jsonb;
begin
  r := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', repeat('a',64), 'ach', 'ref-A', '****1111', false, false);
  if (r->>'ok') <> 'true' then raise exception 'FAIL omit: first call not ok'; end if;
  insert into public.sub_auth_links (id, sub_id, token, purpose, expires_at, used_at)
    values (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', repeat('c',64), 'reauth', now()+interval '5 min', now()-interval '30 sec');
  r := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', repeat('c',64), null, null, '****2222', false, false);
  if (r->>'ok') <> 'true' then raise exception 'FAIL omit: second call not ok'; end if;
  if (select provider from public.sub_banking where sub_id='11111111-1111-1111-1111-111111111111') <> 'ach' then raise exception 'FAIL omit: provider not preserved'; end if;
  if (select provider_ref from public.sub_banking where sub_id='11111111-1111-1111-1111-111111111111') <> 'ref-A' then raise exception 'FAIL omit: provider_ref not preserved'; end if;
  if (select masked_account from public.sub_banking where sub_id='11111111-1111-1111-1111-111111111111') <> '****2222' then raise exception 'FAIL omit: masked_account not updated'; end if;
  raise notice 'PASS omit: omitted provider/provider_ref preserved; masked updated';
end $$;

-- ============ explicit FALSE stays false ============
select _reset(now() - interval '30 sec', 'reauth', now() + interval '5 min', true);  -- accepts_cc starts true
do $$
declare r jsonb;
begin
  r := public.consume_sub_reauth_and_apply_banking('11111111-1111-1111-1111-111111111111', repeat('a',64), 'ach', null, '****1234', true, false);  -- explicit false
  if (r->>'ok') <> 'true' then raise exception 'FAIL false: call not ok'; end if;
  if (select accepts_cc from public.subs where id='11111111-1111-1111-1111-111111111111') is not false then raise exception 'FAIL false: accepts_cc not set to false'; end if;
  raise notice 'PASS false: explicit accepts_cc=false is applied (stays false)';
end $$;

-- ============ ROLE / GRANT matrix ============
do $$
declare sig text := 'public.consume_sub_reauth_and_apply_banking(uuid,text,text,text,text,boolean,boolean)';
begin
  if not has_function_privilege('service_role', sig, 'execute') then raise exception 'FAIL grants: service_role lacks execute'; end if;
  if has_function_privilege('anon', sig, 'execute') then raise exception 'FAIL grants: anon has execute'; end if;
  if has_function_privilege('authenticated', sig, 'execute') then raise exception 'FAIL grants: authenticated has execute'; end if;
  if has_function_privilege('nobody_test', sig, 'execute') then raise exception 'FAIL grants: PUBLIC (unprivileged role) has execute'; end if;
  raise notice 'PASS grants: service_role execute only; anon/authenticated/PUBLIC denied';
end $$;

select 'ALL_SEQUENTIAL_SCENARIOS_PASSED' as result;
