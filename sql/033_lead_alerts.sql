-- New lead opportunities, from any source, should alert Chris -- not sit
-- unseen until someone happens to open the notifications panel (Chris,
-- 2026-07-26). This table is the idempotency ledger for that alert: Vercel
-- Cron delivery is "best effort" and can duplicate or miss invocations (per
-- Vercel's own docs), so the check_new_leads cron handler (api/track1.js)
-- must be safe to run more than once per lead. It claims each lead via an
-- atomic ignore-duplicates insert against this table's unique constraint --
-- only a row that is genuinely new (never claimed before) comes back from
-- that insert, so a lead is alerted exactly once no matter how many times
-- the cron fires or how long it keeps showing up in the lookback window.
--
-- Purely additive: a new table, no changes to any existing table or data.

create table if not exists lead_alerts_sent (
  id bigint generated always as identity primary key,
  source text not null,       -- 'request' (Jobber inbound request) | 'client_lead' (clients.is_lead=true, incl. HiveLogic-native leads tagged via lead_pipeline.lead_source: angi/thumbtack/yelp/facebook/website/etc)
  lead_id text not null,      -- the source's own id for the lead (requests.jobber_id or clients.jobber_id)
  alerted_at timestamptz not null default now(),
  unique (source, lead_id)
);

create index if not exists lead_alerts_sent_alerted_at_idx on lead_alerts_sent (alerted_at desc);
