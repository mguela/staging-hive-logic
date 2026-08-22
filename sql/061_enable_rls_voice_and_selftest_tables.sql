-- sql/061_enable_rls_voice_and_selftest_tables.sql
-- Closes a Supabase security advisory: 6 tables had Row Level Security
-- disabled, meaning the anon/public API key had full read+write access
-- with no per-row control. All 6 get the same policy already used
-- everywhere else in this codebase: only the backend (service_role) may
-- touch the table at all.
--
-- Impact review before applying (all confirmed safe):
--   selftest_reports, voice_queue_members, voice_queues, voice_settings
--     -- backend-only access already (voice_settings is read by the
--        frontend, but only through the backend API, never a direct
--        Supabase call) -- zero behavior change.
--   voice_agent_status, voice_callbacks
--     -- the VoIP panel (public/hiveconnect/voip-panel.js) subscribes to
--        these directly with the anon key for instant live updates, but
--        that is purely an optimization on top of an existing 10-second
--        poll (voipStartLiveUpdates). Locking these down means updates
--        arrive within 10s instead of instantly -- not a functional
--        break.
--
-- Applied to production 2026-08-05 via MCP, on Chris's explicit go-ahead.

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
