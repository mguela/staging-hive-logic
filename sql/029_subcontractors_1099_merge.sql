-- sql/029_subcontractors_1099_merge.sql
--
-- Reconciles the two contractor concepts flagged as an open decision when
-- sql/025_bookkeeping_contractor_tax.sql was written: the bookkeeping-scoped
-- bookkeeping_contractor_profiles table (1099/W-9 tax tracking, keyed by
-- normalized vendor name) and the subcontractors company directory shipped
-- on `main` in commit 63605ad (scheduling/contact info, keyed by id).
--
-- Chris's decision (2026-07-24): merge into one table. At decision time,
-- bookkeeping_contractor_profiles held zero rows in production -- Accounting
-- Control's 1099 tracking had never actually been used -- so this is purely
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

comment on column subcontractors.track_1099 is 'Whether this vendor/subcontractor is tracked for 1099 reporting. Feeds contractorTaxReport() via api/bookkeeping/_contractor_store.js.';
comment on column subcontractors.w9_on_file is 'Whether a signed W-9 is on file for this vendor/subcontractor.';
comment on column subcontractors.tax_id_last4 is 'Last 4 digits only of the vendor''s tax ID (SSN/EIN) -- never the full number.';
comment on column subcontractors.tax_notes is '1099/W-9 tracking notes, separate from the scheduling-facing notes column.';
