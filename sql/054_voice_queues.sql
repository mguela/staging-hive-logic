-- sql/054_voice_queues.sql
-- ADDITIVE ONLY. HiveLogic Phone -- Phase 1: Call Queues.
-- Builds on sql/023_voice_phone_system.sql. See
-- claude/voice-phone-system-spec.md and the VoIP queues/park/intercom/AI
-- task brief (reina-voip-queues-park-intercom-ai-2026-08-02-01).
--
-- Carrier stays behind api/_lib/voice.js -- nothing here names a Twilio
-- concept except provider_queue_sid (an opaque handle, same pattern as
-- voice_numbers.provider_sid / voice_calls.provider_call_sid).
--
-- Run once in the Supabase SQL editor. Safe to run more than once
-- (IF NOT EXISTS guards + idempotent seed throughout).

-- ---------------------------------------------------------------------
-- Queues -- an ordered hold line callers wait in (Twilio <Enqueue>),
-- from which an available agent pulls the next caller (Twilio <Dial><Queue>
-- = "Dequeue"). ONE queue may carry is_default_inbound=true; when such a
-- queue exists the main-line greeting routes callers into it, otherwise
-- inbound behaviour is exactly as before (opt-in, fully reversible by
-- deactivating the queue).
-- ---------------------------------------------------------------------
create table if not exists voice_queues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  ring_order text not null default 'fifo'
    check (ring_order in ('fifo','priority')),   -- fifo: oldest waiting answered first; priority: by member priority
  timeout_seconds integer not null default 30,   -- max hold before overflow fires
  overflow_destination text not null default 'voicemail'
    check (overflow_destination in ('extension','voicemail','callback')),
  overflow_extension_id uuid references voice_extensions(id) on delete set null, -- target when overflow_destination='extension'
  hold_music_url text,                            -- optional <Play> loop; falls back to the 'hold' greeting
  is_default_inbound boolean not null default false, -- the queue the main line routes to (at most one)
  provider_queue_sid text,                        -- Twilio Queue SID, opaque; resolved/cached on first status read
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one default-inbound queue (partial unique index -- multiple
-- false rows are fine, only one true row allowed).
create unique index if not exists voice_queues_one_default_inbound_idx
  on voice_queues (is_default_inbound) where is_default_inbound;

create index if not exists voice_queues_active_idx on voice_queues (active);

-- ---------------------------------------------------------------------
-- Queue membership -- which extensions serve a queue, and their priority
-- (used only when ring_order='priority').
-- ---------------------------------------------------------------------
create table if not exists voice_queue_members (
  id uuid primary key default gen_random_uuid(),
  queue_id uuid not null references voice_queues(id) on delete cascade,
  extension_id uuid not null references voice_extensions(id) on delete cascade,
  priority integer not null default 0,
  created_at timestamptz not null default now(),
  unique (queue_id, extension_id)
);

create index if not exists voice_queue_members_queue_idx on voice_queue_members (queue_id);
create index if not exists voice_queue_members_ext_idx on voice_queue_members (extension_id);

-- ---------------------------------------------------------------------
-- Agent presence -- one row per extension, its current availability.
-- Drives the "agents available" count on the queue card and the toolbar
-- status toggle. 'on_call' is set by call webhooks; the rest are set by
-- the agent. Rows are created lazily (upsert) on first status set.
-- ---------------------------------------------------------------------
create table if not exists voice_agent_status (
  id uuid primary key default gen_random_uuid(),
  extension_id uuid not null unique references voice_extensions(id) on delete cascade,
  status text not null default 'offline'
    check (status in ('available','on_call','on_break','dnd','offline','wrapping_up')),
  status_note text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Callbacks -- a caller who overflowed a queue (or, later, an AI-drafted
-- follow-up) who asked to be called back. status starts 'unassigned' so
-- the next free agent can claim + return the call. Distinct from
-- voicemail: a callback is an explicit "call me back" request tied to a
-- queue, worked from the queue card, not the voicemail inbox.
-- ---------------------------------------------------------------------
create table if not exists voice_callbacks (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references voice_calls(id) on delete set null,
  queue_id uuid references voice_queues(id) on delete set null,
  from_number text not null,
  caller_name text,
  reason text,
  recording_sid text,
  recording_url text,
  duration_seconds integer,
  transcript text,
  transcript_status text default 'not_captured'
    check (transcript_status in ('not_captured','pending','ready','failed')),
  ai_summary jsonb,                               -- { caller_name, callback_number, intent, summary } once structured
  status text not null default 'unassigned'
    check (status in ('unassigned','assigned','completed','dismissed')),
  assigned_extension_id uuid references voice_extensions(id) on delete set null,
  source text not null default 'queue_overflow',  -- 'queue_overflow' | 'ai_call_intelligence' (Phase 4)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists voice_callbacks_status_idx on voice_callbacks (status, created_at desc);
create index if not exists voice_callbacks_queue_idx on voice_callbacks (queue_id);

-- ---------------------------------------------------------------------
-- Seed one 'General' default-inbound queue (30s hold -> callback capture
-- on overflow). Idempotent: only inserts if no default-inbound queue
-- exists yet. Deactivating this row reverts the main line to the prior
-- extension/voicemail behaviour with no code change.
-- ---------------------------------------------------------------------
insert into voice_queues (name, ring_order, timeout_seconds, overflow_destination, is_default_inbound, active)
select 'General', 'fifo', 30, 'callback', true, true
where not exists (select 1 from voice_queues where is_default_inbound = true);

-- ---------------------------------------------------------------------
-- Supabase Realtime -- the queue card subscribes to live changes on
-- voice_calls, voice_agent_status and voice_callbacks. Add each to the
-- supabase_realtime publication only if not already present (re-adding a
-- table to a publication is an error, so guard each one).
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'voice_agent_status'
  ) then
    alter publication supabase_realtime add table voice_agent_status;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'voice_callbacks'
  ) then
    alter publication supabase_realtime add table voice_callbacks;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'voice_calls'
  ) then
    alter publication supabase_realtime add table voice_calls;
  end if;
exception
  when undefined_object then
    -- supabase_realtime publication doesn't exist in this environment; skip.
    raise notice 'supabase_realtime publication not found -- skipping Realtime registration';
end $$;
