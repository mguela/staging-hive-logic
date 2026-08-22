-- sql/024_bookkeeping_reina_learning.sql
--
-- Persistence for Reina's approved-learning memory
-- (server/bookkeeping/src/reina-learning.js). One versioned JSON blob per
-- company, the exact shape ensureLearningState() already produces/expects
-- ({ version, events[], migratedRules[] }) -- same "whole-object blob,
-- versioned for optimistic concurrency" pattern already shipped for the
-- general ledger (ledger_systems, sql/011_ledger.sql).
--
-- Before this migration, no route anywhere ever persisted a learning event
-- -- api/bookkeeping/reina-accuracy.js always read a brand-new, empty
-- createLearningState() on every request, so "approved corrections: 0" was
-- true 100% of the time regardless of how many expenses had actually been
-- approved. This table is what api/bookkeeping/_learning_store.js's durable
-- backend reads/writes.
--
-- NOT run against any real Supabase project by this session. Chris runs
-- this himself before setting BOOKKEEPING_LEARNING_STORE=durable.

create table if not exists bookkeeping_reina_learning (
  company_id text primary key,
  data jsonb not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table bookkeeping_reina_learning is
  'One row per company: Reina''s approved-learning memory (server/bookkeeping/src/reina-learning.js''s ensureLearningState() shape), versioned for optimistic-concurrency updates.';
