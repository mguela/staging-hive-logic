-- 002_archive_channel_rpc.sql — let a channel's CREATOR (not just admins)
-- archive/unarchive it, for the HiveConnect "Archive channel" feature.
--
-- Background: channels UPDATE is RLS-locked to is_admin(auth.uid()), and the
-- existing admin_archive_channel() RPC calls require_admin(). Channel creators
-- therefore could not archive their own channels. This SECURITY DEFINER RPC
-- permits archive/unarchive when the caller is an owner/admin (is_admin) OR the
-- channel's created_by. DMs are never archivable. Nothing is deleted — archive
-- is a reversible flag; messages and channel_members stay intact.

create or replace function public.archive_channel(cid uuid, is_archived boolean)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
begin
  if not (
    public.is_admin(auth.uid())
    or exists (select 1 from public.channels c where c.id = cid and c.created_by = auth.uid())
  ) then
    raise exception 'Not authorized: only the channel creator or an admin can archive this channel';
  end if;
  update public.channels set archived = is_archived where id = cid and type <> 'dm';
end
$function$;

revoke all on function public.archive_channel(uuid, boolean) from public;
grant execute on function public.archive_channel(uuid, boolean) to authenticated;
