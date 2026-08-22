// api/bookkeeping/_sales_tax_store.js
//
// Dual-backend store for manually-logged sales-tax entries (see
// sql/026_bookkeeping_sales_tax.sql for why this is a manual log, not an
// automatic feed). Same fail-closed convention as every other bookkeeping
// store: memory by default, durable opt-in behind
// BOOKKEEPING_SALES_TAX_STORE=durable, production requires durable +
// BOOKKEEPING_SALES_TAX_MIGRATION_CONFIRMED === 'true'. Outside
// production, memory mode requires NODE_ENV=test or
// BOOKKEEPING_ALLOW_MEMORY_STORE=true.
//
// Entries are append-only: "deleting" one sets status='void' rather than
// removing the row, so a mistaken entry leaves an honest trail instead of
// silently disappearing from what could become part of a real tax filing.

import { supabaseRequest } from '../_lib/jobber.js';
import { randomUUID } from 'node:crypto';

function resolveBackend() {
  const requested = process.env.BOOKKEEPING_SALES_TAX_STORE === 'durable' ? 'durable' : 'memory';
  const isProduction = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';

  if (isProduction) {
    if (requested !== 'durable') {
      throw new Error(
        'FAIL_CLOSED: this is a production environment and BOOKKEEPING_SALES_TAX_STORE is not set to "durable". ' +
        'Refusing to start on in-memory sales-tax storage in production -- real tax-collected/tax-remitted ' +
        'records would silently vanish on every cold start. Set BOOKKEEPING_SALES_TAX_STORE=durable after ' +
        'running sql/026_bookkeeping_sales_tax.sql against the real Supabase project.'
      );
    }
    if (process.env.BOOKKEEPING_SALES_TAX_MIGRATION_CONFIRMED !== 'true') {
      throw new Error(
        'FAIL_CLOSED: production is configured for durable sales-tax storage, but ' +
        'BOOKKEEPING_SALES_TAX_MIGRATION_CONFIRMED is not "true". Set that flag only after you have personally ' +
        'run sql/026_bookkeeping_sales_tax.sql against this environment\'s real Supabase project.'
      );
    }
    return 'durable';
  }

  if (requested === 'memory') {
    const allowMemory = process.env.NODE_ENV === 'test' || process.env.BOOKKEEPING_ALLOW_MEMORY_STORE === 'true';
    if (!allowMemory) {
      throw new Error(
        'FAIL_CLOSED: memory-mode sales-tax storage requires an explicit development/test flag. ' +
        'Set BOOKKEEPING_ALLOW_MEMORY_STORE=true for local/demo use, or run under NODE_ENV=test for automated tests.'
      );
    }
  }
  return requested;
}

const BACKEND = resolveBackend();

// ---------------------------------------------------------------------------
// memory backend
// ---------------------------------------------------------------------------
const memEntriesByCompany = {};
function memEntries(companyId) {
  return memEntriesByCompany[companyId] || (memEntriesByCompany[companyId] = []);
}

// ---------------------------------------------------------------------------
// durable backend
// ---------------------------------------------------------------------------
function rowToEntry(row) {
  return { ...row.data, id: row.id, kind: row.kind, taxState: row.tax_state, date: row.entry_date, status: row.status, createdBy: row.created_by || null, createdAt: row.created_at, updatedAt: row.updated_at };
}

async function durableListEntries(companyId) {
  const res = await supabaseRequest(`bookkeeping_sales_tax_entries?company_id=eq.${encodeURIComponent(companyId)}&select=*&order=entry_date.desc`);
  if (!res.ok) throw new Error(`Could not list sales-tax entries: ${await res.text()}`);
  const rows = await res.json();
  return rows.map(rowToEntry);
}

async function durableInsertEntry(companyId, entry, createdBy) {
  const res = await supabaseRequest('bookkeeping_sales_tax_entries', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      id: randomUUID(),
      company_id: companyId,
      kind: entry.kind,
      tax_state: entry.taxState,
      entry_date: entry.date,
      status: 'active',
      created_by: createdBy || null,
      data: entry.kind === 'collected'
        ? { taxableAmount: entry.taxableAmount, exemptAmount: entry.exemptAmount, taxCollected: entry.taxCollected, jobRef: entry.jobRef || null, note: entry.note || '' }
        : { amount: entry.amount, note: entry.note || '' }
    }])
  });
  if (!res.ok) throw new Error(`Could not save this sales-tax entry: ${await res.text()}`);
  const rows = await res.json();
  return rowToEntry(rows[0]);
}

async function durableVoidEntry(companyId, id) {
  const res = await supabaseRequest(
    `bookkeeping_sales_tax_entries?company_id=eq.${encodeURIComponent(companyId)}&id=eq.${encodeURIComponent(id)}`,
    { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'void', updated_at: new Date().toISOString() }) }
  );
  if (!res.ok) throw new Error(`Could not void this sales-tax entry: ${await res.text()}`);
  const rows = await res.json();
  return rows.length ? rowToEntry(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------
export function storeBackend() {
  return BACKEND;
}

export async function listSalesTaxEntries(companyId) {
  if (BACKEND === 'memory') return memEntries(companyId).slice();
  return durableListEntries(companyId);
}

// input: { kind: 'collected'|'remitted', taxState, date, ...kind-specific fields }
export async function recordSalesTaxEntry(companyId, input, actor) {
  const kind = input?.kind;
  if (!['collected', 'remitted'].includes(kind)) throw new Error('kind must be "collected" or "remitted".');
  const taxState = String(input.taxState || '').trim().toUpperCase();
  if (!taxState) throw new Error('taxState is required.');
  const date = String(input.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be an ISO date (YYYY-MM-DD).');

  let entry;
  if (kind === 'collected') {
    const taxableAmount = Number(input.taxableAmount || 0);
    const exemptAmount = Number(input.exemptAmount || 0);
    const taxCollected = Number(input.taxCollected || 0);
    if (!Number.isFinite(taxableAmount) || !Number.isFinite(exemptAmount) || !Number.isFinite(taxCollected)) {
      throw new Error('taxableAmount, exemptAmount, and taxCollected must be finite numbers.');
    }
    if (taxableAmount < 0 || exemptAmount < 0 || taxCollected < 0) throw new Error('Amounts cannot be negative.');
    entry = { kind, taxState, date, taxableAmount, exemptAmount, taxCollected, jobRef: input.jobRef ? String(input.jobRef) : null, note: input.note ? String(input.note) : '' };
  } else {
    const amount = Number(input.amount || 0);
    if (!Number.isFinite(amount) || amount < 0) throw new Error('amount must be a non-negative, finite number.');
    entry = { kind, taxState, date, amount, note: input.note ? String(input.note) : '' };
  }

  if (BACKEND === 'memory') {
    const id = randomUUID();
    const now = new Date().toISOString();
    const record = { ...entry, id, status: 'active', createdBy: actor?.id || null, createdAt: now, updatedAt: now };
    memEntries(companyId).push(record);
    return { ...record };
  }
  return durableInsertEntry(companyId, entry, actor?.id || null);
}

export async function voidSalesTaxEntry(companyId, id) {
  if (BACKEND === 'memory') {
    const entries = memEntries(companyId);
    const found = entries.find(item => item.id === id);
    if (!found) throw new Error('Sales-tax entry not found.');
    found.status = 'void';
    found.updatedAt = new Date().toISOString();
    return { ...found };
  }
  const updated = await durableVoidEntry(companyId, id);
  if (!updated) throw new Error('Sales-tax entry not found.');
  return updated;
}
