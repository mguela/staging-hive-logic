-- 013_job_signatures.sql
-- ADDITIVE ONLY. Creates the job_signatures table for client sign-off
-- captured in the Field app (public/field/index.html, api/fieldops.js
-- action=signature_save / the "day" action's per-job enrichment).
-- Does not alter jobs/clients/invoices/quotes/requests/visits/expenses/
-- time_sheet_entries/users/integrations/documents/client_locations/
-- office_location/workforce_time_sessions/media or any other existing table.
--
-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New
-- query -> paste -> Run) before using client signatures in the Field app.
-- Safe to run more than once (IF NOT EXISTS guards). Until this is run,
-- the Field app degrades gracefully: signature capture returns a clear
-- "not set up yet" error instead of a crash, same pattern as the
-- workforce_* tables in 005_workforce_status.sql.
--
-- Signature images reuse the existing private 'media' Storage bucket (see
-- 006_visual_intel.sql) -- no new bucket needed. This table just points at
-- a storage_path inside it, same pattern as the media table.

create table if not exists job_signatures (
  id uuid primary key default gen_random_uuid(),
  job_id text not null,               -- references jobs.jobber_id (not a FK: jobs is a synced/read-only table)
  visit_id text,                      -- references visits.jobber_id, nullable (not every job is visit-scoped)
  signed_name text not null,          -- name the client typed/confirmed at sign-off time
  storage_path text not null,         -- path inside the 'media' Storage bucket, same pattern as media.storage_path
  signed_at timestamptz not null default now(),
  captured_by uuid,                   -- references auth.users.id (the tech who captured it), nullable if unknown
  created_at timestamptz not null default now()
);
create index if not exists job_signatures_job_id_idx on job_signatures (job_id);
create index if not exists job_signatures_visit_id_idx on job_signatures (visit_id);
