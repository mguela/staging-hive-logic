-- sql/hiveconnect/video_guest_passes_2026-07-26.sql
-- (applied to the hiveconnect Supabase project mzyngawgpxzpsxphswmc on 2026-07-26)
-- FaceTime-style guest video calling: a pass lets someone join ONE call room
-- with no account. Created only by signed-in members; redeemed anonymously via
-- SECURITY DEFINER function; expires (4h default) and capped at 10 uses.
-- No RLS policies on the table on purpose -- clients never touch it directly.
-- SECURITY NOTE (2026-08-17): signing credentials are looked up by name in
-- Supabase Vault. Populate the two named secrets out-of-band after rotating
-- the previously committed credential; never put their values in SQL.

create table if not exists video_guest_passes (
  id uuid primary key default gen_random_uuid(),
  token text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  channel_id uuid not null references channels(id) on delete cascade,
  created_by uuid not null references profiles(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '4 hours',
  max_uses integer not null default 10,
  used_count integer not null default 0,
  created_at timestamptz not null default now()
);
alter table video_guest_passes enable row level security;

create or replace function create_video_guest_pass(p_channel uuid, p_expires_minutes int default 240)
returns text language plpgsql security definer set search_path to 'public' as $$
declare v_uid uuid := auth.uid(); v_token text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.channels c where c.id = p_channel and (
      c.type = 'public' or c.created_by = v_uid
      or exists (select 1 from public.channel_members m where m.channel_id = c.id and m.user_id = v_uid)
  )) then raise exception 'no access to channel'; end if;
  insert into video_guest_passes (channel_id, created_by, expires_at)
    values (p_channel, v_uid, now() + make_interval(mins => greatest(5, least(1440, p_expires_minutes))))
    returning token into v_token;
  return v_token;
end $$;

create or replace function guest_video_token(p_pass text, p_name text)
returns text language plpgsql security definer set search_path to 'pg_catalog', 'public' as $$
declare
  v_secret text;
  v_key text;
  v_row video_guest_passes%rowtype;
  v_name text := left(coalesce(nullif(trim(p_name), ''), 'Guest'), 40);
  v_identity text;
  v_now bigint := extract(epoch from now())::bigint;
  v_header text; v_payload text; v_signing text; v_room text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'hiveconnect_livekit_api_secret';
  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'hiveconnect_livekit_api_key';
  if v_secret is null or v_key is null then
    raise exception 'video signing credentials are not configured';
  end if;
  -- Claim a use atomically; SELECT followed by UPDATE let concurrent requests
  -- exceed max_uses.
  update video_guest_passes as pass
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
  v_header := public.b64url(convert_to('{"alg":"HS256","typ":"JWT"}','utf8'));
  v_payload := public.b64url(convert_to(json_build_object(
    'iss', v_key, 'sub', v_identity, 'name', v_name,
    'nbf', v_now - 10, 'exp', v_now + 14400,
    'video', json_build_object('room', v_room, 'roomJoin', true, 'canPublish', true, 'canSubscribe', true, 'canPublishData', true)
  )::text, 'utf8'));
  v_signing := v_header || '.' || v_payload;
  return v_signing || '.' || public.b64url(extensions.hmac(v_signing, v_secret, 'sha256'));
end $$;

grant execute on function guest_video_token(text, text) to anon;
grant execute on function create_video_guest_pass(uuid, int) to authenticated;
