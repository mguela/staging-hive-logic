// api/bookkeeping/ledger/_store.js
//
// Storage for the ported general-ledger/reporting/banking/controls engine
// (server/bookkeeping/src/ledger.js + controls.js). Unlike the purchase-order
// store (one row per PO), the ledger engine operates on one whole `ledger`
// object per company (companies -> accounts/periods/entries) plus one whole
// `controls` object (approvals/qboOutbox/events) -- so this store persists
// those two objects as a single versioned JSON blob per company, the same
// optimistic-concurrency (CAS) pattern already established in
// api/bookkeeping/purchase-orders/_store.js: read the current version, write
// WHERE version = <that value>, retry on conflict.
//
// This is a deliberate simplification, not an oversight: normalizing the
// ledger into fully relational tables (one row per journal entry/line) is a
// real future improvement for query performance at scale, but the object-
// based model here is exactly what server/bookkeeping/src/ledger.js already
// expects and is already tested against -- storing it as a single durable
// blob is the fastest path to a REAL, working, correctly-tested general
// ledger without rewriting the (already correct) engine's data shape.
//
// Same fail-closed backend selection as the PO store: BOOKKEEPING_PO_STORE
// governs both stores (one Vercel deploy uses one backend for both, since
// they share the same Supabase project) -- 'durable' opts in explicitly,
// memory requires NODE_ENV=test or BOOKKEEPING_ALLOW_MEMORY_STORE=true
// outside production, and production always requires durable + a confirmed
// migration flag. See purchase-orders/_store.js for the full rationale.

import { supabaseRequest } from '../../_lib/jobber.js';
import { getFinancials } from '../../qbo/index.js';
let _load_ledger_cache;
async function _load_ledger() {
  if (!_load_ledger_cache) _load_ledger_cache = await import('../../../server/bookkeeping/src/ledger.js');
  return _load_ledger_cache;
}
let _load_controls_cache;
async function _load_controls() {
  if (!_load_controls_cache) _load_controls_cache = await import('../../../server/bookkeeping/src/controls.js');
  return _load_controls_cache;
}

const MAX_CAS_RETRIES = 5;

function resolveBackend() {
  const requested = process.env.BOOKKEEPING_PO_STORE === 'durable' ? 'durable' : 'memory';
  const isProduction = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  if (isProduction) {
    if (requested !== 'durable') {
      throw new Error('FAIL_CLOSED: this is a production environment and BOOKKEEPING_PO_STORE is not set to "durable". Refusing to start the ledger on in-memory storage in production.');
    }
    if (process.env.BOOKKEEPING_PO_MIGRATION_CONFIRMED !== 'true') {
      throw new Error('FAIL_CLOSED: production is configured for durable storage, but BOOKKEEPING_PO_MIGRATION_CONFIRMED is not "true". Set that flag only after personally running sql/011_ledger.sql against this environment\'s real Supabase project.');
    }
    return 'durable';
  }
  if (requested === 'memory') {
    const allowMemory = process.env.NODE_ENV === 'test' || process.env.BOOKKEEPING_ALLOW_MEMORY_STORE === 'true';
    if (!allowMemory) {
      throw new Error('FAIL_CLOSED: memory-mode ledger storage requires BOOKKEEPING_ALLOW_MEMORY_STORE=true for local/demo use, or NODE_ENV=test for automated tests.');
    }
  }
  return requested;
}

const BACKEND = resolveBackend();

// FALLBACK chart of accounts only -- used to provision a brand-new company
// when QuickBooks isn't reachable yet (e.g. local/offline development). It
// is deliberately NOT what real production data should run on: these ids
// ('64' for job materials, '99' for Unrecorded Expenses, etc.) only ever
// matched server/bookkeeping/src/accounting.js's internal vendor-pattern
// classifier by convention -- they have no relationship to this company's
// real QuickBooks chart of accounts. That mismatch was Kevin's UAT finding
// ("Financial Reports and GL accounts mapping do not match QuickBooks"):
// a real submitted expense always carries a REAL live QBO account id (the
// Expense Entry "QBO expense account" dropdown is populated from real QBO
// data), so its auto-created journal entry (api/bookkeeping/expenses.js's
// buildJournalEntryInput) fails ledger.js's own account-id validation
// against THIS placeholder list, and the General Ledger silently never
// receives most real expense activity. See realChartOfAccountsFromQbo()
// and reseedAccountsFromQbo() below for the real fix: the chart of accounts
// this app's books actually run on should be built from live QuickBooks
// data, not this fixed list. Provisioning doesn't call that automatically
// (this is a single-tenant app -- there's exactly one real company, and an
// admin explicitly triggers the QuickBooks-backed rebuild once via
// POST /api/bookkeeping/ledger/reseed-accounts once QBO is connected,
// rather than every fresh provision silently depending on a live QBO call
// succeeding) -- if HiveLogic ever becomes multi-tenant, revisit whether
// provisioning itself should call realChartOfAccountsFromQbo() directly.
export function defaultChartOfAccounts() {
  return [
    { id: '1000', name: 'Operating Bank', type: 'asset', cashFlowRole: 'cash' },
    { id: '1010', name: 'Business Credit Card', type: 'liability' },
    { id: '1100', name: 'Accounts Receivable', type: 'asset' },
    { id: '2000', name: 'Accounts Payable', type: 'liability' },
    { id: '2100', name: 'Sales Tax Payable', type: 'liability' },
    { id: '2200', name: 'Loan Payable', type: 'liability' },
    { id: '3000', name: 'Owner Equity', type: 'equity' },
    { id: '4000', name: 'Contract Revenue', type: 'income' },
    { id: '64', name: 'Job Materials', type: 'expense' },
    { id: '65', name: 'Subcontractor Costs', type: 'expense' },
    { id: '67', name: 'Truck & Vehicle', type: 'expense' },
    { id: '68', name: 'Insurance', type: 'expense' },
    { id: '69', name: 'Licenses & Permits', type: 'expense' },
    { id: '70', name: 'Payroll', type: 'expense' },
    { id: '71', name: 'Overhead', type: 'expense' },
    { id: '72', name: 'Tools & Equipment', type: 'expense' },
    { id: '73', name: 'Equipment Rental', type: 'expense' },
    { id: '74', name: 'Interest Expense', type: 'expense' },
    { id: '75', name: 'Rent & Lease', type: 'expense' },
    { id: '76', name: 'Gas & Fuel', type: 'expense' },
    { id: '77', name: 'Repairs & Maintenance', type: 'expense' },
    { id: '99', name: 'Unrecorded Expenses', type: 'expense' }
  ];
}

// Maps a real QuickBooks AccountType string (see api/qbo/index.js's
// getFinancials('accounts')) to the 5-way vocabulary server/bookkeeping/src/
// ledger.js's addCompany() requires (asset|liability|equity|income|expense).
// Kept in sync with api/bookkeeping/reference-data.js's own EXPENSE_ACCOUNT_TYPES/
// BANK_ACCOUNT_TYPES sets (those two are a subset of this -- reference-data.js
// only needs bank + expense accounts for its two dropdowns; the ledger needs
// every real account, since a real company's books touch all five types).
const QBO_ASSET_TYPES = new Set(['Bank', 'Accounts Receivable', 'Other Current Asset', 'Fixed Asset', 'Other Asset']);
const QBO_LIABILITY_TYPES = new Set(['Accounts Payable', 'Credit Card', 'Other Current Liability', 'Long Term Liability']);
const QBO_EQUITY_TYPES = new Set(['Equity']);
const QBO_INCOME_TYPES = new Set(['Income', 'Other Income']);
const QBO_EXPENSE_TYPES = new Set(['Expense', 'Other Expense', 'Cost of Goods Sold']);

function mapQboAccountType(qboType) {
  if (QBO_ASSET_TYPES.has(qboType)) return 'asset';
  if (QBO_LIABILITY_TYPES.has(qboType)) return 'liability';
  if (QBO_EQUITY_TYPES.has(qboType)) return 'equity';
  if (QBO_INCOME_TYPES.has(qboType)) return 'income';
  if (QBO_EXPENSE_TYPES.has(qboType)) return 'expense';
  return null;
}

// Builds this company's real chart of accounts straight from live QuickBooks
// -- the exact same getFinancials('accounts') call reference-data.js already
// uses to populate the real "QBO expense account" / bank-account dropdowns
// on Expense Entry and Purchase Orders. An account id returned here is
// always a real, live QBO account id, so a real submitted expense's
// qboAccountId always resolves against it. Throws rather than silently
// falling back to the placeholder chart above -- a silent fallback here is
// exactly the bug this exists to fix, so a failure needs to be loud.
export async function realChartOfAccountsFromQbo() {
  const result = await getFinancials('accounts');
  if (result?.error) throw new Error(`Could not load the real QuickBooks chart of accounts: ${result.error}`);
  const accounts = (result?.accounts || [])
    .map(a => ({ id: String(a.id), name: a.name, type: mapQboAccountType(a.type) }))
    .filter(a => a.type);
  if (!accounts.length) throw new Error('QuickBooks returned no usable accounts (with a recognized asset/liability/equity/income/expense type) to build the general ledger from.');
  return accounts;
}

// Rebuilds a company's chart of accounts from live QuickBooks, replacing
// whatever it currently has (the placeholder list on first provisioning, or
// a prior real pull if QuickBooks's own chart has changed since). Guarded,
// on purpose, against ever running on a company that already has real
// activity: reseeding accounts out from under posted or pending journal
// entries would break their account references, so this refuses outright if
// any entry already exists. That makes this safe to expose to an admin as a
// one-click "sync with QuickBooks" action without needing a human to first
// verify the ledger is empty -- the function verifies it.
export async function reseedAccountsFromQbo(companyId) {
  const accounts = await realChartOfAccountsFromQbo();
  const accountsById = Object.fromEntries(accounts.map(a => [a.id, { active: true, normalBalance: ['asset', 'expense'].includes(a.type) ? 'debit' : 'credit', ...a }]));
  let outcome = null;
  await updateSystem(companyId, system => {
    const company = system.ledger.companies[companyId];
    if (!company) throw new Error(`No ledger company found for ${companyId}. It needs to be accessed once (which auto-provisions it) before its accounts can be synced.`);
    const entryCount = (company.entries || []).length;
    if (entryCount > 0) {
      throw new Error(`Refusing to sync accounts: this company already has ${entryCount} posted or pending journal entr${entryCount === 1 ? 'y' : 'ies'} keyed to its current chart of accounts. Reseeding now would break those entries' account references -- this needs a real remap, not an automatic sync.`);
    }
    company.accounts = accountsById;
    outcome = { companyId, accountCount: accounts.length };
    return system;
  }, 'HiveLogic');
  return outcome;
}

async function provisionedSystem(companyId, companyName) {
  const { createLedger, addCompany } = await _load_ledger();
  const { createControlStore } = await _load_controls();
  const ledger = createLedger();
  addCompany(ledger, { id: companyId, name: companyName, basis: 'accrual', accounts: defaultChartOfAccounts() }, { id: 'system', role: 'controller' });
  return { ledger, controls: createControlStore() };
}

// ---------------------------------------------------------------------------
// memory backend
// ---------------------------------------------------------------------------
let memoryStore = null;
function memGetStore() {
  if (!memoryStore) memoryStore = { systems: {} };
  return memoryStore;
}

// ---------------------------------------------------------------------------
// durable backend -- single versioned jsonb row per company in
// `ledger_systems` (see sql/011_ledger.sql).
// ---------------------------------------------------------------------------
async function durableGetSystem(companyId, companyName) {
  const res = await supabaseRequest(`ledger_systems?company_id=eq.${encodeURIComponent(companyId)}&select=*`);
  if (!res.ok) throw new Error(`Could not read the ledger system: ${await res.text()}`);
  const rows = await res.json();
  if (rows[0]) return { data: rows[0].data, version: rows[0].version, wasProvisioned: false };

  // First access for this company -- provision it, insert, and return.
  // wasProvisioned:true tells updateSystem() that `data` already contains
  // the "company.created" audit event that await provisionedSystem() just
  // generated -- without that flag, the diff baseline used to find "what's
  // new since we last recorded it" would itself already include that first
  // event, and it would never make it into the independent audit log.
  const data = await provisionedSystem(companyId, companyName);
  const insertRes = await supabaseRequest('ledger_systems', {
    method: 'POST',
    headers: { Prefer: 'return=representation,resolution=ignore-duplicates' },
    body: JSON.stringify([{ company_id: companyId, data, version: 1 }])
  });
  if (!insertRes.ok) throw new Error(`Could not provision the ledger system: ${await insertRes.text()}`);
  const inserted = await insertRes.json();
  if (inserted[0]) return { data: inserted[0].data, version: inserted[0].version, wasProvisioned: true };
  // ignore-duplicates raced with a concurrent first-access -- re-read.
  return durableGetSystem(companyId, companyName);
}

async function durableUpdateSystem(companyId, expectedVersion, nextData) {
  const res = await supabaseRequest(`ledger_systems?company_id=eq.${encodeURIComponent(companyId)}&version=eq.${expectedVersion}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ data: nextData, version: expectedVersion + 1, updated_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error(`Could not update the ledger system: ${await res.text()}`);
  const rows = await res.json();
  if (!rows.length) { const err = new Error('CONCURRENT_CONFLICT: the ledger system was modified by someone else since it was read.'); err.code = 'CONCURRENT_CONFLICT'; throw err; }
  return rows[0].data;
}

// ---------------------------------------------------------------------------
// public interface
// ---------------------------------------------------------------------------
export function storeBackend() { return BACKEND; }

export async function getSystem(companyId, companyName = 'HiveLogic') {
  if (BACKEND === 'memory') {
    const store = memGetStore();
    if (!store.systems[companyId]) store.systems[companyId] = { data: await provisionedSystem(companyId, companyName), version: 1 };
    return structuredClone(store.systems[companyId].data);
  }
  const { data } = await durableGetSystem(companyId, companyName);
  return data;
}

// mutate: (system) => nextSystem, where system = { ledger, controls }.
// Applied via compare-and-swap under the durable backend; applied directly
// (single-threaded, no race possible) under the memory backend.
const EMPTY_CHAIN_BASELINE = { ledger: { audit: [] }, controls: { events: [] } };

export async function updateSystem(companyId, mutate, companyName = 'HiveLogic') {
  if (BACKEND === 'memory') {
    const store = memGetStore();
    const isNew = !store.systems[companyId];
    if (isNew) store.systems[companyId] = { data: await provisionedSystem(companyId, companyName), version: 1 };
    // If this call is what just provisioned the company, the pre-mutate
    // baseline for "what's already been recorded in the independent log" is
    // empty -- await provisionedSystem()'s own company.created audit event is
    // itself new and must be captured, not treated as already-known.
    const before = isNew ? EMPTY_CHAIN_BASELINE : store.systems[companyId].data;
    const next = mutate(structuredClone(store.systems[companyId].data));
    store.systems[companyId] = { data: next, version: store.systems[companyId].version + 1 };
    await recordAuditAppend(companyId, before, next);
    return next;
  }

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const { data, version, wasProvisioned } = await durableGetSystem(companyId, companyName);
    const before = wasProvisioned ? EMPTY_CHAIN_BASELINE : data;
    const next = mutate(data);
    try {
      const committed = await durableUpdateSystem(companyId, version, next);
      // The primary write already succeeded at this point. A failure in the
      // independent-log append below is a real, reportable problem (it means
      // the append-only witness is now behind), but it must not be confused
      // with the primary ledger write failing -- those are different
      // failure modes with different remediation.
      await recordAuditAppend(companyId, before, committed);
      return committed;
    } catch (err) {
      if (err.code === 'CONCURRENT_CONFLICT' && attempt < MAX_CAS_RETRIES - 1) continue;
      throw err;
    }
  }
  throw new Error('Could not update the ledger system after repeated concurrent-write conflicts. Please retry.');
}

export function getStore() {
  if (BACKEND !== 'memory') throw new Error('getStore() is memory-backend-only; durable-backend callers must use the async functions above.');
  return memGetStore();
}

// ---------------------------------------------------------------------------
// Independent, append-only audit log (see sql/013_bookkeeping_audit_log.sql).
//
// The engine's two hash chains (ledger.audit, controls.events) are each
// internally self-consistent, but both live inside the one mutable jsonb
// blob `ledger_systems.data` already stores -- so verifyAuditChain()
// checking the chain against itself can't catch a wholesale rewrite of that
// blob (a rewritten chain can be made just as internally consistent as the
// real one). Every time updateSystem() appends new records to either chain,
// those records are ALSO written here, to a table the database itself
// refuses UPDATE/DELETE on. verifyAuditChainAgainstLog() below is the real
// check: does the blob's current chain match this independent witness?
// ---------------------------------------------------------------------------

function auditDiff(before, after) {
  const beforeLen = (before || []).length;
  return (after || []).slice(beforeLen).map((record, i) => ({ seq: beforeLen + i, record }));
}

let memoryAuditLog = null;
function memGetAuditLog() {
  if (!memoryAuditLog) memoryAuditLog = {};
  return memoryAuditLog;
}

async function appendAuditLog(companyId, source, newRecords) {
  if (!newRecords.length) return;
  if (BACKEND === 'memory') {
    const log = memGetAuditLog();
    const key = `${companyId}::${source}`;
    if (!log[key]) log[key] = [];
    for (const { seq, record } of newRecords) {
      if (log[key].some(r => r.seq === seq)) continue; // ignore-duplicates equivalent
      log[key].push({ seq, recordId: record.id, previousHash: record.previousHash ?? null, hash: record.hash, payload: record });
    }
    return;
  }
  const rows = newRecords.map(({ seq, record }) => ({
    company_id: companyId, source, seq, record_id: record.id,
    previous_hash: record.previousHash ?? null, hash: record.hash, payload: record
  }));
  const res = await supabaseRequest('bookkeeping_audit_log', {
    method: 'POST',
    headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
    body: JSON.stringify(rows)
  });
  // A failed audit-log write must never silently look like success -- the
  // whole point of this table is to be a trustworthy independent witness.
  if (!res.ok) throw new Error(`Could not write to the independent audit log: ${await res.text()}`);
}

async function readAuditLog(companyId, source) {
  if (BACKEND === 'memory') {
    const log = memGetAuditLog();
    return (log[`${companyId}::${source}`] || []).slice().sort((a, b) => a.seq - b.seq);
  }
  const res = await supabaseRequest(`bookkeeping_audit_log?company_id=eq.${encodeURIComponent(companyId)}&source=eq.${source}&select=seq,record_id,previous_hash,hash,payload&order=seq.asc`);
  if (!res.ok) throw new Error(`Could not read the independent audit log: ${await res.text()}`);
  const rows = await res.json();
  return rows.map(r => ({ seq: r.seq, recordId: r.record_id, previousHash: r.previous_hash, hash: r.hash, payload: r.payload }));
}

// Called by updateSystem() right after a write commits -- appends whatever
// is new in either chain to the independent log. Never allowed to make the
// primary write look like it failed: the ledger_systems write already
// succeeded by the time this runs, so a failure here is reported distinctly
// (via the thrown error's message) rather than rolled back, since there is
// no cross-table transaction available through PostgREST here.
async function recordAuditAppend(companyId, before, after) {
  const ledgerNew = auditDiff(before?.ledger?.audit, after?.ledger?.audit);
  const controlsNew = auditDiff(before?.controls?.events, after?.controls?.events);
  if (ledgerNew.length) await appendAuditLog(companyId, 'ledger', ledgerNew);
  if (controlsNew.length) await appendAuditLog(companyId, 'controls', controlsNew);
}

// The real check. Confirms the chain currently embedded in ledger_systems.data
// is not just internally self-consistent (verifyAuditChain/verifyEventChain
// already do that) but ALSO byte-for-byte identical to the independent,
// database-enforced-append-only record of every entry ever appended. Any
// divergence -- extra records, missing records, or a record whose hash
// differs -- means ledger_systems.data was altered by something other than
// updateSystem()'s normal append path.
export async function verifyAuditChainAgainstLog(companyId) {
  const data = await getSystem(companyId);
  const results = {};
  for (const source of ['ledger', 'controls']) {
    const current = source === 'ledger' ? (data.ledger?.audit || []) : (data.controls?.events || []);
    const log = await readAuditLog(companyId, source);
    const mismatches = [];
    const maxLen = Math.max(current.length, log.length);
    for (let i = 0; i < maxLen; i++) {
      const c = current[i]; const l = log[i];
      if (!c && l) { mismatches.push({ seq: i, reason: 'present in the independent log but missing from ledger_systems.data -- history may have been rewound' }); continue; }
      if (c && !l) { mismatches.push({ seq: i, reason: 'present in ledger_systems.data but never recorded in the independent log -- may have been inserted outside the normal append path' }); continue; }
      if (c.hash !== l.hash || (c.previousHash ?? null) !== (l.previousHash ?? null) || c.id !== l.recordId) {
        mismatches.push({ seq: i, reason: 'hash/id mismatch between ledger_systems.data and the independent log', current: { id: c.id, hash: c.hash }, log: { id: l.recordId, hash: l.hash } });
      }
    }
    results[source] = { valid: mismatches.length === 0, checkedRecords: maxLen, mismatches };
  }
  return { valid: results.ledger.valid && results.controls.valid, ledger: results.ledger, controls: results.controls };
}
