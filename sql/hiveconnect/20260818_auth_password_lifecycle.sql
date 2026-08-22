-- HiveConnect password lifecycle expand phase.
-- Target project: mzyngawgpxzpsxphswmc
-- Status: APPLIED 2026-08-17 (live receipt 20260818002333).
--
-- Passwords now enter Supabase Auth only through the Admin API's checked
-- update-user path. These helpers coordinate public-schema state only and are
-- callable exclusively with the server-side service role.
--
-- This expand migration deliberately leaves the three legacy password RPCs in
-- place so the currently deployed client and the previous rollback deployment
-- remain functional while the matching bridge/client is deployed. Apply
-- 20260818_auth_password_lifecycle_cleanup.sql only after the new production
-- build is healthy and its account lifecycle has been smoke-tested.

begin;

alter table public.invites
  add column if not exists auth_claim_id uuid,
  add column if not exists auth_user_id uuid,
  add column if not exists auth_claimed_at timestamptz;

create or replace function public.hc_claim_invite_for_auth(
  p_token uuid,
  p_display text,
  p_username text,
  p_email text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  inv public.invites%rowtype;
  claim_id uuid;
  auth_user_id uuid;
  normalized_email text;
  normalized_username text := lower(btrim(coalesce(p_username, '')));
  normalized_display text := btrim(coalesce(p_display, ''));
begin
  select * into inv
    from public.invites
   where token = p_token
   for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'invite_invalid';
  end if;
  if inv.used_at is not null then
    raise exception using errcode = 'P0001', message = 'invite_used';
  end if;
  if inv.expires_at < now() then
    raise exception using errcode = 'P0001', message = 'invite_expired';
  end if;
  if inv.auth_claim_id is not null
     and inv.auth_claimed_at >= now() - interval '10 minutes' then
    raise exception using errcode = 'P0001', message = 'invite_in_progress';
  end if;

  -- Keep the same intended Auth user across an expired/ambiguous attempt so a
  -- retry can recover an acknowledged-lost Admin create by exact UUID.
  claim_id := coalesce(inv.auth_claim_id, gen_random_uuid());
  auth_user_id := coalesce(inv.auth_user_id, p_user_id);
  if auth_user_id is null then
    raise exception using errcode = 'P0001', message = 'bad_request';
  end if;

  -- A bound invite's email is authoritative. The browser value is used only
  -- for unbound invite links.
  normalized_email := lower(btrim(coalesce(nullif(inv.email, ''), nullif(p_email, ''))));
  if normalized_email is null or normalized_email = '' then
    raise exception using errcode = 'P0001', message = 'email_required';
  end if;
  if length(normalized_email) > 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode = 'P0001', message = 'invalid_email';
  end if;
  if normalized_display = '' then
    raise exception using errcode = 'P0001', message = 'name_required';
  end if;
  if length(normalized_display) > 120 then
    raise exception using errcode = 'P0001', message = 'bad_request';
  end if;
  if normalized_username = '' then
    raise exception using errcode = 'P0001', message = 'username_required';
  end if;
  if length(normalized_username) > 64
     or normalized_username !~ '^[a-z0-9][a-z0-9._-]*$' then
    raise exception using errcode = 'P0001', message = 'invalid_username';
  end if;
  if exists (
    select 1 from public.profiles p where lower(p.username) = normalized_username
  ) then
    raise exception using errcode = 'P0001', message = 'username_taken';
  end if;

  update public.invites
     set auth_claim_id = claim_id,
         auth_user_id = auth_user_id,
         auth_claimed_at = now()
   where token = p_token;

  return jsonb_build_object(
    'claim_id', claim_id,
    'user_id', auth_user_id,
    'email', normalized_email
  );
end
$function$;

create or replace function public.hc_finalize_invite_auth(
  p_token uuid,
  p_claim_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  inv public.invites%rowtype;
  normalized_email text;
begin
  select * into inv
    from public.invites
   where token = p_token
   for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'invite_invalid';
  end if;

  normalized_email := lower(btrim(inv.email));

  -- A retry after a committed-but-unacknowledged request is a success.
  if inv.used_at is not null and inv.used_by = p_user_id then
    return jsonb_build_object('email', normalized_email);
  end if;
  if inv.used_at is not null then
    raise exception using errcode = 'P0001', message = 'invite_used';
  end if;
  if inv.auth_claim_id is distinct from p_claim_id then
    raise exception using errcode = 'P0001', message = 'claim_invalid';
  end if;
  if inv.auth_user_id is distinct from p_user_id then
    raise exception using errcode = 'P0001', message = 'claim_invalid';
  end if;

  perform set_config('app.priv', '1', true);
  update public.profiles
     set role = case
       when inv.role in ('admin', 'member', 'guest') then inv.role
       else 'member'
     end
   where id = p_user_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'profile_missing';
  end if;

  insert into public.channel_members (channel_id, user_id)
  select selected.channel_id, p_user_id
    from unnest(coalesce(inv.channel_ids, '{}'::uuid[])) as selected(channel_id)
   where selected.channel_id is not null
  on conflict do nothing;

  update public.invites
     set used_at = now(),
         used_by = p_user_id,
         auth_claim_id = null,
         auth_user_id = null,
         auth_claimed_at = null
   where token = p_token;

  return jsonb_build_object('email', normalized_email);
end
$function$;

create or replace function public.hc_release_invite_auth_claim(
  p_token uuid,
  p_claim_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  update public.invites
     set auth_claim_id = null,
         auth_user_id = null,
         auth_claimed_at = null
   where token = p_token
     and used_at is null
     and auth_claim_id = p_claim_id;
end
$function$;

create or replace function public.hc_finalize_admin_user_auth(
  p_user_id uuid,
  p_role text,
  p_channel_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if p_role not in ('admin', 'member', 'guest') then
    raise exception using errcode = 'P0001', message = 'invalid_role';
  end if;

  perform set_config('app.priv', '1', true);
  update public.profiles
     set role = p_role
   where id = p_user_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'profile_missing';
  end if;

  insert into public.channel_members (channel_id, user_id)
  select distinct selected.channel_id, p_user_id
    from unnest(coalesce(p_channel_ids, '{}'::uuid[])) as selected(channel_id)
   where selected.channel_id is not null
  on conflict do nothing;
end
$function$;

revoke all on function public.hc_claim_invite_for_auth(uuid, text, text, text, uuid)
  from PUBLIC, anon, authenticated, service_role;
revoke all on function public.hc_finalize_invite_auth(uuid, uuid, uuid)
  from PUBLIC, anon, authenticated, service_role;
revoke all on function public.hc_release_invite_auth_claim(uuid, uuid)
  from PUBLIC, anon, authenticated, service_role;
revoke all on function public.hc_finalize_admin_user_auth(uuid, text, uuid[])
  from PUBLIC, anon, authenticated, service_role;

grant execute on function public.hc_claim_invite_for_auth(uuid, text, text, text, uuid)
  to service_role;
grant execute on function public.hc_finalize_invite_auth(uuid, uuid, uuid)
  to service_role;
grant execute on function public.hc_release_invite_auth_claim(uuid, uuid)
  to service_role;
grant execute on function public.hc_finalize_admin_user_auth(uuid, text, uuid[])
  to service_role;

commit;
