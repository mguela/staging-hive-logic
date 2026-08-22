-- sql/060_marketing_quarterly_goal.sql
-- Adds an owner-settable quarterly marketing revenue goal, driving a
-- goal-progress ring on the Command Center Home tab. ADDITIVE ONLY:
-- nullable column on the existing marketing_plan_assumptions table (same
-- single-row-per-tenant table that already drives the Plan tab's forecast
-- bands), no backfill -- a null goal honestly means "not set yet", never
-- defaulted to a fabricated number.
--
-- Applied to production 2026-08-05 via MCP, on Chris's explicit go-ahead
-- (same approval that also cleared sql/058 and sql/059 -- see
-- MIGRATION_LEDGER.md).
alter table marketing_plan_assumptions
  add column if not exists quarterly_revenue_goal_cents integer check (quarterly_revenue_goal_cents is null or quarterly_revenue_goal_cents >= 0);
