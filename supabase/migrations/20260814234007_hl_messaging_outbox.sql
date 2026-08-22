-- Captured verbatim from prod supabase_migrations.schema_migrations (version 20260814234007).
-- Client messaging (confirmations / reminders / approval ladder), OFF by default.
-- Everything is QUEUED into hl_outbox; a master switch in hl_message_settings decides
-- whether a processor actually sends. While OFF, nothing reaches a customer — it's a
-- live preview of exactly what would go out. Additive; RLS on, service-role only.

create table if not exists public.hl_message_settings (
  id boolean primary key default true,          -- single-row guard (only one row: true)
  enabled boolean not null default false,        -- MASTER switch. false = send nothing (preview only)
  confirm_on_create boolean not null default true,
  reminders jsonb not null default '[{"id":"d3","label":"3 days before","on":true},{"id":"d1","label":"1 day before","on":true},{"id":"d0","label":"Same day 7am","on":true},{"id":"h1","label":"1 hour before","on":true}]'::jsonb,
  channels jsonb not null default '{"email":false,"sms":false,"call":false}'::jsonb,   -- per-channel, all off until connected
  cancellation_policy text default '24-hour notice required. Cancellations inside 24 hours may incur a $95 trip fee; no-shows are billed at the visit minimum.',
  updated_by text, updated_at timestamptz not null default now(),
  constraint hl_message_settings_singleton check (id = true)
);
insert into public.hl_message_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.hl_outbox (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid,                 -- source hl_appointment (nullable)
  visit_jid text,                      -- or a Jobber visit
  step text not null,                  -- confirm | d3 | d1 | d0 | h1 | approval
  channel text not null default 'email', -- email | sms | call
  recipient_name text,
  recipient_contact text,              -- email or phone (may be null until resolved)
  subject text,
  body text,
  scheduled_for timestamptz not null,
  status text not null default 'queued', -- queued | sent | skipped | failed | preview
  sent_at timestamptz, error text,
  created_at timestamptz not null default now()
);
create index if not exists hl_outbox_due_idx on public.hl_outbox (scheduled_for) where status = 'queued';
create index if not exists hl_outbox_appt_idx on public.hl_outbox (appointment_id);

alter table public.hl_message_settings enable row level security;
alter table public.hl_outbox enable row level security;
