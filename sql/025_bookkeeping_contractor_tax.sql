-- sql/025_bookkeeping_contractor_tax.sql
--
-- Real, tracked 1099/W-9 status for subcontractors/vendors, scoped inside
-- the bookkeeping module. Feeds server/bookkeeping/src/reporting.js's
-- contractorTaxReport(vendors, payments, {year, threshold}), which was
-- already ported and tested but always fed [] for vendors -- there was no
-- place anywhere in this app to mark a vendor as 1099-tracked, hold a W-9,
-- or record a tax ID's last 4 digits.
--
-- Deliberately NOT the same table as the separate `subcontractors` company
-- directory shipped on `main` (commit 63605ad) -- that table isn't present
-- on this branch (accounting-control-parity forked before it existed, and
-- merging main into this branch is out of scope for this task), and even
-- once merged, that table is a scheduling/contact directory, not a tax
-- record. Disclosed tradeoff: this creates a second, bookkeeping-scoped
-- vendor concept, keyed by normalized vendor NAME (not a shared id) since
-- expenses/receipts in this app record a vendor as free text, not a
-- formal vendor id. When this branch merges to main, Chris should decide
-- whether to consolidate the two -- flagged in the project doc, not
-- silently resolved here.
create table if not exists bookkeeping_contractor_profiles (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  vendor_key text not null, -- normalizeCatalogTerm(vendorName) -- stable join key
  data jsonb not null, -- { vendorName, track1099, w9OnFile, taxIdLast4, notes }
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, vendor_key)
);

comment on table bookkeeping_contractor_profiles is
  'One row per company+vendor: 1099/W-9 tracking status feeding contractorTaxReport(). Keyed by a normalized vendor name (see server/bookkeeping/src/catalog.js''s normalizeCatalogTerm), not a formal vendor id -- this app records vendors as free text on expenses/receipts.';

create index if not exists bookkeeping_contractor_profiles_company_idx
  on bookkeeping_contractor_profiles (company_id);
