-- HiveLogic AI Council, Phase 1. Proposal only: apply through the established
-- Supabase migration workflow after protected-preview review. All records are
-- server/service-role owned; clients receive data only through the admin API.

create table if not exists public.reina_council_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  state text not null check (state in ('completed', 'awaiting_human_approval', 'queued_for_hivebridge')),
  brief text not null,
  evidence jsonb not null,
  budget jsonb not null,
  usage jsonb not null,
  report jsonb not null,
  execution_request jsonb,
  execution_task_id uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  approved_at timestamptz
);

create table if not exists public.reina_council_messages (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.reina_council_runs(id) on delete cascade,
  participant text not null check (participant in ('claude', 'chatgpt', 'grok')),
  round integer not null check (round >= 0 and round <= 3),
  message jsonb not null,
  usage jsonb not null,
  created_at timestamptz not null default now(),
  unique (run_id, participant, round)
);

create table if not exists public.reina_council_audit_events (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.reina_council_runs(id) on delete cascade,
  event_type text not null,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create table if not exists public.reina_council_approvals (
  id bigint generated always as identity primary key,
  run_id uuid not null unique references public.reina_council_runs(id) on delete cascade,
  approved boolean not null,
  decided_by uuid not null references auth.users(id),
  reason text,
  decided_at timestamptz not null default now()
);

create table if not exists public.reina_council_admissions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  idempotency_key text not null check (length(idempotency_key) between 8 and 128),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  reserved_cost_cents integer not null check (reserved_cost_cents > 0),
  state text not null check (state in ('admitted', 'completed', 'failed')),
  run_id uuid references public.reina_council_runs(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  finished_at timestamptz,
  unique (owner_id, idempotency_key)
);

create index if not exists reina_council_runs_owner_created_idx on public.reina_council_runs (owner_id, created_at desc);
create index if not exists reina_council_audit_events_run_idx on public.reina_council_audit_events (run_id, occurred_at);
create index if not exists reina_council_admissions_owner_created_idx on public.reina_council_admissions (owner_id, created_at desc);

alter table public.reina_council_runs enable row level security;
alter table public.reina_council_messages enable row level security;
alter table public.reina_council_audit_events enable row level security;
alter table public.reina_council_approvals enable row level security;
alter table public.reina_council_admissions enable row level security;

revoke all on table public.reina_council_runs, public.reina_council_messages,
  public.reina_council_audit_events, public.reina_council_approvals,
  public.reina_council_admissions from anon, authenticated;
grant all on table public.reina_council_runs, public.reina_council_messages,
  public.reina_council_audit_events, public.reina_council_approvals,
  public.reina_council_admissions to service_role;
grant usage, select on sequence public.reina_council_messages_id_seq,
  public.reina_council_audit_events_id_seq,
  public.reina_council_approvals_id_seq to service_role;

-- Serialize admission decisions per owner. The durable idempotency ledger keeps
-- retries from paying three providers twice, while expiring crashed attempts so
-- they cannot consume a concurrency slot forever.
create or replace function public.reina_council_admit(
  p_owner_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_reserved_cost_cents integer,
  p_max_concurrent_runs integer,
  p_daily_cost_cents integer
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_existing public.reina_council_admissions%rowtype;
  v_admission public.reina_council_admissions%rowtype;
  v_now timestamptz := clock_timestamp();
  v_active integer;
  v_daily bigint;
begin
  if p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
    or p_request_hash !~ '^[a-f0-9]{64}$'
    or p_reserved_cost_cents < 1 or p_reserved_cost_cents > 100000
    or p_max_concurrent_runs < 1 or p_max_concurrent_runs > 10
    or p_daily_cost_cents < 1 or p_daily_cost_cents > 1000000 then
    raise exception 'invalid council admission request';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 0));
  select * into v_existing
  from public.reina_council_admissions
  where owner_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_existing.request_hash <> p_request_hash then
      return jsonb_build_object('status', 'conflict');
    elsif v_existing.state = 'completed' and v_existing.run_id is not null then
      return jsonb_build_object('status', 'replay', 'runId', v_existing.run_id);
    elsif v_existing.state = 'admitted' and v_existing.expires_at > v_now then
      return jsonb_build_object('status', 'in_progress', 'admissionId', v_existing.id);
    end if;
    update public.reina_council_admissions
    set state = 'failed', finished_at = v_now
    where id = v_existing.id;
  end if;

  select count(*) into v_active
  from public.reina_council_admissions
  where owner_id = p_owner_id and state = 'admitted' and expires_at > v_now;
  if v_active >= p_max_concurrent_runs then
    return jsonb_build_object('status', 'quota_exceeded', 'reason', 'concurrent');
  end if;

  select coalesce(sum(reserved_cost_cents), 0) into v_daily
  from public.reina_council_admissions
  where owner_id = p_owner_id and created_at >= date_trunc('day', v_now)
    and (state = 'completed' or (state = 'admitted' and expires_at > v_now));
  if v_daily + p_reserved_cost_cents > p_daily_cost_cents then
    return jsonb_build_object('status', 'quota_exceeded', 'reason', 'daily_cost');
  end if;

  if v_existing.id is not null then
    update public.reina_council_admissions
    set reserved_cost_cents = p_reserved_cost_cents, state = 'admitted', run_id = null,
      created_at = v_now, expires_at = v_now + interval '15 minutes', finished_at = null
    where id = v_existing.id returning * into v_admission;
  else
    insert into public.reina_council_admissions (
      owner_id, idempotency_key, request_hash, reserved_cost_cents, state, created_at, expires_at
    ) values (
      p_owner_id, p_idempotency_key, p_request_hash, p_reserved_cost_cents,
      'admitted', v_now, v_now + interval '15 minutes'
    ) returning * into v_admission;
  end if;
  return jsonb_build_object('status', 'admitted', 'admissionId', v_admission.id);
end;
$$;

revoke all on function public.reina_council_admit(uuid, text, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.reina_council_admit(uuid, text, text, integer, integer, integer) to service_role;

create or replace function public.reina_council_release_admission(
  p_admission_id uuid,
  p_owner_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  update public.reina_council_admissions
  set state = 'failed', finished_at = clock_timestamp()
  where id = p_admission_id and owner_id = p_owner_id and state = 'admitted';
  return jsonb_build_object('released', found);
end;
$$;

revoke all on function public.reina_council_release_admission(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reina_council_release_admission(uuid, uuid) to service_role;

-- Persist the run, all provider messages, and every moderation/audit event in
-- one transaction. Any validation or insert failure rolls the complete call
-- back, so an approvable run can never exist without its forensic record.
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
    or jsonb_typeof(p_budget) <> 'object' then
    raise exception 'invalid council persistence payload';
  end if;
  v_rounds := (p_budget ->> 'maxRounds')::integer;
  if v_rounds < 1 or v_rounds > 4
    or jsonb_array_length(p_messages) <> 3 * v_rounds
    or jsonb_array_length(p_audit_events) <> 3 + (7 * v_rounds) then
    raise exception 'incomplete council persistence payload';
  end if;

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
  set state = 'completed', run_id = p_id, finished_at = clock_timestamp()
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

-- Return the owner-scoped run together with the immutable transcript, audit
-- timeline, and approval record needed by the Council workspace.
create or replace function public.reina_council_get_run(
  p_run_id uuid,
  p_owner_id uuid
) returns jsonb
language sql
security definer
set search_path = pg_catalog, public, extensions
stable
as $$
  select to_jsonb(r) || jsonb_build_object(
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'participant', m.participant, 'round', m.round, 'message', m.message,
        'usage', m.usage, 'createdAt', m.created_at
      ) order by m.round, m.participant)
      from public.reina_council_messages m where m.run_id = r.id
    ), '[]'::jsonb),
    'audit', coalesce((
      select jsonb_agg(jsonb_build_object(
        'eventType', a.event_type, 'detail', a.detail, 'occurredAt', a.occurred_at
      ) order by a.id)
      from public.reina_council_audit_events a where a.run_id = r.id
    ), '[]'::jsonb),
    'approval', (
      select to_jsonb(ap) from public.reina_council_approvals ap where ap.run_id = r.id
    )
  )
  from public.reina_council_runs r
  where r.id = p_run_id and r.owner_id = p_owner_id;
$$;

revoke all on function public.reina_council_get_run(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reina_council_get_run(uuid, uuid) to service_role;

-- Lock the pending run and target agent, then record both approval ledgers,
-- queue the typed task, transition the run, and append the audit event as one
-- transaction. Concurrent approvals or emergency-stop changes cannot interleave.
create or replace function public.reina_council_approve_and_queue(
  p_run_id uuid,
  p_owner_id uuid,
  p_reason text,
  p_tenant_id text,
  p_agent_id uuid,
  p_task_type text,
  p_path text,
  p_scope_hash text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_run public.reina_council_runs%rowtype;
  v_agent public.automation_agents%rowtype;
  v_task public.automation_tasks%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_run
  from public.reina_council_runs
  where id = p_run_id and owner_id = p_owner_id
  for update;
  if not found or v_run.state <> 'awaiting_human_approval' then
    raise exception 'council run is not awaiting approval';
  end if;
  if p_task_type not in ('repository_status', 'repository_test')
    or p_path is null or btrim(p_path) = '' or length(p_path) > 500
    or v_run.execution_request <> jsonb_build_object(
      'agentId', p_agent_id::text, 'taskType', p_task_type, 'path', p_path
    ) then
    raise exception 'execution request does not match approved council run';
  end if;

  select * into v_agent
  from public.automation_agents
  where id = p_agent_id and tenant_id = p_tenant_id and revoked_at is null
  for update;
  if not found or v_agent.status in ('paused', 'emergency_stopped', 'revoked') then
    raise exception 'agent is not accepting tasks';
  end if;

  insert into public.automation_tasks (
    tenant_id, agent_id, task_type, payload, scope_hash, risk_tier, status,
    created_by, approved_at, updated_at
  ) values (
    p_tenant_id, p_agent_id, p_task_type, jsonb_build_object('path', p_path),
    p_scope_hash, 'read_only', 'queued', p_owner_id, v_now, v_now
  ) returning * into v_task;

  insert into public.reina_council_approvals (
    run_id, approved, decided_by, reason, decided_at
  ) values (p_run_id, true, p_owner_id, p_reason, v_now);

  insert into public.automation_task_approvals (
    tenant_id, task_id, scope_hash, decision, decided_by, reason, created_at
  ) values (
    p_tenant_id, v_task.id, p_scope_hash, 'approved', p_owner_id, p_reason, v_now
  );

  update public.reina_council_runs
  set state = 'queued_for_hivebridge', execution_task_id = v_task.id,
    approved_at = v_now
  where id = p_run_id;

  insert into public.reina_council_audit_events (
    run_id, event_type, detail, occurred_at
  ) values (
    p_run_id, 'execution.queued_for_hivebridge',
    jsonb_build_object('taskId', v_task.id, 'taskType', p_task_type), v_now
  );

  return to_jsonb(v_task);
end;
$$;

revoke all on function public.reina_council_approve_and_queue(
  uuid, uuid, text, text, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.reina_council_approve_and_queue(
  uuid, uuid, text, text, uuid, text, text, text
) to service_role;
