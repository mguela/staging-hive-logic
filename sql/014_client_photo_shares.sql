-- 014_client_photo_shares.sql
--
-- Client Portal photo access (HiveSight/Visual Intelligence photos).
-- ADDITIVE ONLY. Safe to run more than once. Run once in the Supabase SQL
-- editor, same as 002-013.
--
-- THE RULE (Chris, 2026-07-21): a client NEVER sees a photo that staff
-- hasn't explicitly approved for them. Approval is a row in this table;
-- no row (or a revoked row) = invisible to the client, period. The media
-- bucket is private, and the client portal only ever hands out short-lived
-- signed URLs for media ids that have a live row here.
--
-- media_id references media(id) (sql/006_visual_intel.sql) with a real FK
-- (both are portal/app-owned tables). client_ref/job_ref are loose TEXT
-- refs to synced Jobber ids, same convention as 013.

create table if not exists client_photo_shares (
  id uuid primary key default gen_random_uuid(),
  media_id uuid not null references media (id) on delete cascade,
  client_ref text not null,             -- clients.jobber_id
  job_ref text not null,                -- jobs.jobber_id (the job the photo belongs to)
  shared_by uuid,                       -- staff profile id who approved it
  note text,                            -- optional caption shown to the client
  created_at timestamptz not null default now(),
  revoked_at timestamptz                -- set = photo disappears from the portal
);
create unique index if not exists client_photo_shares_uidx on client_photo_shares (media_id, client_ref);
create index if not exists client_photo_shares_client_idx on client_photo_shares (client_ref, revoked_at);
create index if not exists client_photo_shares_job_idx on client_photo_shares (job_ref);
