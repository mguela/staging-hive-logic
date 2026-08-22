-- sql/039_marketing_owner_idea_attachment.sql
-- Marketing Suite Phase 4 (sub-slice 4 of the "16 missing entities" data
-- model work) -- see reina/marketing-suite-master-build-plan-2026-07-29.md,
-- Phase 4. ADDITIVE ONLY: no existing table is altered or dropped.
--
-- DEPENDENCY NOTE: this migration references campaigns(id) (sql/021,
-- already on origin/main) and media(id) (sql/006, already on origin/main).
-- It does NOT depend on sql/036/037/038 (sub-slices 1-3, still unmerged) --
-- OwnerIdea/Attachment are the first Phase 4 sub-slice that only needs
-- tables already on main, so this migration can be applied independently of
-- the other three sub-slices' merge order. Still NOT applied to production
-- Supabase, per standing rule -- written-not-run like the rest.
--
-- This sub-slice creates the 2 entities Phase 9 (Ideas) depends on
-- entirely -- OwnerIdea, Attachment. Phase 9 is currently 100% unbuilt
-- (confirmed: zero existing "idea" resource anywhere in the repo), so this
-- unblocks an entirely new user-facing surface rather than extending an
-- already-partially-unblocked phase. Grounded in a direct read of real
-- repo precedents, not the abstract spec description:
--   * `media_entity_links` (sql/006/007) is the repo's only polymorphic
--     entity_type/entity_id pattern, CHECK-constrained to UPPERCASE_SNAKE
--     values, later WIDENED in place by sql/007 (drop constraint / add
--     constraint) as new entity types were needed. marketing_attachments
--     follows the exact same shape and the same future-widening pattern --
--     it starts with a single 'OWNER_IDEA' value since that's the only
--     real consumer today, not because the table is hardcoded to it.
--   * `handleDraftPostPost` (api/marketing.js) is the repo's existing
--     "structured output from real facts, never fabricate" reference
--     implementation -- it reads a job's real photos/analysis and drafts a
--     caption, stateless (Phase 6's Progress Log already confirmed no
--     write to any table). OwnerIdea.brief/gap_flags are designed to be
--     filled in by a future Phase 9 handler built the same way: read the
--     owner's real submitted content (raw_text/attachments), never invent
--     channel recommendations beyond what the real inputs support, and
--     honestly flag gaps instead of guessing.
--   * No voice-note/audio-transcription pipeline exists anywhere in this
--     repo (confirmed by repo-wide search) -- `raw_text` on OwnerIdea and
--     `transcript` on a voice-note Attachment both stay NULL until Phase 9
--     actually builds transcription; this migration does not fabricate a
--     transcription capability that doesn't exist.
--   * `clients` is keyed by `jobber_id` (text), confirmed by the real FK
--     shape already used in sql/021's `campaign_recipients.client_id text
--     references clients(jobber_id) on delete set null` and sql/037's
--     `marketing_media_assets.client_id` (same shape) -- followed exactly
--     here for OwnerIdea's optional customer link. `job_id` is stored as
--     unconstrained text everywhere in this codebase (jobs is a
--     synced/read-only table, sql/006's own comment says so explicitly) --
--     followed here too, not given a FK that doesn't exist elsewhere.

-- ---------- OwnerIdea ----------
-- One row per owner-submitted idea (text, voice note, photo/video/doc
-- upload, optional customer/job link). `input_mode` records how the owner
-- primarily submitted it; actual files live in marketing_attachments
-- (one-to-many). `brief`/`gap_flags` are populated by Phase 9's future
-- processing step -- both are NULL until that step actually runs, matching
-- this repo's "honest not-yet-measurable beats a fake value" convention
-- used throughout marketing_health/command_center.
create table if not exists marketing_owner_ideas (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  submitted_by text,
  input_mode text not null check (input_mode in (
    'text','voice_note','photo','video','document'
  )),
  raw_text text,
  job_id text,
  client_id text references clients(jobber_id) on delete set null,
  status text not null default 'submitted' check (status in (
    'submitted','processing','brief_ready','needs_input','dismissed','error'
  )),
  brief jsonb,
  gap_flags jsonb,
  campaign_id uuid references campaigns(id) on delete set null,
  error_reason text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_owner_ideas_tenant_status_idx
  on marketing_owner_ideas(tenant_id, status);
create index if not exists marketing_owner_ideas_job_idx
  on marketing_owner_ideas(job_id);
create index if not exists marketing_owner_ideas_client_idx
  on marketing_owner_ideas(client_id);
create index if not exists marketing_owner_ideas_campaign_idx
  on marketing_owner_ideas(campaign_id);

alter table marketing_owner_ideas enable row level security;
create policy "service role full access marketing_owner_ideas"
  on marketing_owner_ideas
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ---------- Attachment ----------
-- Polymorphic file attachment, following media_entity_links' exact
-- CHECK-constrained entity_type/entity_id shape (sql/006/007) rather than
-- a free-text pair. Starts with a single real consumer ('OWNER_IDEA');
-- widen the CHECK constraint in place (drop/add, same as sql/007 did for
-- media_entity_links) if a second consumer is ever needed -- do not fork a
-- new attachment table per entity type.
--
-- `media_id` links to an existing `media` row (sql/006) when an attachment
-- happens to be a CompanyCam-style photo/video the owner chose to reuse,
-- so it is not re-uploaded/duplicated in Storage -- null when the
-- attachment is a genuinely new upload (a fresh photo, a voice note, a
-- document) with no corresponding `media` row.
create table if not exists marketing_attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  entity_type text not null check (entity_type in ('OWNER_IDEA')),
  entity_id uuid not null,
  attachment_type text not null check (attachment_type in (
    'photo','video','audio','document'
  )),
  storage_path text not null,
  mime_type text,
  size_bytes bigint,
  duration_ms integer,
  transcript text,
  media_id uuid references media(id) on delete set null,
  uploaded_by text,
  created_at timestamptz not null default now()
);

create index if not exists marketing_attachments_entity_idx
  on marketing_attachments(entity_type, entity_id);
create index if not exists marketing_attachments_media_idx
  on marketing_attachments(media_id);

alter table marketing_attachments enable row level security;
create policy "service role full access marketing_attachments"
  on marketing_attachments
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
