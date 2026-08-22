-- sql/023_voice_phone_system.sql
-- ADDITIVE ONLY. HiveLogic Phone -- a strictly telephone-only business VoIP
-- system, deliberately separate from HiveConnect (chat/messaging/video).
-- See reina/voip-system-architecture-2026-07-24.md (Build Reina project)
-- for the full ADR this implements.
--
-- Carrier: Twilio (Programmable Voice), kept behind api/_lib/voice.js so
-- the carrier itself is swappable later -- nothing in this schema or the
-- frontend references a Twilio-specific concept by name.
--
-- Phase 1 scope only (numbers, extensions, greetings, schedules, calls,
-- voicemail, blocklist). Phase 2/3 items from the architecture spec
-- (desk-phone device provisioning, ring groups/queues beyond a single
-- flat list, AI Attendant, multi-carrier failover, E911 dispatchable
-- location workflow) are NOT modeled here yet -- see the ADR's phased
-- roadmap for what's deliberately deferred and why.
--
-- Run this once in the Supabase SQL editor. Safe to run more than once
-- (IF NOT EXISTS guards throughout).

-- ---------------------------------------------------------------------
-- Caller recognition prerequisite: clients need a normalized phone number
-- to match against. Additive column only -- does not touch how clients
-- sync otherwise. Sync logic lives in api/jobber/sync.js (mapClient).
-- ---------------------------------------------------------------------
alter table clients add column if not exists phone_e164 text;
create index if not exists clients_phone_e164_idx on clients (phone_e164);

-- ---------------------------------------------------------------------
-- Extensions -- one per member (Chris's spec: "Every member receives a
-- unique extension"). user_id is a loose text reference to profiles.id
-- (not a FK -- profiles is HiveLogic's own auth table, kept decoupled
-- the same way clients/jobs are decoupled from Jobber's IDs elsewhere).
-- ---------------------------------------------------------------------
create table if not exists voice_extensions (
  id uuid primary key default gen_random_uuid(),
  extension_number text not null unique,       -- e.g. '101'
  display_name text not null,
  user_id text,                                -- profiles.id, nullable (shared/ring-group-only extensions allowed)
  direct_number_id uuid,                        -- optional FK to voice_numbers, set below
  forwarding_number text,                       -- E.164, optional cellphone forward
  call_waiting_enabled boolean not null default true,
  is_operator boolean not null default false,   -- receives "press 0" calls; exactly one recommended, not enforced
  voicemail_pin text,
  voicemail_greeting_text text,                 -- TTS greeting script (Phase 1: text-to-speech, not audio upload)
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Numbers -- Phase 1 is admin-paste (buy/port in the Twilio console,
-- register the result here), not a self-serve purchase/port API. The
-- full guided porting wizard from the architecture spec is Phase 2+.
-- ---------------------------------------------------------------------
create table if not exists voice_numbers (
  id uuid primary key default gen_random_uuid(),
  e164 text not null unique,
  friendly_name text,
  provider_sid text,                            -- Twilio PhoneNumber SID, opaque outside api/_lib/voice.js
  role text not null default 'main' check (role in ('main','direct','toll_free')),
  assigned_extension_id uuid references voice_extensions(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table voice_extensions
  add constraint voice_extensions_direct_number_fk
  foreign key (direct_number_id) references voice_numbers(id) on delete set null;

-- ---------------------------------------------------------------------
-- Business hours / holidays -- drives day vs. after-hours greeting.
-- ---------------------------------------------------------------------
create table if not exists voice_schedules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'America/New_York',
  business_hours jsonb not null default '{}',   -- { mon: [["08:00","17:00"]], tue: [...], ... }
  holidays jsonb not null default '[]',          -- [{ date: '2026-12-25', name: 'Christmas' }]
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Greetings -- Phase 1 uses text-to-speech (Twilio <Say>) rather than
-- audio file upload, which is real, functional, and needs no storage
-- pipeline. Audio upload is a clean Phase 2 add (this table already has
-- room for it via audio_url).
-- ---------------------------------------------------------------------
create table if not exists voice_greetings (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('main_open','main_closed','voicemail','hold')),
  tts_text text,
  audio_url text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Blocklist -- company-wide. Per-user blocklists are a Phase 2 add.
-- ---------------------------------------------------------------------
create table if not exists voice_blocked_numbers (
  id uuid primary key default gen_random_uuid(),
  e164 text not null unique,
  reason text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Calls -- one row per call leg to the main number or from a member's
-- browser softphone. provider_call_sid is the Twilio Call SID.
-- client_id/job_id are matched at webhook time from clients.phone_e164 --
-- best-effort, nullable, never blocks answering the call if the match
-- fails (see architecture note: integrations must never delay/break
-- ordinary calling).
-- ---------------------------------------------------------------------
create table if not exists voice_calls (
  id uuid primary key default gen_random_uuid(),
  provider_call_sid text unique,
  direction text not null check (direction in ('inbound','outbound')),
  from_number text not null,
  to_number text not null,
  extension_id uuid references voice_extensions(id) on delete set null,
  client_id text,                               -- clients.jobber_id, denormalized (not an FK -- clients is a synced/read-only table)
  job_id text,                                  -- jobs.jobber_id, best-effort from the client's most recent open job
  status text not null default 'created' check (status in (
    'created','routing','ringing','answered','held','transferring',
    'parked','conferenced','voicemail','completed','failed','missed'
  )),
  -- Conference-based call control (real hold/transfer, not a Dial-only
  -- model -- see the ADR's "why a conference" note). Nullable until the
  -- conference actually starts / the two legs are known.
  conference_sid text,
  caller_call_sid text,                         -- the PSTN/original leg's Twilio Call SID
  agent_call_sid text,                          -- the connected member's leg's Twilio Call SID (last one, if transferred)
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  recording_sid text,
  recording_url text,
  transcript text,
  transcript_status text default 'not_captured' check (transcript_status in ('not_captured','pending','ready','failed')),
  ai_summary jsonb,                             -- { summary, requests, commitments, followUps, ... } -- see architecture ADR §AI Call Intelligence
  created_at timestamptz not null default now()
);

create index if not exists voice_calls_client_idx on voice_calls (client_id);
create index if not exists voice_calls_extension_idx on voice_calls (extension_id);
create index if not exists voice_calls_started_idx on voice_calls (started_at desc);

-- Append-only event log per call -- satisfies the architecture spec's
-- "audit events are append-only" rule. Never updated, only inserted.
create table if not exists voice_call_events (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references voice_calls(id) on delete cascade,
  event_type text not null,                     -- 'created','ringing','answered','held','transferred','recording_started', etc.
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists voice_call_events_call_idx on voice_call_events (call_id);

-- ---------------------------------------------------------------------
-- Voicemail -- one row per left message. Distinct from voice_calls so a
-- missed call and its voicemail can be queried/marked-read independently.
-- ---------------------------------------------------------------------
create table if not exists voice_voicemails (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references voice_calls(id) on delete set null,
  extension_id uuid references voice_extensions(id) on delete set null,
  from_number text not null,
  recording_sid text,
  recording_url text,
  duration_seconds integer,
  transcript text,
  transcript_status text default 'not_captured' check (transcript_status in ('not_captured','pending','ready','failed')),
  ai_summary text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists voice_voicemails_extension_idx on voice_voicemails (extension_id);
create index if not exists voice_voicemails_unread_idx on voice_voicemails (extension_id, read);
