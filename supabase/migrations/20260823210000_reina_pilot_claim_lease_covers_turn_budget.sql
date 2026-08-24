-- Reina pilot: the turn's claim lease must be allowed to last as long as the
-- turn does.
--
-- This function rejected any attempt lease longer than 15 seconds. That matched
-- the route's total budget exactly, so it never showed -- until 2026-08-23,
-- when the budget went to 40s so a high reasoning-effort answer could finish.
-- Every claim then came back 'incomplete', the route answered 409, and the
-- panel said Reina was unavailable. Worse than the bug it was fixing: before,
-- only the slow questions failed; after, every question did, and no turn row
-- was written at all, so the failure left no trace in reina_pilot_turns.
--
-- 60 seconds matches MAX_ATTEMPT_LEASE_MS in
-- api/_lib/reina/supabase-conversation-store.js and the 60s maxDuration on the
-- function in vercel.json. The lease still has to expire -- it is what lets an
-- abandoned turn be reclaimed -- it just has to outlive a real turn first.
--
-- Body is otherwise byte-identical to
-- 20260816024009_reina_pilot_claim_turn_self_heal_conversation.sql.
-- Replaces the function only. No schema change, no data migration.

create or replace function public.reina_pilot_claim_turn(
  p_owner_principal_id uuid,
  p_conversation_id text,
  p_idempotency_key text,
  p_input_digest text,
  p_append_policy_reference jsonb,
  p_replay_read_policy_reference jsonb,
  p_deadline_at timestamptz,
  p_attempt_deadline_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_turn public.reina_pilot_turns%rowtype;
  v_other public.reina_pilot_turns%rowtype;
  v_claim uuid;
  v_assistant public.reina_pilot_messages%rowtype;
  v_now timestamptz := clock_timestamp();
  v_count integer;
begin
  if p_owner_principal_id is null
    or p_conversation_id is null
    or p_idempotency_key is null
    or p_input_digest !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_append_policy_reference) <> 'object'
    or jsonb_typeof(p_replay_read_policy_reference) <> 'object'
    or not public.reina_pilot_prepare_deadline(p_deadline_at)
    or p_attempt_deadline_at is null
    or p_attempt_deadline_at < p_deadline_at
    or p_attempt_deadline_at <= v_now
    or p_attempt_deadline_at > v_now + interval '60 seconds' then
    return jsonb_build_object('status', 'incomplete');
  end if;

  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_principal_id::text || ':' || char_length(p_conversation_id)::text || ':' || p_conversation_id,
    0
  )) or clock_timestamp() >= p_deadline_at then
    return jsonb_build_object('status', 'incomplete');
  end if;
  v_now := clock_timestamp();

  select * into v_turn
  from public.reina_pilot_turns t
  where t.owner_principal_id = p_owner_principal_id
    and t.conversation_id = p_conversation_id
    and t.idempotency_key = p_idempotency_key
  for update;

  v_now := clock_timestamp();
  if v_now >= p_deadline_at then
    return jsonb_build_object('status', 'incomplete');
  end if;
  if found then
    if v_turn.input_digest <> p_input_digest then
      return jsonb_build_object('status', 'conflict');
    end if;
    if v_turn.state = 'completed' then
      select * into v_assistant
      from public.reina_pilot_messages m
      where m.message_id = v_turn.assistant_message_id
        and m.owner_principal_id = p_owner_principal_id
        and m.conversation_id = p_conversation_id;
      if not found then return jsonb_build_object('status', 'incomplete'); end if;
      return jsonb_build_object(
        'status', 'replay',
        'result', jsonb_build_object(
          'ownerPrincipalId', p_owner_principal_id::text,
          'conversationId', p_conversation_id,
          'idempotencyKey', p_idempotency_key,
          'inputDigest', v_turn.input_digest,
          'userMessageId', v_turn.user_message_id::text,
          'userMessageSequence', v_turn.user_message_sequence,
          'assistantMessage', jsonb_build_object(
            'messageId', v_assistant.message_id::text,
            'sequence', v_assistant.sequence,
            'role', v_assistant.role,
            'content', v_assistant.content,
            'contentDigest', v_assistant.content_digest
          ),
          'resultReference', v_turn.result_reference::text,
          'policyReference', v_turn.completion_policy_reference
        )
      );
    end if;
    if v_turn.state = 'in_flight' and v_turn.lease_expires_at > v_now then
      return jsonb_build_object('status', 'in_flight');
    end if;
    if v_turn.state = 'failed_terminal' then
      return jsonb_build_object('status', 'failed');
    end if;
    if v_turn.state = 'in_flight' and (v_turn.lease_expires_at is null or v_turn.lease_expires_at <= v_now) then
      update public.reina_pilot_turns
      set state = 'failed_retryable', lease_expires_at = null, updated_at = v_now
      where owner_principal_id = p_owner_principal_id
        and conversation_id = p_conversation_id
        and idempotency_key = p_idempotency_key
        and clock_timestamp() < p_deadline_at;
      get diagnostics v_count = row_count;
      if v_count <> 1 then
        raise exception using errcode = '57014', message = 'reina_pilot_deadline';
      end if;
      v_turn.state := 'failed_retryable';
    end if;
    if v_turn.state = 'failed_retryable' then
      v_claim := extensions.gen_random_uuid();
      update public.reina_pilot_turns
      set claim_id = v_claim,
          state = 'in_flight',
          lease_expires_at = p_attempt_deadline_at,
          append_policy_reference = p_append_policy_reference,
          replay_read_policy_reference = p_replay_read_policy_reference,
          failure_stage = null,
          failure_reason_code = null,
          failure_policy_reference = null,
          updated_at = v_now
      where owner_principal_id = p_owner_principal_id
        and conversation_id = p_conversation_id
        and idempotency_key = p_idempotency_key
        and clock_timestamp() < p_deadline_at;
      get diagnostics v_count = row_count;
      if v_count <> 1 or clock_timestamp() >= p_deadline_at then
        raise exception using errcode = '57014', message = 'reina_pilot_deadline';
      end if;
      return jsonb_build_object(
        'status', 'resumed',
        'claimId', v_claim::text,
        'progress', case when v_turn.user_message_id is null then 'claimed' else 'user_persisted' end
      );
    end if;
    return jsonb_build_object('status', 'incomplete');
  end if;

  select * into v_other
  from public.reina_pilot_turns t
  where t.owner_principal_id = p_owner_principal_id
    and t.conversation_id = p_conversation_id
    and t.state <> 'completed'
  limit 1
  for update;
  v_now := clock_timestamp();
  if v_now >= p_deadline_at then
    return jsonb_build_object('status', 'incomplete');
  end if;
  if found then
    if v_other.state = 'in_flight' and v_other.lease_expires_at > v_now then
      return jsonb_build_object('status', 'in_flight');
    end if;
    if v_other.state = 'failed_terminal' then return jsonb_build_object('status', 'failed'); end if;
    -- A failed_retryable attempt (or an in_flight one whose lease has lapsed)
    -- resumes only under its OWN idempotency key, which is handled earlier in
    -- this function. Reaching here means a DIFFERENT key -- a new utterance --
    -- so the earlier attempt was abandoned by the client.
    --
    -- This used to `return 'incomplete'`, the route answered 409, and the panel
    -- reported the pilot as unavailable. Nothing could ever clear the row:
    -- mark_turn_failed sets lease_expires_at to null, so no lease reclaimed it,
    -- and the UI mints a fresh turnId (hence a fresh key) after every reload, so
    -- the same-key resume path was unreachable. One model failure therefore
    -- bricked that user's Reina permanently -- chris@ghgrp.net was stuck this
    -- way from 2026-08-08 until this migration.
    --
    -- Retire the abandoned attempt and let the new turn proceed. failed_terminal
    -- is deliberately untouched above: a terminal failure still stops the
    -- conversation. The conversation's messages live in reina_pilot_messages and
    -- are unaffected; this table is the claim ledger.
    with retired as (
      delete from public.reina_pilot_turns t
      where t.owner_principal_id = p_owner_principal_id
        and t.conversation_id = p_conversation_id
        and t.state not in ('completed', 'failed_terminal')
      returning t.idempotency_key
    )
    delete from public.reina_pilot_messages m
    using retired r
    where m.owner_principal_id = p_owner_principal_id
      and m.conversation_id = p_conversation_id
      and m.idempotency_key = r.idempotency_key;

    -- A user message with no assistant reply leaves next_sequence even, and
    -- append_user_once() requires it odd (user messages are odd, assistant
    -- even). That was a second permanent wedge sitting behind the first:
    -- USER_MESSAGE_PERSIST_FAILED on every turn. Resynchronise the counter to
    -- whatever actually survived.
    update public.reina_pilot_conversations c
    set next_sequence = coalesce((
          select max(m.sequence) from public.reina_pilot_messages m
          where m.owner_principal_id = p_owner_principal_id
            and m.conversation_id = p_conversation_id
        ), 0) + 1,
        updated_at = v_now
    where c.owner_principal_id = p_owner_principal_id
      and c.conversation_id = p_conversation_id;

    if clock_timestamp() >= p_deadline_at then
      raise exception using errcode = '57014', message = 'reina_pilot_deadline';
    end if;
  end if;

  v_claim := extensions.gen_random_uuid();
  insert into public.reina_pilot_turns (
    owner_principal_id, conversation_id, idempotency_key, input_digest,
    claim_id, state, lease_expires_at,
    append_policy_reference, replay_read_policy_reference
  ) select
    p_owner_principal_id, p_conversation_id, p_idempotency_key, p_input_digest,
    v_claim, 'in_flight', p_attempt_deadline_at,
    p_append_policy_reference, p_replay_read_policy_reference
  where clock_timestamp() < p_deadline_at;
  get diagnostics v_count = row_count;
  if v_count <> 1 or clock_timestamp() >= p_deadline_at then
    raise exception using errcode = '57014', message = 'reina_pilot_deadline';
  end if;
  return jsonb_build_object('status', 'claimed', 'claimId', v_claim::text, 'progress', 'claimed');
end;
$$;
