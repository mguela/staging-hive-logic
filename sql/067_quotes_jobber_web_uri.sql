-- sql/067_quotes_jobber_web_uri.sql
--
-- Adds jobber_web_uri to quotes, so "Batch Send" on the Estimates tab can
-- open each selected quote's real Jobber page (Jobber owns actually sending
-- a quote to a client -- this just gets you there faster instead of
-- building a parallel send system, same reasoning as the invoice-PDF
-- decision earlier this session).
--
-- UNVERIFIED: unlike quote_number/title/quoteStatus/amounts/client (confirmed
-- live against the real Jobber account), jobberWebUri was added to
-- api/jobber/sync-extended.js's QUOTES_QUERY by inference from the Request/
-- Job/Invoice queries, which do have it -- but sync-extended.js's own
-- comments note at least one type (Visit) that does NOT have this field on
-- Jobber's schema. If Quote doesn't either, the NEXT quotes sync run will
-- fail with a GraphQL validation error until that field is reverted. Trigger
-- a sync after this deploys and check sync_log for a quotes-sync error
-- before relying on this.

alter table public.quotes add column if not exists jobber_web_uri text;
