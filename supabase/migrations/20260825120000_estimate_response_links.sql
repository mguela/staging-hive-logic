-- Single-use tokens behind the Approve/Reject links emailed to a client when
-- an estimate is sent (api/bookkeeping/estimates/send.js) — 2026-08-25,
-- jomell: "when clicking 'send to client'... that email should contain
-- details and there should be a button or lets say links either saying
-- 'approve' or 'reject'."
--
-- Deliberately its OWN table, not a reuse of client_approvals
-- (013_client_portal.sql): that table belongs to the separate Client Portal
-- initiative, which Chris explicitly scoped as a mockup ("option b (mockup),
-- it doesn't have to be live just yet") and requires a client session
-- (magic link -> session -> approval_sign/approval_reject). This is a
-- single click from an email, no session, tied directly to the REAL native
-- estimates engine (server/bookkeeping/src/estimates.js) that this app's
-- Estimates list actually reads and writes.
--
-- Same token idiom already used by invites (api/invites.js) and portal auth
-- (api/_lib/portal-auth.js): a random token is emailed once and never
-- stored — only its SHA-256 hash lives here, so a leaked database row can
-- never be replayed into a real approve/reject.
--
-- estimate_id/company_id mirror lead_pipeline.estimate_id's own reasoning
-- (20260818160000_lead_estimate_link.sql): estimates are a jsonb document
-- store with no column for a real foreign key, so this is a loose text link
-- enforced by the route, not the database.

create table if not exists public.estimate_response_links (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  estimate_id text not null,
  estimate_number text,
  client_email text,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_action text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_estimate_response_links_token_hash
  on public.estimate_response_links (token_hash);

create index if not exists idx_estimate_response_links_estimate
  on public.estimate_response_links (estimate_id);

-- Server-only: the respond endpoint looks tokens up by hash before any
-- actor identity exists (the client has no HiveLogic login), so this must
-- be reachable only with the service key, exactly like
-- app_status_findings/app_status_events (20260818180000_app_status_hub.sql).
alter table public.estimate_response_links enable row level security;
revoke all on table public.estimate_response_links from public, anon, authenticated;
grant select, insert, update, delete on table public.estimate_response_links to service_role;
