-- Boardroom provider retries and degraded rounds produce additional forensic
-- events. The original RPC required one exact event count, which made a
-- truthful retry audit impossible to persist. Validate the shape and required
-- lifecycle events instead, while preserving the all-or-nothing transaction.

begin;

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
  p_audit_events jsonb
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
    execution_request, created_at, completed_at
  ) values (
    p_id, p_owner_id, p_state, p_brief, p_evidence, p_budget, p_usage, p_report,
    p_execution_request, clock_timestamp(), clock_timestamp()
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
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.reina_council_create_run(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb
) to service_role;

commit;
