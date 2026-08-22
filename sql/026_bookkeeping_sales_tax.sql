-- sql/026_bookkeeping_sales_tax.sql
--
-- Real, manually-logged sales-tax entries feeding
-- server/bookkeeping/src/reporting.js's salesTaxLiability(sales, payments,
-- throughDate), already ported and tested but always fed [] for both
-- arguments -- there was no source anywhere in this app for either "tax
-- collected from a client on a taxable sale" or "tax remitted to a state".
--
-- Deliberately a manual log, not an automatic feed: this app's invoicing
-- lives in Jobber/QuickBooks, not in this bookkeeping module, and whether
-- Greenwich Handyman even collects sales tax on a given job depends on
-- Connecticut's capital-improvement-vs-repair distinction, which only
-- Chris/his bookkeeper can classify per job -- there is no safe way to
-- infer "taxable sale" data from anything already in this codebase. A
-- manual entry log, feeding the exact same real engine function the
-- close package and close-readiness checks already call, is the honest
-- alternative to leaving the section permanently fake ($0) -- not a
-- placeholder, a real (if manually-fed) production feature, same as many
-- small-business bookkeeping tools without a POS/invoicing integration.
create table if not exists bookkeeping_sales_tax_entries (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  kind text not null check (kind in ('collected', 'remitted')),
  tax_state text not null,
  entry_date date not null,
  data jsonb not null, -- collected: {taxableAmount, exemptAmount, taxCollected, jobRef, note}; remitted: {amount, note}
  status text not null default 'active' check (status in ('active', 'void')),
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table bookkeeping_sales_tax_entries is
  'Manually-logged sales-tax-collected and tax-remitted-to-state entries feeding salesTaxLiability(). Void (not deleted) to preserve an audit trail -- see api/bookkeeping/_sales_tax_store.js.';

create index if not exists bookkeeping_sales_tax_entries_company_idx
  on bookkeeping_sales_tax_entries (company_id, entry_date);
