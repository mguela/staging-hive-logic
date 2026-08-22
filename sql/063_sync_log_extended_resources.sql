-- sql/063_sync_log_extended_resources.sql
--
-- sync_log (sql/baseline) only ever recorded the ORIGINAL Jobber sync
-- (api/jobber/sync.js -- clients/jobs/invoices): fixed clients_synced/
-- jobs_synced/invoices_synced columns, one row per run. api/jobber/
-- sync-extended.js (quotes/requests/visits/expenses/timesheets/users/
-- vehicles/locations, plus the geocode maintenance action) has never
-- written a row here at all -- there is no durable record of whether it
-- ran, succeeded, or when it last actually completed. Discovered 2026-08-07
-- while investigating a "PC Bridge stalled / Jobber sync stale" ticket: the
-- only way to tell the extended sync had gone quiet since 2026-08-06 18:45
-- UTC was to manually diff synced_at across 8 separate tables by hand.
--
-- ADDITIVE ONLY: two new nullable columns, no existing column touched or
-- dropped. Existing sync.js rows are unaffected -- source defaults to
-- 'sync' via the backfill below so old rows keep meaning exactly what they
-- always meant, and sync.js itself is not edited to start setting it
-- (fine either way since 'sync' is also the column default for new rows).
--
-- `source`  -- which cron wrote this row: 'sync' (the original, existing
--             behavior) or 'sync_extended' (new).
-- `details` -- per-resource counts/errors for sync_extended rows (there is
--             no fixed column per extended resource the way clients_synced/
--             jobs_synced/invoices_synced exist for the original sync).
--             NULL for 'sync' rows -- their counts already live in the
--             existing dedicated columns, not duplicated here.

alter table sync_log add column if not exists source text not null default 'sync';
alter table sync_log add column if not exists details jsonb;

update sync_log set source = 'sync' where source is null;

comment on column sync_log.source is 'Which cron wrote this row: ''sync'' (api/jobber/sync.js, original clients/jobs/invoices) or ''sync_extended'' (api/jobber/sync-extended.js). Defaults to ''sync'' for backward compatibility with every pre-2026-08-07 row.';
comment on column sync_log.details is 'Per-resource counts/errors for sync_extended runs, e.g. {"quotes":12,"vehicles":10,"errors":{"timesheets":"..."}}, so a single resource failing is visible without re-deriving it from synced_at. NULL for ''sync'' rows -- see clients_synced/jobs_synced/invoices_synced instead.';
