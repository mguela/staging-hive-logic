-- 022_bookkeeping_evidence.sql
-- ADDITIVE ONLY. Safe to run more than once (IF NOT EXISTS guards throughout).
-- Run once in the Supabase SQL editor before setting BOOKKEEPING_EVIDENCE_STORE=durable.
--
-- Fixes a real, verified gap discovered while building the evidence
-- thumbnail/full-screen viewer: public/app-bookkeeping.js has POSTed to
-- /api/bookkeeping/evidence since it was written, but NO SERVER ROUTE FOR IT
-- EXISTED AT ALL (confirmed by `git grep -rn "bookkeeping/evidence"` across
-- the whole repo before this commit -- it returned only the one fetch() call
-- and one comment referencing the expected route; no handler file existed
-- anywhere). Every "attach a receipt" click silently 404'd, state.evidenceId
-- never got set, and saveExpense() refuses to save without an evidenceId --
-- meaning Expense Entry could not be submitted at all until this fix. This
-- is a functional blocker fix, not a polish item.
--
-- Design: the file is stored as base64 TEXT, not bytea. PostgREST's JSON
-- encoding of a bytea column is hex-escaped and awkward to round-trip
-- cleanly; the file already arrives from the browser as base64 and needs to
-- be re-served as raw bytes to an <img>/<iframe> src, so storing the same
-- base64 text sidesteps a real encoding mismatch rather than introducing
-- one. This is a deliberate, documented trade-off (~33% storage overhead vs.
-- true binary) appropriate for receipt/bill-volume documents, not a hidden
-- shortcut. sha256 is computed server-side (never trusted from the client)
-- so it is real tamper evidence for what is actually stored.

create table if not exists bookkeeping_evidence_documents (
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
