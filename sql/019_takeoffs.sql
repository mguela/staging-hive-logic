-- 019_takeoffs.sql
-- ADDITIVE ONLY. HiveGrid Live Workbench takeoff persistence (Phase 1,
-- Chris's ask 2026-07-22): the Live Workbench canvas tool (count / linear /
-- area measuring against an uploaded plan image or PDF) currently saves
-- NOTHING -- reload the page and every mark is gone, with no link to a
-- real Jobber quote. This table stores the MEASUREMENT DATA a taker
-- builds (conditions/quantities + annotation marks + per-sheet metadata
-- like name/calibration/scale) tied to a real quote, via api/takeoffs.js.
--
-- OUT OF SCOPE for this table (deliberately, Phase 1.5, later): the actual
-- plan image/PDF pixels are NOT stored here or in Supabase Storage yet --
-- no bucket/path column exists on purpose. A reloaded takeoff restores
-- conditions, marks, and sheet metadata (name/calibration/scale) but NOT
-- the plan graphic itself; the UI labels this honestly and the user
-- re-uploads the image/PDF to keep marking it up in that session.
--
-- Run this once in the Supabase SQL editor (Project -> SQL Editor) against
-- the production database. Safe to run more than once.

create table if not exists takeoffs (
  id uuid primary key default gen_random_uuid(),
  quote_id text not null,               -- references quotes.jobber_id (not a FK: quotes is a synced/read-only table)
  job_id text,                          -- references jobs.jobber_id (not a FK), once a quote converts to a job
  title text,
  conditions jsonb not null default '[]'::jsonb, -- WBCONDS snapshot: [{name,type,unit,trade,color,waste,meas:[...],hide}]
  marks jsonb not null default '[]'::jsonb,      -- WB.marks snapshot: annotation objects (cloud/callout/text/arrow/dim/pen)
  sheets jsonb not null default '[]'::jsonb,     -- WB.sheets metadata only (name,w,h,ftpx,cal,ppi,scaleName) -- never the image/canvas pixels
  status text not null default 'draft',         -- draft | final
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists takeoffs_quote_id_idx on takeoffs (quote_id);
create index if not exists takeoffs_job_id_idx on takeoffs (job_id);

alter table takeoffs enable row level security;
-- No permissive policies -- only the service-role key (server-side only,
-- via api/takeoffs.js) can read/write.

comment on table takeoffs is
  'HiveGrid Live Workbench takeoff data (Phase 1): measured conditions/quantities and markup annotations tied to a real Jobber quote. Plan image/PDF pixels are NOT stored here -- that is an explicit, later Phase 1.5 (Supabase Storage). A restored takeoff shows sheet names/calibration but the user must re-upload the plan graphic to keep marking it up.';
