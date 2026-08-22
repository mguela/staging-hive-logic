-- sql/057_call_intelligence_transcript_sid.sql
-- ADDITIVE ONLY. Phase 4: Twilio Voice Intelligence transcript source.
-- When a call recording completes we create a Voice Intelligence transcript
-- for it; the async completion webhook returns only the transcript SID, so
-- we store it here to map the finished transcript back to its call.
alter table voice_calls add column if not exists intelligence_transcript_sid text;
create index if not exists voice_calls_intel_transcript_idx on voice_calls (intelligence_transcript_sid);
