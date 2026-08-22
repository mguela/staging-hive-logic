-- Boardroom project attachment was a second, non-atomic PostgREST PATCH
-- issued (council-store.js createRun()) after this RPC's own transaction had
-- already committed. If that PATCH failed for any reason, the client was
-- told the whole request failed (503) while the run row -- and, if an
-- explicit "create a master project" request had already inserted a fresh
-- boardroom_projects row moments earlier, an orphaned empty project too --
-- already existed in the database. Found during the 2026-08-18 Boardroom
-- production incident review: this is one of the concrete ways a Boardroom
-- request's reported outcome can disagree with the database's real state.
--
-- Fix: accept the project id as part of the same atomic transaction this
-- function already runs, so a run can never be persisted with the wrong
-- project attached (or silently left unattached) by a second, separately
-- failable write. The OLD 12-argument version is explicitly dropped first --
-- adding a parameter changes the function's signature, so CREATE OR REPLACE
-- alone would have left it in place as a second, stale overload rather than
-- actually retiring it. The NEW 13-argument version is created with CREATE OR
-- REPLACE (not a bare CREATE), so this migration stays safe to re-run --
-- e.g. a fresh local/CI database bootstrap -- without a false "already
-- exists" failure the second time it runs.

begin;

drop function if exists public.reina_council_create_run(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb
);

create or replace function public.reina_council_create_run(
  p_id uuid,
  p_owner_id uuid,
  p_admission_id uuid,
  p_state text,
  p_brief text,
  p_evidence jsonb,
  p_budget jsonb,
  p_usage jsonb,
  p_report jsonb,
  p_execution_request jsonb,
  p_messages jsonb,
  p_audit_events jsonb,
  p_project_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_run public.reina_council_runs%rowtype;
  v_admission public.reina_council_admissions%rowtype;
  v_rounds integer;
  v_actual_cost_cents integer;
begin
  select * into v_admission
  from public.reina_council_admissions
  where id = p_admission_id and owner_id = p_owner_id
  for update;
  if not found or v_admission.state <> 'admitted'
    or v_admission.expires_at <= clock_timestamp() then
    raise exception 'council admission is not active';
  end if;

  if jsonb_typeof(p_messages) <> 'array'
    or jsonb_typeof(p_audit_events) <> 'array'
    or jsonb_typeof(p_budget) <> 'object'
    or jsonb_typeof(p_usage) <> 'object' then
    raise exception 'invalid council persistence payload';
  end if;

  v_rounds := (p_budget ->> 'maxRounds')::integer;
  if v_rounds < 1 or v_rounds > 4
    or jsonb_array_length(p_messages) < v_rounds
    or jsonb_array_length(p_messages) > 3 * v_rounds
    or jsonb_array_length(p_audit_events) < 4 + (v_rounds - 1)
    or jsonb_array_length(p_audit_events) > 512 then
    raise exception 'incomplete council persistence payload';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_messages) as items(item)
    where jsonb_typeof(item) <> 'object'
      or item ->> 'participant' not in ('claude', 'chatgpt', 'grok')
      or (item ->> 'round') !~ '^[0-9]+$'
      or (item ->> 'round')::integer < 0
      or (item ->> 'round')::integer >= v_rounds
      or jsonb_typeof(item -> 'message') <> 'object'
      or jsonb_typeof(item -> 'usage') <> 'object'
  ) or exists (
    select 1
    from jsonb_array_elements(p_messages) as items(item)
    group by item ->> 'participant', item ->> 'round'
    having count(*) <> 1
  ) or exists (
    select 1
    from generate_series(0, v_rounds - 1) as expected(round_number)
    where not exists (
      select 1 from jsonb_array_elements(p_messages) as items(item)
      where (item ->> 'round')::integer = expected.round_number
    )
  ) then
    raise exception 'invalid council message transcript';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_audit_events) as events(event)
    where jsonb_typeof(event) <> 'object'
      or coalesce(length(event ->> 'eventType'), 0) not between 1 and 120
      or jsonb_typeof(event -> 'detail') <> 'object'
      or coalesce(event ->> 'occurredAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
  ) or (select count(*) from jsonb_array_elements(p_audit_events) as events(event)
        where event ->> 'eventType' = 'council.started') <> 1
     or (select count(*) from jsonb_array_elements(p_audit_events) as events(event)
        where event ->> 'eventType' = 'moderator.independent_round_completed') <> 1
     or (select count(*) from jsonb_array_elements(p_audit_events) as events(event)
        where event ->> 'eventType' = 'moderator.debate_round_completed') <> v_rounds - 1
     or (select count(*) from jsonb_array_elements(p_audit_events) as events(event)
        where event ->> 'eventType' = 'moderator.consensus_computed') <> 1
     or (select count(*) from jsonb_array_elements(p_audit_events) as events(event)
        where event ->> 'eventType' = 'council.completed') <> 1
     or not exists (
       select 1 from jsonb_array_elements(p_audit_events) as events(event)
       where event ->> 'eventType' = 'provider.completed'
     ) then
    raise exception 'invalid council audit transcript';
  end if;

  if p_project_id is not null and not exists (
    select 1 from public.boardroom_projects where id = p_project_id and owner_id = p_owner_id
  ) then
    raise exception 'boardroom project not found for this owner';
  end if;

  if (p_usage ->> 'totalCostCents') !~ '^[0-9]+([.][0-9]+)?$' then
    raise exception 'invalid council cost payload';
  end if;
  v_actual_cost_cents := greatest(
    1,
    least(
      v_admission.reserved_cost_cents,
      ceil((p_usage ->> 'totalCostCents')::numeric)::integer
    )
  );

  insert into public.reina_council_runs (
    id, owner_id, state, brief, evidence, budget, usage, report,
    execution_request, project_id, created_at, completed_at
  ) values (
    p_id, p_owner_id, p_state, p_brief, p_evidence, p_budget, p_usage, p_report,
    p_execution_request, p_project_id, clock_timestamp(), clock_timestamp()
  ) returning * into v_run;

  insert into public.reina_council_messages (run_id, participant, round, message, usage)
  select p_id, item ->> 'participant', (item ->> 'round')::integer,
    item -> 'message', item -> 'usage'
  from jsonb_array_elements(p_messages) as items(item);

  insert into public.reina_council_audit_events (run_id, event_type, detail, occurred_at)
  select p_id, item ->> 'eventType', item -> 'detail', (item ->> 'occurredAt')::timestamptz
  from jsonb_array_elements(p_audit_events) as items(item);

  update public.reina_council_admissions
  set state = 'completed',
      run_id = p_id,
      reserved_cost_cents = v_actual_cost_cents,
      finished_at = clock_timestamp()
  where id = p_admission_id;

  return to_jsonb(v_run);
end;
$$;

revoke all on function public.reina_council_create_run(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, uuid
) from public, anon, authenticated;
grant execute on function public.reina_council_create_run(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, uuid
) to service_role;

commit;
