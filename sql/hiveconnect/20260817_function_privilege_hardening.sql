-- HiveConnect SECURITY DEFINER privilege hardening.
-- Target project: mzyngawgpxzpsxphswmc
-- Status: APPLIED 2026-08-17 as hiveconnect_function_privilege_hardening_20260817.
--
-- Live read-only audit confirmed the exact signatures below. PostgreSQL grants
-- EXECUTE to PUBLIC on new functions by default, so revoking only anon is not
-- sufficient: anon/authenticated still inherit PUBLIC's grant.

begin;

-- Pin every privileged function to trusted schemas. Function bodies currently
-- qualify sensitive auth/extension calls; keeping these schemas explicit is
-- behavior-preserving while removing the caller-controlled search path.
alter function public.admin_add_member(uuid, uuid) set search_path = pg_catalog, public;
alter function public.admin_archive_channel(uuid, boolean) set search_path = pg_catalog, public;
alter function public.admin_create_user(text, text, text, text, text) set search_path = pg_catalog, public, auth, extensions;
alter function public.admin_delete_channel(uuid) set search_path = pg_catalog, public;
alter function public.admin_remove_member(uuid, uuid) set search_path = pg_catalog, public;
alter function public.admin_reset_password(uuid, text) set search_path = pg_catalog, public, auth, extensions;
alter function public.admin_set_active(uuid, boolean) set search_path = pg_catalog, public;
alter function public.admin_set_category(uuid, text) set search_path = pg_catalog, public;
alter function public.admin_set_channel_type(uuid, text) set search_path = pg_catalog, public;
alter function public.admin_set_role(uuid, text) set search_path = pg_catalog, public;
alter function public.can_access_channel(uuid, uuid) set search_path = pg_catalog, public;
alter function public.create_invite(text, text, uuid[], integer) set search_path = pg_catalog, public;
alter function public.create_video_guest_pass(uuid, integer) set search_path = pg_catalog, public;
alter function public.create_webhook(uuid, text) set search_path = pg_catalog, public;
alter function public.guest_video_token(text, text) set search_path = pg_catalog, public, extensions;
alter function public.guard_profile_change() set search_path = pg_catalog, public;
alter function public.handle_new_message() set search_path = pg_catalog, public;
alter function public.handle_new_user() set search_path = pg_catalog, public;
alter function public.invite_info(uuid) set search_path = pg_catalog, public;
alter function public.is_admin(uuid) set search_path = pg_catalog, public;
alter function public.is_channel_member(uuid, uuid) set search_path = pg_catalog, public;
alter function public.livekit_token(uuid, text) set search_path = pg_catalog, public, extensions;
alter function public.my_role() set search_path = pg_catalog, public;
alter function public.redeem_invite(uuid, text, text, text, text) set search_path = pg_catalog, public, auth, extensions;
alter function public.reina_read(uuid, timestamptz, integer) set search_path = pg_catalog, public;
alter function public.require_admin() set search_path = pg_catalog, public;
alter function public.revoke_webhook(uuid) set search_path = pg_catalog, public;
alter function public.toggle_pin(uuid) set search_path = pg_catalog, public;
alter function public.webhook_post(uuid, text, text) set search_path = pg_catalog, public;

-- Helper used only from owner-executed JWT functions. It does not need to be
-- directly callable through PostgREST.
alter function public.b64url(bytea) set search_path = pg_catalog;
revoke execute on function public.b64url(bytea) from PUBLIC, anon, authenticated, service_role;

-- Start from zero inherited privileges for all 29 SECURITY DEFINER functions.
revoke execute on function public.admin_add_member(uuid, uuid) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.admin_archive_channel(uuid, boolean) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.admin_create_user(text, text, text, text, text) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.admin_delete_channel(uuid) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.admin_remove_member(uuid, uuid) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.admin_reset_password(uuid, text) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.admin_set_active(uuid, boolean) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.admin_set_category(uuid, text) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.admin_set_channel_type(uuid, text) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.admin_set_role(uuid, text) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.can_access_channel(uuid, uuid) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.create_invite(text, text, uuid[], integer) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.create_video_guest_pass(uuid, integer) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.create_webhook(uuid, text) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.guest_video_token(text, text) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.guard_profile_change() from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.handle_new_message() from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.handle_new_user() from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.invite_info(uuid) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.is_admin(uuid) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.is_channel_member(uuid, uuid) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.livekit_token(uuid, text) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.my_role() from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.redeem_invite(uuid, text, text, text, text) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.reina_read(uuid, timestamptz, integer) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.require_admin() from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.revoke_webhook(uuid) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.toggle_pin(uuid) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.webhook_post(uuid, text, text) from PUBLIC, anon, authenticated, service_role;

-- Pre-auth/token-gated flows. Keep authenticated too so an already-signed-in
-- browser following an invite/guest link does not regress.
grant execute on function public.invite_info(uuid) to anon, authenticated, service_role;
grant execute on function public.redeem_invite(uuid, text, text, text, text) to anon, authenticated, service_role;
grant execute on function public.guest_video_token(text, text) to anon, authenticated, service_role;
grant execute on function public.webhook_post(uuid, text, text) to anon, authenticated, service_role;
grant execute on function public.reina_read(uuid, timestamptz, integer) to anon, authenticated, service_role;

-- Signed-in application functions and RLS helpers.
grant execute on function public.admin_add_member(uuid, uuid) to authenticated, service_role;
grant execute on function public.admin_archive_channel(uuid, boolean) to authenticated, service_role;
grant execute on function public.admin_create_user(text, text, text, text, text) to authenticated, service_role;
grant execute on function public.admin_delete_channel(uuid) to authenticated, service_role;
grant execute on function public.admin_remove_member(uuid, uuid) to authenticated, service_role;
grant execute on function public.admin_reset_password(uuid, text) to authenticated, service_role;
grant execute on function public.admin_set_active(uuid, boolean) to authenticated, service_role;
grant execute on function public.admin_set_category(uuid, text) to authenticated, service_role;
grant execute on function public.admin_set_channel_type(uuid, text) to authenticated, service_role;
grant execute on function public.admin_set_role(uuid, text) to authenticated, service_role;
grant execute on function public.can_access_channel(uuid, uuid) to authenticated, service_role;
grant execute on function public.create_invite(text, text, uuid[], integer) to authenticated, service_role;
grant execute on function public.create_video_guest_pass(uuid, integer) to authenticated, service_role;
grant execute on function public.create_webhook(uuid, text) to authenticated, service_role;
grant execute on function public.is_admin(uuid) to authenticated, service_role;
grant execute on function public.is_channel_member(uuid, uuid) to authenticated, service_role;
grant execute on function public.livekit_token(uuid, text) to authenticated, service_role;
grant execute on function public.my_role() to authenticated, service_role;
grant execute on function public.revoke_webhook(uuid) to authenticated, service_role;
grant execute on function public.toggle_pin(uuid) to authenticated, service_role;

-- guard_profile_change, handle_new_message, handle_new_user, and
-- require_admin are trigger/internal helpers. Their owner keeps implicit
-- execution rights; no API-facing role receives a direct grant.

commit;
