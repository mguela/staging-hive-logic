-- Reconciled into the canonical migration history from sql/067_quotes_jobber_web_uri.sql
-- (applied to production 2026-08-11, never mirrored into supabase/migrations/).
-- Captures existing production state; does not change the database. Verified
-- against the 2026-08-02 remote baseline (the quotes table had no jobber_web_uri
-- column) and live api/jobber/sync-extended.js which selects jobberWebUri for
-- quotes and the Estimates "Batch Send" flow which reads it.
--
-- Adds jobber_web_uri to quotes so Batch Send can open each selected quote's
-- real Jobber page (Jobber owns actually sending a quote to a client).

alter table public.quotes add column if not exists jobber_web_uri text;
