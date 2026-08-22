-- sql/045_marketing_channel_budget_pacing.sql
-- Phase 4 (ChannelAllocation extension) / Phase 7 dependency: extends
-- marketing_channel_budgets (sql/034, dollar-split only) with the pacing
-- fields Phase 7's brief calls for -- daily maximum, testing allowance,
-- emergency pause, approval threshold, and minimum viable spend (the
-- floor below which a channel isn't worth running). ADDITIVE ONLY, no
-- existing column changed or dropped.
--
-- "Monthly maximum" already exists as monthly_budget_cents (sql/034).
-- "Platform maximum" is the same thing -- each row already IS one
-- platform/channel's cap. "Campaign maximum" is deliberately NOT added
-- here: a campaign-level cap belongs on the campaigns table, not this
-- per-channel-per-tenant table, and no such column is invented just to
-- check a box -- that remains real, separate future work.
--
-- NOTE ON MIGRATION NUMBERING: sql/039, sql/040, and sql/041 are already
-- claimed independently by (a) unrelated Gate-1 performance work now on
-- origin/main, and (b) several still-unmerged Marketing Suite sibling
-- branches -- a real filename collision this project's plan doc has
-- flagged since 2026-07-31 pending Chris's reconciliation at merge time.
-- sql/042 is also taken on origin/main (qbo_report_cache). This file uses
-- 043, the first number not claimed by any file this session could see on
-- origin/main or any fetched Marketing Suite sibling branch as of
-- 2026-08-01 -- but given how many concurrent sessions touch this repo,
-- it may still collide with another branch's own pick; reconcile at merge
-- time the same as the existing 039/040/041 collisions.
--
-- Correction (2026-08-07 ledger audit): this comment used to say the
-- migration was NOT applied to production. It is -- all 5 columns and all 4
-- named constraints below are present verbatim in the 2026-08-02 production
-- schema dump (supabase/migrations/20260802140000_remote_baseline.sql). The
-- original comment was stale, not the source of truth; see
-- sql/MIGRATION_LEDGER.md §3b for the full applied/pending status of every
-- migration in this number range.

alter table marketing_channel_budgets
  add column if not exists min_viable_spend_cents integer,
  add column if not exists daily_max_cents integer,
  add column if not exists testing_allowance_cents integer not null default 0,
  add column if not exists paused boolean not null default false,
  add column if not exists approval_threshold_cents integer;

alter table marketing_channel_budgets
  add constraint marketing_channel_budgets_min_viable_spend_nonneg
    check (min_viable_spend_cents is null or min_viable_spend_cents >= 0);

alter table marketing_channel_budgets
  add constraint marketing_channel_budgets_daily_max_nonneg
    check (daily_max_cents is null or daily_max_cents >= 0);

alter table marketing_channel_budgets
  add constraint marketing_channel_budgets_testing_allowance_nonneg
    check (testing_allowance_cents >= 0);

alter table marketing_channel_budgets
  add constraint marketing_channel_budgets_approval_threshold_nonneg
    check (approval_threshold_cents is null or approval_threshold_cents >= 0);

comment on column marketing_channel_budgets.min_viable_spend_cents is
  'Owner-set floor below which this channel is not considered worth running. NULL = not set yet, an honest "no floor configured" state, never a fabricated default.';
comment on column marketing_channel_budgets.daily_max_cents is
  'Owner-set per-day spend cap for this channel. NULL = no daily cap set.';
comment on column marketing_channel_budgets.testing_allowance_cents is
  'A small, protected experiment budget for this channel that automatic reallocation logic should not sweep away. Defaults to 0 (no allowance), a real zero rather than null, since "no testing allowance" is itself a meaningful, always-known state.';
comment on column marketing_channel_budgets.paused is
  'Owner emergency-pause flag for this channel. When true, this channel should be excluded from automatic budget allocation regardless of its monthly_budget_cents value. Defaults to false.';
comment on column marketing_channel_budgets.approval_threshold_cents is
  'Spend level above which a change to this channel should require explicit owner approval before taking effect. NULL = no threshold set (every change auto-applies, current behavior unchanged). Not yet wired to the Approval entity (sql/037-ish, Phase 4 sub-slice 3) -- that wiring is separate future work, tracked in the plan doc, not fabricated here.';
