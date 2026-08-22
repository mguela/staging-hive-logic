-- sql/056_voicemail_soft_delete.sql
-- ADDITIVE ONLY. Soft-delete for voicemails: a Delete action in the VoIP
-- Voicemail tab sets deleted_at instead of hard-removing the row, so an
-- accidental delete is recoverable and the linked call/recording history
-- stays intact. The voicemail list filters deleted_at is null.
alter table voice_voicemails add column if not exists deleted_at timestamptz;
create index if not exists voice_voicemails_deleted_idx on voice_voicemails (deleted_at);
