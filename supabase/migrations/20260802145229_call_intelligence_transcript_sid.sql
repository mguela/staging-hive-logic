-- Forward delta applied to production during the baseline reconciliation
-- (version 20260802145229, name call_intelligence_transcript_sid). Verbatim from
-- production's supabase_migrations.schema_migrations. Additive + idempotent.
alter table voice_calls add column if not exists intelligence_transcript_sid text;
create index if not exists voice_calls_intel_transcript_idx on voice_calls (intelligence_transcript_sid);
