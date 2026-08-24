-- Per-user settings, so a preference follows the person and not the machine.
--
-- Chris, 2026-08-23: "as a full HiveLogic Rule, settings changed should follow
-- the user not the device. for every part of Hivelogic" (see CLAUDE.md).
--
-- One jsonb blob on profiles rather than a table of key/value rows: these are
-- read all at once on page load and written one at a time by a person clicking
-- something, so a row per key buys nothing and costs a join. company_settings,
-- voice_settings and workforce_settings are company-scoped and are NOT the home
-- for a personal preference -- putting one there sets it for everybody.
alter table profiles
  add column if not exists settings jsonb not null default '{}'::jsonb;

comment on column profiles.settings is
  'Per-user preferences, keyed by the app. Follows the signed-in user across every browser. localStorage may cache these but is never the record. Hardware selection (mic/speaker), device registration (push subscriptions) and unsent drafts stay per-device and do NOT belong here.';
