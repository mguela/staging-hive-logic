-- Captured verbatim from prod supabase_migrations.schema_migrations (version 20260805105734).
alter table public.selftest_reports enable row level security;
create policy "service role full access selftest_reports"
  on public.selftest_reports for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

alter table public.voice_queue_members enable row level security;
create policy "service role full access voice_queue_members"
  on public.voice_queue_members for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

alter table public.voice_agent_status enable row level security;
create policy "service role full access voice_agent_status"
  on public.voice_agent_status for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

alter table public.voice_settings enable row level security;
create policy "service role full access voice_settings"
  on public.voice_settings for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

alter table public.voice_callbacks enable row level security;
create policy "service role full access voice_callbacks"
  on public.voice_callbacks for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

alter table public.voice_queues enable row level security;
create policy "service role full access voice_queues"
  on public.voice_queues for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
