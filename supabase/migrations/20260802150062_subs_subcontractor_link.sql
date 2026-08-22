-- sql/062_subs_subcontractor_link.sql
--
-- Links the Sub Portal's `subs` table (magic-link login, sessions, RFQs,
-- invoices, messages -- sql/012_subcontractor_portal.sql) to the staff-facing
-- vendor directory `subcontractors` table (sql/029_subcontractors_1099_merge.sql).
-- Today these are two fully disconnected records for the same real-world
-- company -- zero linking column, no shared identity. Flagged as an open gap
-- (subs 0 rows, subcontractors 1 row at audit time -- no real data migration
-- needed, just a schema fix before either table grows).
--
-- ADDITIVE ONLY, safe to run more than once (IF NOT EXISTS guards). Does not
-- touch or drop any existing column -- api/subportal.js's existing reads of
-- subs.company_name/contact_name/phone/email keep working unchanged even if
-- some future code path doesn't set subcontractor_id yet.
--
-- `subcontractors` stays the one source-of-truth entity (name, trade, phone,
-- email, 1099/W-9 tax tracking, directory-wide reporting). `subs` becomes the
-- portal-account extension of a subcontractors row, not a second identity.

alter table subs add column if not exists subcontractor_id uuid references subcontractors(id);
create index if not exists subs_subcontractor_id_idx on subs(subcontractor_id);

comment on column subs.subcontractor_id is 'Links this portal account to its one directory entry in subcontractors. Nullable only for legacy rows created before this link existed; api/subportal.js''s invite action sets it on every new invite going forward (see 2026-08 fix).';
