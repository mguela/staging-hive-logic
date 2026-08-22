-- 013_bookkeeping_audit_log.sql
-- ADDITIVE ONLY. Safe to run more than once (IF NOT EXISTS guards throughout).
--
-- Fixes a real, verified gap: the ledger engine's two hash chains
-- (server/bookkeeping/src/ledger.js's `ledger.audit`, and controls.js's
-- `store.events`) are each internally self-consistent -- every record links
-- to the previous record's hash -- but both chains live *inside* the same
-- single mutable jsonb blob that ledger_systems.data already stores (see
-- 011_ledger.sql). That means anyone who can write that one jsonb column
-- (a compromised service-role key, a bug in application code, direct
-- Supabase dashboard access) can replace the whole audit history with a
-- DIFFERENT, but still internally-consistent, chain -- verifyAuditChain()
-- would show "valid: true" either way, because it only checks the chain
-- against *itself*, not against anything outside that same blob.
--
-- The fix: every audit/event record, the moment it's appended in
-- application code, is ALSO written here -- to a table this database
-- itself refuses to let anyone UPDATE or DELETE from (see the REVOKE
-- below). That makes this table an independent witness: if ledger_systems.data
-- is ever rewritten with a different history, the rewritten chain will
-- no longer match what's durably recorded here, and
-- verifyAuditChainAgainstLog() (api/bookkeeping/ledger/_store.js) will catch
-- the divergence. This table is intentionally append-only at the database
-- level, not just "we promise not to update it" at the application level --
-- that's the actual, real difference between this and the pre-existing
-- in-blob chain.

create table if not exists bookkeeping_audit_log (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  source text not null check (source in ('ledger', 'controls')),   -- which of the two chains this record belongs to
  seq integer not null,                                            -- 0-based position within (company_id, source)'s chain
  record_id text not null,                                         -- the engine's own record.id (randomUUID from ledger.js/controls.js)
  previous_hash text,
  hash text not null,
  recorded_at timestamptz not null default now(),                  -- when THIS table received the record (independent of the engine's own `at`)
  payload jsonb not null,                                           -- the full record as appended by the engine, verbatim
  unique (company_id, source, seq),
  unique (company_id, source, hash)
);

create index if not exists bookkeeping_audit_log_company_idx on bookkeeping_audit_log (company_id, source, seq);

-- The actual enforcement: revoke UPDATE and DELETE from the roles PostgREST
-- (Supabase's REST layer, which is all this app ever talks to) uses. INSERT
-- and SELECT remain so the app can append new records and verify old ones.
-- Run this even if the table already existed from a prior partial run.
revoke update, delete on bookkeeping_audit_log from anon, authenticated, service_role;
grant insert, select on bookkeeping_audit_log to service_role;

-- Belt-and-suspenders: a trigger that raises even if some future grant
-- change accidentally reopens UPDATE/DELETE at the role level.
create or replace function bookkeeping_audit_log_immutable() returns trigger as $$
begin
  raise exception 'bookkeeping_audit_log is append-only -- % is not permitted', TG_OP;
end;
$$ language plpgsql;

drop trigger if exists bookkeeping_audit_log_no_update on bookkeeping_audit_log;
create trigger bookkeeping_audit_log_no_update
  before update or delete on bookkeeping_audit_log
  for each row execute function bookkeeping_audit_log_immutable();
