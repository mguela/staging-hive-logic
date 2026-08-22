-- Reina pilot durable conversation store (proposal only; do not apply as part
-- of the RC review). The browser never receives database credentials and never
-- calls these tables/functions directly. Every operation is performed by the
-- authenticated server route with the service role after ActingContext policy.

begin;

create table if not exists public.reina_pilot_conversations (
  owner_principal_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id text not null,
  next_sequence integer not null default 1,
  created_policy_reference jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (owner_principal_id, conversation_id),
  constraint reina_pilot_conversation_id_check check (
    char_length(conversation_id) between 1 and 128
    and conversation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint reina_pilot_conversation_sequence_check check (
    next_sequence between 1 and 201
  ),
  constraint reina_pilot_conversation_policy_check check (
    jsonb_typeof(created_policy_reference) = 'object'
  )
);

create table if not exists public.reina_pilot_turns (
  owner_principal_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id text not null,
  idempotency_key text not null,
  input_digest text not null,
  claim_id uuid not null,
  state text not null,
  lease_expires_at timestamptz,
  append_policy_reference jsonb not null,
  replay_read_policy_reference jsonb not null,
  user_message_id uuid,
  user_message_sequence integer,
  assistant_message_id uuid,
  result_reference uuid,
  completion_policy_reference jsonb,
  failure_stage text,
  failure_reason_code text,
  failure_policy_reference jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  primary key (owner_principal_id, conversation_id, idempotency_key),
  constraint reina_pilot_turn_conversation_id_check check (
    char_length(conversation_id) between 1 and 128
    and conversation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint reina_pilot_turn_idempotency_key_check check (
    char_length(idempotency_key) between 1 and 128
    and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint reina_pilot_turn_input_digest_check check (input_digest ~ '^[a-f0-9]{64}$'),
  constraint reina_pilot_turn_state_check check (
    state in ('in_flight', 'failed_retryable', 'failed_terminal', 'completed')
  ),
  constraint reina_pilot_turn_policy_check check (
    jsonb_typeof(append_policy_reference) = 'object'
    and jsonb_typeof(replay_read_policy_reference) = 'object'
    and (completion_policy_reference is null or jsonb_typeof(completion_policy_reference) = 'object')
    and (failure_policy_reference is null or jsonb_typeof(failure_policy_reference) = 'object')
  ),
  constraint reina_pilot_turn_completion_check check (
    (state = 'completed'
      and user_message_id is not null
      and user_message_sequence is not null
      and assistant_message_id is not null
      and result_reference is not null
      and completion_policy_reference is not null
      and completed_at is not null
      and lease_expires_at is null)
    or state <> 'completed'
  )
);

-- The durable core claims before it loads/creates a conversation. Therefore a
-- turn intentionally has no conversation FK until its first message is stored.
create unique index if not exists reina_pilot_one_unresolved_turn_idx
  on public.reina_pilot_turns (owner_principal_id, conversation_id)
  where state <> 'completed';

create table if not exists public.reina_pilot_messages (
  message_id uuid primary key,
  owner_principal_id uuid not null,
  conversation_id text not null,
  idempotency_key text not null,
  sequence integer not null,
  role text not null,
  content text not null,
  content_digest text not null,
  policy_reference jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint reina_pilot_messages_conversation_fk foreign key (owner_principal_id, conversation_id)
    references public.reina_pilot_conversations(owner_principal_id, conversation_id) on delete cascade,
  constraint reina_pilot_messages_turn_fk foreign key (owner_principal_id, conversation_id, idempotency_key)
    references public.reina_pilot_turns(owner_principal_id, conversation_id, idempotency_key) on delete cascade,
  constraint reina_pilot_messages_sequence_unique unique (owner_principal_id, conversation_id, sequence),
  constraint reina_pilot_messages_turn_role_unique unique (owner_principal_id, conversation_id, idempotency_key, role),
  constraint reina_pilot_messages_role_check check (role in ('user', 'assistant')),
  constraint reina_pilot_messages_sequence_check check (sequence between 1 and 200),
  constraint reina_pilot_messages_content_check check (
    char_length(content) between 1 and 100000
    and octet_length(content) <= 400000
  ),
  constraint reina_pilot_messages_digest_check check (content_digest ~ '^[a-f0-9]{64}$'),
  constraint reina_pilot_messages_policy_check check (jsonb_typeof(policy_reference) = 'object')
);

create table if not exists public.reina_pilot_review_intents (
  intent_id text primary key,
  owner_principal_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id text not null,
  turn_id text not null,
  expires_at timestamptz not null,
  policy_reference jsonb not null,
  issued_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz,
  constraint reina_pilot_review_intents_turn_unique
    unique (owner_principal_id, conversation_id, turn_id),
  constraint reina_pilot_review_intent_id_check check (
    char_length(intent_id) between 1 and 128
    and intent_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint reina_pilot_review_conversation_id_check check (
    char_length(conversation_id) between 1 and 128
    and conversation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint reina_pilot_review_turn_id_check check (
    char_length(turn_id) between 1 and 128
    and turn_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint reina_pilot_review_expiry_check check (
    expires_at > issued_at
    and expires_at <= issued_at + interval '10 minutes'
  ),
  constraint reina_pilot_review_consumption_check check (
    consumed_at is null or (consumed_at >= issued_at and consumed_at < expires_at)
  ),
  constraint reina_pilot_review_policy_check check (jsonb_typeof(policy_reference) = 'object')
);

create index if not exists reina_pilot_messages_history_idx
  on public.reina_pilot_messages (owner_principal_id, conversation_id, sequence);

alter table public.reina_pilot_conversations enable row level security;
alter table public.reina_pilot_turns enable row level security;
alter table public.reina_pilot_messages enable row level security;
alter table public.reina_pilot_review_intents enable row level security;

revoke all on public.reina_pilot_conversations from public, anon, authenticated, service_role;
revoke all on public.reina_pilot_turns from public, anon, authenticated, service_role;
revoke all on public.reina_pilot_messages from public, anon, authenticated, service_role;
revoke all on public.reina_pilot_review_intents from public, anon, authenticated, service_role;

-- Every RPC receives the server's absolute transport deadline. The local lock
-- timeout prevents a database lock wait from continuing after that deadline;
-- explicit checks after lock acquisition prevent a late mutation/commit.
create or replace function public.reina_pilot_prepare_deadline(
  p_deadline_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_remaining_ms integer;
begin
  if p_deadline_at is null
    or p_deadline_at <= v_now
    or p_deadline_at > v_now + interval '15 seconds' then
    return false;
  end if;
  v_remaining_ms := greatest(
    1,
    floor(extract(epoch from (p_deadline_at - v_now)) * 1000)::integer
  );
  perform pg_catalog.set_config('lock_timeout', v_remaining_ms::text || 'ms', true);
  return true;
end;
$$;

revoke all on function public.reina_pilot_prepare_deadline(timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.reina_pilot_issue_review_intent(
  p_owner_principal_id uuid,
  p_conversation_id text,
  p_turn_id text,
  p_intent_id text,
  p_expires_at timestamptz,
  p_policy_reference jsonb,
  p_deadline_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_now timestamptz;
  v_count integer;
  v_expected_policy constant jsonb := jsonb_build_object(
    'kind', 'reina_ui_confirmation_policy',
    'policyVersion', 'reina-acting-context-policy-v1',
    'operation', 'reina.pilot.access',
    'capability', 'reina:pilot:access',
    'resource', 'pilot_runtime',
    'effect', 'access',
    'ownerScope', 'principal',
    'ownerPrincipalId', p_owner_principal_id::text
  );
begin
  if p_owner_principal_id is null
    or p_conversation_id is null
    or p_conversation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_turn_id is null
    or p_turn_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_intent_id is null
    or p_intent_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_expires_at is null
    or p_policy_reference is null
    or jsonb_typeof(p_policy_reference) <> 'object'
    or not public.reina_pilot_prepare_deadline(p_deadline_at) then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_policy_reference <> v_expected_policy then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_now := clock_timestamp();
  if v_now >= p_deadline_at
    or p_expires_at <= v_now
    or p_expires_at > v_now + interval '10 minutes' then
    return jsonb_build_object('status', 'invalid');
  end if;

  insert into public.reina_pilot_review_intents (
    intent_id, owner_principal_id, conversation_id, turn_id, expires_at,
    policy_reference, issued_at
  )
  select
    p_intent_id, p_owner_principal_id, p_conversation_id, p_turn_id,
    p_expires_at, p_policy_reference, v_now
  where clock_timestamp() < p_deadline_at
  on conflict do nothing;
  get diagnostics v_count = row_count;
  if clock_timestamp() >= p_deadline_at then
    raise exception using errcode = '57014', message = 'reina_pilot_deadline';
  end if;
  if v_count <> 1 then
    return jsonb_build_object('status', 'invalid');
  end if;
  return jsonb_build_object(
    'status', 'issued',
    'intentId', p_intent_id,
    'expiresAt', to_char(
      p_expires_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );
end;
$$;

create or replace function public.reina_pilot_consume_review_intent(
  p_owner_principal_id uuid,
  p_conversation_id text,
  p_intent_id text,
  p_policy_reference jsonb,
  p_deadline_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_intent public.reina_pilot_review_intents%rowtype;
  v_now timestamptz;
  v_count integer;
  v_found boolean;
  v_expected_policy constant jsonb := jsonb_build_object(
    'kind', 'reina_ui_confirmation_policy',
    'policyVersion', 'reina-acting-context-policy-v1',
    'operation', 'reina.pilot.access',
    'capability', 'reina:pilot:access',
    'resource', 'pilot_runtime',
    'effect', 'access',
    'ownerScope', 'principal',
    'ownerPrincipalId', p_owner_principal_id::text
  );
begin
  if p_owner_principal_id is null
    or p_conversation_id is null
    or p_conversation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_intent_id is null
    or p_intent_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_policy_reference is null
    or jsonb_typeof(p_policy_reference) <> 'object'
    or not public.reina_pilot_prepare_deadline(p_deadline_at) then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_policy_reference <> v_expected_policy then
    return jsonb_build_object('status', 'policy_mismatch');
  end if;

  select * into v_intent
  from public.reina_pilot_review_intents i
  where i.intent_id = p_intent_id
  for update;
  v_found := found;

  if clock_timestamp() >= p_deadline_at then
    raise exception using errcode = '57014', message = 'reina_pilot_deadline';
  end if;
  if not v_found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_intent.owner_principal_id <> p_owner_principal_id then
    return jsonb_build_object('status', 'owner_mismatch');
  end if;
  if v_intent.conversation_id <> p_conversation_id then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_intent.policy_reference <> p_policy_reference then
    return jsonb_build_object('status', 'policy_mismatch');
  end if;

  v_now := clock_timestamp();
  if v_intent.consumed_at is not null then
    return jsonb_build_object('status', 'duplicate');
  end if;
  if v_intent.expires_at <= v_now then
    return jsonb_build_object('status', 'expired');
  end if;

  update public.reina_pilot_review_intents
  set consumed_at = v_now
  where intent_id = p_intent_id
    and consumed_at is null
    and expires_at > clock_timestamp()
    and clock_timestamp() < p_deadline_at;
  get diagnostics v_count = row_count;
  if clock_timestamp() >= p_deadline_at then
    raise exception using errcode = '57014', message = 'reina_pilot_deadline';
  end if;
  if v_count <> 1 then
    if v_intent.expires_at <= clock_timestamp() then
      return jsonb_build_object('status', 'expired');
    end if;
    return jsonb_build_object('status', 'invalid');
  end if;
  return jsonb_build_object('status', 'consumed', 'intentId', p_intent_id);
end;
$$;

create or replace function public.reina_pilot_load_conversation(
  p_owner_principal_id uuid,
  p_conversation_id text,
  p_policy_reference jsonb,
  p_deadline_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if p_owner_principal_id is null
    or p_conversation_id is null
    or jsonb_typeof(p_policy_reference) <> 'object'
    or not public.reina_pilot_prepare_deadline(p_deadline_at) then
    return jsonb_build_object('status', 'invalid');
  end if;
  if exists (
    select 1 from public.reina_pilot_conversations c
    where c.owner_principal_id = p_owner_principal_id
      and c.conversation_id = p_conversation_id
  ) then
    return jsonb_build_object(
      'status', 'found',
      'conversation', jsonb_build_object(
        'ownerPrincipalId', p_owner_principal_id::text,
        'conversationId', p_conversation_id
      )
    );
  end if;
  return jsonb_build_object('status', 'not_found');
end;
$$;

create or replace function public.reina_pilot_create_conversation(
  p_owner_principal_id uuid,
  p_conversation_id text,
  p_policy_reference jsonb,
  p_deadline_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_inserted integer;
begin
  if p_owner_principal_id is null
    or p_conversation_id is null
    or jsonb_typeof(p_policy_reference) <> 'object'
    or not public.reina_pilot_prepare_deadline(p_deadline_at) then
    return jsonb_build_object('status', 'invalid');
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_principal_id::text || ':' || char_length(p_conversation_id)::text || ':' || p_conversation_id,
    0
  )) or clock_timestamp() >= p_deadline_at then
    return jsonb_build_object('status', 'invalid');
  end if;
  insert into public.reina_pilot_conversations (
    owner_principal_id, conversation_id, created_policy_reference
  ) select
    p_owner_principal_id, p_conversation_id, p_policy_reference
  where clock_timestamp() < p_deadline_at
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if clock_timestamp() >= p_deadline_at then
    raise exception using errcode = '57014', message = 'reina_pilot_deadline';
  end if;
  if v_inserted = 1 then
    return jsonb_build_object(
      'status', 'created',
      'conversation', jsonb_build_object(
        'ownerPrincipalId', p_owner_principal_id::text,
        'conversationId', p_conversation_id
      )
    );
  end if;
  return jsonb_build_object('status', 'exists');
end;
$$;

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
    or p_attempt_deadline_at > v_now + interval '15 seconds' then
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
    return jsonb_build_object('status', 'incomplete');
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

create or replace function public.reina_pilot_append_user_once(
  p_owner_principal_id uuid,
  p_conversation_id text,
  p_idempotency_key text,
  p_input_digest text,
  p_claim_id uuid,
  p_content text,
  p_content_digest text,
  p_policy_reference jsonb,
  p_deadline_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_turn public.reina_pilot_turns%rowtype;
  v_conversation public.reina_pilot_conversations%rowtype;
  v_message public.reina_pilot_messages%rowtype;
  v_message_id uuid;
  v_count integer;
begin
  if p_owner_principal_id is null
    or p_conversation_id is null
    or p_idempotency_key is null
    or p_claim_id is null
    or p_content is null
    or p_content_digest !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_policy_reference) <> 'object'
    or not public.reina_pilot_prepare_deadline(p_deadline_at) then
    return jsonb_build_object('status', 'invalid');
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_principal_id::text || ':' || char_length(p_conversation_id)::text || ':' || p_conversation_id,
    0
  )) or clock_timestamp() >= p_deadline_at then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into v_turn from public.reina_pilot_turns t
  where t.owner_principal_id = p_owner_principal_id
    and t.conversation_id = p_conversation_id
    and t.idempotency_key = p_idempotency_key
  for update;
  if clock_timestamp() >= p_deadline_at
    or not found
    or v_turn.input_digest <> p_input_digest
    or v_turn.claim_id <> p_claim_id
    or v_turn.state <> 'in_flight'
    or v_turn.lease_expires_at is null
    or v_turn.lease_expires_at <= clock_timestamp() then
    return jsonb_build_object('status', 'invalid');
  end if;
  if v_turn.user_message_id is not null then
    select * into v_message from public.reina_pilot_messages m
    where m.message_id = v_turn.user_message_id;
    if not found or v_message.content <> p_content or v_message.content_digest <> p_content_digest then
      return jsonb_build_object('status', 'invalid');
    end if;
    return jsonb_build_object(
      'status', 'existing',
      'ownerPrincipalId', p_owner_principal_id::text,
      'conversationId', p_conversation_id,
      'message', jsonb_build_object(
        'messageId', v_message.message_id::text,
        'sequence', v_message.sequence,
        'role', v_message.role,
        'content', v_message.content,
        'contentDigest', v_message.content_digest
      )
    );
  end if;

  select * into v_conversation from public.reina_pilot_conversations c
  where c.owner_principal_id = p_owner_principal_id
    and c.conversation_id = p_conversation_id
  for update;
  if clock_timestamp() >= p_deadline_at
    or not found
    or mod(v_conversation.next_sequence, 2) <> 1 then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_message_id := extensions.gen_random_uuid();
  insert into public.reina_pilot_messages (
    message_id, owner_principal_id, conversation_id, idempotency_key,
    sequence, role, content, content_digest, policy_reference
  ) select
    v_message_id, p_owner_principal_id, p_conversation_id, p_idempotency_key,
    v_conversation.next_sequence, 'user', p_content, p_content_digest, p_policy_reference
  where clock_timestamp() < p_deadline_at;
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception using errcode = '57014', message = 'reina_pilot_deadline';
  end if;
  update public.reina_pilot_conversations
  set next_sequence = next_sequence + 1, updated_at = clock_timestamp()
  where owner_principal_id = p_owner_principal_id
    and conversation_id = p_conversation_id
    and clock_timestamp() < p_deadline_at;
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception using errcode = '57014', message = 'reina_pilot_deadline';
  end if;
  update public.reina_pilot_turns
  set user_message_id = v_message_id,
      user_message_sequence = v_conversation.next_sequence,
      updated_at = clock_timestamp()
  where owner_principal_id = p_owner_principal_id
    and conversation_id = p_conversation_id
    and idempotency_key = p_idempotency_key
    and claim_id = p_claim_id
    and state = 'in_flight'
    and clock_timestamp() < p_deadline_at;
  get diagnostics v_count = row_count;
  if v_count <> 1 or clock_timestamp() >= p_deadline_at then
    raise exception using errcode = '57014', message = 'reina_pilot_deadline';
  end if;

  return jsonb_build_object(
    'status', 'appended',
    'ownerPrincipalId', p_owner_principal_id::text,
    'conversationId', p_conversation_id,
    'message', jsonb_build_object(
      'messageId', v_message_id::text,
      'sequence', v_conversation.next_sequence,
      'role', 'user',
      'content', p_content,
      'contentDigest', p_content_digest
    )
  );
end;
$$;

create or replace function public.reina_pilot_load_history(
  p_owner_principal_id uuid,
  p_conversation_id text,
  p_through_message_id uuid,
  p_policy_reference jsonb,
  p_deadline_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_through_sequence integer;
  v_count integer;
  v_bytes bigint;
  v_messages jsonb;
begin
  if p_owner_principal_id is null
    or p_conversation_id is null
    or p_through_message_id is null
    or jsonb_typeof(p_policy_reference) <> 'object'
    or not public.reina_pilot_prepare_deadline(p_deadline_at) then
    return jsonb_build_object('status', 'invalid');
  end if;
  select m.sequence into v_through_sequence from public.reina_pilot_messages m
  where m.owner_principal_id = p_owner_principal_id
    and m.conversation_id = p_conversation_id
    and m.message_id = p_through_message_id;
  if not found or clock_timestamp() >= p_deadline_at then
    return jsonb_build_object('status', 'invalid');
  end if;
  select count(*), coalesce(sum(octet_length(m.content)), 0)
  into v_count, v_bytes
  from public.reina_pilot_messages m
  where m.owner_principal_id = p_owner_principal_id
    and m.conversation_id = p_conversation_id
    and m.sequence <= v_through_sequence;
  if v_count < 1
    or v_count > 200
    or v_bytes > 1000000
    or clock_timestamp() >= p_deadline_at then
    return jsonb_build_object('status', 'invalid');
  end if;
  select jsonb_agg(jsonb_build_object(
    'messageId', m.message_id::text,
    'sequence', m.sequence,
    'role', m.role,
    'content', m.content,
    'contentDigest', m.content_digest
  ) order by m.sequence) into v_messages
  from public.reina_pilot_messages m
  where m.owner_principal_id = p_owner_principal_id
    and m.conversation_id = p_conversation_id
    and m.sequence <= v_through_sequence;
  if clock_timestamp() >= p_deadline_at then
    return jsonb_build_object('status', 'invalid');
  end if;
  return jsonb_build_object(
    'status', 'loaded',
    'ownerPrincipalId', p_owner_principal_id::text,
    'conversationId', p_conversation_id,
    'messages', v_messages
  );
end;
$$;

create or replace function public.reina_pilot_append_assistant_and_complete(
  p_owner_principal_id uuid,
  p_conversation_id text,
  p_idempotency_key text,
  p_input_digest text,
  p_claim_id uuid,
  p_user_message_id uuid,
  p_user_message_sequence integer,
  p_content text,
  p_content_digest text,
  p_policy_reference jsonb,
  p_deadline_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_turn public.reina_pilot_turns%rowtype;
  v_conversation public.reina_pilot_conversations%rowtype;
  v_assistant_id uuid;
  v_result_id uuid;
  v_count integer;
begin
  if p_owner_principal_id is null
    or p_conversation_id is null
    or p_idempotency_key is null
    or p_claim_id is null
    or p_user_message_id is null
    or p_content is null
    or p_content_digest !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_policy_reference) <> 'object'
    or not public.reina_pilot_prepare_deadline(p_deadline_at) then
    return jsonb_build_object('status', 'invalid');
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_principal_id::text || ':' || char_length(p_conversation_id)::text || ':' || p_conversation_id,
    0
  )) or clock_timestamp() >= p_deadline_at then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into v_turn from public.reina_pilot_turns t
  where t.owner_principal_id = p_owner_principal_id
    and t.conversation_id = p_conversation_id
    and t.idempotency_key = p_idempotency_key
  for update;
  if clock_timestamp() >= p_deadline_at
    or not found
    or v_turn.input_digest <> p_input_digest
    or v_turn.claim_id <> p_claim_id
    or v_turn.state <> 'in_flight'
    or v_turn.lease_expires_at is null
    or v_turn.lease_expires_at <= clock_timestamp()
    or v_turn.user_message_id <> p_user_message_id
    or v_turn.user_message_sequence <> p_user_message_sequence then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into v_conversation from public.reina_pilot_conversations c
  where c.owner_principal_id = p_owner_principal_id
    and c.conversation_id = p_conversation_id
  for update;
  if clock_timestamp() >= p_deadline_at
    or not found
    or v_conversation.next_sequence <> p_user_message_sequence + 1
    or mod(v_conversation.next_sequence, 2) <> 0 then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_assistant_id := extensions.gen_random_uuid();
  v_result_id := extensions.gen_random_uuid();
  insert into public.reina_pilot_messages (
    message_id, owner_principal_id, conversation_id, idempotency_key,
    sequence, role, content, content_digest, policy_reference
  ) select
    v_assistant_id, p_owner_principal_id, p_conversation_id, p_idempotency_key,
    v_conversation.next_sequence, 'assistant', p_content, p_content_digest, p_policy_reference
  where clock_timestamp() < p_deadline_at;
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception using errcode = '57014', message = 'reina_pilot_deadline';
  end if;
  update public.reina_pilot_conversations
  set next_sequence = next_sequence + 1, updated_at = clock_timestamp()
  where owner_principal_id = p_owner_principal_id
    and conversation_id = p_conversation_id
    and clock_timestamp() < p_deadline_at;
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception using errcode = '57014', message = 'reina_pilot_deadline';
  end if;
  update public.reina_pilot_turns
  set state = 'completed',
      lease_expires_at = null,
      assistant_message_id = v_assistant_id,
      result_reference = v_result_id,
      completion_policy_reference = p_policy_reference,
      completed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where owner_principal_id = p_owner_principal_id
    and conversation_id = p_conversation_id
    and idempotency_key = p_idempotency_key
    and claim_id = p_claim_id
    and state = 'in_flight'
    and clock_timestamp() < p_deadline_at;
  get diagnostics v_count = row_count;
  if v_count <> 1 or clock_timestamp() >= p_deadline_at then
    raise exception using errcode = '57014', message = 'reina_pilot_deadline';
  end if;

  return jsonb_build_object(
    'status', 'completed',
    'result', jsonb_build_object(
      'ownerPrincipalId', p_owner_principal_id::text,
      'conversationId', p_conversation_id,
      'idempotencyKey', p_idempotency_key,
      'inputDigest', p_input_digest,
      'userMessageId', p_user_message_id::text,
      'userMessageSequence', p_user_message_sequence,
      'assistantMessage', jsonb_build_object(
        'messageId', v_assistant_id::text,
        'sequence', p_user_message_sequence + 1,
        'role', 'assistant',
        'content', p_content,
        'contentDigest', p_content_digest
      ),
      'resultReference', v_result_id::text,
      'policyReference', p_policy_reference
    )
  );
end;
$$;

create or replace function public.reina_pilot_mark_turn_failed(
  p_owner_principal_id uuid,
  p_conversation_id text,
  p_idempotency_key text,
  p_input_digest text,
  p_claim_id uuid,
  p_stage text,
  p_reason_code text,
  p_policy_reference jsonb,
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
    or p_conversation_id is null
    or p_idempotency_key is null
    or p_claim_id is null
    or p_stage is null
    or p_reason_code is null
    or jsonb_typeof(p_policy_reference) <> 'object'
    or not public.reina_pilot_prepare_deadline(p_deadline_at) then
    return jsonb_build_object('status', 'incomplete');
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_principal_id::text || ':' || char_length(p_conversation_id)::text || ':' || p_conversation_id,
    0
  )) or clock_timestamp() >= p_deadline_at then
    return jsonb_build_object('status', 'incomplete');
  end if;
  update public.reina_pilot_turns
  set state = 'failed_retryable',
      lease_expires_at = null,
      failure_stage = left(p_stage, 80),
      failure_reason_code = left(p_reason_code, 100),
      failure_policy_reference = p_policy_reference,
      updated_at = clock_timestamp()
  where owner_principal_id = p_owner_principal_id
    and conversation_id = p_conversation_id
    and idempotency_key = p_idempotency_key
    and input_digest = p_input_digest
    and claim_id = p_claim_id
    and state = 'in_flight'
    and clock_timestamp() < p_deadline_at;
  get diagnostics v_count = row_count;
  if v_count = 1 then
    if clock_timestamp() >= p_deadline_at then
      raise exception using errcode = '57014', message = 'reina_pilot_deadline';
    end if;
    return jsonb_build_object('status', 'recorded', 'state', 'failed_retryable');
  end if;
  return jsonb_build_object('status', 'incomplete');
end;
$$;

revoke all on function public.reina_pilot_load_conversation(uuid, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.reina_pilot_create_conversation(uuid, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.reina_pilot_claim_turn(uuid, text, text, text, jsonb, jsonb, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.reina_pilot_append_user_once(uuid, text, text, text, uuid, text, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.reina_pilot_load_history(uuid, text, uuid, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.reina_pilot_append_assistant_and_complete(uuid, text, text, text, uuid, uuid, integer, text, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.reina_pilot_mark_turn_failed(uuid, text, text, text, uuid, text, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.reina_pilot_issue_review_intent(uuid, text, text, text, timestamptz, jsonb, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.reina_pilot_consume_review_intent(uuid, text, text, jsonb, timestamptz) from public, anon, authenticated, service_role;

grant execute on function public.reina_pilot_load_conversation(uuid, text, jsonb, timestamptz) to service_role;
grant execute on function public.reina_pilot_create_conversation(uuid, text, jsonb, timestamptz) to service_role;
grant execute on function public.reina_pilot_claim_turn(uuid, text, text, text, jsonb, jsonb, timestamptz, timestamptz) to service_role;
grant execute on function public.reina_pilot_append_user_once(uuid, text, text, text, uuid, text, text, jsonb, timestamptz) to service_role;
grant execute on function public.reina_pilot_load_history(uuid, text, uuid, jsonb, timestamptz) to service_role;
grant execute on function public.reina_pilot_append_assistant_and_complete(uuid, text, text, text, uuid, uuid, integer, text, text, jsonb, timestamptz) to service_role;
grant execute on function public.reina_pilot_mark_turn_failed(uuid, text, text, text, uuid, text, text, jsonb, timestamptz) to service_role;
grant execute on function public.reina_pilot_issue_review_intent(uuid, text, text, text, timestamptz, jsonb, timestamptz) to service_role;
grant execute on function public.reina_pilot_consume_review_intent(uuid, text, text, jsonb, timestamptz) to service_role;

comment on table public.reina_pilot_conversations is
  'Principal-scoped Reina pilot conversations. Service RPC access only.';
comment on table public.reina_pilot_turns is
  'Fenced, idempotent Reina pilot turn claims and replay references. Service RPC access only.';
comment on table public.reina_pilot_messages is
  'Ordered principal-scoped Reina pilot messages. Service RPC access only.';
comment on table public.reina_pilot_review_intents is
  'Single-use principal-scoped Reina bootstrap review confirmations. Service RPC access only.';
commit;
