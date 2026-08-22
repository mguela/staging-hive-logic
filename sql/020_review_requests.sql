-- sql/020_review_requests.sql
-- ADDITIVE ONLY. Tracks review-request engagement per completed job so the
-- Marketing > Opportunity Engine can show "which completed jobs still need
-- a review ask" without re-surfacing ones already handled. Does not alter
-- jobs/clients/invoices or any other existing table.
--
-- No automatic sending exists yet -- no Twilio/SendGrid/Resend/similar
-- account is connected (see reina/mos-architecture-spec-2026-07-23.md,
-- Section 9, in the Build Reina project). This table backs a manual
-- workflow instead: HiveLogic tells you which completed jobs still need a
-- review ask and gives you a ready-to-send email link; you click send
-- yourself from your own email client, then mark it here so it doesn't
-- keep nagging you about the same job.
--
-- Deliberately has NO sentiment field. Every completed job with a client
-- email gets the same review-ask treatment regardless of any predicted
-- sentiment -- there is nothing here to gate on, by design. See the
-- review-gating research (reina/mos-competitive-research-2026-07-23.md,
-- Cluster 6) and the FTC's 2024 Consumer Review Rule before ever adding
-- one.
--
-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New
-- query -> paste -> Run). Safe to run more than once (IF NOT EXISTS guards).

create table if not exists review_requests (
  id uuid primary key default gen_random_uuid(),
  job_id text not null unique,   -- references jobs.jobber_id (not a FK: jobs is a synced/read-only table)
  client_id text,                -- references clients.jobber_id, denormalized for display without a second join
  channel text check (channel in ('email', 'sms')),  -- 'sms' reserved for when phone numbers are synced from Jobber (not yet -- see api/jobber/sync.js CLIENTS_QUERY)
  status text not null default 'pending' check (status in ('pending', 'sent', 'dismissed')),
  sent_at timestamptz,
  dismissed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists review_requests_status_idx on review_requests (status);
