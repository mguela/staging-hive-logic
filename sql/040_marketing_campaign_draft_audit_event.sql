-- sql/040_marketing_campaign_draft_audit_event.sql
-- Marketing Suite Phase 4 (sub-slice 5 of the "16 missing entities" data
-- model work) -- see reina/marketing-suite-master-build-plan-2026-07-29.md,
-- Phase 4. ADDITIVE ONLY: no existing table is altered or dropped.
--
-- This sub-slice creates 2 of the remaining 6 entities: CampaignDraft and
-- AuditEvent. Still not created after this slice: WebsiteChange, ReviewReply
-- (Phase 13), LeadAttribution, RevenueAttribution, OptimizationRecommendation
-- (Phase 18). Both tables below are schema-only in this slice, same as every
-- prior Phase 4 sub-slice -- wiring handleDraftPostPost to actually persist a
-- CampaignDraft row (and emitting real marketing_audit_events from existing
-- handlers) is separate, follow-up application-code work, not bundled here.

-- ---------- CampaignDraft ----------
-- handleDraftPostPost (api/marketing.js) is a real, live AI caption
-- generator for a job's social post -- confirmed 2026-07-30 to be a pure
-- stateless function: it reads a job + its synced CompanyCam media/analysis,
-- calls Anthropic, and returns the caption in the HTTP response with no
-- INSERT anywhere. Every draft is lost the moment the response is sent.
-- This table is the CampaignDraft entity from the original spec's core data
-- objects list -- deliberately distinct from campaign_variants (sql/036),
-- which is scoped to "alternative content for a campaign that already
-- exists." A CampaignDraft has no campaign yet; it becomes one (or gets
-- discarded) later, tracked here via status + promoted_campaign_id.
create table if not exists marketing_campaign_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  job_id text,
  division text,
  draft_text text not null,
  used_real_analysis boolean not null default false,
  photo_count integer not null default 0 check (photo_count >= 0),
  generated_by text not null default 'ai' check (generated_by in ('ai','owner')),
  model text,
  status text not null default 'draft' check (status in ('draft','discarded','promoted')),
  promoted_campaign_id uuid references campaigns(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_campaign_drafts_tenant_status_idx
  on marketing_campaign_drafts(tenant_id, status, created_at desc);
create index if not exists marketing_campaign_drafts_job_idx
  on marketing_campaign_drafts(job_id);
create index if not exists marketing_campaign_drafts_promoted_campaign_idx
  on marketing_campaign_drafts(promoted_campaign_id);

alter table marketing_campaign_drafts enable row level security;
create policy "service role full access marketing_campaign_drafts"
  on marketing_campaign_drafts
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ---------- AuditEvent ----------
-- A general activity trail across the Marketing Suite (idea submitted,
-- brief generated, campaign sent, approval decided, connection state
-- changed, budget adjusted, etc.), for Phase 5's "what Reina completed
-- automatically" dashboard and Phase 19's full owner-journey test coverage.
--
-- This is deliberately NOT modeled on bookkeeping_audit_log (sql/013) --
-- that table is a tamper-evident hash-chain *witness* for two specific
-- existing in-jsonb chains (ledger.js/controls.js), solving a very specific
-- "can this financial history be silently rewritten" problem. Nothing in
-- the Marketing Suite has an equivalent existing hash-chain to witness, and
-- inventing one here would be solving a problem this domain doesn't have.
-- What this table borrows from sql/013 is only the append-only-at-the-
-- database-level enforcement (REVOKE update/delete + a raising trigger),
-- since "the activity trail can't be quietly edited after the fact" is a
-- real property worth keeping for an audit log, without the hash-chain
-- machinery that only makes sense for the ledger's specific threat model.
create table if not exists marketing_audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  category text not null check (category in (
    'idea','campaign','approval','connection','budget','plan','review','opportunity'
  )),
  action text not null,
  entity_type text,
  entity_id text,
  actor text not null default 'system' check (actor in ('system','owner')),
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists marketing_audit_events_tenant_category_idx
  on marketing_audit_events(tenant_id, category, created_at desc);
create index if not exists marketing_audit_events_entity_idx
  on marketing_audit_events(entity_type, entity_id);

alter table marketing_audit_events enable row level security;
create policy "service role full access marketing_audit_events"
  on marketing_audit_events
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- Append-only enforcement, same real technique as sql/013's
-- bookkeeping_audit_log: revoke UPDATE/DELETE from every role PostgREST
-- uses, and back it with a trigger so a future grant change can't silently
-- reopen it.
revoke update, delete on marketing_audit_events from anon, authenticated, service_role;
grant insert, select on marketing_audit_events to service_role;

create or replace function marketing_audit_events_immutable() returns trigger as $$
begin
  raise exception 'marketing_audit_events is append-only -- % is not permitted', TG_OP;
end;
$$ language plpgsql;

drop trigger if exists marketing_audit_events_no_update on marketing_audit_events;
create trigger marketing_audit_events_no_update
  before update or delete on marketing_audit_events
  for each row execute function marketing_audit_events_immutable();
