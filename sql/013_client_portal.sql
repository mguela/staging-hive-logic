-- 013_client_portal.sql
--
-- Client Portal — Phase 1 schema. Companion to the Sub Portal (012).
-- Read side (jobs, invoices, client identity) reuses the REAL tables already
-- synced from Jobber (clients/jobs/invoices via api/jobber/sync.js) --
-- this migration never duplicates that data, only adds the portal-native
-- tables Jobber doesn't sync for us: auth, messaging, notifications,
-- approvals (estimate/change-order e-sign), and payment requests.
--
-- ADDITIVE ONLY. Safe to run more than once (IF NOT EXISTS guards
-- throughout). Run once in the Supabase SQL editor, same as 002-012.
--
-- client_ref is TEXT, not uuid -- it stores Jobber's own client id
-- (clients.jobber_id, a base64 GraphQL global id like "Z2lkOi8v...").
-- No formal foreign key to clients(jobber_id): that table is owned by the
-- Jobber sync job and can be re-upserted/reordered independently, so this
-- mirrors the loose-coupling already used by client_locations elsewhere
-- in this schema rather than risking sync-order FK failures.
--
-- Design constraints (same P0 discipline as the Sub Portal):
--   - Every client-initiated action is audit-logged (client_audit_log,
--     append-only, never updated).
--   - client_auth_links (single-use, short-lived magic links) is a
--     separate table from client_sessions (long-lived device sessions),
--     same "session reality" reasoning as the Sub Portal: the link gets a
--     client in the door once, the session is what keeps them in.
--   - client_payments is a REQUEST record, never a charge record. Phase 1
--     has no live payment processor wired in (Chris's call: "option b
--     (mockup), it doesn't have to be live just yet") -- status only ever
--     moves invited -> requested -> (future: sent_to_office). It must
--     never be set to 'paid' by this code path; real payment status still
--     comes from Jobber's synced invoices.payments field, same as today.

create table if not exists client_auth_links (
  id uuid primary key default gen_random_uuid(),
  client_ref text not null,
  token text not null unique,              -- single-use, opaque, random
  purpose text not null default 'login',   -- invite | login
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists client_auth_links_token_idx on client_auth_links(token);
create index if not exists client_auth_links_client_idx on client_auth_links(client_ref);

create table if not exists client_sessions (
  id uuid primary key default gen_random_uuid(),
  client_ref text not null,
  token text not null unique,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists client_sessions_token_idx on client_sessions(token);
create index if not exists client_sessions_client_idx on client_sessions(client_ref);

-- Estimates AND change orders share one table (kind distinguishes them) --
-- the mockup already treats both as the same "review, e-sign, approve"
-- flow, and neither is currently synced from Jobber, so these are
-- portal-native records staff creates for a client to act on.
create table if not exists client_approvals (
  id uuid primary key default gen_random_uuid(),
  client_ref text not null,
  job_ref text,                    -- optional link to jobs.jobber_id
  kind text not null,              -- estimate | change_order
  number text,                     -- e.g. 'CO-231-004-01' or an estimate #
  title text not null,
  description text,
  amount numeric,
  payment_terms text,
  doc_url text,                    -- optional link to the full PDF
  status text not null default 'pending',  -- pending | approved | rejected | expired
  sent_at timestamptz not null default now(),
  responded_at timestamptz,
  signer_name text,
  signature_ip text,
  created_at timestamptz not null default now()
);
create index if not exists client_approvals_client_idx on client_approvals(client_ref, status);

-- Payment REQUEST only -- see header note. Never a source of truth for
-- whether an invoice is actually paid; that stays Jobber's job.
create table if not exists client_payments (
  id uuid primary key default gen_random_uuid(),
  client_ref text not null,
  invoice_ref text,                -- invoices.jobber_id
  amount numeric not null,
  method text,                     -- card | ach | check (selection only)
  status text not null default 'requested',  -- requested | sent_to_office
  note text,
  requested_at timestamptz not null default now()
);
create index if not exists client_payments_client_idx on client_payments(client_ref, status);

create table if not exists client_notifications (
  id uuid primary key default gen_random_uuid(),
  client_ref text not null,
  type text not null,   -- approval_due | invoice_due | job_update | payment_requested
  title text not null,
  body text,
  action_url text,
  entity_type text,
  entity_id uuid,
  read_at timestamptz,
  send_after timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists client_notifications_client_idx on client_notifications(client_ref, read_at);

create table if not exists client_messages (
  id uuid primary key default gen_random_uuid(),
  client_ref text not null,
  job_ref text,
  sender text not null,   -- 'client' | 'staff'
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists client_messages_client_idx on client_messages(client_ref, created_at);

create table if not exists client_audit_log (
  id uuid primary key default gen_random_uuid(),
  client_ref text,
  actor text not null default 'client',   -- client | staff | reina
  action text not null,                   -- e.g. 'approval_signed', 'payment_requested'
  entity_type text,
  entity_id uuid,
  detail jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists client_audit_log_client_idx on client_audit_log(client_ref, created_at);
