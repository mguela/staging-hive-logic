-- Captured verbatim from prod supabase_migrations.schema_migrations (version 20260803203559).
alter table public.profiles add column if not exists title text;
alter table public.profiles add column if not exists mobile text;
