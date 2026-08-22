-- T&M invoicing + payment (Chris's ask, 2026-07-21/22): tech generates the
-- invoice and collects payment on-site instead of Dispatch doing it after
-- the fact. Processor: United Payment Corp, gateway: Authorize.Net (Chris's
-- choice). Collection method: a payment link/QR the client pays on their
-- own device (Accept Hosted) -- works from the existing web Field App, no
-- native app or card-reader hardware required.
create table if not exists tm_invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null unique, -- short code, fits Authorize.Net's 20-char order.invoiceNumber limit
  job_ref text not null,               -- job_workflow.job_ref / jobs.jobber_id
  client_id text,
  client_name text,
  job_title text,
  hours numeric not null,
  rate_hourly numeric not null,        -- snapshot of job_workflow.tm_rate_hourly at generation time
  labor_amount numeric not null,
  materials_amount numeric not null default 0,
  total_amount numeric not null,
  notes text,
  status text not null default 'pending', -- pending | paid | failed | void
  pay_token text not null unique,      -- capability token for the public /pay/ page, same pattern as travel_sessions.token
  created_by uuid,
  created_by_name text,
  authnet_transaction_id text,
  authnet_response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table tm_invoices enable row level security;
-- No permissive policies -- only the service-role key (server-side only,
-- via api/fieldops.js) can read/write. Same secure-by-default pattern as
-- workforce_time_sessions.

comment on table tm_invoices is
  'Tech-generated T&M invoices, paid via Authorize.Net Accept Hosted (payment link/QR, no hardware). Status is only ever set to paid by the authnet webhook handler after Authorize.Net confirms the charge -- never by the client-side redirect alone.';
comment on column tm_invoices.rate_hourly is
  'Snapshot at invoice-generation time, not a live read of tm_rate_types, so a later rate-table edit never changes an already-generated invoice.';
