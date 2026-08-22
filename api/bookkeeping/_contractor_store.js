// api/bookkeeping/_contractor_store.js
//
// 2026-07-24: Reconciled with the `subcontractors` company directory
// (commit 63605ad) per Chris's decision to merge 1099/W-9 tax tracking
// directly onto that table rather than keep a second, parallel
// bookkeeping-scoped contractor concept (see sql/025's original header and
// sql/029_subcontractors_1099_merge.sql for the full history). At the time
// of this merge, bookkeeping_contractor_profiles held zero production rows
// -- Accounting Control's 1099 tracking had not yet been used for real --
// so this is a pure backend swap, not a data migration.
//
// track1099/w9OnFile/taxIdLast4/notes now live as columns on `subcontractors`
// (track_1099, w9_on_file, tax_id_last4, tax_notes -- a separate column from
// the directory's own `notes`, so editing tax notes here can never clobber
// a dispatcher's scheduling notes on the same row). Still keyed by
// normalizeCatalogTerm(vendorName) for matching against free-text vendor
// names on expenses -- exactly the same join key api/bookkeeping/
// _close_tax_adapters.js already used, so that file needs zero changes.
//
// No more memory/durable backend split: `subcontractors` is a single,
// always-live Supabase table (same as handleSubcontractors in
// api/track1.js already assumes), so the FAIL_CLOSED memory-store guard
// this file used to need for bookkeeping_contractor_profiles no longer
// applies here.
//
// Creating a brand-new profile for a vendor name that doesn't yet exist in
// the directory creates a real `subcontractors` row (status 'active', no
// trade/contact/phone/email yet) -- by design: if a vendor is being
// 1099-tracked, they're a real subcontractor the company pays, so they
// belong in the directory too, even if the office hasn't filled in their
// contact details yet.

import { supabaseRequest } from '../_lib/jobber.js';
import { randomUUID } from 'node:crypto';

let _load_catalog_cache;
async function _load_catalog() {
  if (!_load_catalog_cache) _load_catalog_cache = await import('../../server/bookkeeping/src/catalog.js');
  return _load_catalog_cache;
}

const SUB_FIELDS = 'id,name,track_1099,w9_on_file,tax_id_last4,tax_notes,created_at,updated_at';

function rowToProfile(row, vendorKey) {
  return {
    id: row.id,
    vendorKey,
    vendorName: row.name,
    track1099: !!row.track_1099,
    w9OnFile: !!row.w9_on_file,
    taxIdLast4: row.tax_id_last4 || null,
    notes: row.tax_notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ---------------------------------------------------------------------------
// Public interface (unchanged shape -- api/bookkeeping/contractors.js and
// api/bookkeeping/_close_tax_adapters.js consume this without modification)
// ---------------------------------------------------------------------------
export function storeBackend() {
  return 'subcontractors-table';
}

// companyId is accepted for interface compatibility but unused: this app
// is single-tenant (see SINGLE_TENANT_COMPANY_ID in
// api/bookkeeping/ledger/_actor.js), and `subcontractors` has no
// company_id column -- exactly the same assumption handleSubcontractors()
// in api/track1.js already makes.
export async function listContractorProfiles(_companyId) {
  const { normalizeCatalogTerm } = await _load_catalog();
  const res = await supabaseRequest(`subcontractors?select=${SUB_FIELDS}&order=name.asc`);
  if (!res.ok) throw new Error(`Could not list contractor profiles: ${await res.text()}`);
  const rows = await res.json();
  return rows.map((row) => rowToProfile(row, normalizeCatalogTerm(row.name)));
}

// input: { vendorName (required), track1099?, w9OnFile?, taxIdLast4?, notes? }
export async function saveContractorProfile(_companyId, input, actorEmail) {
  const { normalizeCatalogTerm } = await _load_catalog();
  const vendorName = String(input?.vendorName || '').trim();
  if (!vendorName) throw new Error('vendorName is required.');
  const vendorKey = normalizeCatalogTerm(vendorName);
  if (!vendorKey) throw new Error('vendorName must contain at least one letter or number.');

  const listRes = await supabaseRequest(`subcontractors?select=${SUB_FIELDS}`);
  if (!listRes.ok) throw new Error(`Could not look up existing subcontractors: ${await listRes.text()}`);
  const rows = await listRes.json();
  const existingRow = rows.find((row) => normalizeCatalogTerm(row.name) === vendorKey);

  const taxIdLast4 = input.taxIdLast4 !== undefined
    ? (input.taxIdLast4 ? String(input.taxIdLast4).slice(-4) : null)
    : (existingRow ? existingRow.tax_id_last4 : null);
  const notes = input.notes !== undefined
    ? String(input.notes || '')
    : (existingRow ? (existingRow.tax_notes || '') : '');
  const track1099 = input.track1099 != null ? !!input.track1099 : (existingRow ? !!existingRow.track_1099 : false);
  const w9OnFile = input.w9OnFile != null ? !!input.w9OnFile : (existingRow ? !!existingRow.w9_on_file : false);

  if (existingRow) {
    const updRes = await supabaseRequest(`subcontractors?id=eq.${existingRow.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        track_1099: track1099,
        w9_on_file: w9OnFile,
        tax_id_last4: taxIdLast4,
        tax_notes: notes,
        updated_by: actorEmail || null,
        updated_at: new Date().toISOString()
      })
    });
    if (!updRes.ok) throw new Error(`Could not update this contractor profile: ${await updRes.text()}`);
    const updated = await updRes.json();
    return { profile: rowToProfile(updated[0], vendorKey), created: false };
  }

  const insRes = await supabaseRequest('subcontractors', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      id: randomUUID(),
      name: vendorName,
      status: 'active',
      track_1099: track1099,
      w9_on_file: w9OnFile,
      tax_id_last4: taxIdLast4,
      tax_notes: notes,
      created_by: actorEmail || null,
      updated_by: actorEmail || null
    })
  });
  if (!insRes.ok) throw new Error(`Could not save this contractor profile: ${await insRes.text()}`);
  const created = await insRes.json();
  return { profile: rowToProfile(created[0], vendorKey), created: true };
}
