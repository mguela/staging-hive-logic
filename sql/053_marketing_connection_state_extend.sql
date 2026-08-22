-- sql/053_marketing_connection_state_extend.sql
-- Phase 15 (Universal Connections framework) of the Marketing Suite build.
-- ADDITIVE ONLY: extends the marketing_platform_connections.state CHECK
-- constraint from sql/030's original 6 values to add 4 more specific,
-- honest failure states. Confirms/extends the enum per the master build
-- plan's explicit instruction ("most of these already exist as states in
-- marketing_platform_connections, confirm/extend the enum rather than
-- redefining it") -- no existing value is removed or renamed, so no
-- existing row's state ever becomes invalid.
--
-- Why these 4 specifically: 'needs_attention' (the only failure state that
-- existed before this migration) is too generic to tell the owner what to
-- actually do next. A connector that loses its OAuth token needs a
-- different owner action (re-authenticate) than one whose ad account was
-- suspended for a policy violation (contact the platform), a billing
-- failure (update payment method), or a pending external approval like
-- Google Ads' Basic Access review (wait -- nothing to fix, nothing broken).
-- Collapsing all four into one generic label was already flagged as a gap
-- in reina/phase0-m02-legacy-marketing-inventory-2026-07-25.md (Google Ads
-- showing a flat "not connected" instead of "approval pending"). This
-- migration is the schema half of closing that gap; the state-machine
-- code in api/marketing.js is the enforcement half.
alter table marketing_platform_connections
  drop constraint if exists marketing_platform_connections_state_check;

alter table marketing_platform_connections
  add constraint marketing_platform_connections_state_check
  check (state in (
    'not_connected','setup_incomplete','reporting_verified',
    'draft_validated','launch_enabled','needs_attention',
    'needs_reauth','policy_blocked','billing_blocked','external_approval_pending'
  ));
