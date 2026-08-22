-- HiveConnect password lifecycle contract phase.
-- Target project: mzyngawgpxzpsxphswmc
-- Status: NOT APPLIED.
--
-- Apply only after all of the following are true:
--   1. 20260818_auth_password_lifecycle.sql is applied.
--   2. The matching bridge/client build is the active production deployment.
--   3. Invite redemption, admin account creation, and password reset have been
--      smoke-tested through the bridge.
--   4. The matching deployment is retained as the rollback floor.
--
-- This removes every custom function that accepts a plaintext password or
-- writes an auth.users password hash. Password lifecycle changes then flow
-- exclusively through GoTrue's checked Admin API path.

begin;

revoke execute on function public.redeem_invite(uuid, text, text, text, text)
  from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.admin_create_user(text, text, text, text, text)
  from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.admin_reset_password(uuid, text)
  from PUBLIC, anon, authenticated, service_role;

drop function public.redeem_invite(uuid, text, text, text, text);
drop function public.admin_create_user(text, text, text, text, text);
drop function public.admin_reset_password(uuid, text);

commit;
