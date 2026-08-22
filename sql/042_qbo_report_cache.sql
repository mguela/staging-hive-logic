-- 042: qbo_report_cache — durable cache for slow QuickBooks report scans.
--
-- Problem: the Command Center's "Jobs Needing Attention" tile (and the
-- Watching margin-fade tile) call api/track1?resource=watching_margin_fade,
-- which calls getFinancials('job_costing_summary') in api/qbo/index.js.
-- That kind paginates EVERY Purchase and Bill in QuickBooks (SELECT * in
-- 1000-row pages) on each call — commonly 10-15 seconds of live QBO
-- latency. The only cache was a 50s in-memory promise memo, which dies
-- with every serverless cold start, so real users paid the full 10-15s
-- freeze almost every visit.
--
-- This table persists the computed report payload across invocations.
-- api/qbo/index.js's getFinancialsDurable() serves the cached payload
-- instantly and revalidates from QuickBooks AFTER the response is sent
-- (stale-while-revalidate), so no user request ever blocks on the scan
-- again after the very first compute.
--
-- One row per report kind+opts. Payload is the exact getFinancials()
-- return value (real QBO data, never fabricated) plus nothing else —
-- staleness is exposed to the caller via computed_at so the UI can say
-- honestly how old the numbers are.
--
-- SECURITY: RLS enabled with no policies — only the service role (the
-- API) can read or write it, same trust model as the integrations table.
-- Nothing here is user-facing PII, but there is no reason to expose it.

create table if not exists public.qbo_report_cache (
  cache_key   text primary key,
  payload     jsonb not null,
  computed_at timestamptz not null default now()
);

alter table public.qbo_report_cache enable row level security;

revoke all on public.qbo_report_cache from anon, authenticated;
