-- Close the fail-open Data API exposure on the multi-tenant authorization
-- table.  Reads are self-only and writes intentionally have no client policy;
-- server-side service-role operations continue to bypass RLS.
alter table public.company_members enable row level security;

drop policy if exists company_members_read_self on public.company_members;
create policy company_members_read_self on public.company_members
  for select
  to authenticated
  using ((select auth.uid()) = user_id);
