-- 012_subcontractor_portal.sql
--
-- Subcontractor Portal — Phase 1 schema. Spec: claude/sub-portal-spec.md
-- (dictated by Chris 2026-07-21, audited and approved same day).
--
-- ADDITIVE ONLY. Safe to run more than once (IF NOT EXISTS guards
-- throughout). Run once in the Supabase SQL editor, same as 002-011.
--
-- Design constraints baked into this schema (spec P0 items):
--   - No raw ACH/bank numbers, anywhere, ever (P0 #2). sub_banking stores
--     only a masked display string + an opaque payment-provider reference
--     token. If a future code path tries to write anything that looks like
--     a raw account/routing number here, that's a bug in the API layer,
--     not something this schema should make easy.
--   - Every sub-initiated action is audit-logged (P0 #3) — sub_audit_log
--     is append-only, never updated.
--   - sub_auth_links (single-use, short-lived magic links) is a separate
--     table from sub_sessions (long-lived device sessions) on purpose —
--     P0 #5: the magic link gets a sub in the door once; the session is
--     what keeps them in without a password, ever.

create table if not exists subs (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,
  contact_name text,
  phone text,
  email text,
  accepts_cc boolean,
  ap_contact_name text,
  ap_email text,
  license_number text,
  license_type text,
  status text not null default 'invited',        -- invited | onboarding | active | suspended
  preferred_language text not null default 'en',  -- en | es (spec P1 #8)
  notify_sms boolean not null default true,
  notify_email boolean not null default true,
  notify_chirp boolean not null default false,    -- opt-in only, requires the app (spec: Chirp)
  calendar_sync_enabled boolean not null default false,
  invited_at timestamptz not null default now(),
  onboarded_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists subs_status_idx on subs(status);
create index if not exists subs_phone_idx on subs(phone);
create index if not exists subs_email_idx on subs(email);

create table if not exists sub_auth_links (
  id uuid primary key default gen_random_uuid(),
  sub_id uuid not null references subs(id) on delete cascade,
  token text not null unique,              -- single-use, opaque, random
  purpose text not null default 'login',   -- invite | login | reauth
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists sub_auth_links_token_idx on sub_auth_links(token);
create index if not exists sub_auth_links_sub_idx on sub_auth_links(sub_id);

-- Long-lived device session, separate from the single-use link above.
-- P0 #5: magic links get opened in email/SMS webviews and lost — once
-- redeemed, the sub stays signed in on that device via this token until
-- they explicitly need a new one ("text me a new link").
create table if not exists sub_sessions (
  id uuid primary key default gen_random_uuid(),
  sub_id uuid not null references subs(id) on delete cascade,
  token text not null unique,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists sub_sessions_token_idx on sub_sessions(token);
create index if not exists sub_sessions_sub_idx on sub_sessions(sub_id);

create table if not exists sub_documents (
  id uuid primary key default gen_random_uuid(),
  sub_id uuid not null references subs(id) on delete cascade,
  doc_type text not null,          -- coi | w9 | license | other
  file_url text not null,
  expires_at date,
  status text not null default 'current',  -- current | expiring | expired
  uploaded_at timestamptz not null default now()
);
create index if not exists sub_documents_sub_idx on sub_documents(sub_id);

-- P0 #2: this table NEVER stores a raw account or routing number. Only a
-- masked display value and an opaque reference token minted by whichever
-- payment provider Phase 2 wires up (QBO Bill Pay / Melio / Stripe — see
-- claude/sub-portal-spec.md open questions). The API layer must reject any
-- write here that looks like a real bank number.
create table if not exists sub_banking (
  id uuid primary key default gen_random_uuid(),
  sub_id uuid not null references subs(id) on delete cascade,
  provider text,          -- 'qbo_billpay' | 'melio' | 'stripe' | null until Phase 2
  provider_ref text,      -- opaque token from the provider, never a bank number
  masked_account text,    -- e.g. '****4821', display only
  accepts_ach boolean not null default false,
  updated_at timestamptz not null default now()
);
create unique index if not exists sub_banking_sub_uidx on sub_banking(sub_id);

create table if not exists sub_rfqs (
  id uuid primary key default gen_random_uuid(),
  sub_id uuid not null references subs(id) on delete cascade,
  job_ref text,
  title text not null,
  scope text,
  doc_urls jsonb,
  due_date date,
  status text not null default 'sent',   -- sent | viewed | bid_submitted | declined | expired
  bid_amount numeric,
  bid_notes text,
  bid_submitted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists sub_rfqs_sub_idx on sub_rfqs(sub_id, status);

create table if not exists sub_rfis (
  id uuid primary key default gen_random_uuid(),
  sub_id uuid not null references subs(id) on delete cascade,
  job_ref text,
  question text not null,
  answer text,
  status text not null default 'open',   -- open | answered
  created_at timestamptz not null default now(),
  answered_at timestamptz
);
create index if not exists sub_rfis_sub_idx on sub_rfis(sub_id, status);

create table if not exists sub_schedule_items (
  id uuid primary key default gen_random_uuid(),
  sub_id uuid not null references subs(id) on delete cascade,
  job_ref text,
  title text not null,
  start_at timestamptz not null,
  end_at timestamptz,
  status text not null default 'proposed',  -- proposed | approved | change_requested
  change_note text,
  created_at timestamptz not null default now()
);
create index if not exists sub_schedule_sub_idx on sub_schedule_items(sub_id, start_at);

create table if not exists sub_invoices (
  id uuid primary key default gen_random_uuid(),
  sub_id uuid not null references subs(id) on delete cascade,
  job_ref text,
  file_url text not null,
  amount numeric,                       -- OCR-read or sub-confirmed (spec P1 #6)
  amount_source text default 'manual',  -- ocr | manual
  status text not null default 'submitted',  -- submitted | scheduled | paid
  payment_due date,
  submitted_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists sub_invoices_sub_idx on sub_invoices(sub_id, status);

create table if not exists sub_notifications (
  id uuid primary key default gen_random_uuid(),
  sub_id uuid not null references subs(id) on delete cascade,
  type text not null,   -- bid_due | invoice_due | schedule_upcoming | schedule_unapproved | doc_expiring | payment_sent
  title text not null,
  body text,
  action_url text,
  entity_type text,
  entity_id uuid,
  read_at timestamptz,
  send_after timestamptz not null default now(),
  sent_sms_at timestamptz,
  sent_email_at timestamptz,
  sent_chirp_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists sub_notifications_sub_idx on sub_notifications(sub_id, read_at);

-- P0 #3: append-only audit trail for every sub-initiated action (dispute
-- protection: "why does the sub say they approved this schedule?"). Rows
-- are inserted, never updated or deleted by application code.
create table if not exists sub_audit_log (
  id uuid primary key default gen_random_uuid(),
  sub_id uuid references subs(id) on delete set null,
  actor text not null default 'sub',   -- sub | staff | reina
  action text not null,                -- e.g. 'bid_submitted', 'schedule_approved', 'doc_uploaded'
  entity_type text,
  entity_id uuid,
  detail jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists sub_audit_log_sub_idx on sub_audit_log(sub_id, created_at);

create table if not exists sub_messages (
  id uuid primary key default gen_random_uuid(),
  sub_id uuid not null references subs(id) on delete cascade,
  sender text not null,   -- 'sub' | 'staff'
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists sub_messages_sub_idx on sub_messages(sub_id, created_at);
