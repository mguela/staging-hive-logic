-- 002_extended_resources.sql
-- ADDITIVE ONLY. Creates new tables for api/jobber/sync-extended.js.
-- Does not alter clients/jobs/invoices/sync_cursors/sync_log/integrations
-- (the tables the original sync.js already depends on).
--
-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New
-- query -> paste -> Run) before hitting /api/jobber/sync-extended for the
-- first time. Safe to run more than once (IF NOT EXISTS guards).

create table if not exists quotes (
  jobber_id text primary key,
  quote_number text,
  title text,
  quote_status text,
  total numeric,
  client_id text,
  client_name text,
  jobber_created_at timestamptz,
  jobber_updated_at timestamptz,
  synced_at timestamptz
);
create index if not exists quotes_client_id_idx on quotes (client_id);
create index if not exists quotes_status_idx on quotes (quote_status);

create table if not exists requests (
  jobber_id text primary key,
  title text,
  request_status text,
  client_id text,
  jobber_web_uri text,
  jobber_created_at timestamptz,
  jobber_updated_at timestamptz,
  synced_at timestamptz
);
create index if not exists requests_client_id_idx on requests (client_id);
create index if not exists requests_updated_at_idx on requests (jobber_updated_at desc);

create table if not exists visits (
  jobber_id text primary key,
  title text,
  start_at timestamptz,
  end_at timestamptz,
  completed_at timestamptz,
  is_all_day boolean,
  client_id text,
  job_id text,
  jobber_web_uri text,
  jobber_created_at timestamptz,
  jobber_updated_at timestamptz,
  synced_at timestamptz
);
create index if not exists visits_job_id_idx on visits (job_id);
create index if not exists visits_start_at_idx on visits (start_at);

create table if not exists expenses (
  jobber_id text primary key,
  title text,
  total numeric,
  expense_date date,
  reimbursable_to_user boolean,
  job_id text,
  jobber_created_at timestamptz,
  jobber_updated_at timestamptz,
  synced_at timestamptz
);
create index if not exists expenses_job_id_idx on expenses (job_id);

create table if not exists time_sheet_entries (
  jobber_id text primary key,
  start_at timestamptz,
  end_at timestamptz,
  final_duration numeric,
  user_id text,
  job_id text,
  jobber_created_at timestamptz,
  jobber_updated_at timestamptz,
  synced_at timestamptz
);
create index if not exists time_sheet_entries_user_id_idx on time_sheet_entries (user_id);
create index if not exists time_sheet_entries_job_id_idx on time_sheet_entries (job_id);

create table if not exists users (
  jobber_id text primary key,
  name text,
  email text,
  jobber_created_at timestamptz,
  jobber_updated_at timestamptz,
  synced_at timestamptz
);
