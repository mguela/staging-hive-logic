-- sql/037_marketing_media_generated_evidence.sql
-- Marketing Suite Phase 4 (sub-slice 2 of the "16 missing entities" data
-- model work) -- see reina/marketing-suite-master-build-plan-2026-07-29.md,
-- Phase 4. ADDITIVE ONLY: no existing table is altered or dropped.
--
-- DEPENDENCY NOTE: this migration references campaign_variants(id), created
-- by sql/036_marketing_shared_workspace_plan_opportunity_variant.sql (Phase 4
-- sub-slice 1, branch marketing-suite-phase4-plan-opportunity-variant, not
-- yet merged to main as of this writing). Apply sql/036 before this file if
-- both are ever run against a real database. Neither has been applied to
-- production Supabase yet, per standing rule -- both are written-not-run.
--
-- This sub-slice creates the 3 entities Phase 11 (video-first Content
-- Studio) depends on most directly: MediaAsset, GeneratedAsset,
-- SourceEvidence. Grounded in a direct read of the real `media` table
-- (sql/006_visual_intel.sql), `api/import-companycam.js`, and
-- `handleDraftPostPost`/`handleContentJobsGet` in api/marketing.js --
-- not the abstract spec description. Key findings that shaped this design:
--   * `media` already holds every real CompanyCam-synced photo/video (job_id,
--     storage_path, gps, captured_at) -- MediaAsset does NOT duplicate this.
--     It is the marketing-domain wrapper: which media rows have been pulled
--     into the marketing workflow, and what's known about permission to use
--     them in marketing (see below).
--   * `marketing_consent_ledger` (sql/030) already has a `media_marketing_use`
--     channel value in its CHECK constraint that is DEFINED BUT NEVER READ
--     OR WRITTEN anywhere in the app (confirmed by repo-wide search) --
--     this is a real, already-designed hook. MediaAsset.permission_status is
--     a point-in-time snapshot of that ledger's state at selection time (for
--     audit trail); the live gate before any actual publish must still
--     re-check `marketing_consent_ledger` directly, this snapshot is not a
--     substitute for that.
--   * `media_analysis` (sql/006) already has trade/room/materials/description
--     fields read by handleDraftPostPost/handleContentJobsGet -- SourceEvidence
--     snapshots the relevant fields at time of use rather than re-deriving a
--     new analysis pipeline.
--   * No CompanyCam id/url column exists anywhere (only an overloaded
--     `offline_client_id` dedupe key on `media`) -- not something this
--     migration needs to fix; noted for awareness only.

-- ---------- MediaAsset ----------
-- Marketing-domain selection of an existing real `media` row (CompanyCam
-- photo/video) for use in the marketing workflow (Content Studio review,
-- Ready for You, etc). One row per underlying media item ever pulled in;
-- does not copy or duplicate the underlying file/storage_path.
create table if not exists marketing_media_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  media_id uuid not null references media(id) on delete cascade,
  job_id text,
  client_id text references clients(jobber_id) on delete set null,
  selected_for text not null default 'review' check (selected_for in ('review','content_studio','ready_for_you')),
  -- Snapshot of marketing_consent_ledger's (client_id, 'media_marketing_use')
  -- row at selection time -- 'unknown' until that ledger channel is actually
  -- wired up (Phase 11), which is honest since nothing reads/writes it yet.
  permission_status text not null default 'unknown' check (permission_status in ('unknown','granted','revoked','owner_override')),
  permission_checked_at timestamptz,
  selected_by text not null default 'system' check (selected_by in ('system','owner')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, media_id)
);

create index if not exists marketing_media_assets_job_idx
  on marketing_media_assets(job_id);
create index if not exists marketing_media_assets_client_idx
  on marketing_media_assets(client_id);
create index if not exists marketing_media_assets_selected_for_idx
  on marketing_media_assets(tenant_id, selected_for);

alter table marketing_media_assets enable row level security;
create policy "service role full access marketing_media_assets"
  on marketing_media_assets
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ---------- GeneratedAsset ----------
-- AI- or owner-produced marketing content derived from a MediaAsset and/or
-- a CampaignVariant (sql/036). Per Phase 11's explicit requirement, every
-- generated asset must retain its generation method/prompt/provider, the
-- claims it makes (traceable to SourceEvidence below), approver, and
-- publish destinations -- never invent products, prices, locations,
-- warranties, or results.
create table if not exists marketing_generated_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  media_asset_id uuid references marketing_media_assets(id) on delete set null,
  campaign_variant_id uuid references campaign_variants(id) on delete set null,
  asset_type text not null check (asset_type in ('image','video','caption','social_post','ad_copy','landing_page_copy')),
  generation_method text not null check (generation_method in ('ai_text','ai_image','ai_video','ai_enhanced','manual')),
  prompt text,
  provider text,
  provider_model text,
  output_storage_path text,
  output_text text,
  claims_used jsonb,
  status text not null default 'draft' check (status in ('draft','pending_approval','approved','rejected','published')),
  approved_by text,
  approved_at timestamptz,
  publish_destinations jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_generated_assets_media_asset_idx
  on marketing_generated_assets(media_asset_id);
create index if not exists marketing_generated_assets_variant_idx
  on marketing_generated_assets(campaign_variant_id);
create index if not exists marketing_generated_assets_status_idx
  on marketing_generated_assets(tenant_id, status);

alter table marketing_generated_assets enable row level security;
create policy "service role full access marketing_generated_assets"
  on marketing_generated_assets
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ---------- SourceEvidence ----------
-- The real, verifiable fact(s) backing one claim made inside a
-- GeneratedAsset -- e.g. "we replaced this deck in [city]" must trace back
-- to a real job_id/media_id/media_analysis snapshot, not an assumption.
-- media_analysis_snapshot copies the relevant fields (trade/room/materials/
-- description) AT THE TIME the claim was made, so a later edit to the real
-- media_analysis row can never silently rewrite history for a claim that
-- already shipped -- matches the existing immutable-edit pattern already
-- used by the `annotations` table (sql/006, superseded_by column).
create table if not exists marketing_source_evidence (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  generated_asset_id uuid not null references marketing_generated_assets(id) on delete cascade,
  evidence_type text not null check (evidence_type in ('job_record','media_analysis','review','job_total','client_history','manual_note')),
  job_id text,
  media_id uuid references media(id) on delete set null,
  media_analysis_snapshot jsonb,
  claim_text text not null,
  verified boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists marketing_source_evidence_asset_idx
  on marketing_source_evidence(generated_asset_id);
create index if not exists marketing_source_evidence_job_idx
  on marketing_source_evidence(job_id);

alter table marketing_source_evidence enable row level security;
create policy "service role full access marketing_source_evidence"
  on marketing_source_evidence
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
