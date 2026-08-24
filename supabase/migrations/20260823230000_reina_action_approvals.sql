-- Reina action approvals: the record that a human said yes.
--
-- Reina has been read-only by construction. Making her able to act is not a
-- matter of removing a refusal -- it is a matter of adding the thing that makes
-- acting safe, and that thing lives HERE, in the database, not in the popup.
--
-- The rule this table enforces: an action executes at most once, and only after
-- a human approved that specific action. A confirmation dialog that only exists
-- in the browser protects nobody -- anything that can call the API skips it. So
-- the server refuses to execute without consuming a row from this table, and a
-- row can only be consumed once, by its owner, before it expires.
--
-- Modelled deliberately on reina_pilot_review_intents, which has been holding
-- the same shape of promise (issue once, consume once, owner-scoped, expiring)
-- for the one navigation intent Reina was already allowed to request.
--
-- Sends and payments have no undo. Everything here is built for that.

create table if not exists public.reina_action_approvals (
  approval_id text primary key,
  owner_principal_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id text not null,
  turn_id text not null,
  -- What she wants to do, and how much it matters. Sensitivity decides whether a
  -- human must approve at all; it is recorded per row so a later change to the
  -- rules cannot retroactively reclassify what was already approved.
  action_kind text not null,
  sensitivity text not null,
  -- The proposal as Reina wrote it. Kept even after execution: what she proposed
  -- and what was actually sent are different questions, and after the fact you
  -- need to be able to ask both.
  proposal jsonb not null,
  policy_reference jsonb not null,
  issued_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  -- Exactly one of these is set, ever.
  approved_at timestamptz,
  rejected_at timestamptz,
  -- The digest of what was ACTUALLY executed, which is not necessarily what was
  -- proposed -- the person can edit the draft in the approval popup before
  -- saying yes. Recording it is the only way to answer "what went out".
  executed_digest text,
  outcome text,

  constraint reina_action_approval_id_check check (
    char_length(approval_id) between 1 and 128
    and approval_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint reina_action_conversation_id_check check (
    char_length(conversation_id) between 1 and 128
    and conversation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint reina_action_turn_id_check check (
    char_length(turn_id) between 1 and 128
    and turn_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  -- An unknown action kind must be impossible to store, not merely unhandled.
  -- Widening Reina's reach should require a migration someone has to read.
  constraint reina_action_kind_check check (
    action_kind in ('send_email')
  ),
  constraint reina_action_sensitivity_check check (
    sensitivity in ('routine', 'comms', 'schedule', 'financial')
  ),
  constraint reina_action_expiry_check check (expires_at > issued_at),
  -- An approval is good for minutes, not hours. A yes given this morning must
  -- not still be spendable this afternoon.
  constraint reina_action_expiry_window_check check (
    expires_at <= issued_at + interval '30 minutes'
  ),
  constraint reina_action_outcome_check check (
    outcome is null or outcome in ('sent', 'failed')
  ),
  -- Approved and rejected are mutually exclusive.
  constraint reina_action_single_verdict_check check (
    approved_at is null or rejected_at is null
  ),
  -- Nothing can have been executed without having been approved.
  constraint reina_action_executed_needs_approval_check check (
    (executed_digest is null and outcome is null) or approved_at is not null
  ),
  constraint reina_action_digest_check check (
    executed_digest is null or executed_digest ~ '^[a-f0-9]{64}$'
  ),
  constraint reina_action_proposal_object_check check (
    jsonb_typeof(proposal) = 'object'
  ),
  constraint reina_action_policy_object_check check (
    jsonb_typeof(policy_reference) = 'object'
  )
);

create index if not exists reina_action_approvals_owner_issued_idx
  on public.reina_action_approvals (owner_principal_id, issued_at desc);

alter table public.reina_action_approvals enable row level security;

-- No direct table access for anyone. Every path goes through the functions
-- below, which are the only place the once-only rule can be enforced.
revoke all on table public.reina_action_approvals from public, anon, authenticated, service_role;

-- Issue: Reina proposes. This grants nothing on its own -- an issued approval
-- is a question, not permission.
create or replace function public.reina_action_issue_approval(
  p_owner_principal_id uuid,
  p_conversation_id text,
  p_turn_id text,
  p_approval_id text,
  p_action_kind text,
  p_sensitivity text,
  p_proposal jsonb,
  p_expires_at timestamptz,
  p_policy_reference jsonb,
  p_deadline_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_owner_principal_id is null
    or p_conversation_id is null
    or p_turn_id is null
    or p_approval_id is null
    or p_action_kind is null
    or p_sensitivity is null
    or jsonb_typeof(p_proposal) <> 'object'
    or jsonb_typeof(p_policy_reference) <> 'object'
    or p_expires_at is null
    or p_expires_at <= v_now
    or p_expires_at > v_now + interval '30 minutes'
    or not public.reina_pilot_prepare_deadline(p_deadline_at) then
    return jsonb_build_object('status', 'invalid');
  end if;

  begin
    insert into public.reina_action_approvals (
      approval_id, owner_principal_id, conversation_id, turn_id,
      action_kind, sensitivity, proposal, policy_reference, expires_at
    ) values (
      p_approval_id, p_owner_principal_id, p_conversation_id, p_turn_id,
      p_action_kind, p_sensitivity, p_proposal, p_policy_reference, p_expires_at
    );
  exception
    when unique_violation then return jsonb_build_object('status', 'duplicate');
    when check_violation then return jsonb_build_object('status', 'invalid');
    when foreign_key_violation then return jsonb_build_object('status', 'invalid');
  end;

  return jsonb_build_object(
    'status', 'issued',
    'approvalId', p_approval_id,
    'expiresAt', p_expires_at
  );
end;
$$;

-- Consume: the human said yes, and this is the single moment that can be true.
-- Returns 'consumed' exactly once for a given approval, ever. Every later call
-- for the same approval returns 'duplicate', including one racing it in another
-- transaction -- the row is locked for update before the verdict is read.
create or replace function public.reina_action_consume_approval(
  p_owner_principal_id uuid,
  p_approval_id text,
  p_executed_digest text,
  p_policy_reference jsonb,
  p_deadline_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_row public.reina_action_approvals%rowtype;
  v_now timestamptz := clock_timestamp();
  v_count integer;
begin
  if p_owner_principal_id is null
    or p_approval_id is null
    or p_executed_digest !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_policy_reference) <> 'object'
    or not public.reina_pilot_prepare_deadline(p_deadline_at) then
    return jsonb_build_object('status', 'invalid');
  end if;

  select * into v_row
  from public.reina_action_approvals a
  where a.approval_id = p_approval_id
  for update;

  if not found then return jsonb_build_object('status', 'not_found'); end if;
  -- Owner mismatch is reported as not_found on purpose: whether some other
  -- account holds this id is not information a caller should be able to probe.
  if v_row.owner_principal_id <> p_owner_principal_id then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.rejected_at is not null then return jsonb_build_object('status', 'rejected'); end if;
  if v_row.approved_at is not null then return jsonb_build_object('status', 'duplicate'); end if;
  if v_row.expires_at <= v_now then return jsonb_build_object('status', 'expired'); end if;

  update public.reina_action_approvals
  set approved_at = v_now,
      executed_digest = p_executed_digest
  where approval_id = p_approval_id
    and approved_at is null
    and rejected_at is null
    and expires_at > v_now;
  get diagnostics v_count = row_count;
  if v_count <> 1 then return jsonb_build_object('status', 'duplicate'); end if;

  return jsonb_build_object(
    'status', 'consumed',
    'approvalId', p_approval_id,
    'actionKind', v_row.action_kind,
    'sensitivity', v_row.sensitivity,
    'conversationId', v_row.conversation_id,
    'turnId', v_row.turn_id
  );
end;
$$;

-- Record what happened after execution. Separate from consume so that a send
-- which fails at the SMTP server is still visibly a send that was attempted --
-- the approval was spent either way, and it must not become spendable again.
create or replace function public.reina_action_record_outcome(
  p_owner_principal_id uuid,
  p_approval_id text,
  p_outcome text,
  p_deadline_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_count integer;
begin
  if p_owner_principal_id is null
    or p_approval_id is null
    or p_outcome not in ('sent', 'failed')
    or not public.reina_pilot_prepare_deadline(p_deadline_at) then
    return jsonb_build_object('status', 'invalid');
  end if;

  update public.reina_action_approvals
  set outcome = p_outcome
  where approval_id = p_approval_id
    and owner_principal_id = p_owner_principal_id
    and approved_at is not null
    and outcome is null;
  get diagnostics v_count = row_count;
  if v_count <> 1 then return jsonb_build_object('status', 'not_found'); end if;
  return jsonb_build_object('status', 'recorded', 'approvalId', p_approval_id);
end;
$$;

-- Reject: the human said no. Terminal, and it cannot be walked back into a yes.
create or replace function public.reina_action_reject_approval(
  p_owner_principal_id uuid,
  p_approval_id text,
  p_deadline_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_count integer;
begin
  if p_owner_principal_id is null
    or p_approval_id is null
    or not public.reina_pilot_prepare_deadline(p_deadline_at) then
    return jsonb_build_object('status', 'invalid');
  end if;

  update public.reina_action_approvals
  set rejected_at = clock_timestamp()
  where approval_id = p_approval_id
    and owner_principal_id = p_owner_principal_id
    and approved_at is null
    and rejected_at is null;
  get diagnostics v_count = row_count;
  if v_count <> 1 then return jsonb_build_object('status', 'not_found'); end if;
  return jsonb_build_object('status', 'rejected', 'approvalId', p_approval_id);
end;
$$;

revoke all on function public.reina_action_issue_approval(uuid, text, text, text, text, text, jsonb, timestamptz, jsonb, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.reina_action_consume_approval(uuid, text, text, jsonb, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.reina_action_record_outcome(uuid, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.reina_action_reject_approval(uuid, text, timestamptz) from public, anon, authenticated, service_role;

grant execute on function public.reina_action_issue_approval(uuid, text, text, text, text, text, jsonb, timestamptz, jsonb, timestamptz) to service_role;
grant execute on function public.reina_action_consume_approval(uuid, text, text, jsonb, timestamptz) to service_role;
grant execute on function public.reina_action_record_outcome(uuid, text, text, timestamptz) to service_role;
grant execute on function public.reina_action_reject_approval(uuid, text, timestamptz) to service_role;
