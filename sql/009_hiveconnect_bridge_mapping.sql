-- 009_hiveconnect_bridge_mapping.sql
-- HIVECONNECT MERGE — Option C mapping table (spec §5 SELECTED, §9, §10).
--
-- Keyed on immutable user IDs on both sides, never on email alone (§9
-- requirement). Lives in HiveLogic's own Supabase project — HiveConnect's
-- project is never modified by this migration.
--
-- Apply the same way as 002-008: Supabase dashboard -> SQL Editor -> New
-- query -> paste -> Run. Not part of any automated migration runner in this
-- repo (matches the existing pattern for 002-008).

create table if not exists hiveconnect_account_map (
  hivelogic_user_id  uuid primary key,
  hiveconnect_user_id uuid not null unique,
  status             text not null default 'active' check (status in ('active','disabled')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table hiveconnect_account_map is
  'HIVECONNECT MERGE: maps a HiveLogic user to their (auto-provisioned or '
  'pre-existing) HiveConnect account, by immutable id. One row per user. '
  'Rollback: DROP TABLE hiveconnect_account_map; — see claude/hiveconnect-merge-progress.md §Rollback.';

create index if not exists hiveconnect_account_map_hiveconnect_user_id_idx
  on hiveconnect_account_map (hiveconnect_user_id);

-- Rollback (kept here for a single copy/paste — also recorded in the spec's
-- §10 Rollback Plan and the progress log):
--   drop table if exists hiveconnect_account_map;
