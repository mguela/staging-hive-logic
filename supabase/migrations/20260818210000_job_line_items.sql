-- Line-item activities on a job — 2026-08-18
--
-- Chris's ask: "ability to add line item activities to a job, and a way to turn
-- a job into an invoice." Estimates, quotes and invoices all already carry
-- priced lines; a job was the one record in the chain that could only hold a
-- single lump `total`, so the work actually performed on a job could never be
-- itemised — and converting a job into an invoice had nothing to copy.
--
-- Shape note: invoices.line_items is jsonb, not a child table. This is a real
-- table rather than another jsonb blob because job lines get edited one at a
-- time by whoever is on the job, and are summed across jobs for reporting;
-- both are awkward against a document column. The invoice side stays jsonb —
-- conversion serialises these rows into that existing column rather than
-- changing how invoices store lines.
--
-- job_ref holds jobs.jobber_id, matching hl_appointments.job_ref and
-- visits.job_id. Deliberately NOT a foreign key, for the same reason those
-- aren't: Jobber-synced jobs come and go with the sync, and a line item
-- outliving a resynced job row is better than the sync failing on a
-- constraint.
--
-- Additive only. Nothing reads or writes these columns before this migration.

create table if not exists public.job_line_items (
  id uuid primary key default gen_random_uuid(),
  job_ref text not null,
  description text not null,
  quantity numeric(12, 2) not null default 1,
  unit_price numeric(12, 2) not null default 0,
  -- Stored, not computed on read: an invoice raised from these lines must be
  -- able to show what was billed even if someone later edits the quantity.
  line_total numeric(14, 2) not null default 0,
  sort_order integer not null default 0,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.job_line_items is
  'Priced line-item activities on a job. job_ref is jobs.jobber_id (not a FK — same rationale as hl_appointments.job_ref). Converting a job to an invoice serialises these rows into invoices.line_items jsonb.';

comment on column public.job_line_items.line_total is
  'quantity * unit_price at the time the line was saved. Stored so a raised invoice still reflects what was billed if the line is edited afterwards.';

-- Guard against negative quantities/prices sneaking in from a tampered request;
-- the API validates too, but the table is the last line.
alter table public.job_line_items
  drop constraint if exists job_line_items_quantity_nonneg;
alter table public.job_line_items
  add constraint job_line_items_quantity_nonneg check (quantity >= 0);

alter table public.job_line_items
  drop constraint if exists job_line_items_unit_price_nonneg;
alter table public.job_line_items
  add constraint job_line_items_unit_price_nonneg check (unit_price >= 0);

create index if not exists job_line_items_job_ref_idx
  on public.job_line_items (job_ref, sort_order, created_at);

-- Same tenancy model as the rest of this project's tables: reached only through
-- the serverless API using the service role, never directly from the browser.
alter table public.job_line_items enable row level security;
revoke all on table public.job_line_items from public, anon, authenticated;
grant select, insert, update, delete on table public.job_line_items to service_role;
