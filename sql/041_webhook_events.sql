-- sql/041_webhook_events.sql
-- Queue for Jobber webhook events (2026-07-31). api/jobber/webhook.js
-- inserts one row per received event (fast ACK inside Jobber's 1-second
-- response rule); the once-a-minute drain cron fetches each changed record
-- from Jobber and upserts it, then marks the row done/error.
-- Service-role only (RLS enabled, no policies) - same pattern as the other
-- sync/infra tables.

create table if not exists webhook_events (
  id bigint generated always as identity primary key,
  topic text not null,
  item_id text not null,
  account_id text,
  occurred_at timestamptz,
  status text not null default 'pending', -- pending | done | error
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists webhook_events_pending_idx
  on webhook_events (received_at)
  where status = 'pending';

alter table webhook_events enable row level security;
