-- Repair the already-applied Documents Storage cleanup policy so its
-- SECURITY DEFINER helper is not exposed as a public PostgREST RPC.
--
-- The migration is idempotent: it replaces the private helper, recreates only
-- the HiveLogic-owned cleanup policy, and then removes the superseded public
-- helper after its policy dependency is gone.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create or replace function private.can_cleanup_unfiled_document_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select auth.uid() is not null
    and not exists (
      select 1
      from public.documents d
      where d.storage_path = object_name
    );
$function$;

revoke execute on function private.can_cleanup_unfiled_document_object(text)
  from public, anon;
grant execute on function private.can_cleanup_unfiled_document_object(text)
  to authenticated, service_role;

drop policy if exists "hivelogic docs owner cleanup" on storage.objects;

create policy "hivelogic docs owner cleanup"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'docs'
    and owner_id = auth.uid()::text
    and private.can_cleanup_unfiled_document_object(storage.objects.name)
  );

drop function if exists public.can_cleanup_unfiled_document_object(text);
