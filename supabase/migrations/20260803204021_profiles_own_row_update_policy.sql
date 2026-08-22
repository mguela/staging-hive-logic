-- Captured verbatim from prod supabase_migrations.schema_migrations (version 20260803204021).
-- Every signed-in user may update their OWN profile row (admins keep their broader policy).
-- Note: role changes are still admin-only in the app UI; guard role at the column level.
create policy "profiles: update own row" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
