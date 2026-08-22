-- Dev To-Do: record WHO resolved a finding, not just that it is resolved.
--
-- Chris's ask (2026-08-18): the Resolved tab shows what was closed and when,
-- but not who closed it, so there is no way to ask the person who fixed
-- something what they actually did.
--
-- `updated_by` already exists but is the LAST toucher of any status change --
-- it is overwritten when a resolved finding is reopened and re-triaged, so it
-- cannot be trusted as the resolver.  `resolved_by` is set only when a finding
-- moves into a closed status (resolved/ignored) and cleared when it reopens,
-- exactly mirroring the existing `resolved_at` column next to it.
--
-- ADDITIVE ONLY.  No backfill: findings closed before this shipped genuinely
-- have no recorded resolver, and the UI shows "Unknown" for them rather than
-- inventing an attribution from `updated_by` (which may be a later reopener).
-- That also keeps this file free of top-level DML, so
-- scripts/check-migration-replay-safety.mjs passes it.

alter table public.app_status_findings
  add column if not exists resolved_by uuid references auth.users(id) on delete set null;

comment on column public.app_status_findings.resolved_by is
  'Signed-in user who moved this finding into resolved/ignored. Null for findings closed before 2026-08-18 or reopened since.';

-- Existing grants cover new columns; the table stays service-role only.
