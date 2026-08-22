SET session_replication_role = replica;

--
-- PostgreSQL database dump
--

-- \restrict 2JMOzlaVURvZEs3OhWAzqOc3qNRGXBmex2KbC7tx98SxBl9LOHgWTjV8JLmT9fi

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: supabase_migrations; Owner: postgres
--

INSERT INTO "supabase_migrations"."schema_migrations" ("version", "statements", "name", "created_by", "idempotency_key", "rollback") VALUES
	('20260723153817', '{"-- sql/020_review_requests.sql
-- ADDITIVE ONLY. Tracks review-request engagement per completed job so the
-- Marketing > Opportunity Engine can show \"which completed jobs still need
-- a review ask\" without re-surfacing ones already handled. Does not alter
-- jobs/clients/invoices or any other existing table.
--
-- No automatic sending exists yet -- no Twilio/SendGrid/Resend/similar
-- account is connected. This table backs a manual workflow instead:
-- HiveLogic tells you which completed jobs still need a review ask and
-- gives you a ready-to-send email link; you click send yourself from your
-- own email client, then mark it here so it doesn''t keep nagging you
-- about the same job.
--
-- Deliberately has NO sentiment field. Every completed job with a client
-- email gets the same review-ask treatment regardless of any predicted
-- sentiment -- there is nothing here to gate on, by design.

create table if not exists review_requests (
  id uuid primary key default gen_random_uuid(),
  job_id text not null unique,
  client_id text,
  channel text check (channel in (''email'', ''sms'')),
  status text not null default ''pending'' check (status in (''pending'', ''sent'', ''dismissed'')),
  sent_at timestamptz,
  dismissed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists review_requests_status_idx on review_requests (status);
"}', '020_review_requests', 'c_kendall@icloud.com', NULL, NULL),
	('20260723231942', '{"-- sql/021_campaigns.sql
-- Real campaign tracking for the Marketing Suite rebuild (Chris, 2026-07-23).
--
-- Same honest pattern as review_requests (sql/020): no automatic sending
-- exists (no Twilio/SendGrid/Resend connected), so \"sent\" is recorded when
-- the owner actually clicks through a real mailto/print-ready link and marks
-- it done. Outcomes (responded/booked) are marked manually by the owner too
-- -- there is no inbox/CRM integration to auto-detect a reply or a booking.
-- ROI/response-rate numbers computed from this table are real precisely
-- because they start empty and only fill in as real actions happen -- never
-- seed this with placeholder rows.

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null check (type in (''estimate_recovery'',''review_request'',''reactivation'',''referral'',''seasonal'',''custom'')),
  target_filter jsonb, -- describes which real records this targets, e.g. {\"quoteIds\": [...]} or {\"clientIds\": [...]}
  channel text not null default ''email'' check (channel in (''email'',''sms'',''mail'')),
  status text not null default ''draft'' check (status in (''draft'',''active'',''paused'',''completed'')),
  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  client_id text references clients(jobber_id) on delete set null,
  target_record_id text,   -- e.g. a quote or job jobber_id this recipient''s outreach is tied to
  target_record_type text, -- ''quote'' | ''job'' | ''client''
  sent_at timestamptz,     -- set manually when the owner marks it sent, same as review_requests
  outcome text not null default ''no_response'' check (outcome in (''no_response'',''responded'',''booked'')),
  outcome_value numeric,   -- real booked $ if outcome = ''booked'', entered by the owner
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaigns_status_idx on campaigns(status);
create index if not exists campaign_recipients_campaign_idx on campaign_recipients(campaign_id);
create index if not exists campaign_recipients_client_idx on campaign_recipients(client_id);

alter table campaigns enable row level security;
alter table campaign_recipients enable row level security;

create policy \"service role full access campaigns\" on campaigns
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');
create policy \"service role full access campaign_recipients\" on campaign_recipients
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');
"}', '021_campaigns', 'c_kendall@icloud.com', NULL, NULL),
	('20260724000627', '{"-- Employee schedule roles: which calendar/lens each real (Jobber-synced) employee
-- routes to on the Job Schedule board. Replaces the old hardcoded DTECHS/DOFF/DSUBS
-- arrays in public/index.html, which showed a frozen, partly-fictional 14-person
-- roster (including at least 2 names matching no real employee) regardless of
-- whether someone was still active in Jobber.
create table if not exists employee_roles (
  jobber_id text primary key references users(jobber_id) on delete cascade,
  lens text not null default ''unassigned'' check (lens in (''crew'',''office'',''sub'',''hidden'',''unassigned'')),
  division text,
  crew_label text,
  color text,
  sort_order integer,
  updated_at timestamptz not null default now(),
  updated_by text
);
comment on table employee_roles is ''Admin-assigned schedule routing (crew/office/sub/hidden) per real Jobber employee. Set via Team > Crew Roster in the app.'';"}', 'create_employee_roles', 'c_kendall@icloud.com', NULL, NULL),
	('20260724011207', '{"alter table employee_roles
  add column if not exists permission_role text
  check (permission_role in (
    ''owner'',''partner'',''office_manager'',''project_manager'',
    ''dispatch'',''accounting'',''design_sales'',''marketing'',
    ''systems_pm'',''field_crew''
  ));

comment on column employee_roles.permission_role is ''Job-function role (2026-07-24, Chris) -- distinct from lens (which schedule board they hit). Drives app permissions and default Command Center landing page. NULL = not yet classified.'';"}', 'add_permission_role_to_employee_roles', 'c_kendall@icloud.com', NULL, NULL),
	('20260724014858', '{"create table if not exists bookkeeping_evidence_documents (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  filename text not null,
  mime_type text not null,
  size_bytes integer not null,
  sha256 text not null,
  data_base64 text not null,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists bookkeeping_evidence_documents_company_idx on bookkeeping_evidence_documents (company_id);
"}', 'bookkeeping_evidence_documents', 'c_kendall@icloud.com', NULL, NULL),
	('20260724014942', '{"-- Match the security posture of the sibling bookkeeping_expenses table:
-- RLS enabled, zero policies. This blocks all anon/authenticated-key access
-- (the app never uses those for this table) while leaving the service-role
-- key (used server-side by api/bookkeeping/evidence.js via supabaseRequest)
-- fully unaffected, since the service role always bypasses RLS in Supabase.
alter table bookkeeping_evidence_documents enable row level security;
"}', 'bookkeeping_evidence_documents_rls_parity', 'c_kendall@icloud.com', NULL, NULL),
	('20260724015713', '{"alter table employee_roles drop constraint employee_roles_permission_role_check;
alter table employee_roles add constraint employee_roles_permission_role_check
  check (permission_role = ANY (ARRAY[''owner'',''partner'',''office_manager'',''project_manager'',''dispatch'',''accounting'',''design_sales'',''marketing'',''systems_pm'',''field_crew'',''subcontractor'']::text[]));"}', 'add_subcontractor_permission_role', 'c_kendall@icloud.com', NULL, NULL),
	('20260724020643', '{"create table if not exists subcontractors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  trade text,
  contact_name text,
  phone text,
  email text,
  notes text,
  status text not null default ''active'' check (status in (''active'',''inactive'')),
  jobber_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text,
  updated_by text
);

comment on table subcontractors is ''Subcontractor company directory for the Vendors & Subs page. Optional jobber_id links to employee_roles/users when a sub is also tracked as a Jobber team member for schedule matching (e.g. Pro Custom Home Builders / Albarn Flood).'';

-- Seed Pro Custom Home Builders, already tracked via employee_roles for schedule matching
insert into subcontractors (name, trade, status, jobber_id, created_by, updated_by)
values (''Pro Custom Home Builders'', null, ''active'', ''Z2lkOi8vSm9iYmVyL1VzZXIvMTcyOTc5NA=='', ''claude-subs-page-2026-07-24'', ''claude-subs-page-2026-07-24'')
on conflict do nothing;"}', 'create_subcontractors_table', 'c_kendall@icloud.com', NULL, NULL),
	('20260724122306', '{"alter table bookkeeping_evidence_documents
  add column if not exists status text not null default ''received'';

alter table bookkeeping_evidence_documents
  add column if not exists resolution text;

alter table bookkeeping_evidence_documents
  add column if not exists review_note text;

alter table bookkeeping_evidence_documents
  add column if not exists reviewed_at timestamptz;

alter table bookkeeping_evidence_documents
  add column if not exists reviewed_by uuid;

update bookkeeping_evidence_documents set status = ''received'' where status is null;

create index if not exists bookkeeping_evidence_documents_status_idx on bookkeeping_evidence_documents (company_id, status);"}', 'bookkeeping_evidence_review', 'c_kendall@icloud.com', NULL, NULL),
	('20260724130808', '{"create table if not exists bookkeeping_catalog_items (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  type text not null check (type in (''material'', ''expense'')),
  name text not null,
  nickname text,
  sku text,
  version integer not null default 1,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bookkeeping_catalog_items_company_idx on bookkeeping_catalog_items (company_id);
create index if not exists bookkeeping_catalog_items_company_type_idx on bookkeeping_catalog_items (company_id, type);"}', 'bookkeeping_catalog', 'c_kendall@icloud.com', NULL, NULL),
	('20260724130812', '{"create table if not exists bookkeeping_reina_learning (
  company_id text primary key,
  data jsonb not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table bookkeeping_reina_learning is
  ''One row per company: Reina''''s approved-learning memory (server/bookkeeping/src/reina-learning.js''''s ensureLearningState() shape), versioned for optimistic-concurrency updates.'';"}', 'bookkeeping_reina_learning', 'c_kendall@icloud.com', NULL, NULL),
	('20260724130818', '{"create table if not exists bookkeeping_contractor_profiles (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  vendor_key text not null,
  data jsonb not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, vendor_key)
);

comment on table bookkeeping_contractor_profiles is
  ''One row per company+vendor: 1099/W-9 tracking status feeding contractorTaxReport(). Keyed by a normalized vendor name (see server/bookkeeping/src/catalog.js''''s normalizeCatalogTerm), not a formal vendor id -- this app records vendors as free text on expenses/receipts.'';

create index if not exists bookkeeping_contractor_profiles_company_idx
  on bookkeeping_contractor_profiles (company_id);"}', 'bookkeeping_contractor_tax', 'c_kendall@icloud.com', NULL, NULL),
	('20260724130823', '{"create table if not exists bookkeeping_sales_tax_entries (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  kind text not null check (kind in (''collected'', ''remitted'')),
  tax_state text not null,
  entry_date date not null,
  data jsonb not null,
  status text not null default ''active'' check (status in (''active'', ''void'')),
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table bookkeeping_sales_tax_entries is
  ''Manually-logged sales-tax-collected and tax-remitted-to-state entries feeding salesTaxLiability(). Void (not deleted) to preserve an audit trail -- see api/bookkeeping/_sales_tax_store.js.'';

create index if not exists bookkeeping_sales_tax_entries_company_idx
  on bookkeeping_sales_tax_entries (company_id, entry_date);"}', 'bookkeeping_sales_tax', 'c_kendall@icloud.com', NULL, NULL),
	('20260724135239', '{"-- sql/023_voice_phone_system.sql
-- ADDITIVE ONLY. HiveLogic Phone -- a strictly telephone-only business VoIP
-- system, deliberately separate from HiveConnect (chat/messaging/video).

alter table clients add column if not exists phone_e164 text;
create index if not exists clients_phone_e164_idx on clients (phone_e164);

create table if not exists voice_extensions (
  id uuid primary key default gen_random_uuid(),
  extension_number text not null unique,
  display_name text not null,
  user_id text,
  direct_number_id uuid,
  forwarding_number text,
  call_waiting_enabled boolean not null default true,
  is_operator boolean not null default false,
  voicemail_pin text,
  voicemail_greeting_text text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists voice_numbers (
  id uuid primary key default gen_random_uuid(),
  e164 text not null unique,
  friendly_name text,
  provider_sid text,
  role text not null default ''main'' check (role in (''main'',''direct'',''toll_free'')),
  assigned_extension_id uuid references voice_extensions(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = ''voice_extensions_direct_number_fk''
  ) then
    alter table voice_extensions
      add constraint voice_extensions_direct_number_fk
      foreign key (direct_number_id) references voice_numbers(id) on delete set null;
  end if;
end $$;

create table if not exists voice_schedules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default ''America/New_York'',
  business_hours jsonb not null default ''{}'',
  holidays jsonb not null default ''[]'',
  created_at timestamptz not null default now()
);

create table if not exists voice_greetings (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in (''main_open'',''main_closed'',''voicemail'',''hold'')),
  tts_text text,
  audio_url text,
  created_at timestamptz not null default now()
);

create table if not exists voice_blocked_numbers (
  id uuid primary key default gen_random_uuid(),
  e164 text not null unique,
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists voice_calls (
  id uuid primary key default gen_random_uuid(),
  provider_call_sid text unique,
  direction text not null check (direction in (''inbound'',''outbound'')),
  from_number text not null,
  to_number text not null,
  extension_id uuid references voice_extensions(id) on delete set null,
  client_id text,
  job_id text,
  status text not null default ''created'' check (status in (
    ''created'',''routing'',''ringing'',''answered'',''held'',''transferring'',
    ''parked'',''conferenced'',''voicemail'',''completed'',''failed'',''missed''
  )),
  conference_sid text,
  caller_call_sid text,
  agent_call_sid text,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  recording_sid text,
  recording_url text,
  transcript text,
  transcript_status text default ''not_captured'' check (transcript_status in (''not_captured'',''pending'',''ready'',''failed'')),
  ai_summary jsonb,
  created_at timestamptz not null default now()
);

create index if not exists voice_calls_client_idx on voice_calls (client_id);
create index if not exists voice_calls_extension_idx on voice_calls (extension_id);
create index if not exists voice_calls_started_idx on voice_calls (started_at desc);

create table if not exists voice_call_events (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references voice_calls(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default ''{}'',
  created_at timestamptz not null default now()
);

create index if not exists voice_call_events_call_idx on voice_call_events (call_id);

create table if not exists voice_voicemails (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references voice_calls(id) on delete set null,
  extension_id uuid references voice_extensions(id) on delete set null,
  from_number text not null,
  recording_sid text,
  recording_url text,
  duration_seconds integer,
  transcript text,
  transcript_status text default ''not_captured'' check (transcript_status in (''not_captured'',''pending'',''ready'',''failed'')),
  ai_summary text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists voice_voicemails_extension_idx on voice_voicemails (extension_id);
create index if not exists voice_voicemails_unread_idx on voice_voicemails (extension_id, read);
"}', 'voice_phone_system', 'c_kendall@icloud.com', NULL, NULL),
	('20260724141512', '{"alter table public.bookkeeping_catalog_items enable row level security;
alter table public.bookkeeping_reina_learning enable row level security;
alter table public.bookkeeping_contractor_profiles enable row level security;
alter table public.bookkeeping_sales_tax_entries enable row level security;"}', 'bookkeeping_stores_rls_parity_batch2', 'c_kendall@icloud.com', NULL, NULL),
	('20260724152010', '{"alter table public.employee_roles enable row level security;
alter table public.subcontractors enable row level security;"}', 'employee_roles_subcontractors_rls_parity', 'c_kendall@icloud.com', NULL, NULL),
	('20260724154122', '{"alter table public.review_requests enable row level security;"}', 'review_requests_rls_parity', 'c_kendall@icloud.com', NULL, NULL),
	('20260724183059', '{"alter table bookkeeping_evidence_documents
  add column if not exists document_type text;

alter table bookkeeping_evidence_documents
  add column if not exists extracted jsonb;

create index if not exists bookkeeping_evidence_documents_document_type_idx on bookkeeping_evidence_documents (company_id, document_type);
"}', 'bookkeeping_evidence_extracted', 'c_kendall@icloud.com', NULL, NULL),
	('20260725001028', '{"
-- Fix schema drift: handleWorkforceBreak() in api/track1.js has referenced these
-- columns since it was written, but they were never actually added to the table --
-- meaning Start Break / End Break has likely been failing silently or erroring.
alter table workforce_time_sessions
  add column if not exists on_break boolean not null default false,
  add column if not exists break_started_at timestamptz null,
  add column if not exists total_break_seconds integer not null default 0;

-- New: distinguishes a normal manual clock-out (via the EOD-report flow) from
-- an automatic safety-net clock-out fired when the browser tab closes without
-- one. Null = normal. Office Manager/Owner can see ''browser_closed'' sessions
-- and know that employee still owes an EOD report for that day.
alter table workforce_time_sessions
  add column if not exists close_reason text null;
"}', 'fix_workforce_break_columns_and_close_reason', 'c_kendall@icloud.com', NULL, NULL),
	('20260724203517', '{"
-- HiveLogic Phone: unknown-number actions (Create Contact / Add to Existing
-- Contact) and outbound SMS quick-send from the call log.
--
-- voice_known_numbers lets the phone popup label a number that isn''t a
-- Jobber client''s phone_e164 -- either with a plain name (Create Contact)
-- or by linking it to an existing Jobber client (Add to Existing Contact),
-- for cases like a customer calling from a personal cell that isn''t the
-- number on file. Resolved live in GET /api/voice?resource=calls, not
-- backfilled onto voice_calls rows.
create table if not exists public.voice_known_numbers (
  id uuid primary key default gen_random_uuid(),
  e164 text not null unique,
  display_name text,
  jobber_client_id text references public.clients(jobber_id) on delete set null,
  created_at timestamptz not null default now(),
  constraint voice_known_numbers_has_a_name check (display_name is not null or jobber_client_id is not null)
);

alter table public.voice_known_numbers enable row level security;

-- Outbound SMS log (quick-send from the Recent Calls / Calls list). No
-- inbound SMS handling yet -- that needs its own Twilio webhook resource
-- and is out of scope for this pass.
create table if not exists public.voice_messages (
  id uuid primary key default gen_random_uuid(),
  direction text not null default ''outbound'',
  from_number text not null,
  to_number text not null,
  body text not null,
  provider_sid text,
  status text not null default ''queued'',
  client_id text,
  created_at timestamptz not null default now()
);

alter table public.voice_messages enable row level security;
"}', 'voice_known_numbers_and_messages', 'c_kendall@icloud.com', NULL, NULL),
	('20260724232741', '{"-- sql/029_subcontractors_1099_merge.sql
--
-- Reconciles the two contractor concepts flagged as an open decision when
-- sql/025_bookkeeping_contractor_tax.sql was written: the bookkeeping-scoped
-- bookkeeping_contractor_profiles table (1099/W-9 tax tracking, keyed by
-- normalized vendor name) and the subcontractors company directory shipped
-- on `main` in commit 63605ad (scheduling/contact info, keyed by id).
--
-- Chris''s decision (2026-07-24): merge into one table. At decision time,
-- bookkeeping_contractor_profiles held zero rows in production -- Accounting
-- Control''s 1099 tracking had never actually been used -- so this is purely
-- additive, no data migration step needed. See
-- api/bookkeeping/_contractor_store.js for the backend swap that now reads
-- and writes these columns on `subcontractors` directly, keyed by
-- normalizeCatalogTerm(name) for matching against the free-text vendor names
-- already recorded on expenses (same join key the tax engine has always
-- used -- api/bookkeeping/_close_tax_adapters.js needed zero changes).
--
-- tax_notes is a separate column from subcontractors.notes on purpose: that
-- existing column holds dispatcher/scheduling notes. Editing 1099/W-9 notes
-- from Accounting Control must never silently overwrite a scheduling note
-- on the same row.
--
-- bookkeeping_contractor_profiles is left in place (unused, zero rows) as a
-- rollback safety net. Safe to drop in a follow-up migration once this has
-- run in production for a while with no issues.

alter table subcontractors add column if not exists track_1099 boolean not null default false;
alter table subcontractors add column if not exists w9_on_file boolean not null default false;
alter table subcontractors add column if not exists tax_id_last4 text;
alter table subcontractors add column if not exists tax_notes text;

comment on column subcontractors.track_1099 is ''Whether this vendor/subcontractor is tracked for 1099 reporting. Feeds contractorTaxReport() via api/bookkeeping/_contractor_store.js.'';
comment on column subcontractors.w9_on_file is ''Whether a signed W-9 is on file for this vendor/subcontractor.'';
comment on column subcontractors.tax_id_last4 is ''Last 4 digits only of the vendor''''s tax ID (SSN/EIN) -- never the full number.'';
comment on column subcontractors.tax_notes is ''1099/W-9 tracking notes, separate from the scheduling-facing notes column.'';
"}', 'subcontractors_1099_merge', 'c_kendall@icloud.com', NULL, NULL),
	('20260724232834', '{"
-- Support multiple permission roles per employee (e.g. Owner who also does Sales).
-- Additive only: existing permission_role column is kept in sync (first/primary role)
-- for any code path not yet updated to read the array.

ALTER TABLE employee_roles
  ADD COLUMN IF NOT EXISTS permission_roles text[] NOT NULL DEFAULT ''{}'';

-- Backfill from the existing single-value column.
UPDATE employee_roles
  SET permission_roles = ARRAY[permission_role]
  WHERE permission_role IS NOT NULL
    AND permission_roles = ''{}'';

-- Every element of permission_roles must be one of the same valid roles
-- already enforced on permission_role.
ALTER TABLE employee_roles
  ADD CONSTRAINT employee_roles_permission_roles_check
  CHECK (
    permission_roles <@ ARRAY[
      ''owner'',''partner'',''office_manager'',''project_manager'',''dispatch'',
      ''accounting'',''design_sales'',''marketing'',''systems_pm'',''field_crew'',''subcontractor''
    ]::text[]
  );
"}', 'employee_roles_multi_permission_roles', 'c_kendall@icloud.com', NULL, NULL),
	('20260724234713', '{"alter table public.voice_calls add column if not exists escalation_requested boolean not null default false;"}', 'voice_calls_escalation_flag', 'c_kendall@icloud.com', NULL, NULL),
	('20260725000530', '{"-- 018_change_orders.sql
-- ADDITIVE ONLY. Safe to run more than once (IF NOT EXISTS guards throughout).
-- Run once in the Supabase SQL editor before setting BOOKKEEPING_CO_STORE=durable.
--
-- Durable storage for the real Change Orders feature (server/bookkeeping/src/
-- change-orders.js), replacing the static three-row mockup that used to live
-- directly in public/index.html. Same jsonb-document convention as
-- sql/010_purchase_orders.sql: the full change order object the engine
-- produces/consumes is stored as one jsonb document per row, with a handful
-- of columns pulled out for fast indexing/filtering.

create table if not exists change_orders (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  co_number text not null,
  job_id text not null,               -- always chained to a parent job -- never null
  kind text not null,                  -- ''estimate'' | ''invoice''
  lifecycle_status text not null,      -- mirrors co.lifecycleStatus
  auto_approved boolean not null default false,
  version integer not null default 1,
  data jsonb not null,                 -- the full change order object exactly as the engine produces/consumes it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A company can never have two change orders sharing a number.
create unique index if not exists change_orders_company_number_uidx
  on change_orders (company_id, co_number);

create index if not exists change_orders_company_idx on change_orders (company_id);
create index if not exists change_orders_company_job_idx on change_orders (company_id, job_id);
create index if not exists change_orders_company_status_idx on change_orders (company_id, lifecycle_status);

-- Durable, atomic per-company/per-job sequence for CO numbering (mirrors
-- allocate_po_number() in sql/010_purchase_orders.sql). A change order is
-- always chained to a job, so there is no \"general\" scope here -- p_job_id
-- is required.
create table if not exists co_counters (
  company_id text not null,
  job_id text not null,
  next_sequence integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (company_id, job_id)
);

create or replace function allocate_co_number(p_company_id text, p_job_id text, p_company_code text default ''CO'')
returns table(co_number text, sequence_no integer) as $$
declare
  v_seq integer;
begin
  if p_job_id is null or p_job_id = '''' then
    raise exception ''A change order must be chained to a job -- p_job_id is required.'';
  end if;

  insert into co_counters (company_id, job_id, next_sequence)
    values (p_company_id, p_job_id, 1)
  on conflict (company_id, job_id)
    do update set next_sequence = co_counters.next_sequence + 1, updated_at = now()
  returning next_sequence into v_seq;

  if v_seq is null then
    v_seq := 1;
  end if;

  co_number := p_company_code || ''-'' || p_job_id || ''-'' || lpad(v_seq::text, 2, ''0'');
  sequence_no := v_seq;
  return next;
end;
$$ language plpgsql;
"}', '018_change_orders', 'c_kendall@icloud.com', NULL, NULL),
	('20260725000541', '{"-- 020_estimates.sql
-- ADDITIVE ONLY. Safe to run more than once (IF NOT EXISTS guards throughout).
-- Run once in the Supabase SQL editor before setting BOOKKEEPING_EST_STORE=durable.
--
-- Durable storage for the real, native HiveLogic Estimates engine
-- (server/bookkeeping/src/estimates.js) -- built per the standing rule
-- (2026-07-22): HiveLogic is the destination system, Jobber is only an
-- interim data feed. This table has no dependency on Jobber''s quote or
-- payment-schedule shapes. Same jsonb-document convention as
-- sql/010_purchase_orders.sql / sql/018_change_orders.sql: the full
-- estimate object the engine produces/consumes is stored as one jsonb
-- document per row, with a handful of columns pulled out for fast
-- indexing/filtering.

create table if not exists estimates (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  estimate_number text not null,
  client_id text not null,
  lifecycle_status text not null,      -- mirrors estimate.lifecycleStatus
  version integer not null default 1,
  data jsonb not null,                 -- the full estimate object exactly as the engine produces/consumes it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A company can never have two estimates sharing a number.
create unique index if not exists estimates_company_number_uidx
  on estimates (company_id, estimate_number);

create index if not exists estimates_company_idx on estimates (company_id);
create index if not exists estimates_company_client_idx on estimates (company_id, client_id);
create index if not exists estimates_company_status_idx on estimates (company_id, lifecycle_status);

-- Durable, atomic per-company sequence for estimate numbering (mirrors
-- allocate_po_number() / allocate_co_number()). An estimate has no job yet
-- (that''s the point of this workflow), so numbering is company-scoped, not
-- job-scoped.
create table if not exists est_counters (
  company_id text not null,
  next_sequence integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (company_id)
);

create or replace function allocate_estimate_number(p_company_id text, p_company_code text default ''EST'')
returns table(estimate_number text, sequence_no integer) as $$
declare
  v_seq integer;
begin
  insert into est_counters (company_id, next_sequence)
    values (p_company_id, 1)
  on conflict (company_id)
    do update set next_sequence = est_counters.next_sequence + 1, updated_at = now()
  returning next_sequence into v_seq;

  if v_seq is null then
    v_seq := 1;
  end if;

  estimate_number := p_company_code || ''-'' || lpad(v_seq::text, 4, ''0'');
  sequence_no := v_seq;
  return next;
end;
$$ language plpgsql;
"}', '020_estimates', 'c_kendall@icloud.com', NULL, NULL),
	('20260725001047', '{"
-- HiveLogic Monitor: the WebWork-replacement desktop screen/activity tracker.
-- Everything here is written/read only by api/track1.js using the service
-- key -- never queried directly from the browser with the anon key -- so RLS
-- is enabled with zero policies (default-deny), same pattern as the other
-- service-key-only tables in this app.

create table if not exists monitor_agents (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references profiles(id),
  device_name text null,
  platform text not null check (platform in (''windows'',''mac'')),
  agent_version text null,
  pairing_code text null,
  pairing_code_expires_at timestamptz null,
  paired_at timestamptz null,
  last_seen_at timestamptz null,
  status text not null default ''pending'' check (status in (''pending'',''active'',''revoked'')),
  created_at timestamptz not null default now()
);
create index if not exists idx_monitor_agents_employee on monitor_agents(employee_id);
create index if not exists idx_monitor_agents_pairing_code on monitor_agents(pairing_code) where pairing_code is not null;

create table if not exists monitor_sessions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references profiles(id),
  agent_id uuid not null references monitor_agents(id),
  workforce_session_id uuid null references workforce_time_sessions(id),
  started_at timestamptz not null default now(),
  ended_at timestamptz null,
  created_at timestamptz not null default now()
);
create index if not exists idx_monitor_sessions_employee on monitor_sessions(employee_id);
create index if not exists idx_monitor_sessions_agent on monitor_sessions(agent_id);

create table if not exists monitor_activity_samples (
  id uuid primary key default gen_random_uuid(),
  monitor_session_id uuid not null references monitor_sessions(id),
  sampled_at timestamptz not null default now(),
  activity_level integer not null default 0,
  idle_seconds integer not null default 0,
  active_app text null,
  display_count integer null
);
create index if not exists idx_monitor_activity_session on monitor_activity_samples(monitor_session_id, sampled_at desc);

create table if not exists monitor_screenshots (
  id uuid primary key default gen_random_uuid(),
  monitor_session_id uuid not null references monitor_sessions(id),
  captured_at timestamptz not null default now(),
  display_index integer not null default 0,
  storage_path text not null,
  width integer null,
  height integer null
);
create index if not exists idx_monitor_screenshots_session on monitor_screenshots(monitor_session_id, captured_at desc);

alter table monitor_agents enable row level security;
alter table monitor_sessions enable row level security;
alter table monitor_activity_samples enable row level security;
alter table monitor_screenshots enable row level security;

insert into storage.buckets (id, name, public)
values (''monitor-screenshots'', ''monitor-screenshots'', false)
on conflict (id) do nothing;
"}', 'hivelogic_monitor_schema', 'c_kendall@icloud.com', NULL, NULL),
	('20260725001233', '{"
-- Pairing flow needs: (1) platform unknown until the agent claims the code,
-- so it can no longer be NOT NULL; (2) a long-lived agent_token issued at
-- claim time, which the desktop agent uses to authenticate every heartbeat
-- and screenshot upload afterward (never the employee''s own login token).
alter table monitor_agents alter column platform drop not null;
alter table monitor_agents add column if not exists agent_token text null;
create unique index if not exists idx_monitor_agents_token on monitor_agents(agent_token) where agent_token is not null;
"}', 'monitor_agents_pairing_fields', 'c_kendall@icloud.com', NULL, NULL),
	('20260725001548', '{"CREATE TABLE IF NOT EXISTS schedule_writeback_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id text NOT NULL,
  action text NOT NULL CHECK (action IN (''reschedule'',''reassign'',''both'')),
  before jsonb NOT NULL,
  after jsonb,
  requested_by_email text,
  requested_by_name text,
  freeze_override boolean NOT NULL DEFAULT false,
  freeze_blocked boolean NOT NULL DEFAULT false,
  success boolean NOT NULL,
  user_errors jsonb,
  notified jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS schedule_writeback_log_visit_id_idx ON schedule_writeback_log (visit_id);
CREATE INDEX IF NOT EXISTS schedule_writeback_log_created_at_idx ON schedule_writeback_log (created_at DESC);
"}', 'schedule_writeback_log', 'c_kendall@icloud.com', NULL, NULL),
	('20260725005423', '{"
-- Hardening for the pairing endpoint (Chris asked to close this gap):
-- 1. pair_attempts caps brute-force guesses against one specific pending
--    code -- after 5 wrong guesses the code is invalidated and a fresh one
--    must be generated, instead of being guessable for the full 15 minutes.
alter table monitor_agents add column if not exists pair_attempts integer not null default 0;

-- 2. A short-lived IP attempt log for basic rate limiting on monitor_pair,
-- independent of which employee/code is being tried. Auto-prunable (rows
-- older than an hour are irrelevant); no FK, intentionally lightweight.
create table if not exists monitor_pair_attempts (
  id uuid primary key default gen_random_uuid(),
  ip text not null,
  attempted_at timestamptz not null default now()
);
create index if not exists idx_monitor_pair_attempts_ip_time on monitor_pair_attempts(ip, attempted_at desc);
alter table monitor_pair_attempts enable row level security;
"}', 'monitor_pairing_hardening', 'c_kendall@icloud.com', NULL, NULL),
	('20260725124551', '{"-- sql/030_marketing_canonical_foundation.sql
-- Phase 0 (M-01) of the Ultimate Marketing Suite rebuild -- canonical
-- foundation tables for platform connections and consent/suppression.
-- ADDITIVE ONLY: no existing table is altered.

create table if not exists marketing_platform_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default ''ghgrp'',
  platform text not null check (platform in (
    ''email'',''sms'',''google_ads'',''meta_ads'',''google_business_profile'',
    ''website_cms'',''ga4'',''gtm'',''search_console'',''youtube'',
    ''facebook_instagram'',''microsoft_ads'',''linkedin'',''tiktok'',''direct_mail''
  )),
  state text not null default ''not_connected'' check (state in (
    ''not_connected'',''setup_incomplete'',''reporting_verified'',
    ''draft_validated'',''launch_enabled'',''needs_attention''
  )),
  account_name text,
  account_id text,
  login_account_id text,
  credential_ref text,
  note text,
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, platform)
);

create index if not exists marketing_platform_connections_tenant_idx
  on marketing_platform_connections(tenant_id);

alter table marketing_platform_connections enable row level security;
create policy \"service role full access marketing_platform_connections\"
  on marketing_platform_connections
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');

create table if not exists marketing_consent_ledger (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(jobber_id) on delete cascade,
  channel text not null check (channel in (''email'',''sms'',''review_request'',''media_marketing_use'')),
  status text not null check (status in (''granted'',''revoked'',''unknown'')),
  source text not null check (source in (
    ''implicit_customer_relationship'',''explicit_opt_in'',''explicit_opt_out'',''owner_override''
  )),
  granted_at timestamptz,
  revoked_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, channel)
);

create index if not exists marketing_consent_ledger_client_idx
  on marketing_consent_ledger(client_id);
create index if not exists marketing_consent_ledger_status_idx
  on marketing_consent_ledger(channel, status);

alter table marketing_consent_ledger enable row level security;
create policy \"service role full access marketing_consent_ledger\"
  on marketing_consent_ledger
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');

create table if not exists marketing_suppressions (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(jobber_id) on delete cascade,
  channel text not null check (channel in (''email'',''sms'',''review_request'')),
  reason text not null check (reason in (''bounced'',''complained'',''unsubscribed'',''owner_override'',''legal_hold'')),
  notes text,
  created_at timestamptz not null default now(),
  unique (client_id, channel)
);

create index if not exists marketing_suppressions_client_idx
  on marketing_suppressions(client_id);

alter table marketing_suppressions enable row level security;
create policy \"service role full access marketing_suppressions\"
  on marketing_suppressions
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');
"}', 'marketing_canonical_foundation', 'c_kendall@icloud.com', NULL, NULL),
	('20260725131325', '{"create table if not exists marketing_budget_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null unique default ''ghgrp'',
  monthly_budget_cents integer not null default 250000 check (monthly_budget_cents between 250000 and 1500000),
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table marketing_budget_settings enable row level security;
create policy \"service role full access marketing_budget_settings\"
  on marketing_budget_settings
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');
"}', 'marketing_budget_settings', 'c_kendall@icloud.com', NULL, NULL),
	('20260725132908', '{"-- 1. Per-clock-in consent for HiveLogic Monitor. Every fresh clock-in opens
--    a new monitor_sessions row (see handleMonitorHeartbeat) which now
--    starts ''pending'' -- the desktop agent must show a notify+allow/deny
--    prompt and get an explicit answer before any capture happens for that
--    session. Chris: \"when you clock in it HAS to notify you and you
--    should also be allowed to deny it access each time.\"
alter table monitor_sessions add column if not exists consent text not null default ''pending'';
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = ''monitor_sessions_consent_check''
  ) then
    alter table monitor_sessions add constraint monitor_sessions_consent_check check (consent in (''pending'',''allowed'',''denied''));
  end if;
end $$;

-- 2. Company-wide workforce settings: end-of-day clock-out prompt time and
--    idle-auto-clockout thresholds. Single row for now (HiveLogic is
--    single-company today). Service-key-only via RLS with zero policies,
--    same pattern as the monitor_* tables -- read through a track1.js
--    endpoint, not the anon-key client directly.
create table if not exists workforce_settings (
  id uuid primary key default gen_random_uuid(),
  workday_end_hour integer not null default 15,
  workday_end_minute integer not null default 30,
  idle_warning_minutes integer not null default 30,
  idle_autoclockout_grace_minutes integer not null default 15,
  updated_at timestamptz not null default now()
);
alter table workforce_settings enable row level security;
insert into workforce_settings (workday_end_hour, workday_end_minute, idle_warning_minutes, idle_autoclockout_grace_minutes)
select 15, 30, 30, 15
where not exists (select 1 from workforce_settings);
"}', 'monitor_consent_and_workforce_settings', 'c_kendall@icloud.com', NULL, NULL),
	('20260725143141', '{"create table if not exists marketing_plan_assumptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null unique default ''ghgrp'',
  gross_margin_pct numeric(5,2) check (gross_margin_pct is null or (gross_margin_pct >= 0 and gross_margin_pct <= 100)),
  qualified_lead_rate_per_100 numeric(8,2) check (qualified_lead_rate_per_100 is null or qualified_lead_rate_per_100 >= 0),
  close_rate_pct numeric(5,2) check (close_rate_pct is null or (close_rate_pct >= 0 and close_rate_pct <= 100)),
  max_new_jobs_per_month integer check (max_new_jobs_per_month is null or max_new_jobs_per_month >= 0),
  avg_job_value_cents integer check (avg_job_value_cents is null or avg_job_value_cents >= 0),
  risk_posture text not null default ''balanced'' check (risk_posture in (''conservative'',''balanced'',''aggressive'')),
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table marketing_plan_assumptions enable row level security;

create policy \"service role full access marketing_plan_assumptions\"
  on marketing_plan_assumptions
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');
"}', 'marketing_plan_assumptions', 'c_kendall@icloud.com', NULL, NULL),
	('20260725162524', '{"alter table workforce_settings add column if not exists monitor_screenshot_interval_minutes integer not null default 5;
alter table workforce_settings add column if not exists monitor_blur_screenshots boolean not null default false;
alter table profiles add column if not exists monitoring_enabled boolean not null default true;"}', 'monitor_settings_and_per_user_toggle', 'c_kendall@icloud.com', NULL, NULL),
	('20260725204944', '{"-- Additive-only: campaign audit trail, optional scheduling, and an index
-- supporting the atomic per-recipient send-claim path. No existing column
-- or table is altered destructively; nothing here changes current behavior
-- until the application code references the new columns/table.

CREATE TABLE IF NOT EXISTS campaign_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  event text NOT NULL, -- created | edited | duplicated | deleted | test_sent | send_started | send_completed | send_failed | scheduled | schedule_cancelled
  actor text,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_activity_log_campaign_id_idx ON campaign_activity_log(campaign_id, created_at DESC);

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS updated_by text;

CREATE INDEX IF NOT EXISTS campaign_recipients_campaign_id_sent_at_idx ON campaign_recipients(campaign_id, sent_at);

ALTER TABLE campaign_activity_log ENABLE ROW LEVEL SECURITY;
-- No policies: deny-all by default via RLS, consistent with how campaigns/
-- campaign_recipients are accessed (service-role key from the backend only,
-- which bypasses RLS -- see reina/... security notes on this pattern).
"}', 'marketing_campaign_management_additions', 'c_kendall@icloud.com', NULL, NULL),
	('20260725205429', '{"-- Additive: campaigns previously had nowhere to persist edited subject/body
-- content -- the compose modal generated it fresh client-side on every open
-- and it was only ever sent, never saved. This blocks real \"edit a draft\"
-- and \"schedule a send for later\" workflows (nobody is present to type
-- content into a compose modal at the scheduled time). Both columns are
-- nullable so every existing campaign row remains valid with no backfill.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS subject text;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS body text;
"}', 'campaigns_subject_body_storage', 'c_kendall@icloud.com', NULL, NULL),
	('20260725205850', '{"create table if not exists public.voice_call_flows (
  id uuid primary key default gen_random_uuid(),
  name text not null default ''Main Inbound Flow'',
  is_active boolean not null default true,
  graph jsonb not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Only one flow should be \"the\" live flow at a time -- the runtime always
-- reads is_active=true, order by updated_at desc, limit 1. A partial
-- unique index isn''t used here on purpose (drafts may exist with
-- is_active=false while an admin is mid-edit); the API layer enforces
-- single-active by flipping older active rows off on save.
create index if not exists voice_call_flows_active_idx on public.voice_call_flows (is_active, updated_at desc);

alter table public.voice_call_flows enable row level security;

-- Service-role only (matches every other voice_* table -- all access goes
-- through api/voice.js and api/voice-webhook.js using the service key,
-- never directly from the browser).
drop policy if exists \"service role full access\" on public.voice_call_flows;
create policy \"service role full access\" on public.voice_call_flows
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');

-- Track which flow node an in-progress call is on, so the dial-action /
-- gather-timeout fallback paths can look up \"what comes next\" from the
-- flow graph instead of always hardcoding voicemail.
alter table public.voice_calls add column if not exists flow_node_id text;
"}', 'create_voice_call_flows', 'c_kendall@icloud.com', NULL, NULL),
	('20260726000705', '{"alter table workforce_settings add column if not exists dispatch_freeze_window_enabled boolean not null default true;
alter table workforce_settings add column if not exists dispatch_freeze_window_minutes integer not null default 60;"}', 'dispatch_freeze_window_settings', 'c_kendall@icloud.com', NULL, NULL),
	('20260726022328', '{"-- New lead opportunities, from any source, should alert Chris -- not sit
-- unseen until someone happens to open the notifications panel (Chris,
-- 2026-07-26). This table is the idempotency ledger for that alert: Vercel
-- Cron delivery is \"best effort\" and can duplicate or miss invocations (per
-- Vercel''s own docs), so the check_new_leads cron handler (api/track1.js)
-- must be safe to run more than once per lead. It claims each lead via an
-- atomic ignore-duplicates insert against this table''s unique constraint --
-- only a row that is genuinely new (never claimed before) comes back from
-- that insert, so a lead is alerted exactly once no matter how many times
-- the cron fires or how long it keeps showing up in the lookback window.
--
-- Purely additive: a new table, no changes to any existing table or data.

create table if not exists lead_alerts_sent (
  id bigint generated always as identity primary key,
  source text not null,       -- ''request'' (Jobber inbound request) | ''client_lead'' (clients.is_lead=true, incl. HiveLogic-native leads tagged via lead_pipeline.lead_source: angi/thumbtack/yelp/facebook/website/etc)
  lead_id text not null,      -- the source''s own id for the lead (requests.jobber_id or clients.jobber_id)
  alerted_at timestamptz not null default now(),
  unique (source, lead_id)
);

create index if not exists lead_alerts_sent_alerted_at_idx on lead_alerts_sent (alerted_at desc);

-- Matches every other table in this project: RLS on, no policies (server
-- code uses the Supabase service-role key, which bypasses RLS; this just
-- blocks any anon/authenticated-key access by default, same as the rest).
alter table lead_alerts_sent enable row level security;
"}', '033_lead_alerts', 'c_kendall@icloud.com', NULL, NULL),
	('20260726173434', '{"create table if not exists marketing_channel_budgets (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default ''ghgrp'',
  channel text not null check (channel in (
    ''email'',''sms'',''google_ads'',''meta_ads'',''google_business_profile'',
    ''website_cms'',''direct_mail'',''other''
  )),
  monthly_budget_cents integer not null default 0 check (monthly_budget_cents >= 0),
  updated_at timestamptz not null default now(),
  updated_by text,
  unique (tenant_id, channel)
);

create index if not exists marketing_channel_budgets_tenant_idx
  on marketing_channel_budgets(tenant_id);

alter table marketing_channel_budgets enable row level security;
create policy \"service role full access marketing_channel_budgets\"
  on marketing_channel_budgets
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');"}', 'marketing_channel_budgets', 'c_kendall@icloud.com', NULL, NULL),
	('20260726200534', '{"-- 033_card_pricing.sql — cash-discount (dual-price) program on T&M invoices.
-- ADDITIVE ONLY, idempotent. Full docs in server/bookkeeping/src/card-pricing.js.

alter table tm_invoices add column if not exists card_rate_bps integer;
alter table tm_invoices add column if not exists card_fee_amount numeric;
alter table tm_invoices add column if not exists cash_amount numeric;
alter table tm_invoices add column if not exists paid_method text;
alter table tm_invoices add column if not exists paid_amount numeric;

comment on column tm_invoices.card_rate_bps is
  ''Cash-discount program rate snapshot at invoice creation (400 = 4.00%). NULL on pre-program invoices.'';
comment on column tm_invoices.cash_amount is
  ''Normal price (cash/check/ACH price after the cash discount). total_amount is the posted card-inclusive total.'';
comment on column tm_invoices.paid_method is
  ''card = confirmed by signature-verified Authorize.Net webhook; cash/check/ach = recorded by staff via tm_invoice_mark_paid_offline.'';"}', 'card_pricing_cash_discount', 'c_kendall@icloud.com', NULL, NULL),
	('20260729224655', '{"-- Invoice builder (2026-07-29): link HiveLogic-created invoices to a Jobber job
-- and store the full line-item document (lines, per-line QBO item refs, costs,
-- computed totals). Jobber-synced invoices leave both columns null; the sync
-- upsert only writes its own columns so these are never clobbered.
alter table invoices add column if not exists job_id text;
alter table invoices add column if not exists line_items jsonb;
create index if not exists idx_invoices_job_id on invoices (job_id) where job_id is not null;"}', 'invoices_job_link_and_line_items', 'c_kendall@icloud.com', NULL, NULL),
	('20260731034633', '{"create or replace view public.jobs_enriched
with (security_invoker = true) as
select
  j.jobber_id,
  j.client_id,
  j.job_number,
  j.title,
  j.job_status,
  j.job_type,
  j.total,
  j.start_at,
  j.end_at,
  j.completed_at,
  j.jobber_web_uri,
  j.jobber_created_at,
  j.jobber_updated_at,
  j.synced_at,
  coalesce(
    nullif(c.name, ''''),
    nullif(trim(concat_ws('' '', c.first_name, c.last_name)), ''''),
    nullif(c.company_name, '''')
  ) as client_name,
  cl.lat  as gps_lat,
  cl.lng  as gps_lng,
  cl.city as loc_city,
  cl.province as loc_province
from public.jobs j
left join public.clients c
  on c.jobber_id = j.client_id
left join public.client_locations cl
  on cl.jobber_id = j.client_id and cl.lat is not null;

revoke all on public.jobs_enriched from anon, authenticated;"}', 'jobs_enriched_view', 'c_kendall@icloud.com', NULL, NULL),
	('20260731044343', '{"-- 040: snapshot_aggregates() — Gate 1 continuation.
-- /api/snapshot previously downloaded EVERY row of clients (~8.7k), jobs
-- (~2.7k) and invoices (~2.8k) — ~15 paginated PostgREST requests per call —
-- to compute a handful of counts and sums in Node. This function computes the
-- exact same aggregates in the database in one round-trip.
-- Semantics transcribed 1:1 from api/snapshot.js getSnapshotData():
--   * activeClients: !is_archived (null counts as active, matching JS !c.is_archived)
--   * leads: is_lead is true
--   * jobsByStatus key: job_status || ''unknown'' (JS falsy: null AND '''' -> ''unknown'')
--   * invoice status: lower(trim(coalesce(invoice_status,'''')))
--   * balance: coalesce(total,0) - coalesce(payments,0); \"open\" needs > 0.01
--   * open AR statuses: awaiting_payment, past_due ONLY (Chris''s 2026-07-29 call)
--   * amounts rounded to cents (JS Math.round(x*100)/100)
-- Security: invoker rights + EXECUTE revoked from anon/authenticated/public —
-- service-role-only, same trust model as the underlying tables.

create or replace function public.snapshot_aggregates()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $fn$
with inv as (
  select lower(trim(coalesce(invoice_status,''''))) as st,
         (coalesce(total,0) - coalesce(payments,0)) as bal,
         due_date
  from public.invoices
)
select jsonb_build_object(
  ''counts'', jsonb_build_object(
    ''clients'',       (select count(*) from public.clients),
    ''activeClients'', (select count(*) from public.clients where is_archived is distinct from true),
    ''leads'',         (select count(*) from public.clients where is_lead is true),
    ''jobs'',          (select count(*) from public.jobs),
    ''invoices'',      (select count(*) from public.invoices)
  ),
  ''jobsByStatus'', (
    select coalesce(jsonb_object_agg(k, n), ''{}''::jsonb)
    from (
      select coalesce(nullif(job_status, ''''), ''unknown'') as k, count(*) as n
      from public.jobs group by 1
    ) g
  ),
  ''ar'', jsonb_build_object(
    ''openInvoices'', (select count(*) from inv where st in (''awaiting_payment'',''past_due'') and bal > 0.01),
    ''outstanding'',  (select coalesce(round(sum(bal), 2), 0) from inv where st in (''awaiting_payment'',''past_due'') and bal > 0.01),
    ''overdueCount'', (select count(*) from inv where st in (''awaiting_payment'',''past_due'') and bal > 0.01 and due_date is not null and due_date < now()),
    ''excluded'', jsonb_build_object(
      ''draftUnsent'',       (select jsonb_build_object(''count'', count(*), ''amount'', coalesce(round(sum(bal),2),0)) from inv where st = ''draft''    and bal > 0.01),
      ''writtenOffBadDebt'', (select jsonb_build_object(''count'', count(*), ''amount'', coalesce(round(sum(bal),2),0)) from inv where st = ''bad_debt'' and bal > 0.01),
      ''markedPaid'',        (select jsonb_build_object(''count'', count(*), ''amount'', coalesce(round(sum(bal),2),0)) from inv where st = ''paid''     and bal > 0.01)
    )
  )
);
$fn$;

revoke execute on function public.snapshot_aggregates() from public, anon, authenticated;"}', 'snapshot_aggregates_fn', 'c_kendall@icloud.com', NULL, NULL),
	('20260731131529', '{"-- 042: qbo_report_cache — durable cache for slow QuickBooks report scans.
-- See sql/042_qbo_report_cache.sql in the repo for the full rationale.
create table if not exists public.qbo_report_cache (
  cache_key   text primary key,
  payload     jsonb not null,
  computed_at timestamptz not null default now()
);

alter table public.qbo_report_cache enable row level security;

revoke all on public.qbo_report_cache from anon, authenticated;"}', 'qbo_report_cache', 'c_kendall@icloud.com', NULL, NULL),
	('20260731132826', '{"-- Security hardening (2026-07-31), from the Supabase security advisor.
-- (1) Stop the anon role (and PUBLIC) from calling internal SECURITY DEFINER
--     helpers via /rest/v1/rpc. Keep ''authenticated'' + service_role because
--     HiveDoc''s RLS policies on folders/documents/folder_access call these for
--     logged-in users. handle_new_user() is a trigger-only function, so no
--     invoking role needs EXECUTE (the trigger runs as the owner).
-- (2) Pin search_path on 6 functions flagged with a mutable search_path.

-- (1) folder/admin helpers: revoke anon+PUBLIC, guarantee authenticated+service_role keep it
revoke execute on function public.can_access_folder(uuid) from public, anon;
grant  execute on function public.can_access_folder(uuid) to authenticated, service_role;

revoke execute on function public.can_see_folder(uuid) from public, anon;
grant  execute on function public.can_see_folder(uuid) to authenticated, service_role;

revoke execute on function public.is_admin() from public, anon;
grant  execute on function public.is_admin() to authenticated, service_role;

-- handle_new_user() is only ever fired by the auth.users trigger -> nobody needs EXECUTE
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- (2) pin search_path (prevents search_path-based injection; matches the other functions)
alter function public.apply_sensitive_default() set search_path to ''public'';
alter function public.bookkeeping_audit_log_immutable() set search_path to ''public'';
alter function public.allocate_co_number(text, text, text) set search_path to ''public'';
alter function public.allocate_estimate_number(text, text) set search_path to ''public'';
alter function public.allocate_po_number(text, text, text, text) set search_path to ''public'';
alter function public.apply_po_batch_update(jsonb, jsonb) set search_path to ''public'';"}', 'security_harden_functions_2026_07_31', 'c_kendall@icloud.com', NULL, NULL),
	('20260731163255', '{"create table if not exists webhook_events (
  id bigint generated always as identity primary key,
  topic text not null,
  item_id text not null,
  account_id text,
  occurred_at timestamptz,
  status text not null default ''pending'',
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists webhook_events_pending_idx
  on webhook_events (received_at)
  where status = ''pending'';

alter table webhook_events enable row level security;"}', 'webhook_events_queue', 'c_kendall@icloud.com', NULL, NULL),
	('20260731165239', '{"-- Add a lock flag: rows marked locked keep their manually-set coordinates
ALTER TABLE client_locations ADD COLUMN IF NOT EXISTS geocode_locked boolean NOT NULL DEFAULT false;

-- Trigger: if a row is locked, any UPDATE keeps the old lat/lng (unlock first to change them)
CREATE OR REPLACE FUNCTION protect_locked_geocode() RETURNS trigger AS $$
BEGIN
  IF OLD.geocode_locked IS TRUE AND NEW.geocode_locked IS TRUE THEN
    NEW.lat := OLD.lat;
    NEW.lng := OLD.lng;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_locked_geocode ON client_locations;
CREATE TRIGGER trg_protect_locked_geocode
BEFORE UPDATE ON client_locations
FOR EACH ROW EXECUTE FUNCTION protect_locked_geocode();"}', 'geocode_lock_protection', 'c_kendall@icloud.com', NULL, NULL),
	('20260731172503', '{"-- Server-side Microsoft 365 mail tokens for HiveConnect EMBEDDED mode
-- (main-app logins). Twin of the same table in the hiveconnect project.
-- Written/read ONLY by /api/msmail with the service key; RLS with no
-- policies keeps browsers out entirely.
create table if not exists public.hc_ms_tokens (
  owner_id uuid not null,
  home_account_id text not null,
  username text,
  name text,
  refresh_token text not null,
  access_token text,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner_id, home_account_id)
);
alter table public.hc_ms_tokens enable row level security;"}', 'hc_ms_tokens_server_side_mail', 'c_kendall@icloud.com', NULL, NULL),
	('20260731175403', '{"create table if not exists bridge_heartbeats (
  id bigint generated always as identity primary key,
  source text not null default ''fractal-pc'',
  pinged_at timestamptz not null default now(),
  meta jsonb
);

create index if not exists bridge_heartbeats_pinged_idx on bridge_heartbeats (pinged_at desc);

alter table bridge_heartbeats enable row level security;"}', 'bridge_heartbeats', 'c_kendall@icloud.com', NULL, NULL),
	('20260801175055', '{"create or replace view public.client_ar_outstanding
with (security_invoker = true) as
select
  c.jobber_id as client_id,
  coalesce(
    nullif(c.name, ''''),
    nullif(trim(concat_ws('' '', c.first_name, c.last_name)), ''''),
    nullif(c.company_name, '''')
  ) as client_name,
  c.balance            as jobber_balance,
  greatest(c.balance, 0) as outstanding,
  c.jobber_web_uri,
  c.synced_at
from public.clients c
where c.balance > 0;

revoke all on public.client_ar_outstanding from anon, authenticated;"}', 'client_ar_outstanding_view', 'c_kendall@icloud.com', NULL, NULL),
	('20260801180845', '{"create or replace function public.snapshot_aggregates()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $fn$
with inv as (
  select lower(trim(coalesce(invoice_status,''''))) as st,
         (coalesce(total,0) - coalesce(payments,0)) as bal,
         due_date
  from public.invoices
)
select jsonb_build_object(
  ''counts'', jsonb_build_object(
    ''clients'',       (select count(*) from public.clients),
    ''activeClients'', (select count(*) from public.clients where is_archived is distinct from true),
    ''leads'',         (select count(*) from public.clients where is_lead is true),
    ''jobs'',          (select count(*) from public.jobs),
    ''invoices'',      (select count(*) from public.invoices)
  ),
  ''jobsByStatus'', (
    select coalesce(jsonb_object_agg(k, n), ''{}''::jsonb)
    from (
      select coalesce(nullif(job_status, ''''), ''unknown'') as k, count(*) as n
      from public.jobs group by 1
    ) g
  ),
  ''ar'', jsonb_build_object(
    ''openInvoices'', (select count(*) from inv where st in (''awaiting_payment'',''past_due'') and bal > 0.01),
    ''outstanding'',  (select coalesce(round(sum(outstanding), 2), 0) from public.client_ar_outstanding),
    ''overdueCount'', (select count(*) from inv where st in (''awaiting_payment'',''past_due'') and bal > 0.01 and due_date is not null and due_date < now()),
    ''excluded'', jsonb_build_object(
      ''draftUnsent'',       (select jsonb_build_object(''count'', count(*), ''amount'', coalesce(round(sum(bal),2),0)) from inv where st = ''draft''    and bal > 0.01),
      ''writtenOffBadDebt'', (select jsonb_build_object(''count'', count(*), ''amount'', coalesce(round(sum(bal),2),0)) from inv where st = ''bad_debt'' and bal > 0.01),
      ''markedPaid'',        (select jsonb_build_object(''count'', count(*), ''amount'', coalesce(round(sum(bal),2),0)) from inv where st = ''paid''     and bal > 0.01)
    )
  )
);
$fn$;

revoke execute on function public.snapshot_aggregates() from public, anon, authenticated;"}', 'snapshot_ar_client_level', 'c_kendall@icloud.com', NULL, NULL),
	('20260801183418', '{"-- sql/036_marketing_shared_workspace_plan_opportunity_variant.sql (applied from branch marketing-suite-phase8-approvals-writer)
create table if not exists marketing_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default ''ghgrp'',
  status text not null default ''draft'' check (status in (''draft'',''active'',''superseded'',''archived'')),
  period_start date not null,
  period_end date not null check (period_end >= period_start),
  objective text,
  budget_cents integer check (budget_cents is null or budget_cents >= 0),
  assumptions_snapshot jsonb,
  forecast jsonb,
  forecast_state text check (forecast_state is null or forecast_state in (''blocked_no_channel'',''blocked_assumptions'',''ready'')),
  blocked_reasons jsonb,
  rationale text,
  generated_by text not null default ''system'' check (generated_by in (''system'',''owner'')),
  superseded_by uuid references marketing_plans(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists marketing_plans_one_active_per_tenant
  on marketing_plans(tenant_id) where (status = ''active'');

create index if not exists marketing_plans_tenant_status_idx
  on marketing_plans(tenant_id, status);
create index if not exists marketing_plans_period_idx
  on marketing_plans(tenant_id, period_start, period_end);

alter table marketing_plans enable row level security;
create policy \"service role full access marketing_plans\"
  on marketing_plans
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');

create table if not exists marketing_opportunities (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default ''ghgrp'',
  plan_id uuid references marketing_plans(id) on delete set null,
  opportunity_key text not null check (opportunity_key in (
    ''unsold_estimates'',''review_requests'',''reactivate_customers'',
    ''seasonal_promotion'',''neighborhood_expansion'',''referral_opportunities''
  )),
  title text,
  signal jsonb,
  actionable boolean not null default false,
  actionable_reason text,
  required_integration text,
  status text not null default ''surfaced'' check (status in (''surfaced'',''acted_on'',''dismissed'',''expired'')),
  campaign_id uuid references campaigns(id) on delete set null,
  surfaced_at timestamptz not null default now(),
  acted_at timestamptz,
  dismissed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_opportunities_tenant_key_idx
  on marketing_opportunities(tenant_id, opportunity_key, surfaced_at desc);
create index if not exists marketing_opportunities_plan_idx
  on marketing_opportunities(plan_id);
create index if not exists marketing_opportunities_campaign_idx
  on marketing_opportunities(campaign_id);
create index if not exists marketing_opportunities_status_idx
  on marketing_opportunities(tenant_id, status);

alter table marketing_opportunities enable row level security;
create policy \"service role full access marketing_opportunities\"
  on marketing_opportunities
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');

create table if not exists campaign_variants (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default ''ghgrp'',
  campaign_id uuid not null references campaigns(id) on delete cascade,
  opportunity_id uuid references marketing_opportunities(id) on delete set null,
  label text,
  channel text not null default ''email'' check (channel in (''email'',''sms'',''mail'')),
  subject text,
  body text,
  media_refs jsonb,
  generated_by text not null default ''ai'' check (generated_by in (''ai'',''owner'')),
  status text not null default ''proposed'' check (status in (''proposed'',''selected'',''rejected'',''sent'')),
  selected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaign_variants_campaign_idx
  on campaign_variants(campaign_id);
create index if not exists campaign_variants_status_idx
  on campaign_variants(tenant_id, status);

alter table campaign_variants enable row level security;
create policy \"service role full access campaign_variants\"
  on campaign_variants
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');"}', '036_marketing_shared_workspace_plan_opportunity_variant', 'c_kendall@icloud.com', NULL, NULL),
	('20260801183443', '{"-- sql/037_marketing_media_generated_evidence.sql (applied from branch marketing-suite-phase8-approvals-writer; 036 applied first)
create table if not exists marketing_media_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default ''ghgrp'',
  media_id uuid not null references media(id) on delete cascade,
  job_id text,
  client_id text references clients(jobber_id) on delete set null,
  selected_for text not null default ''review'' check (selected_for in (''review'',''content_studio'',''ready_for_you'')),
  permission_status text not null default ''unknown'' check (permission_status in (''unknown'',''granted'',''revoked'',''owner_override'')),
  permission_checked_at timestamptz,
  selected_by text not null default ''system'' check (selected_by in (''system'',''owner'')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, media_id)
);

create index if not exists marketing_media_assets_job_idx
  on marketing_media_assets(job_id);
create index if not exists marketing_media_assets_client_idx
  on marketing_media_assets(client_id);
create index if not exists marketing_media_assets_selected_for_idx
  on marketing_media_assets(tenant_id, selected_for);

alter table marketing_media_assets enable row level security;
create policy \"service role full access marketing_media_assets\"
  on marketing_media_assets
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');

create table if not exists marketing_generated_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default ''ghgrp'',
  media_asset_id uuid references marketing_media_assets(id) on delete set null,
  campaign_variant_id uuid references campaign_variants(id) on delete set null,
  asset_type text not null check (asset_type in (''image'',''video'',''caption'',''social_post'',''ad_copy'',''landing_page_copy'')),
  generation_method text not null check (generation_method in (''ai_text'',''ai_image'',''ai_video'',''ai_enhanced'',''manual'')),
  prompt text,
  provider text,
  provider_model text,
  output_storage_path text,
  output_text text,
  claims_used jsonb,
  status text not null default ''draft'' check (status in (''draft'',''pending_approval'',''approved'',''rejected'',''published'')),
  approved_by text,
  approved_at timestamptz,
  publish_destinations jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_generated_assets_media_asset_idx
  on marketing_generated_assets(media_asset_id);
create index if not exists marketing_generated_assets_variant_idx
  on marketing_generated_assets(campaign_variant_id);
create index if not exists marketing_generated_assets_status_idx
  on marketing_generated_assets(tenant_id, status);

alter table marketing_generated_assets enable row level security;
create policy \"service role full access marketing_generated_assets\"
  on marketing_generated_assets
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');

create table if not exists marketing_source_evidence (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default ''ghgrp'',
  generated_asset_id uuid not null references marketing_generated_assets(id) on delete cascade,
  evidence_type text not null check (evidence_type in (''job_record'',''media_analysis'',''review'',''job_total'',''client_history'',''manual_note'')),
  job_id text,
  media_id uuid references media(id) on delete set null,
  media_analysis_snapshot jsonb,
  claim_text text not null,
  verified boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists marketing_source_evidence_asset_idx
  on marketing_source_evidence(generated_asset_id);
create index if not exists marketing_source_evidence_job_idx
  on marketing_source_evidence(job_id);

alter table marketing_source_evidence enable row level security;
create policy \"service role full access marketing_source_evidence\"
  on marketing_source_evidence
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');"}', '037_marketing_media_generated_evidence', 'c_kendall@icloud.com', NULL, NULL),
	('20260801183513', '{"-- sql/038_marketing_approval_annotation_publication.sql (applied from branch; 036+037 applied first)
create table if not exists marketing_approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default ''ghgrp'',
  approvable_type text not null check (approvable_type in (
    ''CAMPAIGN_SPEND'',''GENERATED_VIDEO'',''WEBSITE_PROMOTION'',''REVIEW_REPLY'',
    ''CLAIM_CORRECTION'',''ACCOUNT_REPAIR'',''BUDGET_ADJUSTMENT''
  )),
  approvable_id text,
  generated_asset_id uuid references marketing_generated_assets(id) on delete set null,
  title text not null,
  rationale text,
  preview_text text,
  preview_media_id uuid references media(id) on delete set null,
  amount_cents integer check (amount_cents is null or amount_cents >= 0),
  max_amount_cents integer check (max_amount_cents is null or max_amount_cents >= 0),
  target_description text,
  estimate jsonb,
  confidence numeric,
  risks jsonb,
  status text not null default ''pending'' check (status in (
    ''pending'',''approved'',''rejected'',''edited'',''regenerating'',''needs_input'',''expired''
  )),
  requested_by text not null default ''system'' check (requested_by in (''system'',''owner'')),
  decided_by text,
  decided_at timestamptz,
  decision_reason text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_approvals_tenant_status_idx
  on marketing_approvals(tenant_id, status);
create index if not exists marketing_approvals_type_idx
  on marketing_approvals(approvable_type);
create index if not exists marketing_approvals_asset_idx
  on marketing_approvals(generated_asset_id);

alter table marketing_approvals enable row level security;
create policy \"service role full access marketing_approvals\"
  on marketing_approvals
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');

create table if not exists marketing_annotations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default ''ghgrp'',
  generated_asset_id uuid not null references marketing_generated_assets(id) on delete cascade,
  annotation_type text not null check (annotation_type in (
    ''VIDEO_MARK'',''REGION_CLICK'',''TEXT_HIGHLIGHT'',''CORRECTION''
  )),
  data jsonb not null,
  frame_time_ms integer,
  correction_text text,
  regenerated_asset_id uuid references marketing_generated_assets(id) on delete set null,
  created_by text,
  created_at timestamptz not null default now(),
  superseded_by uuid references marketing_annotations(id) on delete set null
);

create index if not exists marketing_annotations_asset_idx
  on marketing_annotations(generated_asset_id);
create index if not exists marketing_annotations_active_idx
  on marketing_annotations(generated_asset_id, created_at desc) where (superseded_by is null);

alter table marketing_annotations enable row level security;
create policy \"service role full access marketing_annotations\"
  on marketing_annotations
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');

create table if not exists marketing_publications (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default ''ghgrp'',
  generated_asset_id uuid references marketing_generated_assets(id) on delete set null,
  approval_id uuid references marketing_approvals(id) on delete set null,
  destination_type text not null check (destination_type in (
    ''website_cms'',''google_business_profile'',''facebook_instagram'',''youtube'',
    ''email'',''sms'',''direct_mail'',''other''
  )),
  destination_ref text,
  status text not null default ''draft'' check (status in (
    ''draft'',''scheduled'',''published'',''rollback_requested'',''rolled_back'',''expired''
  )),
  published_at timestamptz,
  expires_at timestamptz,
  rolled_back_at timestamptz,
  rollback_reason text,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_publications_tenant_status_idx
  on marketing_publications(tenant_id, status);
create index if not exists marketing_publications_asset_idx
  on marketing_publications(generated_asset_id);
create index if not exists marketing_publications_destination_idx
  on marketing_publications(destination_type);

alter table marketing_publications enable row level security;
create policy \"service role full access marketing_publications\"
  on marketing_publications
  for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'');"}', '038_marketing_approval_annotation_publication', 'c_kendall@icloud.com', NULL, NULL),
	('20260801183528', '{"-- sql/044_lead_pipeline_referred_by.sql (applied from branch feature/lead-referral-candidates)
alter table lead_pipeline
  add column if not exists referred_by_client_id text references clients(jobber_id) on delete set null;

create index if not exists lead_pipeline_referred_by_idx
  on lead_pipeline(referred_by_client_id)
  where referred_by_client_id is not null;"}', '044_lead_pipeline_referred_by', 'c_kendall@icloud.com', NULL, NULL),
	('20260801183544', '{"-- sql/045_marketing_channel_budget_pacing.sql (applied from branch marketing-suite-phase4-channel-pacing)
alter table marketing_channel_budgets
  add column if not exists min_viable_spend_cents integer,
  add column if not exists daily_max_cents integer,
  add column if not exists testing_allowance_cents integer not null default 0,
  add column if not exists paused boolean not null default false,
  add column if not exists approval_threshold_cents integer;

alter table marketing_channel_budgets
  add constraint marketing_channel_budgets_min_viable_spend_nonneg
    check (min_viable_spend_cents is null or min_viable_spend_cents >= 0);

alter table marketing_channel_budgets
  add constraint marketing_channel_budgets_daily_max_nonneg
    check (daily_max_cents is null or daily_max_cents >= 0);

alter table marketing_channel_budgets
  add constraint marketing_channel_budgets_testing_allowance_nonneg
    check (testing_allowance_cents >= 0);

alter table marketing_channel_budgets
  add constraint marketing_channel_budgets_approval_threshold_nonneg
    check (approval_threshold_cents is null or approval_threshold_cents >= 0);

comment on column marketing_channel_budgets.min_viable_spend_cents is
  ''Owner-set floor below which this channel is not considered worth running. NULL = not set yet.'';
comment on column marketing_channel_budgets.daily_max_cents is
  ''Owner-set per-day spend cap for this channel. NULL = no daily cap set.'';
comment on column marketing_channel_budgets.testing_allowance_cents is
  ''Protected experiment budget automatic reallocation should not sweep. Defaults to 0.'';
comment on column marketing_channel_budgets.paused is
  ''Owner emergency-pause flag. When true, exclude from automatic allocation. Defaults to false.'';
comment on column marketing_channel_budgets.approval_threshold_cents is
  ''Spend level above which changes require explicit owner approval. NULL = no threshold.'';"}', '045_marketing_channel_budget_pacing', 'c_kendall@icloud.com', NULL, NULL),
	('20260801191315', '{"-- sql/033_card_pricing.sql (applied from main; approved by Chris 8/1 — Authorize.Net cash-discount path)
alter table tm_invoices add column if not exists card_rate_bps integer;
alter table tm_invoices add column if not exists card_fee_amount numeric;
alter table tm_invoices add column if not exists cash_amount numeric;
alter table tm_invoices add column if not exists paid_method text;
alter table tm_invoices add column if not exists paid_amount numeric;

comment on column tm_invoices.card_rate_bps is
  ''Cash-discount program rate snapshot at invoice creation (400 = 4.00%). NULL on pre-program invoices.'';
comment on column tm_invoices.cash_amount is
  ''Normal price (cash/check/ACH price after the cash discount). total_amount is the posted card-inclusive total.'';
comment on column tm_invoices.paid_method is
  ''card = confirmed by signature-verified Authorize.Net webhook; cash/check/ach = recorded by staff via tm_invoice_mark_paid_offline.'';"}', '033_card_pricing', 'c_kendall@icloud.com', NULL, NULL),
	('20260801212400', '{"-- Gate 1 Phase 0 — additive, reversible, idempotent
create table if not exists public.external_refs (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  system text not null default ''jobber'',
  external_id text not null,
  created_at timestamptz not null default now(),
  unique (system, entity_type, external_id)
);

alter table public.clients  add column if not exists uuid_id uuid default gen_random_uuid();
alter table public.jobs     add column if not exists uuid_id uuid default gen_random_uuid();
alter table public.invoices add column if not exists uuid_id uuid default gen_random_uuid();

update public.clients  set uuid_id = gen_random_uuid() where uuid_id is null;
update public.jobs     set uuid_id = gen_random_uuid() where uuid_id is null;
update public.invoices set uuid_id = gen_random_uuid() where uuid_id is null;

create unique index if not exists ux_clients_uuid  on public.clients(uuid_id);
create unique index if not exists ux_jobs_uuid     on public.jobs(uuid_id);
create unique index if not exists ux_invoices_uuid on public.invoices(uuid_id);

insert into public.external_refs (entity_type, entity_id, system, external_id)
  select ''client'', uuid_id, ''jobber'', jobber_id from public.clients  where jobber_id is not null
  on conflict (system, entity_type, external_id) do nothing;
insert into public.external_refs (entity_type, entity_id, system, external_id)
  select ''job'', uuid_id, ''jobber'', jobber_id from public.jobs     where jobber_id is not null
  on conflict (system, entity_type, external_id) do nothing;
insert into public.external_refs (entity_type, entity_id, system, external_id)
  select ''invoice'', uuid_id, ''jobber'', jobber_id from public.invoices where jobber_id is not null
  on conflict (system, entity_type, external_id) do nothing;

alter table public.external_refs enable row level security;
revoke all on public.external_refs from anon, authenticated;"}', 'gate1_phase0_uuid_identity_and_external_refs', 'c_kendall@icloud.com', NULL, NULL),
	('20260801212639', '{"-- Gate 1 Phase 1 — add client_uuid / job_uuid to base tables + backfill. Additive, idempotent.
DO $$
DECLARE r record;
BEGIN
  -- client_uuid on every BASE TABLE with a text client_id
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema=''public'' AND t.table_name=c.table_name AND t.table_type=''BASE TABLE''
    WHERE c.table_schema=''public'' AND c.column_name=''client_id''
      AND c.data_type IN (''text'',''character varying'')
  LOOP
    EXECUTE format(''ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS client_uuid uuid'', r.table_name);
    EXECUTE format(''UPDATE public.%I t SET client_uuid = c.uuid_id FROM public.clients c WHERE t.client_id = c.jobber_id AND t.client_uuid IS NULL'', r.table_name);
  END LOOP;

  -- job_uuid on every BASE TABLE with a text job_id
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema=''public'' AND t.table_name=c.table_name AND t.table_type=''BASE TABLE''
    WHERE c.table_schema=''public'' AND c.column_name=''job_id''
      AND c.data_type IN (''text'',''character varying'')
  LOOP
    EXECUTE format(''ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS job_uuid uuid'', r.table_name);
    EXECUTE format(''UPDATE public.%I t SET job_uuid = j.uuid_id FROM public.jobs j WHERE t.job_id = j.jobber_id AND t.job_uuid IS NULL'', r.table_name);
  END LOOP;
END $$;"}', 'gate1_phase1_uuid_fk_columns_backfill', 'c_kendall@icloud.com', NULL, NULL),
	('20260801220311', '{"-- Record GH Co. as a DBA; add operational/planned status; seed the 8 divisions
alter table public.companies add column if not exists dba text;
update public.companies set dba=''GH Co.'' where slug=''greenwich-handyman'';

alter table public.org_units add column if not exists status text not null default ''planned''
  check (status in (''operational'',''planned''));

insert into public.org_units (company_id, unit_type, name, is_primary, status, sort_order)
select c.id, ''division'', v.name, v.is_primary, v.status, v.sort_order
from (select id from public.companies where slug=''greenwich-handyman'') c
cross join (values
  (''GH Co. Design|Build'',         true,  ''planned'',     0),
  (''Greenwich Handyman'',          false, ''operational'', 1),
  (''GH Handyman'',                 false, ''planned'',     2),
  (''GH Electric'',                 false, ''operational'', 3),
  (''GH Outdoor Spaces'',           false, ''planned'',     4),
  (''GH Home Concierge Services'',  false, ''planned'',     5),
  (''GH Plumbing'',                 false, ''planned'',     6),
  (''GH HVAC'',                     false, ''planned'',     7)
) as v(name, is_primary, status, sort_order)
on conflict (company_id, unit_type, name) do update
  set is_primary=excluded.is_primary, status=excluded.status, sort_order=excluded.sort_order;"}', 'gate1b_seed_divisions_expansion_plan', 'c_kendall@icloud.com', NULL, NULL),
	('20260801213029', '{"-- Gate 1 Phase 1b — promote uuid unique indexes to constraints, add + validate FKs. Idempotent.
DO $$
DECLARE r record; cname text;
BEGIN
  -- FK targets must be a unique CONSTRAINT (index alone is insufficient)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=''uq_clients_uuid'') THEN
    ALTER TABLE public.clients ADD CONSTRAINT uq_clients_uuid UNIQUE USING INDEX ux_clients_uuid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=''uq_jobs_uuid'') THEN
    ALTER TABLE public.jobs ADD CONSTRAINT uq_jobs_uuid UNIQUE USING INDEX ux_jobs_uuid;
  END IF;

  -- client_uuid FKs -> clients(uuid_id)
  FOR r IN SELECT table_name FROM information_schema.columns
           WHERE table_schema=''public'' AND column_name=''client_uuid''
  LOOP
    cname := left(''fk_''||r.table_name||''_client_uuid'', 63);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=cname) THEN
      EXECUTE format(''ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (client_uuid) REFERENCES public.clients(uuid_id) NOT VALID'', r.table_name, cname);
      EXECUTE format(''ALTER TABLE public.%I VALIDATE CONSTRAINT %I'', r.table_name, cname);
    END IF;
  END LOOP;

  -- job_uuid FKs -> jobs(uuid_id)
  FOR r IN SELECT table_name FROM information_schema.columns
           WHERE table_schema=''public'' AND column_name=''job_uuid''
  LOOP
    cname := left(''fk_''||r.table_name||''_job_uuid'', 63);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=cname) THEN
      EXECUTE format(''ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (job_uuid) REFERENCES public.jobs(uuid_id) NOT VALID'', r.table_name, cname);
      EXECUTE format(''ALTER TABLE public.%I VALIDATE CONSTRAINT %I'', r.table_name, cname);
    END IF;
  END LOOP;
END $$;"}', 'gate1_phase1b_fk_constraints', 'c_kendall@icloud.com', NULL, NULL),
	('20260801214101', '{"-- Gate 1b Phase 0 — tenant anchor + org hierarchy. Additive, idempotent.
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  plan text not null default ''internal'',
  status text not null default ''active'',
  created_at timestamptz not null default now()
);

insert into public.companies (name, slug, status, plan)
  values (''Greenwich Handyman'', ''greenwich-handyman'', ''active'', ''primary'')
  on conflict (slug) do nothing;

create table if not exists public.org_units (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  parent_id uuid references public.org_units(id),
  unit_type text not null check (unit_type in (''division'',''location'',''crew'')),
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (company_id, unit_type, name)
);

insert into public.org_units (company_id, unit_type, name)
  select c.id, ''division'', d.division
  from (select distinct division from public.employee_roles
        where division is not null and btrim(division) <> '''') d
  cross join lateral (select id from public.companies where slug=''greenwich-handyman'') c
  on conflict (company_id, unit_type, name) do nothing;

alter table public.companies enable row level security;
alter table public.org_units enable row level security;
revoke all on public.companies from anon, authenticated;
revoke all on public.org_units from anon, authenticated;"}', 'gate1b_phase0_companies_and_org_units', 'c_kendall@icloud.com', NULL, NULL),
	('20260801214634', '{"-- Revert the prior seed and rebuild with the correct org structure
drop table if exists public.org_units cascade;
drop table if exists public.companies cascade;

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  plan text not null default ''internal'',
  status text not null default ''active'',
  created_at timestamptz not null default now()
);
insert into public.companies (name, slug, status, plan)
  values (''GH Co.'', ''gh-co'', ''active'', ''primary'');

create table public.org_units (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  parent_id uuid references public.org_units(id),
  unit_type text not null default ''division'' check (unit_type in (''division'',''location'',''crew'')),
  name text not null,
  is_primary boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (company_id, unit_type, name)
);
insert into public.org_units (company_id, unit_type, name, is_primary, sort_order)
select c.id, ''division'', v.name, v.is_primary, v.sort_order
from (select id from public.companies where slug=''gh-co'') c
cross join (values
  (''GH Co. Design|Build'', true, 0),
  (''Greenwich Handyman'', false, 1),
  (''GH Handyman'', false, 2),
  (''GH Electric'', false, 3),
  (''GH Outdoor Spaces'', false, 4),
  (''GH Home Concierge Services'', false, 5),
  (''GH Plumbing'', false, 6),
  (''GH HVAC'', false, 7)
) as v(name, is_primary, sort_order);

alter table public.companies enable row level security;
alter table public.org_units enable row level security;
revoke all on public.companies from anon, authenticated;
revoke all on public.org_units from anon, authenticated;"}', 'gate1b_phase0_revised_org_structure', 'c_kendall@icloud.com', NULL, NULL),
	('20260801215633', '{"-- Set the current tenant to Greenwich Handyman; clear the incorrect GH Co. seed
delete from public.org_units;
delete from public.companies;
insert into public.companies (name, slug, status, plan)
  values (''Greenwich Handyman'', ''greenwich-handyman'', ''active'', ''primary'');"}', 'gate1b_company_greenwich_handyman', 'c_kendall@icloud.com', NULL, NULL),
	('20260801215817', '{"DO $$
DECLARE gh uuid;
BEGIN
  SELECT id INTO gh FROM public.companies WHERE slug=''greenwich-handyman'';
  ALTER TABLE public.clients  ADD COLUMN IF NOT EXISTS company_id uuid;
  ALTER TABLE public.jobs     ADD COLUMN IF NOT EXISTS company_id uuid;
  ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS company_id uuid;
  UPDATE public.clients  SET company_id=gh WHERE company_id IS NULL;
  UPDATE public.jobs     SET company_id=gh WHERE company_id IS NULL;
  UPDATE public.invoices SET company_id=gh WHERE company_id IS NULL;
  EXECUTE format(''ALTER TABLE public.clients  ALTER COLUMN company_id SET DEFAULT %L'', gh);
  EXECUTE format(''ALTER TABLE public.jobs     ALTER COLUMN company_id SET DEFAULT %L'', gh);
  EXECUTE format(''ALTER TABLE public.invoices ALTER COLUMN company_id SET DEFAULT %L'', gh);
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=''fk_clients_company'') THEN
    ALTER TABLE public.clients ADD CONSTRAINT fk_clients_company FOREIGN KEY (company_id) REFERENCES public.companies(id) NOT VALID;
    ALTER TABLE public.clients VALIDATE CONSTRAINT fk_clients_company;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=''fk_jobs_company'') THEN
    ALTER TABLE public.jobs ADD CONSTRAINT fk_jobs_company FOREIGN KEY (company_id) REFERENCES public.companies(id) NOT VALID;
    ALTER TABLE public.jobs VALIDATE CONSTRAINT fk_jobs_company;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=''fk_invoices_company'') THEN
    ALTER TABLE public.invoices ADD CONSTRAINT fk_invoices_company FOREIGN KEY (company_id) REFERENCES public.companies(id) NOT VALID;
    ALTER TABLE public.invoices VALIDATE CONSTRAINT fk_invoices_company;
  END IF;
END $$;"}', 'gate1b_tag_core_data_to_greenwich_handyman', 'c_kendall@icloud.com', NULL, NULL),
	('20260801222140', '{"create table if not exists portal_rate_limits (
  id bigint generated always as identity primary key,
  bucket text not null,
  created_at timestamptz not null default now()
);

create index if not exists portal_rate_limits_bucket_time_idx
  on portal_rate_limits (bucket, created_at);

alter table portal_rate_limits enable row level security;

create or replace function prune_portal_rate_limits()
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  delete from public.portal_rate_limits where created_at < now() - interval ''1 day'';
$$;

revoke all on function prune_portal_rate_limits() from public;"}', '043_portal_rate_limits', 'c_kendall@icloud.com', NULL, NULL),
	('20260801222155', '{"create table if not exists authnet_payment_events (
  id                 bigint generated always as identity primary key,
  notification_id    text not null unique,
  event_type         text,
  transaction_id     text,
  invoice_number     text,
  invoice_id         uuid,
  transaction_status text,
  outcome            text not null default ''received'',
  applied_paid       boolean not null default false,
  raw_event          jsonb,
  raw_transaction    jsonb,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz
);

create index if not exists authnet_payment_events_transaction_idx
  on authnet_payment_events (transaction_id);
create index if not exists authnet_payment_events_invoice_idx
  on authnet_payment_events (invoice_id);

alter table authnet_payment_events enable row level security;

comment on table authnet_payment_events is
  ''Audit ledger + idempotency guard for Authorize.Net webhook deliveries. notification_id is unique; an invoice is only marked paid when transaction_status = settledSuccessfully.'';"}', '044_authnet_payment_events', 'c_kendall@icloud.com', NULL, NULL),
	('20260801222202', '{"create table if not exists oauth_states (
  id bigint generated always as identity primary key,
  provider text not null,
  state_hash text not null,
  user_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create unique index if not exists oauth_states_provider_hash_uidx
  on oauth_states (provider, state_hash);

alter table oauth_states enable row level security;

create or replace function prune_oauth_states()
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  delete from public.oauth_states
   where used_at is not null
      or expires_at < now() - interval ''1 day'';
$$;

revoke all on function prune_oauth_states() from public;"}', '047_oauth_states', 'c_kendall@icloud.com', NULL, NULL),
	('20260801222209', '{"alter function public.protect_locked_geocode() set search_path = pg_catalog, public;
alter function public.can_access_folder(uuid)   set search_path = pg_catalog, public;
alter function public.can_see_folder(uuid)      set search_path = pg_catalog, public;
alter function public.is_admin()                set search_path = pg_catalog, public;

revoke execute on function public.can_access_folder(uuid) from anon;
revoke execute on function public.can_see_folder(uuid)    from anon;
revoke execute on function public.is_admin()              from anon;"}', '048_security_harden_advisors', 'c_kendall@icloud.com', NULL, NULL),
	('20260801222223', '{"create table if not exists monitor_agents (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null,
  device_name text,
  platform text,
  agent_version text,
  pairing_code text,
  pairing_code_expires_at timestamptz,
  paired_at timestamptz,
  last_seen_at timestamptz,
  status text not null default ''pending'',
  agent_token text,
  pair_attempts integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists monitor_agents_employee_status_idx on monitor_agents (employee_id, status);
create index if not exists monitor_agents_pending_idx on monitor_agents (employee_id) where status = ''pending'';

create table if not exists monitor_sessions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null,
  agent_id uuid not null,
  workforce_session_id uuid,
  consent text not null default ''pending'',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists monitor_sessions_agent_open_idx on monitor_sessions (agent_id, started_at desc) where ended_at is null;
create index if not exists monitor_sessions_employee_idx on monitor_sessions (employee_id, started_at desc);
create index if not exists monitor_sessions_workforce_idx on monitor_sessions (workforce_session_id);

create table if not exists monitor_activity_samples (
  id uuid primary key default gen_random_uuid(),
  monitor_session_id uuid not null,
  activity_level integer,
  idle_seconds integer,
  active_app text,
  display_count integer,
  sampled_at timestamptz not null default now()
);
create index if not exists monitor_activity_samples_session_idx on monitor_activity_samples (monitor_session_id, sampled_at desc);
create index if not exists monitor_activity_samples_sampled_idx on monitor_activity_samples (sampled_at);

create table if not exists monitor_screenshots (
  id uuid primary key default gen_random_uuid(),
  monitor_session_id uuid not null,
  display_index integer,
  storage_path text not null,
  width integer,
  height integer,
  captured_at timestamptz not null default now()
);
create index if not exists monitor_screenshots_session_idx on monitor_screenshots (monitor_session_id, captured_at desc);
create index if not exists monitor_screenshots_captured_idx on monitor_screenshots (captured_at);

create table if not exists monitor_pair_attempts (
  id uuid primary key default gen_random_uuid(),
  ip text,
  attempted_at timestamptz not null default now()
);
create index if not exists monitor_pair_attempts_ip_idx on monitor_pair_attempts (ip, attempted_at);

alter table monitor_agents           enable row level security;
alter table monitor_sessions         enable row level security;
alter table monitor_activity_samples enable row level security;
alter table monitor_screenshots      enable row level security;
alter table monitor_pair_attempts    enable row level security;"}', '050_monitor_tables', 'c_kendall@icloud.com', NULL, NULL),
	('20260801222228', '{"alter table monitor_agents
  add column if not exists agent_token_hash text;

create index if not exists monitor_agents_token_hash_idx
  on monitor_agents (agent_token_hash)
  where status = ''active'';"}', '051_monitor_agent_token_hash', 'c_kendall@icloud.com', NULL, NULL),
	('20260801222236', '{"create or replace function prune_monitor_data(retention_days integer default 90)
returns table (activity_samples_deleted bigint, pair_attempts_deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff timestamptz := now() - make_interval(days => greatest(retention_days, 1));
  n_samples bigint;
  n_attempts bigint;
begin
  delete from monitor_activity_samples where sampled_at < cutoff;
  get diagnostics n_samples = row_count;

  delete from monitor_pair_attempts where attempted_at < cutoff;
  get diagnostics n_attempts = row_count;

  return query select n_samples, n_attempts;
end;
$$;

revoke all on function prune_monitor_data(integer) from public;"}', '052_monitor_retention', 'c_kendall@icloud.com', NULL, NULL),
	('20260802012531', '{"create table if not exists selftest_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  tally jsonb,
  shield jsonb,
  results jsonb,
  meta jsonb
);"}', 'create_selftest_reports', 'c_kendall@icloud.com', NULL, NULL),
	('20260802013135', '{"-- Index the UUID/company FK columns added today (fast joins on cutover). Idempotent.
DO $$
DECLARE r record; idx text;
BEGIN
  FOR r IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema=''public''
      AND column_name IN (''client_uuid'',''job_uuid'',''company_id'')
  LOOP
    idx := left(''ix_''||r.table_name||''_''||r.column_name, 63);
    EXECUTE format(''CREATE INDEX IF NOT EXISTS %I ON public.%I(%I)'', idx, r.table_name, r.column_name);
  END LOOP;
END $$;"}', 'gate1_index_new_fk_columns', 'c_kendall@icloud.com', NULL, NULL),
	('20260802110636', '{"alter table selftest_reports add column if not exists run_id text;
create unique index if not exists selftest_reports_run_id_key on selftest_reports (run_id) where run_id is not null;"}', 'selftest_reports_add_run_id', 'c_kendall@icloud.com', NULL, NULL),
	('20260802111455', '{"drop index if exists selftest_reports_run_id_key;
create unique index if not exists selftest_reports_run_id_uidx on selftest_reports (run_id);"}', 'selftest_reports_run_id_full_unique', 'c_kendall@icloud.com', NULL, NULL),
	('20260802121107', '{"ALTER TABLE public.marketing_approvals
  DROP CONSTRAINT IF EXISTS marketing_approvals_approvable_type_check;
ALTER TABLE public.marketing_approvals
  ADD CONSTRAINT marketing_approvals_approvable_type_check
  CHECK (approvable_type = ANY (ARRAY[
    ''CAMPAIGN_SPEND'',''GENERATED_VIDEO'',''WEBSITE_PROMOTION'',''REVIEW_REPLY'',
    ''CLAIM_CORRECTION'',''ACCOUNT_REPAIR'',''BUDGET_ADJUSTMENT'',''reina_change_request''
  ]));
ALTER TABLE public.marketing_approvals
  DROP CONSTRAINT IF EXISTS marketing_approvals_requested_by_check;
ALTER TABLE public.marketing_approvals
  ADD CONSTRAINT marketing_approvals_requested_by_check
  CHECK (requested_by = ANY (ARRAY[''system'',''owner'',''reina'']));"}', 'reina_change_request_approvals', 'c_kendall@icloud.com', NULL, NULL),
	('20260802122146', '{"-- sql/054_voice_queues.sql -- Phase 1: Call Queues (additive, idempotent).
create table if not exists voice_queues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  ring_order text not null default ''fifo''
    check (ring_order in (''fifo'',''priority'')),
  timeout_seconds integer not null default 30,
  overflow_destination text not null default ''voicemail''
    check (overflow_destination in (''extension'',''voicemail'',''callback'')),
  overflow_extension_id uuid references voice_extensions(id) on delete set null,
  hold_music_url text,
  is_default_inbound boolean not null default false,
  provider_queue_sid text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists voice_queues_one_default_inbound_idx
  on voice_queues (is_default_inbound) where is_default_inbound;
create index if not exists voice_queues_active_idx on voice_queues (active);

create table if not exists voice_queue_members (
  id uuid primary key default gen_random_uuid(),
  queue_id uuid not null references voice_queues(id) on delete cascade,
  extension_id uuid not null references voice_extensions(id) on delete cascade,
  priority integer not null default 0,
  created_at timestamptz not null default now(),
  unique (queue_id, extension_id)
);
create index if not exists voice_queue_members_queue_idx on voice_queue_members (queue_id);
create index if not exists voice_queue_members_ext_idx on voice_queue_members (extension_id);

create table if not exists voice_agent_status (
  id uuid primary key default gen_random_uuid(),
  extension_id uuid not null unique references voice_extensions(id) on delete cascade,
  status text not null default ''offline''
    check (status in (''available'',''on_call'',''on_break'',''dnd'',''offline'',''wrapping_up'')),
  status_note text,
  updated_at timestamptz not null default now()
);

create table if not exists voice_callbacks (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references voice_calls(id) on delete set null,
  queue_id uuid references voice_queues(id) on delete set null,
  from_number text not null,
  caller_name text,
  reason text,
  recording_sid text,
  recording_url text,
  duration_seconds integer,
  transcript text,
  transcript_status text default ''not_captured''
    check (transcript_status in (''not_captured'',''pending'',''ready'',''failed'')),
  ai_summary jsonb,
  status text not null default ''unassigned''
    check (status in (''unassigned'',''assigned'',''completed'',''dismissed'')),
  assigned_extension_id uuid references voice_extensions(id) on delete set null,
  source text not null default ''queue_overflow'',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists voice_callbacks_status_idx on voice_callbacks (status, created_at desc);
create index if not exists voice_callbacks_queue_idx on voice_callbacks (queue_id);

insert into voice_queues (name, ring_order, timeout_seconds, overflow_destination, is_default_inbound, active)
select ''General'', ''fifo'', 30, ''callback'', true, true
where not exists (select 1 from voice_queues where is_default_inbound = true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname=''supabase_realtime'' and schemaname=''public'' and tablename=''voice_agent_status'') then
    alter publication supabase_realtime add table voice_agent_status;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname=''supabase_realtime'' and schemaname=''public'' and tablename=''voice_callbacks'') then
    alter publication supabase_realtime add table voice_callbacks;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname=''supabase_realtime'' and schemaname=''public'' and tablename=''voice_calls'') then
    alter publication supabase_realtime add table voice_calls;
  end if;
exception when undefined_object then
  raise notice ''supabase_realtime publication not found -- skipping Realtime registration'';
end $$;"}', 'voice_queues_phase1', 'c_kendall@icloud.com', NULL, NULL),
	('20260802134738', '{"create table if not exists voice_settings (
  id uuid primary key default gen_random_uuid(),
  record_calls boolean not null default true,
  recording_channels text not null default ''dual''
    check (recording_channels in (''dual'',''mono'')),
  ai_call_summaries boolean not null default true,
  recording_consent_message text,
  singleton boolean not null default true unique check (singleton = true),
  updated_at timestamptz not null default now()
);

insert into voice_settings (record_calls, recording_channels, ai_call_summaries)
select true, ''dual'', true
where not exists (select 1 from voice_settings);"}', 'voice_call_recording_settings', 'c_kendall@icloud.com', NULL, NULL),
	('20260802135607', '{"alter table voice_voicemails add column if not exists deleted_at timestamptz;
create index if not exists voice_voicemails_deleted_idx on voice_voicemails (deleted_at);"}', 'voicemail_soft_delete', 'c_kendall@icloud.com', NULL, NULL);


--
-- PostgreSQL database dump complete
--

-- \unrestrict 2JMOzlaVURvZEs3OhWAzqOc3qNRGXBmex2KbC7tx98SxBl9LOHgWTjV8JLmT9fi

RESET ALL;
