-- Version the private `docs` bucket and the authenticated Storage policies
-- required by the Documents screen's direct Supabase upload/copy/sign flow.
--
-- Metadata remains authoritative. An authenticated user may create an object,
-- but may only read/sign it after a visible public.documents row points at the
-- same storage path. The public.documents SELECT policy continues to enforce
-- folder sharing and sensitive-document rules. Object owners may remove only
-- uploads that do not have a metadata row, so cleanup cannot delete a filed
-- document and leave broken metadata behind.

insert into storage.buckets (id, name, public)
values ('docs', 'docs', false)
on conflict (id) do update
set public = false;

-- The Documents SELECT policy intentionally hides sensitive rows from most
-- authenticated users. A plain NOT EXISTS query inside storage.objects RLS
-- would therefore mistake a hidden sensitive row for "no row" and let its
-- uploader delete the object. This pinned SECURITY DEFINER helper checks the
-- authoritative table without that visibility distortion. Its answer is used
-- only together with owner_id = auth.uid() below.
create or replace function public.can_cleanup_unfiled_document_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select auth.uid() is not null
    and not exists (
      select 1
      from public.documents d
      where d.storage_path = object_name
    );
$function$;

revoke execute on function public.can_cleanup_unfiled_document_object(text)
  from public, anon;
grant execute on function public.can_cleanup_unfiled_document_object(text)
  to authenticated, service_role;

do $policies$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'hivelogic docs authenticated upload'
  ) then
    create policy "hivelogic docs authenticated upload"
      on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = 'docs'
        and auth.uid() is not null
      );
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'hivelogic docs metadata-authorized read'
  ) then
    create policy "hivelogic docs metadata-authorized read"
      on storage.objects
      for select
      to authenticated
      using (
        bucket_id = 'docs'
        and exists (
          select 1
          from public.documents d
          where d.storage_path = storage.objects.name
        )
      );
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'hivelogic docs owner cleanup'
  ) then
    create policy "hivelogic docs owner cleanup"
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = 'docs'
        and owner_id = auth.uid()::text
        and public.can_cleanup_unfiled_document_object(storage.objects.name)
      );
  end if;
end
$policies$;
