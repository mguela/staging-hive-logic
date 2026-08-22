-- Transactional sub-banking reauthorization consume + apply.
--
-- Codex review of PR #43 flagged that the banking endpoint consumed the reauth
-- grant BEFORE input validation and split the banking writes across two
-- separate HTTP calls, so (a) invalid input could permanently burn a valid
-- grant and (b) a failure between writes could leave partial state. This
-- function makes the whole thing ONE database transaction: it validates input,
-- finds the hashed grant, verifies it, consumes it exactly once, and applies
-- every banking mutation together. Any failure rolls back everything —
-- including the consume.
--
-- Second Codex round hardened this further:
--   * The maximum validity window is HARD-CODED here (10 minutes). There is no
--     caller-controlled window parameter — a caller can neither extend nor
--     override how long a redeemed grant stays usable.
--   * Time bounds use the STRICTEST boundary: the grant must be redeemed
--     (used_at not null), not future-dated (used_at <= now()), redeemed within
--     the last 10 minutes (used_at >= now() - 10min), AND the underlying link
--     must not be expired (expires_at > now()).
--   * All input is validated INSIDE the function (types/formats/lengths).
--     Invalid input raises before any write, so it can never consume the grant
--     or change a banking record.
--
-- Concurrency: the guarded UPDATE on sub_auth_links takes a row lock held for
-- the whole function. A second concurrent call blocks, then re-evaluates the
-- predicate after the first commits (purpose is no longer 'reauth') and matches
-- zero rows — so exactly one banking change can ride a given reauth.
--
-- Security posture: SECURITY INVOKER (the caller is the Supabase service role,
-- which already bypasses RLS and owns full table access). EXECUTE is revoked
-- from PUBLIC and granted only to service_role — the portals call it with the
-- service key, never anon/authenticated.

create or replace function public.consume_sub_reauth_and_apply_banking(
  p_sub_id          uuid,
  p_token_hash      text,
  p_provider        text    default null,
  p_provider_ref    text    default null,
  p_masked_account  text    default null,
  p_set_accepts_cc  boolean default false,
  p_accepts_cc      boolean default false
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  -- Hard-coded maximum validity for a redeemed reauth grant. Not caller-tunable.
  c_max_age constant interval := interval '10 minutes';
  v_link_id uuid;
  v_banking public.sub_banking%rowtype;
begin
  -- 0) VALIDATE INPUT (defense in depth; the Node handler also validates).
  --    Invalid input raises BEFORE any write, so it can never consume a grant
  --    or touch a banking row.
  if p_sub_id is null then
    raise exception 'invalid_banking_input: sub_id is required';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_banking_input: token_hash must be a sha256 hex digest';
  end if;
  if p_provider is not null and (btrim(p_provider) = '' or char_length(p_provider) > 64) then
    raise exception 'invalid_banking_input: provider';
  end if;
  if p_provider_ref is not null and (btrim(p_provider_ref) = '' or char_length(p_provider_ref) > 128) then
    raise exception 'invalid_banking_input: provider_ref';
  end if;
  if p_masked_account is not null
     and (char_length(p_masked_account) > 32
          or p_masked_account !~ ('^[*' || U&'\2022' || ']{2,}[0-9]{2,4}$')) then
    raise exception 'invalid_banking_input: masked_account must be a masked display value';
  end if;

  -- 1) Atomically CONSUME the reauth grant. Match by token HASH, scoped to this
  --    sub, purpose='reauth', and inside the STRICTEST time window: redeemed,
  --    not future-dated, redeemed within c_max_age, and link not expired. Flip
  --    it to 'reauth_consumed'. Matching zero rows (forged / expired / already
  --    consumed / wrong purpose / wrong sub / stale) leaves the grant untouched
  --    and writes nothing below.
  update public.sub_auth_links
     set purpose = 'reauth_consumed'
   where token = p_token_hash
     and sub_id = p_sub_id
     and purpose = 'reauth'
     and used_at is not null
     and used_at <= now()
     and used_at >= now() - c_max_age
     and expires_at > now()
  returning id into v_link_id;

  if v_link_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_reauth');
  end if;

  -- 2) Optional accepts_cc change on the sub (only when the caller sent it).
  if p_set_accepts_cc then
    update public.subs set accepts_cc = p_accepts_cc where id = p_sub_id;
  end if;

  -- 3) Upsert banking. Only overwrite the fields that were provided (non-null);
  --    existing values are preserved otherwise. accepts_ach stays true.
  insert into public.sub_banking as b
        (sub_id, accepts_ach, provider, provider_ref, masked_account, updated_at)
  values (p_sub_id, true, p_provider, p_provider_ref, p_masked_account, now())
  on conflict (sub_id) do update
     set accepts_ach    = true,
         provider       = coalesce(excluded.provider, b.provider),
         provider_ref   = coalesce(excluded.provider_ref, b.provider_ref),
         masked_account = coalesce(excluded.masked_account, b.masked_account),
         updated_at     = now()
  returning * into v_banking;

  -- 4) Consume + accepts_cc + banking commit together as one transaction.
  return jsonb_build_object('ok', true, 'banking', to_jsonb(v_banking));
end;
$$;

comment on function public.consume_sub_reauth_and_apply_banking(uuid, text, text, text, text, boolean, boolean)
  is 'Atomically consume a hashed sub reauth grant (single-use; purpose + strict hard-coded 10-minute window + expires_at checked) and apply the sub_banking upsert (+ optional accepts_cc) in one transaction. Validates all input internally. No caller-controlled validity window. Added for PR #43 / Codex review.';

-- Only the service role may execute this (portals call it with the service key).
revoke all on function public.consume_sub_reauth_and_apply_banking(uuid, text, text, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.consume_sub_reauth_and_apply_banking(uuid, text, text, text, text, boolean, boolean) to service_role;
