-- Captured verbatim from prod supabase_migrations.schema_migrations (version 20260803234918).
-- Server-side cache for the Command Center "Today's Decisions" brief.
-- The brief aggregates 3 live QuickBooks reports + several table scans;
-- computing it on every page load made the box crawl. Service-role only.
create table if not exists public.fi_brief_cache (
  id text primary key,
  payload jsonb not null,
  computed_at timestamptz not null default now()
);
alter table public.fi_brief_cache enable row level security;
