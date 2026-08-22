-- 028_bookkeeping_evidence_extracted.sql
-- ADDITIVE ONLY. Safe to run more than once (IF NOT EXISTS guards throughout).
-- Run once in the Supabase SQL editor before -- or any time after -- setting
-- BOOKKEEPING_EVIDENCE_STORE=durable. Adds the two columns
-- api/bookkeeping/receipt-scan.js and the updated api/bookkeeping/
-- _evidence_store.js now read/write to persist a Reina OCR scan result onto
-- its evidence document.
--
-- Fixes a real, disclosed gap in the live receipt-scan pipeline (task 8):
-- the route re-scanned a document fresh on every call (no way to know a
-- document had already been read) and could not clear
-- server/bookkeeping/src/close.js's document_intake close-readiness check
-- except through a human's manual "Reviewed" click in
-- api/bookkeeping/document-reviews.js -- even after Reina had already read a
-- document with real, high confidence. This was exactly the gap
-- api/bookkeeping/_evidence_store.js's own header comment predicted before
-- this pipeline existed ("...or, in a future receipt-scan/OCR pipeline --
-- not built yet -- could move to 'extracted' automatically").
--
-- document_type: the classification Reina's scan returned (receipt,
-- vendor_bill, other, etc). Small, safe to include in vault-listing queries.
--
-- extracted: the full annotated scan result (vendor, dates, amounts,
-- line items, confidence, etc) as jsonb -- deliberately excluded from any
-- bulk vault-listing query (see _evidence_store.js's durableList()/
-- rowToDocSummary()), the same way data_base64 already is, since a scan
-- payload can carry a whole line-item table and listing hundreds of
-- documents should stay a lightweight index, not a bulk data dump.
--
-- NULL is the correct, honest default for both columns on every row that
-- existed before this migration and on every row created before it is ever
-- scanned -- "not yet scanned" is a real, different state from "scanned and
-- found nothing," and nothing here should claim otherwise.

alter table bookkeeping_evidence_documents
  add column if not exists document_type text;

alter table bookkeeping_evidence_documents
  add column if not exists extracted jsonb;

create index if not exists bookkeeping_evidence_documents_document_type_idx on bookkeeping_evidence_documents (company_id, document_type);
