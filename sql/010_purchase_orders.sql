-- 010_purchase_orders.sql
-- ADDITIVE ONLY. Safe to run more than once (IF NOT EXISTS guards throughout).
-- Run once in the Supabase SQL editor before setting BOOKKEEPING_PO_STORE=durable.
--
-- Replaces the in-memory preview store in
-- api/bookkeeping/purchase-orders/_store.js, per the outside review's
-- explicit corrective requirement: "Replace the separate in-memory
-- serverless stores with durable transactional storage."
--
-- Design: the full purchase order object produced/consumed by
-- server/bookkeeping/src/purchase-orders.js (lines, history, exceptions,
-- applied match keys, all of it) is stored as one jsonb document per row --
-- same convention this repo already uses for spec_attributes / bulk_price_tiers
-- in sql/008_material_catalog.sql -- rather than fully normalizing it into a
-- dozen relational tables. That keeps the durable store a faithful mirror of
-- the already-tested (81/81) engine's own data shape, so there is no separate
-- mapping layer that could silently drift from what the engine actually
-- produces. A handful of top-level columns are pulled out of that jsonb body
-- so Postgres can index and query on them directly (company scoping, job
-- linkage, lifecycle state, numbering) without needing jsonb path queries on
-- every list/filter call.
--
-- Optimistic concurrency: `version` guards every update. A caller must read
-- a row, compute the next state, then update WHERE version = <value it read>;
-- zero rows affected means someone else moved first, and the caller must
-- re-read and retry. This is what actually answers the review's concurrency
-- concern for a real (not in-memory) store -- two simultaneous approve/match/
-- close calls on the same PO can no longer silently clobber one another.

create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  po_number text not null,
  job_id text,
  overhead_category text,
  order_type text not null,               -- 'planned' | 'after_the_fact' -- mirrors po.orderType, kept here too for fast filtering/reporting
  lifecycle_status text not null,         -- mirrors po.lifecycleStatus
  not_preapproved boolean not null default false,
  version integer not null default 1,
  data jsonb not null,                    -- the full purchase order object exactly as the engine produces/consumes it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A company can never have two POs sharing a number -- this is the durable
-- backstop for Bug 4 (numbering could reuse an existing PO number). The
-- allocate_po_number() function below is what actually prevents the
-- collision from being generated in the first place; this constraint is the
-- last line of defense if it ever were.
create unique index if not exists purchase_orders_company_number_uidx
  on purchase_orders (company_id, po_number);

create index if not exists purchase_orders_company_idx on purchase_orders (company_id);
create index if not exists purchase_orders_company_job_idx on purchase_orders (company_id, job_id);
create index if not exists purchase_orders_company_status_idx on purchase_orders (company_id, lifecycle_status);

-- Durable, atomic per-company/per-scope sequence for PO numbering. `scope_key`
-- is 'job:<jobId>' or 'general' -- matches allocatePurchaseOrderNumber()'s own
-- key convention in the engine, so the formatted number this produces is
-- byte-for-byte what the engine would have produced from an equivalent
-- in-memory counterState.
create table if not exists po_counters (
  company_id text not null,
  scope_key text not null,
  next_sequence integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (company_id, scope_key)
);

-- Single atomic UPDATE (or INSERT if the row doesn't exist yet) -- Postgres
-- guarantees no two concurrent callers can read-then-write the same row
-- without one blocking on the other's row lock, so this can never hand out
-- the same sequence number twice, and a cancelled/deleted PO can never free
-- up its number for reuse (the counter only ever goes up).
create or replace function allocate_po_number(p_company_id text, p_scope_key text, p_job_id text, p_company_code text default 'PO')
returns table(po_number text, sequence_no integer) as $$
declare
  v_seq integer;
begin
  insert into po_counters (company_id, scope_key, next_sequence)
    values (p_company_id, p_scope_key, 1)
  on conflict (company_id, scope_key)
    do update set next_sequence = po_counters.next_sequence + 1, updated_at = now()
  returning next_sequence into v_seq;

  -- first-ever row for this scope: the insert above sets next_sequence=1 and
  -- the ON CONFLICT branch never runs, so v_seq is already correct at 1.
  if v_seq is null then
    v_seq := 1;
  end if;

  if p_job_id is not null and p_job_id <> '' then
    po_number := p_company_code || '-' || p_job_id || '-' || lpad(v_seq::text, 2, '0');
  else
    po_number := p_company_code || '-GEN-' || lpad(v_seq::text, 4, '0');
  end if;
  sequence_no := v_seq;
  return next;
end;
$$ language plpgsql;

-- Round 3 correction #5: multi-PO receipt matching must commit atomically --
-- a failure partway through must not leave a receipt half-posted (some POs
-- updated, others not). This single plpgsql function applies every PO update
-- in the batch inside the one implicit transaction PostgREST already wraps
-- around each RPC call: if ANY row in the batch fails its optimistic-
-- concurrency version check, the function raises and the whole call's
-- effects -- including any updates already applied earlier in the same loop
-- -- are rolled back together. Callers (see _store.js
-- durableApplyReceiptMatchBatch) re-read and retry the whole batch on that
-- failure, exactly like the single-PO CAS retry loop, just batched.
-- Round 5 fix (task #25): p_seen_bill is a new, optional parameter. Previously
-- match.js called applyReceiptMatchBatch() to post the PO updates, then made
-- a SEPARATE, later call to recordSeenBill() to record the duplicate-bill
-- fingerprint -- two independent round-trips with no shared transaction. If
-- the process died, the request timed out, or the second call failed for any
-- reason between those two calls, the receipt would be durably matched to
-- its purchase order(s) but NEVER recorded in po_seen_bills, silently
-- disabling duplicate-bill detection for that receipt forever. Folding the
-- seen-bill insert into this same PL/pgSQL function body puts it in the same
-- implicit transaction as every PO update in the batch: either the whole
-- receipt (every PO update AND the duplicate-detection record) commits, or
-- none of it does. p_seen_bill defaults to null so existing callers that
-- don't pass it (e.g. any code path with nothing worth recording, or old
-- clients mid-deploy) are unaffected.
create or replace function apply_po_batch_update(p_updates jsonb, p_seen_bill jsonb default null)
returns setof purchase_orders as $$
declare
  upd jsonb;
  updated_row purchase_orders%rowtype;
begin
  for upd in select * from jsonb_array_elements(p_updates)
  loop
    update purchase_orders
    set
      po_number = upd->>'po_number',
      job_id = nullif(upd->>'job_id', ''),
      overhead_category = nullif(upd->>'overhead_category', ''),
      order_type = upd->>'order_type',
      lifecycle_status = upd->>'lifecycle_status',
      not_preapproved = (upd->>'not_preapproved')::boolean,
      data = upd->'data',
      version = (upd->>'expected_version')::integer + 1,
      updated_at = now()
    where company_id = upd->>'company_id'
      and data->>'id' = upd->>'po_id'
      and version = (upd->>'expected_version')::integer
    returning * into updated_row;

    if not found then
      raise exception 'CONCURRENT_CONFLICT: purchase order %  was modified by someone else since it was read (expected version %). Rolling back the entire batch so the receipt is never left half-posted.',
        upd->>'po_id', upd->>'expected_version';
    end if;

    return next updated_row;
  end loop;

  if p_seen_bill is not null then
    insert into po_seen_bills (
      company_id, qbo_vendor_id, vendor_name, invoice_number, currency, amount, evidence_hash, source_transaction_id
    ) values (
      p_seen_bill->>'company_id',
      p_seen_bill->>'qbo_vendor_id',
      p_seen_bill->>'vendor_name',
      p_seen_bill->>'invoice_number',
      p_seen_bill->>'currency',
      nullif(p_seen_bill->>'amount', '')::numeric,
      p_seen_bill->>'evidence_hash',
      p_seen_bill->>'source_transaction_id'
    )
    on conflict (company_id, source_transaction_id) do nothing;
  end if;
end;
$$ language plpgsql;

-- Idempotent receipt/bill duplicate-detection needs a durable record of
-- previously seen vendor bills per company, independent of any one PO
-- (a duplicate can be flagged even before it's matched to anything).
--
-- Round 3 correction #9: this row shape must match, field-for-field, what
-- server/bookkeeping/src/purchase-orders.js's detectExceptions() actually
-- reads off an existingBills entry (companyId, qboVendorId, vendorName,
-- invoiceNumber, currency, amount) -- the column is named `amount`, never
-- `total`, matching the one naming this app now uses everywhere for a bill's
-- dollar value (see _store.js's durableExistingBills, which maps these
-- snake_case columns to that exact camelCase shape on read). vendor_name is
-- new -- the engine falls back to matching on vendor name when no QBO
-- vendor id is present yet, and the old schema had nowhere to store it.
create table if not exists po_seen_bills (
  id uuid primary key default gen_random_uuid(),
  company_id text not null,
  qbo_vendor_id text,
  invoice_number text,
  currency text,
  amount numeric,
  evidence_hash text,
  source_transaction_id text,
  created_at timestamptz not null default now()
);

-- Round 5 fix: vendor_name used to be declared inside the CREATE TABLE IF NOT
-- EXISTS block above. That is a no-op against any database that already ran
-- this migration -- the table already exists, so the whole CREATE TABLE
-- statement is skipped and the column never gets added. ALTER TABLE ... ADD
-- COLUMN IF NOT EXISTS is the only form of this that's safe to re-run and
-- actually lands the column on an already-migrated database.
alter table po_seen_bills add column if not exists vendor_name text;

create index if not exists po_seen_bills_dup_idx
  on po_seen_bills (company_id, qbo_vendor_id, invoice_number, currency, amount);

-- Idempotency constraint: source_transaction_id is the receipt's own id
-- (see match.js). A retried request, a duplicate webhook, or a user
-- double-click recording the same receipt as a seen bill twice must be a
-- safe no-op, not a second row -- a second row would itself look like a
-- second, distinct bill the next time duplicate detection runs.
--
-- Round 5 fix: this used to be a PARTIAL unique index (WHERE
-- source_transaction_id IS NOT NULL), which is incompatible with _store.js's
-- durableRecordSeenBill, which posts to PostgREST with
-- ?on_conflict=company_id,source_transaction_id -- PostgREST's on_conflict
-- param always generates a plain (non-partial) ON CONFLICT clause, and
-- Postgres requires the ON CONFLICT arbiter to exactly match an existing
-- unique constraint/index INCLUDING any partial predicate, so this would
-- fail against a real Postgres database with "there is no unique or
-- exclusion constraint matching the ON CONFLICT specification." Dropping the
-- WHERE clause is safe: Postgres unique indexes never treat NULL as equal to
-- another NULL, so rows with a null source_transaction_id remain
-- unconstrained by uniqueness even without an explicit partial predicate --
-- the original intended semantics are preserved.
--
-- This is written as DROP + CREATE (not CREATE UNIQUE INDEX IF NOT EXISTS)
-- specifically so it's upgrade-safe: a database that already has the old,
-- broken partial index under this same name would otherwise have IF NOT
-- EXISTS silently skip creating the corrected version, since a same-named
-- index already exists.
drop index if exists po_seen_bills_source_txn_uidx;
create unique index po_seen_bills_source_txn_uidx
  on po_seen_bills (company_id, source_transaction_id);
