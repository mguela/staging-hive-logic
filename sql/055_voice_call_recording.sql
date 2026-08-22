-- sql/055_voice_call_recording.sql
-- ADDITIVE ONLY. HiveLogic Phone -- Phase 4 part 1: call recording settings.
-- Recording is the prerequisite for AI Call Intelligence (transcribe ->
-- summarize -> draft actions). Consent is already disclosed on the
-- login/greeting notice; recording_consent_message optionally adds a spoken
-- line when a call connects.
--
-- voice_calls already carries recording_sid, recording_url, transcript,
-- transcript_status, ai_summary (jsonb) from sql/023 -- no new columns needed.
--
-- Run once in the Supabase SQL editor. Idempotent.

create table if not exists voice_settings (
  id uuid primary key default gen_random_uuid(),
  record_calls boolean not null default true,           -- master toggle (default ON per Chris)
  recording_channels text not null default 'dual'
    check (recording_channels in ('dual','mono')),      -- dual = separate caller/agent channels
  ai_call_summaries boolean not null default true,      -- run Claude summary + draft actions on ready transcripts
  recording_consent_message text,                        -- optional spoken notice; null = rely on existing login/greeting notice
  -- Enforce a single settings row: a UNIQUE column that is always true means
  -- a second insert collides. Read with ?singleton=eq.true, write by upsert.
  singleton boolean not null default true unique check (singleton = true),
  updated_at timestamptz not null default now()
);

insert into voice_settings (record_calls, recording_channels, ai_call_summaries)
select true, 'dual', true
where not exists (select 1 from voice_settings);
