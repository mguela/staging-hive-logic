-- Completion is a database-enforced state, not an agent-authored label.
-- Existing unverified "done" rows are reopened because they predate receipts.
alter table public.workroom_tasks
  add column if not exists verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'verification_failed', 'verified_complete')),
  add column if not exists completion_receipt jsonb,
  add column if not exists completion_fingerprint text,
  add column if not exists verified_at timestamptz;
alter table public.workroom_evidence
  add column if not exists evidence_sequence bigint generated always as identity;

-- The API already recognizes every council participant. Keep the ledger in
-- sync so evidence from Grok and Reina is not silently rejected by Postgres.
alter table public.workroom_tasks drop constraint if exists workroom_tasks_assigned_agent_check;
alter table public.workroom_tasks add constraint workroom_tasks_assigned_agent_check
  check (assigned_agent is null or assigned_agent in ('codex', 'chatgpt', 'claude', 'claude_code', 'grok', 'reina'));
alter table public.workroom_events drop constraint if exists workroom_events_actor_check;
alter table public.workroom_events add constraint workroom_events_actor_check
  check (actor in ('user', 'codex', 'chatgpt', 'claude', 'claude_code', 'grok', 'reina', 'system'));
alter table public.workroom_evidence drop constraint if exists workroom_evidence_actor_check;
alter table public.workroom_evidence add constraint workroom_evidence_actor_check
  check (actor in ('codex', 'chatgpt', 'claude', 'claude_code', 'grok', 'reina', 'system'));

-- Fail closed: authenticated browser sessions may read their own ledger, but
-- only the trusted server/service role may write evidence or completion state.
drop policy if exists workroom_tasks_owner on public.workroom_tasks;
drop policy if exists workroom_events_owner on public.workroom_events;
drop policy if exists workroom_evidence_owner on public.workroom_evidence;
create policy workroom_tasks_read_owner on public.workroom_tasks
  for select using (auth.uid() = owner_id);
create policy workroom_events_read_owner on public.workroom_events
  for select using (auth.uid() = owner_id);
create policy workroom_evidence_read_owner on public.workroom_evidence
  for select using (auth.uid() = owner_id);
revoke insert, update, delete on public.workroom_tasks from anon, authenticated;
revoke insert, update, delete on public.workroom_events from anon, authenticated;
revoke insert, update, delete on public.workroom_evidence from anon, authenticated;

update public.workroom_tasks
set status = 'review',
    completed_at = null,
    verification_status = 'unverified',
    completion_receipt = null,
    completion_fingerprint = null,
    verified_at = null,
    updated_at = clock_timestamp()
where status = 'done';

alter table public.workroom_tasks
  drop constraint if exists workroom_tasks_verified_done_check;
alter table public.workroom_tasks
  add constraint workroom_tasks_verified_done_check check (
    status <> 'done'
    or (
      verification_status = 'verified_complete'
      and completed_at is not null
      and verified_at is not null
      and completion_receipt is not null
      and completion_fingerprint ~ '^[0-9a-f]{64}$'
      and completion_receipt ->> 'fingerprint' = completion_fingerprint
      and completion_receipt ->> 'status' is null
      and completion_receipt ->> 'version' = 'hivelogic.completion-gate.v1'
      and completion_receipt ->> 'sourceRevision' ~ '^[0-9a-f]{7,40}$'
      and completion_receipt ->> 'deploymentUrl' ~ '^https://'
    )
  );

create or replace function public.workroom_enforce_completion_gate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_missing text[];
  v_independent_review boolean;
  v_source_revision text;
  v_deployment_url text;
begin
  if tg_op = 'UPDATE' and old.status = 'done' and new.status = 'done' then
    if new.specification is distinct from old.specification
       or new.assigned_agent is distinct from old.assigned_agent then
      new.status := 'review';
      new.completed_at := null;
      new.verified_at := null;
      new.verification_status := 'unverified';
      new.completion_receipt := null;
      new.completion_fingerprint := null;
      return new;
    end if;
    if new.completion_receipt is distinct from old.completion_receipt
       or new.completion_fingerprint is distinct from old.completion_fingerprint
       or new.verified_at is distinct from old.verified_at
       or new.verification_status is distinct from old.verification_status then
      raise exception 'completion gate: a verified receipt is immutable; reopen and reverify the task';
    end if;
  end if;

  if new.status <> 'done' then
    new.completed_at := null;
    new.verified_at := null;
    new.verification_status := 'unverified';
    new.completion_receipt := null;
    new.completion_fingerprint := null;
    return new;
  end if;

  if char_length(trim(new.specification)) < 40 then
    raise exception 'completion gate: intended behavior and acceptance criteria are required';
  end if;

  with required(type) as (
    values ('diff'), ('test'), ('crawler'), ('preview'), ('review'), ('deployment')
  ), latest as (
    select distinct on (e.evidence_type)
      e.evidence_type, e.verdict, e.summary, e.reference, e.actor
    from public.workroom_evidence e
    where e.task_id = new.id and e.owner_id = new.owner_id
    order by e.evidence_type, e.evidence_sequence desc
  )
  select array_agg(required.type order by required.type)
  into v_missing
  from required
  left join latest on latest.evidence_type = required.type
  where latest.evidence_type is null
     or latest.verdict <> 'pass'
     or char_length(trim(latest.summary)) < 10
     or nullif(trim(latest.reference), '') is null
     or (latest.evidence_type = 'diff' and latest.reference !~ '[0-9a-f]{7,40}')
     or (latest.evidence_type in ('preview', 'deployment') and latest.reference !~ '^https://');

  if coalesce(array_length(v_missing, 1), 0) > 0 then
    raise exception 'completion gate: missing or failed evidence: %', array_to_string(v_missing, ', ');
  end if;

  select new.assigned_agent is null or e.actor <> new.assigned_agent
  into v_independent_review
  from public.workroom_evidence e
  where e.task_id = new.id
    and e.owner_id = new.owner_id
    and e.evidence_type = 'review'
  order by e.evidence_sequence desc
  limit 1;
  if v_independent_review is distinct from true then
    raise exception 'completion gate: independent review is required';
  end if;

  select substring(e.reference from '([0-9a-f]{7,40})')
  into v_source_revision
  from public.workroom_evidence e
  where e.task_id = new.id
    and e.owner_id = new.owner_id
    and e.evidence_type = 'diff'
  order by e.evidence_sequence desc
  limit 1;

  select e.reference
  into v_deployment_url
  from public.workroom_evidence e
  where e.task_id = new.id
    and e.owner_id = new.owner_id
    and e.evidence_type = 'deployment'
  order by e.evidence_sequence desc
  limit 1;

  if new.completion_receipt ->> 'sourceRevision' is distinct from v_source_revision then
    raise exception 'completion gate: receipt source revision does not match verified diff evidence';
  end if;
  if new.completion_receipt ->> 'deploymentUrl' is distinct from v_deployment_url then
    raise exception 'completion gate: receipt deployment URL does not match verified deployment evidence';
  end if;

  return new;
end;
$$;

drop trigger if exists workroom_tasks_completion_gate on public.workroom_tasks;
create trigger workroom_tasks_completion_gate
before insert or update of status, specification, assigned_agent, completion_receipt,
  completion_fingerprint, verification_status, verified_at
on public.workroom_tasks
for each row execute function public.workroom_enforce_completion_gate();

create or replace function public.workroom_revoke_completion_on_evidence_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_task_id uuid := coalesce(new.task_id, old.task_id);
begin
  update public.workroom_tasks
  set status = 'review',
      completed_at = null,
      verified_at = null,
      verification_status = 'unverified',
      completion_receipt = null,
      completion_fingerprint = null,
      updated_at = clock_timestamp()
  where id = v_task_id and status = 'done';
  return coalesce(new, old);
end;
$$;

drop trigger if exists workroom_evidence_revokes_completion on public.workroom_evidence;
create trigger workroom_evidence_revokes_completion
after insert or update or delete on public.workroom_evidence
for each row execute function public.workroom_revoke_completion_on_evidence_change();

revoke execute on function public.workroom_enforce_completion_gate() from public, anon, authenticated;
revoke execute on function public.workroom_revoke_completion_on_evidence_change() from public, anon, authenticated;
