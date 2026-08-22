-- Default privileges in this project granted function execution directly to
-- Data API roles.  Revoking PUBLIC alone does not remove those direct grants.
revoke execute on function public.consume_sub_reauth_and_apply_banking(
  uuid, text, text, text, text, boolean, boolean
) from public, anon, authenticated;

grant execute on function public.consume_sub_reauth_and_apply_banking(
  uuid, text, text, text, text, boolean, boolean
) to service_role;
