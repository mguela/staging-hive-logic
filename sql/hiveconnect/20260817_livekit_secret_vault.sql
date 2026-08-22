-- Remove LiveKit signing credentials from callable function source.
-- Target project: mzyngawgpxzpsxphswmc
-- Status: BLOCKED / NOT APPLIED (2026-08-17).
--
-- Required first: rotate the exposed LiveKit credential, then create these
-- two values out-of-band in Supabase Vault:
--   hiveconnect_livekit_api_key
--   hiveconnect_livekit_api_secret
-- Never paste either value into this migration.

begin;

do $preflight$
begin
  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'hiveconnect_livekit_api_key'
      and nullif(decrypted_secret, '') is not null
  ) or not exists (
    select 1 from vault.decrypted_secrets
    where name = 'hiveconnect_livekit_api_secret'
      and nullif(decrypted_secret, '') is not null
  ) then
    raise exception 'HiveConnect LiveKit Vault secrets are not configured; rotate and store them before applying';
  end if;
end
$preflight$;

create or replace function public.livekit_token(p_channel uuid, p_name text default null)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_secret text;
  v_key text;
  v_uid uuid := auth.uid();
  v_identity text;
  v_name text;
  v_now bigint := extract(epoch from now())::bigint;
  v_header text;
  v_payload text;
  v_signing text;
  v_room text := 'hc-' || p_channel::text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
    where name = 'hiveconnect_livekit_api_secret';
  select decrypted_secret into v_key
    from vault.decrypted_secrets
    where name = 'hiveconnect_livekit_api_key';
  if v_secret is null or v_key is null then
    raise exception 'video signing credentials are not configured';
  end if;

  if v_uid is null then raise exception 'not authenticated'; end if;
  select id::text, coalesce(p_name, display_name, username)
    into v_identity, v_name
    from public.profiles
    where id = v_uid and active is not false;
  if v_identity is null then raise exception 'no active profile'; end if;
  if not exists (
    select 1 from public.channels c
    where c.id = p_channel and (
      c.type = 'public'
      or c.created_by = v_uid
      or exists (
        select 1 from public.channel_members m
        where m.channel_id = c.id and m.user_id = v_uid
      )
    )
  ) then
    raise exception 'no access to channel';
  end if;

  v_header := public.b64url(convert_to('{"alg":"HS256","typ":"JWT"}', 'utf8'));
  v_payload := public.b64url(convert_to(json_build_object(
    'iss', v_key,
    'sub', v_identity,
    'name', v_name,
    'nbf', v_now - 10,
    'exp', v_now + 21600,
    'video', json_build_object(
      'room', v_room,
      'roomJoin', true,
      'canPublish', true,
      'canSubscribe', true,
      'canPublishData', true
    )
  )::text, 'utf8'));
  v_signing := v_header || '.' || v_payload;
  return v_signing || '.' ||
    public.b64url(extensions.hmac(v_signing, v_secret, 'sha256'));
end
$function$;

create or replace function public.guest_video_token(p_pass text, p_name text)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_secret text;
  v_key text;
  v_row public.video_guest_passes%rowtype;
  v_name text := left(coalesce(nullif(trim(p_name), ''), 'Guest'), 40);
  v_identity text;
  v_now bigint := extract(epoch from now())::bigint;
  v_header text;
  v_payload text;
  v_signing text;
  v_room text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
    where name = 'hiveconnect_livekit_api_secret';
  select decrypted_secret into v_key
    from vault.decrypted_secrets
    where name = 'hiveconnect_livekit_api_key';
  if v_secret is null or v_key is null then
    raise exception 'video signing credentials are not configured';
  end if;

  -- Claim a use atomically. The prior SELECT-then-UPDATE sequence allowed
  -- concurrent requests to exceed max_uses.
  update public.video_guest_passes as pass
    set used_count = pass.used_count + 1
    where pass.token = p_pass
      and pass.expires_at >= now()
      and pass.used_count < pass.max_uses
    returning pass.* into v_row;
  if v_row.id is null then
    raise exception 'invalid, expired, or exhausted call link';
  end if;

  v_room := 'hc-' || v_row.channel_id::text;
  v_identity := 'guest-' || substr(md5(p_pass || v_name || v_now::text), 1, 12);
  v_header := public.b64url(convert_to('{"alg":"HS256","typ":"JWT"}', 'utf8'));
  v_payload := public.b64url(convert_to(json_build_object(
    'iss', v_key,
    'sub', v_identity,
    'name', v_name,
    'nbf', v_now - 10,
    'exp', v_now + 14400,
    'video', json_build_object(
      'room', v_room,
      'roomJoin', true,
      'canPublish', true,
      'canSubscribe', true,
      'canPublishData', true
    )
  )::text, 'utf8'));
  v_signing := v_header || '.' || v_payload;
  return v_signing || '.' ||
    public.b64url(extensions.hmac(v_signing, v_secret, 'sha256'));
end
$function$;

revoke execute on function public.livekit_token(uuid, text) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.guest_video_token(text, text) from PUBLIC, anon, authenticated, service_role;
grant execute on function public.livekit_token(uuid, text) to authenticated, service_role;
grant execute on function public.guest_video_token(text, text) to anon, authenticated, service_role;

commit;
