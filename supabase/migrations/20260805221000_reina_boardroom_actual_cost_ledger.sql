-- Charge completed Boardroom runs for measured provider spend instead of the
-- maximum amount reserved before the run. Active admissions retain their full
-- reservation, so concurrent requests still cannot exceed the daily ceiling.

update public.reina_council_admissions as admission
set reserved_cost_cents = greatest(
  1,
  least(
    admission.reserved_cost_cents,
    case
      when (run.usage ->> 'totalCostCents') ~ '^[0-9]+(\.[0-9]+)?$'
        then ceil((run.usage ->> 'totalCostCents')::numeric)::integer
      else admission.reserved_cost_cents
    end
  )
)
from public.reina_council_runs as run
where admission.run_id = run.id
  and admission.state = 'completed'
  and jsonb_typeof(run.usage) = 'object';

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
    or jsonb_array_length(p_messages) <> 3 * v_rounds
    or jsonb_array_length(p_audit_events) <> 3 + (7 * v_rounds) then
    raise exception 'incomplete council persistence payload';
  end if;

  if (p_usage ->> 'totalCostCents') !~ '^[0-9]+(\.[0-9]+)?$' then
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
