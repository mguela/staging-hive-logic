-- sql/021_campaigns.sql
-- Real campaign tracking for the Marketing Suite rebuild (Chris, 2026-07-23).
--
-- Same honest pattern as review_requests (sql/020): no automatic sending
-- exists (no Twilio/SendGrid/Resend connected), so "sent" is recorded when
-- the owner actually clicks through a real mailto/print-ready link and marks
-- it done. Outcomes (responded/booked) are marked manually by the owner too
-- -- there is no inbox/CRM integration to auto-detect a reply or a booking.
-- ROI/response-rate numbers computed from this table are real precisely
-- because they start empty and only fill in as real actions happen -- never
-- seed this with placeholder rows.
-- Applied directly via Supabase MCP on 2026-07-23; this file documents it.

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null check (type in ('estimate_recovery','review_request','reactivation','referral','seasonal','custom')),
  target_filter jsonb,
  channel text not null default 'email' check (channel in ('email','sms','mail')),
  status text not null default 'draft' check (status in ('draft','active','paused','completed')),
  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  client_id text references clients(jobber_id) on delete set null,
  target_record_id text,
  target_record_type text,
  sent_at timestamptz,
  outcome text not null default 'no_response' check (outcome in ('no_response','responded','booked')),
  outcome_value numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaigns_status_idx on campaigns(status);
create index if not exists campaign_recipients_campaign_idx on campaign_recipients(campaign_id);
create index if not exists campaign_recipients_client_idx on campaign_recipients(client_id);

alter table campaigns enable row level security;
alter table campaign_recipients enable row level security;

create policy "service role full access campaigns" on campaigns
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
create policy "service role full access campaign_recipients" on campaign_recipients
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
