-- 20260823_hv_call_log.sql
-- HiveVideo call log
-- Target: HiveConnect Supabase project (ref mzyngawgpxzpsxphswmc) -- NOT hivelogic-live's project.
--
-- Chris, 2026-08-23: "we need a call log and AI summary and a transcription."
--
-- Transcription and the AI summary already existed (live captions -> Reina
-- notes posted in the channel). The call LOG did not: there was no table of any
-- kind for HiveVideo, so a call left no trace at all -- who called whom, when,
-- how long, or whether it was even answered. Presence is in-memory in the
-- realtime server and is gone the moment the socket closes.
--
-- Additive only. Rollback: drop table hv_calls.

create table if not exists hv_calls (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete cascade,

  started_by uuid not null references profiles(id),
  started_at timestamptz not null default now(),
  ended_at   timestamptz,

  -- Everyone who was in it at any point, not just who is in it now:
  -- [{ user_id, display_name, joined_at }]. A call is worth logging even when
  -- nobody answers, so this can hold exactly one person.
  participants jsonb not null default '[]'::jsonb,

  -- Filled from the in-call transcript when captions were on. Null means
  -- nobody turned CC on, which is different from "nobody said anything".
  transcript text,
  summary    text,

  created_at timestamptz not null default now()
);

create index if not exists hv_calls_channel_started_idx on hv_calls (channel_id, started_at desc);
create index if not exists hv_calls_started_idx on hv_calls (started_at desc);

-- One open call per channel. Two people hitting Join at the same moment both
-- try to open one; this makes the loser's insert fail loudly so it can attach
-- to the winner's row instead of forking the log into two half-calls.
create unique index if not exists hv_calls_one_open_per_channel
  on hv_calls (channel_id) where ended_at is null;

alter table hv_calls enable row level security;

-- The log follows channel membership, exactly like the messages in it: if you
-- can see the conversation, you can see that a call happened in it.
create policy hv_calls_member_select on hv_calls for select
  using (exists (select 1 from channel_members m where m.channel_id = hv_calls.channel_id and m.user_id = auth.uid()));

create policy hv_calls_member_insert on hv_calls for insert
  with check (
    started_by = auth.uid()
    and exists (select 1 from channel_members m where m.channel_id = hv_calls.channel_id and m.user_id = auth.uid())
  );

-- Anyone in the channel may close out the call or attach a transcript --
-- the person who started it is often not the last one to leave.
create policy hv_calls_member_update on hv_calls for update
  using (exists (select 1 from channel_members m where m.channel_id = hv_calls.channel_id and m.user_id = auth.uid()));
