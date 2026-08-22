-- supabase/migrations/20260816181500_profiles_page_build.sql
--
-- Record which build of the app each person's browser is actually running.
--
-- WHY. On 2026-08-16 an idle-timeout fix was merged, deployed, and tested
-- against production for an hour -- and the test proved nothing, because the
-- browser under test was still running the page from before the merge. The
-- server was demonstrably new (its new PostgREST query was visibly running in
-- the edge logs) and that was read as proof the page was new too. It is not:
-- an OLD page calling monitor_my_status triggers the NEW server's queries
-- identically. The two halves deploy together and then age apart, and a
-- long-lived tab can run last week's JavaScript for days.
--
-- With these columns, "is this person running current code" stops being an
-- inference and becomes:
--
--   select email, page_build, page_build_seen_at from profiles
--    where page_build is distinct from '<current>'
--      and page_build_seen_at > now() - interval '1 hour';
--
-- Written by handleMonitorMyStatus on the poll that already runs, and only
-- when the answer changes or has gone stale (PAGE_BUILD_RECORD_INTERVAL_MS),
-- so this is roughly one write per person per five minutes, not one per poll.
--
-- NULL means "has not reported" -- either a client older than this mechanism
-- or someone who has not signed in since. It deliberately does NOT mean
-- stale; claiming otherwise would be the same unfounded assertion this whole
-- mechanism exists to prevent.
--
-- Rollback:
--   alter table public.profiles drop column page_build, drop column page_build_seen_at;

begin;

alter table public.profiles
  add column if not exists page_build text,
  add column if not exists page_build_seen_at timestamptz;

comment on column public.profiles.page_build is
  'Build id (HL_PAGE_BUILD) last reported by this person''s browser. NULL = never reported, which is not the same as stale.';
comment on column public.profiles.page_build_seen_at is
  'When page_build was last recorded. Recency matters: a stale build last seen days ago is a closed tab, not someone working against old code right now.';

-- Answering "who is on old code right now" scans on recency first.
create index if not exists profiles_page_build_seen_at_idx
  on public.profiles (page_build_seen_at desc)
  where page_build_seen_at is not null;

commit;
