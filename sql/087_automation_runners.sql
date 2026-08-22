-- sql/087_automation_runners.sql
--
-- Gives the Company Setup automation toggles something real to drive.
--
-- ✅ APPLIED to production (sqhusuuhlmcmkeowdrga) 2026-08-18, on Chris's explicit
-- go-ahead ("merge it and apply the migration"), via Supabase MCP apply_migration
-- as version 20260818005946 / 087_automation_runners. The outer begin/commit below
-- is not sent to apply_migration, which runs its own transaction; every statement
-- is idempotent so the file re-runs cleanly either way.
--
-- Verified after applying: hl_outbox gained all 4 columns plus hl_outbox_dedupe_idx
-- and hl_outbox_automation_idx; automation_runs has 10 columns, 0 rows, RLS on,
-- 2 check constraints, and acl = {postgres, service_role} with anon and
-- authenticated absent (has_table_privilege('anon', …, 'SELECT') = false).
-- hl_message_settings.enabled re-confirmed FALSE, so every runner queues previews.
--
-- Exercised against production inside a DO block that raises at the end (so every
-- probe rolled back — 0 rows re-confirmed in both tables afterwards):
--   night 1 nudge            -> queued
--   night 2, same invoice    -> BLOCKED by hl_outbox_dedupe_idx   <-- the point
--   escalation, same invoice -> allowed (different key)
--   legacy null-key rows     -> still repeat freely
--   bad automation_runs outcome -> rejected
--
-- Known, intended advisor finding: automation_runs reports INFO
-- "RLS enabled, but no policies exist". That is the design — service-role only,
-- revoked from anon/authenticated — and hl_outbox already carries the same one.
--
-- Before it was applied, every runner returned ok:true with table_missing and
-- queued nothing. That path stays in the code as the fresh-install behaviour.
--
-- SAFETY MODEL — read this before changing anything here.
-- Two independent gates must BOTH be open before a customer ever hears from us:
--   1. hl_message_settings.enabled — the MASTER switch (currently false).
--      While false, everything lands in hl_outbox as status 'preview': a live,
--      reviewable picture of exactly what would go out, sent to nobody.
--   2. company_settings.automations.<key>.enabled — the per-automation toggle
--      on Company Setup (sql/086).
-- The dormant re-engagement runner keeps a THIRD gate, its existing
-- LIFECYCLE_AUTOSEND_DORMANT_REACTIVATION env var, because that path creates and
-- sends a real marketing campaign rather than queueing an outbox row.
--
-- NUMBERING: repo sql/ tops out at 086_company_settings.sql (applied to prod
-- 2026-08-17 as 20260817225146). Nothing numbered 087 exists in sql/ or
-- supabase/migrations. 043 remains off-limits; not a factor at 087.
--
-- Rollback:
--   drop table public.automation_runs;
--   alter table public.hl_outbox drop column automation, drop column dedupe_key,
--     drop column client_id, drop column company_id;
--   drop index if exists hl_outbox_dedupe_idx;

begin;

-- ---------------------------------------------------------------------------
-- 1. hl_outbox gains automation provenance + an idempotency key
-- ---------------------------------------------------------------------------
-- hl_outbox was built for appointment confirmations/reminders (appointment_id,
-- visit_jid, step). Automations queue into the same table so there is ONE place
-- to review everything that would reach a customer — but they are not tied to an
-- appointment, so they need their own provenance and their own dedupe key.

alter table public.hl_outbox add column if not exists automation text;
alter table public.hl_outbox add column if not exists dedupe_key text;
alter table public.hl_outbox add column if not exists client_id  text;
alter table public.hl_outbox add column if not exists company_id uuid references public.companies(id) on delete cascade;

comment on column public.hl_outbox.automation is
  'Which Company Setup automation queued this row (missed_call_textback | invoice_overdue_nudge | dormant_client_reengage). Null for appointment confirmations/reminders.';
comment on column public.hl_outbox.dedupe_key is
  'Idempotency key. This is what stops a nightly runner from nudging the same invoice every single night — the unique index below makes a repeat queue a no-op.';

-- The whole point of the dedupe key. Partial so the pre-existing appointment
-- rows (dedupe_key null) are unaffected and can still repeat per step.
create unique index if not exists hl_outbox_dedupe_idx
  on public.hl_outbox (dedupe_key)
  where dedupe_key is not null;

-- Finding "what is queued for this automation" is the review question.
create index if not exists hl_outbox_automation_idx
  on public.hl_outbox (automation, status)
  where automation is not null;

-- ---------------------------------------------------------------------------
-- 2. automation_runs — what each cron tick actually did
-- ---------------------------------------------------------------------------
-- Without this, "the automation is on but nothing happened" is unanswerable.
-- Every tick records a row even when it queues nothing, including WHY it
-- stopped (toggle off, master switch off, no candidates, error).

create table if not exists public.automation_runs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies(id) on delete cascade,
  automation  text not null,
  ran_at      timestamptz not null default now(),
  -- ran | skipped_disabled | skipped_no_candidates | error
  outcome     text not null,
  considered  integer not null default 0,
  queued      integer not null default 0,
  skipped     integer not null default 0,
  detail      jsonb   not null default '{}'::jsonb,
  error       text,
  constraint automation_runs_outcome_known check (
    outcome in ('ran', 'skipped_disabled', 'skipped_no_candidates', 'error')
  ),
  constraint automation_runs_detail_is_object check (jsonb_typeof(detail) = 'object')
);

comment on table public.automation_runs is
  'One row per automation cron tick, including no-op ticks. Answers "it is switched on, so why did nothing happen?".';

create index if not exists automation_runs_recent_idx
  on public.automation_runs (automation, ran_at desc);

-- ---------------------------------------------------------------------------
-- 3. RLS — service-role only, same as hl_outbox
-- ---------------------------------------------------------------------------
-- These are written by cron through the service key (which bypasses RLS). No
-- policy is created for `authenticated`, so a user's own anon-key session
-- cannot read the queue directly; the app reads it through an auth-gated API.

alter table public.automation_runs enable row level security;

revoke all on public.automation_runs from anon, authenticated;

commit;
