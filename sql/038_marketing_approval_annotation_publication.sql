-- sql/038_marketing_approval_annotation_publication.sql
-- Marketing Suite Phase 4 (sub-slice 3 of the "16 missing entities" data
-- model work) -- see reina/marketing-suite-master-build-plan-2026-07-29.md,
-- Phase 4. ADDITIVE ONLY: no existing table is altered or dropped.
--
-- DEPENDENCY NOTE: this migration references marketing_generated_assets(id)
-- from sql/037_marketing_media_generated_evidence.sql (Phase 4 sub-slice 2,
-- branch marketing-suite-phase4-media-generated-evidence) and, transitively,
-- campaign_variants(id) from sql/036 (sub-slice 1). Apply sql/036 and
-- sql/037 before this file if all three are ever run against a real
-- database. None have been applied to production Supabase yet, per
-- standing rule -- all are written-not-run.
--
-- This sub-slice creates the 3 entities Phase 8 (Ready for You expansion)
-- and Phase 12 (Annotations & corrections) depend on most directly:
-- Approval, Annotation, Publication. Grounded in a direct read of the real
-- existing approval/annotation precedents in this repo, not the abstract
-- spec description:
--   * `automation_task_approvals` (sql/035) is an append-only DECISION log
--     against a parent task whose own status lives elsewhere -- that
--     pattern doesn't fit here because a Marketing Approval card (per
--     Phase 8's brief: campaign+spend, generated video, website promotion,
--     review reply, unsupported-claim correction, disconnected-account
--     repair, budget adjustment) IS the primary record with no separate
--     parent status field, and needs six real actions (Approve/Edit/
--     Annotate/Reject/Regenerate/Ask-Reina), not just approve/reject. So
--     marketing_approvals is a single mutable-status row per approval item
--     instead, closer to sql/013's simpler `client_approvals` shape.
--   * `media_entity_links` (sql/006/007) is the only polymorphic
--     entity_type/entity_id pattern in the repo that's actually
--     CHECK-constrained (UPPERCASE_SNAKE values) rather than free text --
--     followed here for marketing_approvals.approvable_type, using the
--     exact 7 card types from Phase 8's brief.
--   * `annotations` (sql/006) already covers raw CompanyCam media
--     annotation (DRAWING/ARROW/LINE/RECTANGLE/CIRCLE/TEXT/MEASUREMENT/
--     BLUR on a `media_id`) -- NOT duplicated here. marketing_annotations
--     is a distinct, generated-marketing-content-scoped table (annotating a
--     GeneratedAsset or its website/copy text, per Phase 12's brief), reusing
--     the same superseded_by immutable-edit shape. Confirmed by repo-wide
--     search that sql/006's `superseded_by` is schema-only (no code writes
--     it yet) -- this migration doesn't change that, Phase 12's future code
--     is what will actually populate marketing_annotations.superseded_by.
--   * No publish/rollback/website-provider table or code exists anywhere in
--     this repo (confirmed by repo-wide search for wordpress/webflow/wix/
--     published_at/rollback) -- marketing_publications is genuinely new,
--     reusing the existing `website_cms` channel-key string from sql/030/034
--     for naming consistency where it overlaps.

-- ---------- Approval ----------
-- One row per Ready-for-You approval card. Deliberately a single row with a
-- mutable status (not an append-only decision log against a separate parent
-- status) because here the approval item itself carries the full context a
-- Ready-for-You card must show: why, preview, amount+max, target, estimate,
-- confidence, risks -- there is no separate parent entity whose status this
-- gates the way automation_task_approvals gates automation_tasks.
create table if not exists marketing_approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  approvable_type text not null check (approvable_type in (
    'CAMPAIGN_SPEND','GENERATED_VIDEO','WEBSITE_PROMOTION','REVIEW_REPLY',
    'CLAIM_CORRECTION','ACCOUNT_REPAIR','BUDGET_ADJUSTMENT'
  )),
  approvable_id text,
  generated_asset_id uuid references marketing_generated_assets(id) on delete set null,
  title text not null,
  rationale text,
  preview_text text,
  preview_media_id uuid references media(id) on delete set null,
  amount_cents integer check (amount_cents is null or amount_cents >= 0),
  max_amount_cents integer check (max_amount_cents is null or max_amount_cents >= 0),
  target_description text,
  estimate jsonb,
  confidence numeric,
  risks jsonb,
  status text not null default 'pending' check (status in (
    'pending','approved','rejected','edited','regenerating','needs_input','expired'
  )),
  requested_by text not null default 'system' check (requested_by in ('system','owner')),
  decided_by text,
  decided_at timestamptz,
  decision_reason text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_approvals_tenant_status_idx
  on marketing_approvals(tenant_id, status);
create index if not exists marketing_approvals_type_idx
  on marketing_approvals(approvable_type);
create index if not exists marketing_approvals_asset_idx
  on marketing_approvals(generated_asset_id);

alter table marketing_approvals enable row level security;
create policy "service role full access marketing_approvals"
  on marketing_approvals
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ---------- Annotation ----------
-- Annotates a GeneratedAsset (or the website/copy text it produced) -- NOT
-- the same table as sql/006's `annotations`, which is scoped to raw
-- CompanyCam `media` rows and already fully serves that purpose. Reuses the
-- same shape (data jsonb, frame_time_ms, superseded_by immutable-edit
-- chain) for consistency, plus two Phase-12-specific additions:
-- correction_text (the plain-language correction itself) and
-- regenerated_asset_id (the new GeneratedAsset produced by a targeted
-- regeneration addressing this annotation, once one exists).
create table if not exists marketing_annotations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  generated_asset_id uuid not null references marketing_generated_assets(id) on delete cascade,
  annotation_type text not null check (annotation_type in (
    'VIDEO_MARK','REGION_CLICK','TEXT_HIGHLIGHT','CORRECTION'
  )),
  data jsonb not null,
  frame_time_ms integer,
  correction_text text,
  regenerated_asset_id uuid references marketing_generated_assets(id) on delete set null,
  created_by text,
  created_at timestamptz not null default now(),
  superseded_by uuid references marketing_annotations(id) on delete set null
);

create index if not exists marketing_annotations_asset_idx
  on marketing_annotations(generated_asset_id);
create index if not exists marketing_annotations_active_idx
  on marketing_annotations(generated_asset_id, created_at desc) where (superseded_by is null);

alter table marketing_annotations enable row level security;
create policy "service role full access marketing_annotations"
  on marketing_annotations
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ---------- Publication ----------
-- Tracks the publish/rollback lifecycle of a GeneratedAsset (or an approved
-- item generally) to an external destination. Genuinely new -- no existing
-- publish/rollback/website-provider table or code exists anywhere in this
-- repo to extend instead. destination_type reuses the real channel-key
-- vocabulary already established in sql/030/034 where it overlaps
-- (website_cms, google_business_profile, facebook_instagram, youtube,
-- email, sms, direct_mail), plus an honest 'other' catch-all rather than
-- inventing new channel names ahead of Phase 13/15's connector work.
create table if not exists marketing_publications (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  generated_asset_id uuid references marketing_generated_assets(id) on delete set null,
  approval_id uuid references marketing_approvals(id) on delete set null,
  destination_type text not null check (destination_type in (
    'website_cms','google_business_profile','facebook_instagram','youtube',
    'email','sms','direct_mail','other'
  )),
  destination_ref text,
  status text not null default 'draft' check (status in (
    'draft','scheduled','published','rollback_requested','rolled_back','expired'
  )),
  published_at timestamptz,
  expires_at timestamptz,
  rolled_back_at timestamptz,
  rollback_reason text,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_publications_tenant_status_idx
  on marketing_publications(tenant_id, status);
create index if not exists marketing_publications_asset_idx
  on marketing_publications(generated_asset_id);
create index if not exists marketing_publications_destination_idx
  on marketing_publications(destination_type);

alter table marketing_publications enable row level security;
create policy "service role full access marketing_publications"
  on marketing_publications
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
