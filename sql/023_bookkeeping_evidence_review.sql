-- 023_bookkeeping_evidence_review.sql
-- ADDITIVE ONLY. Safe to run more than once (IF NOT EXISTS guards throughout).
-- Run once in the Supabase SQL editor before -- or any time after -- setting
-- BOOKKEEPING_EVIDENCE_STORE=durable. Adds the review-queue columns that
-- api/bookkeeping/document-reviews.js and the updated
-- api/bookkeeping/_evidence_store.js now read/write.
--
-- Fixes a real, disclosed gap: server/bookkeeping/src/close.js's
-- document_intake close-readiness check has always looked for an
-- 'extracted'/'processed' status on every evidence document, but this
-- table (022_bookkeeping_evidence.sql) never had a status column at all --
-- so every evidence document was permanently, silently unreviewable, and
-- document_intake was destined to become a permanent close blocker the
-- moment any document existed. This migration adds the missing column plus
-- the reviewer/resolution/note/timestamp columns needed to close the loop,
-- ported from the same shape the approved hivelogic-expense-control
-- reference stores this in (its documentInbox/evidenceDocuments records'
-- status/resolution/reviewNote/reviewedAt/reviewedBy fields).
--
-- 'received' is the default for both new rows and any already-existing row
-- (via the DEFAULT + a backfill UPDATE) -- this is the honest, correct
-- starting state: a document that has never been reviewed needs review, it
-- is not silently marked as already handled.

alter table bookkeeping_evidence_documents
  add column if not exists status text not null default 'received';

alter table bookkeeping_evidence_documents
  add column if not exists resolution text;

alter table bookkeeping_evidence_documents
  add column if not exists review_note text;

alter table bookkeeping_evidence_documents
  add column if not exists reviewed_at timestamptz;

alter table bookkeeping_evidence_documents
  add column if not exists reviewed_by uuid;

-- Backfill: any row inserted before this migration ran has a NULL status
-- (the column didn't exist yet, so there's nothing to overwrite) -- this
-- catches that case explicitly rather than relying on the DEFAULT, which
-- only applies to NEW inserts, not existing rows.
update bookkeeping_evidence_documents set status = 'received' where status is null;

create index if not exists bookkeeping_evidence_documents_status_idx on bookkeeping_evidence_documents (company_id, status);
