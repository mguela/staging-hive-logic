// api/bookkeeping/purchase-orders/_store.test.mjs
// Exercises the durable (Supabase/PostgREST) backend of _store.js against a
// mocked fetch — no real database or network involved. This proves the
// request shapes, the atomic-numbering round trip, and the
// optimistic-concurrency retry-on-conflict logic are correct, independent of
// having live Supabase credentials available in this environment.
//
// Run: BOOKKEEPING_PO_STORE=durable SUPABASE_URL=https://x.test SUPABASE_SERVICE_KEY=test node --test api/bookkeeping/purchase-orders/_store.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.BOOKKEEPING_PO_STORE = 'durable';
process.env.SUPABASE_URL = 'https://example.test';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

function mockFetchSequence(responses) {
  let call = 0;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body)
    };
  };
  return calls;
}

test('allocatePoNumber calls the rpc endpoint with the right scope key and returns the formatted number', async () => {
  const calls = mockFetchSequence([{ body: [{ po_number: 'PO-231-01', sequence_no: 1 }] }]);
  const { allocatePoNumber } = await import(`./_store.js?t=${Date.now()}`);
  const result = await allocatePoNumber({ companyId: 'co1', jobId: '231', companyCode: 'PO' });
  assert.equal(result.poNumber, 'PO-231-01');
  assert.match(calls[0].url, /rpc\/allocate_po_number$/);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.p_company_id, 'co1');
  assert.equal(body.p_scope_key, 'job:231');
  assert.equal(body.p_job_id, '231');
});

test('allocatePoNumber uses the general scope when no job is given', async () => {
  const calls = mockFetchSequence([{ body: [{ po_number: 'PO-GEN-0001', sequence_no: 1 }] }]);
  const { allocatePoNumber } = await import(`./_store.js?t=${Date.now()}`);
  const result = await allocatePoNumber({ companyId: 'co1' });
  assert.equal(result.poNumber, 'PO-GEN-0001');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.p_scope_key, 'general');
  assert.equal(body.p_job_id, null);
});

test('insertPurchaseOrder posts the full engine object as the data column plus indexed columns', async () => {
  const po = { id: 'po1', companyId: 'co1', poNumber: 'PO-231-01', jobId: '231', orderType: 'planned', lifecycleStatus: 'draft', notPreapproved: false };
  const calls = mockFetchSequence([{ body: [{ id: 'row1', version: 1, data: po }] }]);
  const { insertPurchaseOrder } = await import(`./_store.js?t=${Date.now()}`);
  const saved = await insertPurchaseOrder(po);
  assert.equal(saved.id, 'po1');
  assert.equal(saved.__storeVersion, 1);
  const body = JSON.parse(calls[0].options.body)[0];
  assert.equal(body.company_id, 'co1');
  assert.equal(body.po_number, 'PO-231-01');
  assert.deepEqual(body.data, po);
});

test('updatePurchaseOrder reads current version, writes WHERE version=<that value>, and returns the new row', async () => {
  const current = { id: 'po1', companyId: 'co1', poNumber: 'PO-231-01', orderType: 'planned', lifecycleStatus: 'draft' };
  const next = { ...current, lifecycleStatus: 'ordered' };
  const calls = mockFetchSequence([
    { body: [{ id: 'row1', version: 3, data: current }] }, // durableGetPurchaseOrder read
    { body: [{ id: 'row1', version: 4, data: next }] }      // durableUpdatePurchaseOrder PATCH result
  ]);
  const { updatePurchaseOrder } = await import(`./_store.js?t=${Date.now()}`);
  const result = await updatePurchaseOrder('co1', 'po1', po => ({ ...po, lifecycleStatus: 'ordered' }));
  assert.equal(result.lifecycleStatus, 'ordered');
  assert.match(calls[1].url, /version=eq\.3/);
});

test('updatePurchaseOrder retries when the PATCH returns zero rows (a concurrent writer moved first)', async () => {
  const v3 = { id: 'po1', companyId: 'co1', poNumber: 'PO-231-01', orderType: 'planned', lifecycleStatus: 'draft' };
  const v4 = { ...v3, lifecycleStatus: 'ordered' };
  const calls = mockFetchSequence([
    { body: [{ id: 'row1', version: 3, data: v3 }] },  // first read: version 3
    { body: [] },                                       // first PATCH WHERE version=3 -> 0 rows (someone else already moved it to 4)
    { body: [{ id: 'row1', version: 4, data: v4 }] },  // re-read: now version 4
    { body: [{ id: 'row1', version: 5, data: { ...v4, lifecycleStatus: 'billed' } }] } // second PATCH WHERE version=4 -> succeeds
  ]);
  const { updatePurchaseOrder } = await import(`./_store.js?t=${Date.now()}`);
  const result = await updatePurchaseOrder('co1', 'po1', po => ({ ...po, lifecycleStatus: 'billed' }));
  assert.equal(result.lifecycleStatus, 'billed');
  assert.match(calls[1].url, /version=eq\.3/);
  assert.match(calls[3].url, /version=eq\.4/);
});

// --- Round 3 correction #5: atomic multi-PO receipt matching ---------------

test('applyReceiptMatchBatch reads every PO once, then commits all of them in a single rpc/apply_po_batch_update call', async () => {
  const poA = { id: 'poA', companyId: 'co1', poNumber: 'PO-231-01', jobId: '231', orderType: 'planned', lifecycleStatus: 'ordered' };
  const poB = { id: 'poB', companyId: 'co1', poNumber: 'PO-231-02', jobId: '231', orderType: 'planned', lifecycleStatus: 'ordered' };
  const calls = mockFetchSequence([
    { body: [{ id: 'row-a', version: 2, data: poA }] },   // getPurchaseOrders read #1 (poA)
    { body: [{ id: 'row-b', version: 5, data: poB }] },   // getPurchaseOrders read #2 (poB)
    { body: [{ id: 'row-a', version: 3, data: { ...poA, lifecycleStatus: 'billed' } }, { id: 'row-b', version: 6, data: { ...poB, lifecycleStatus: 'billed' } }] } // rpc batch call
  ]);
  const { applyReceiptMatchBatch } = await import(`./_store.js?t=${Date.now()}`);
  const computeUpdates = (current) => current.map(po => ({ ...po, lifecycleStatus: 'billed' }));
  const result = await applyReceiptMatchBatch('co1', ['poA', 'poB'], computeUpdates);
  assert.equal(result.length, 2);
  assert.ok(result.every(po => po.lifecycleStatus === 'billed'));
  assert.match(calls[2].url, /rpc\/apply_po_batch_update$/);
  const body = JSON.parse(calls[2].options.body);
  assert.equal(body.p_updates.length, 2);
  assert.equal(body.p_updates[0].po_id, 'poA');
  assert.equal(body.p_updates[0].expected_version, 2);
  assert.equal(body.p_updates[1].po_id, 'poB');
  assert.equal(body.p_updates[1].expected_version, 5);
});

test('applyReceiptMatchBatch retries the WHOLE batch (re-reading every PO fresh) when the rpc call reports a concurrent conflict', async () => {
  const poA = { id: 'poA', companyId: 'co1', poNumber: 'PO-231-01', jobId: '231', orderType: 'planned', lifecycleStatus: 'ordered' };
  const poB = { id: 'poB', companyId: 'co1', poNumber: 'PO-231-02', jobId: '231', orderType: 'planned', lifecycleStatus: 'ordered' };
  const calls = mockFetchSequence([
    { body: [{ id: 'row-a', version: 2, data: poA }] },                 // attempt 1 read poA
    { body: [{ id: 'row-b', version: 5, data: poB }] },                 // attempt 1 read poB
    { ok: false, body: 'CONCURRENT_CONFLICT: purchase order poB was modified by someone else' }, // attempt 1 rpc -> conflict, whole batch rolled back
    { body: [{ id: 'row-a', version: 2, data: poA }] },                 // attempt 2 re-read poA (unchanged)
    { body: [{ id: 'row-b', version: 6, data: poB }] },                 // attempt 2 re-read poB (someone else's change is now visible)
    { body: [{ id: 'row-a', version: 3, data: { ...poA, lifecycleStatus: 'billed' } }, { id: 'row-b', version: 7, data: { ...poB, lifecycleStatus: 'billed' } }] } // attempt 2 rpc succeeds
  ]);
  const { applyReceiptMatchBatch } = await import(`./_store.js?t=${Date.now()}`);
  const computeUpdates = (current) => current.map(po => ({ ...po, lifecycleStatus: 'billed' }));
  const result = await applyReceiptMatchBatch('co1', ['poA', 'poB'], computeUpdates);
  assert.equal(result.length, 2);
  assert.ok(result.every(po => po.lifecycleStatus === 'billed'));
  // second attempt's rpc call carried the freshly re-read version (6), not the stale one (5)
  const secondRpcBody = JSON.parse(calls[5].options.body);
  assert.equal(secondRpcBody.p_updates.find(u => u.po_id === 'poB').expected_version, 6);
});

// --- Round 5 (task #25): duplicate-bill recording folded into the same
// atomic batch as the PO updates, instead of a separate later call ---------

test('applyReceiptMatchBatch (durable) passes a seenBill through as p_seen_bill on the SAME rpc call as the PO updates -- not a separate request', async () => {
  const poA = { id: 'poA', companyId: 'co1', poNumber: 'PO-231-01', jobId: '231', orderType: 'planned', lifecycleStatus: 'ordered' };
  const calls = mockFetchSequence([
    { body: [{ id: 'row-a', version: 2, data: poA }] },   // getPurchaseOrders read
    { body: [{ id: 'row-a', version: 3, data: { ...poA, lifecycleStatus: 'billed' } }] } // the ONE rpc batch call
  ]);
  const { applyReceiptMatchBatch } = await import(`./_store.js?t=${Date.now()}`);
  const computeUpdates = (current) => current.map(po => ({ ...po, lifecycleStatus: 'billed' }));
  const seenBill = { companyId: 'co1', qboVendorId: 'qbo-9', vendorName: 'Home Depot', invoiceNumber: 'INV-100', currency: 'USD', amount: 179, evidenceHash: 'hash-1', sourceTransactionId: 'receipt-1' };
  await applyReceiptMatchBatch('co1', ['poA'], computeUpdates, seenBill);
  // exactly 2 fetch calls total (one read, one rpc) -- no separate seen-bill request
  assert.equal(calls.length, 2);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.p_seen_bill.company_id, 'co1');
  assert.equal(body.p_seen_bill.invoice_number, 'INV-100');
  assert.equal(body.p_seen_bill.amount, 179);
  assert.equal(body.p_seen_bill.source_transaction_id, 'receipt-1');
});

test('applyReceiptMatchBatch (durable) sends p_seen_bill: null when there is no seen bill to record', async () => {
  const poA = { id: 'poA', companyId: 'co1', poNumber: 'PO-231-01', jobId: '231', orderType: 'planned', lifecycleStatus: 'ordered' };
  const calls = mockFetchSequence([
    { body: [{ id: 'row-a', version: 2, data: poA }] },
    { body: [{ id: 'row-a', version: 3, data: { ...poA, lifecycleStatus: 'billed' } }] }
  ]);
  const { applyReceiptMatchBatch } = await import(`./_store.js?t=${Date.now()}`);
  const computeUpdates = (current) => current.map(po => ({ ...po, lifecycleStatus: 'billed' }));
  await applyReceiptMatchBatch('co1', ['poA'], computeUpdates);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.p_seen_bill, null);
});

test('applyReceiptMatchBatch (memory) records the seenBill in the same call, idempotently on (companyId, sourceTransactionId)', async () => {
  delete process.env.BOOKKEEPING_PO_STORE;
  process.env.BOOKKEEPING_ALLOW_MEMORY_STORE = 'true';
  const { applyReceiptMatchBatch, insertPurchaseOrder, getExistingBills } = await import(`./_store.js?t=${Date.now()}`);
  const po = { id: 'poMem1', companyId: 'co-mem-seenbill', poNumber: 'PO-1', jobId: null, orderType: 'planned', lifecycleStatus: 'ordered' };
  await insertPurchaseOrder(po);
  const computeUpdates = (current) => current.map(p => ({ ...p, lifecycleStatus: 'billed' }));
  const seenBill = { invoiceNumber: 'INV-DUP', amount: 50, sourceTransactionId: 'rct-dup' };
  await applyReceiptMatchBatch('co-mem-seenbill', ['poMem1'], computeUpdates, seenBill);
  await applyReceiptMatchBatch('co-mem-seenbill', ['poMem1'], computeUpdates, seenBill); // replay -- must not duplicate the seen-bill record
  const bills = await getExistingBills('co-mem-seenbill');
  assert.equal(bills.filter(b => b.sourceTransactionId === 'rct-dup').length, 1);
  // restore durable mode for the tests that follow, which rely on the
  // module-level BOOKKEEPING_PO_STORE='durable' set at the top of this file
  process.env.BOOKKEEPING_PO_STORE = 'durable';
  delete process.env.BOOKKEEPING_ALLOW_MEMORY_STORE;
});

test('listPurchaseOrders scopes the request to the given company', async () => {
  const calls = mockFetchSequence([{ body: [] }]);
  const { listPurchaseOrders } = await import(`./_store.js?t=${Date.now()}`);
  await listPurchaseOrders('co1');
  assert.match(calls[0].url, /company_id=eq\.co1/);
});

test('memory backend still works when BOOKKEEPING_PO_STORE is unset (default), untouched by the durable tests above', async () => {
  delete process.env.BOOKKEEPING_PO_STORE;
  // Round 3 correction #2: memory mode now requires an explicit
  // development/test flag rather than being a silent default -- set it here
  // so this test still exercises the (now opt-in) memory path.
  process.env.BOOKKEEPING_ALLOW_MEMORY_STORE = 'true';
  const mod = await import(`./_store.js?t=${Date.now()}`);
  assert.equal(mod.storeBackend(), 'memory');
  const po = { id: 'mem1', companyId: 'coX', poNumber: 'PO-GEN-0001' };
  await mod.insertPurchaseOrder(po);
  const list = await mod.listPurchaseOrders('coX');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'mem1');
});

// --- Round 3 correction #2: fail-closed store selection ---------------------

test('FAIL CLOSED: memory mode is refused without an explicit dev/test flag', async () => {
  delete process.env.BOOKKEEPING_PO_STORE;
  delete process.env.BOOKKEEPING_ALLOW_MEMORY_STORE;
  delete process.env.NODE_ENV;
  delete process.env.VERCEL_ENV;
  await assert.rejects(
    () => import(`./_store.js?t=${Date.now()}`),
    /FAIL_CLOSED.*memory-mode/s
  );
});

test('FAIL CLOSED: production refuses memory mode even if requested', async () => {
  process.env.VERCEL_ENV = 'production';
  delete process.env.BOOKKEEPING_PO_STORE;
  try {
    await assert.rejects(
      () => import(`./_store.js?t=${Date.now()}`),
      /FAIL_CLOSED.*production/s
    );
  } finally {
    delete process.env.VERCEL_ENV;
  }
});

test('FAIL CLOSED: production with durable storage still refuses to start without migration confirmation', async () => {
  process.env.VERCEL_ENV = 'production';
  process.env.BOOKKEEPING_PO_STORE = 'durable';
  delete process.env.BOOKKEEPING_PO_MIGRATION_CONFIRMED;
  try {
    await assert.rejects(
      () => import(`./_store.js?t=${Date.now()}`),
      /FAIL_CLOSED.*BOOKKEEPING_PO_MIGRATION_CONFIRMED/s
    );
  } finally {
    delete process.env.VERCEL_ENV;
  }
});

test('production starts cleanly on durable storage once BOOKKEEPING_PO_MIGRATION_CONFIRMED=true is set', async () => {
  process.env.VERCEL_ENV = 'production';
  process.env.BOOKKEEPING_PO_STORE = 'durable';
  process.env.BOOKKEEPING_PO_MIGRATION_CONFIRMED = 'true';
  try {
    const mod = await import(`./_store.js?t=${Date.now()}`);
    assert.equal(mod.storeBackend(), 'durable');
  } finally {
    delete process.env.VERCEL_ENV;
    delete process.env.BOOKKEEPING_PO_MIGRATION_CONFIRMED;
  }
});

// --- Round 3 correction #9: po_seen_bills shape normalization -------------

test('getExistingBills (durable) maps snake_case rows to the camelCase shape detectExceptions expects', async () => {
  process.env.BOOKKEEPING_PO_STORE = 'durable';
  mockFetchSequence([{
    body: [{
      id: 'row-1', company_id: 'greenwich-handyman', qbo_vendor_id: 'qbo-9', vendor_name: 'Home Depot',
      invoice_number: 'INV-100', currency: 'USD', amount: 179, evidence_hash: 'hash-1',
      source_transaction_id: 'receipt-1', created_at: '2026-07-21T00:00:00Z'
    }]
  }]);
  const { getExistingBills } = await import(`./_store.js?t=${Date.now()}`);
  const bills = await getExistingBills('greenwich-handyman');
  assert.equal(bills.length, 1);
  assert.deepEqual(bills[0], {
    companyId: 'greenwich-handyman', qboVendorId: 'qbo-9', vendorName: 'Home Depot',
    invoiceNumber: 'INV-100', currency: 'USD', amount: 179, evidenceHash: 'hash-1',
    sourceTransactionId: 'receipt-1'
  });
});

test('recordSeenBill (durable) posts with the on_conflict/ignore-duplicates idempotency headers and the amount/vendor_name columns', async () => {
  process.env.BOOKKEEPING_PO_STORE = 'durable';
  const calls = mockFetchSequence([{ body: [] }]);
  const { recordSeenBill } = await import(`./_store.js?t=${Date.now()}`);
  await recordSeenBill('greenwich-handyman', { qboVendorId: 'qbo-9', vendorName: 'Home Depot', invoiceNumber: 'INV-100', currency: 'USD', amount: 179, evidenceHash: 'hash-1', sourceTransactionId: 'receipt-1' });
  assert.match(calls[0].url, /po_seen_bills\?on_conflict=company_id,source_transaction_id/);
  assert.equal(calls[0].options.headers.Prefer, 'resolution=ignore-duplicates');
  const body = JSON.parse(calls[0].options.body)[0];
  assert.equal(body.amount, 179);
  assert.equal(body.vendor_name, 'Home Depot');
  assert.equal(body.source_transaction_id, 'receipt-1');
});

test('recordSeenBill (memory) is idempotent on (companyId, sourceTransactionId) -- recording the same receipt twice does not duplicate it', async () => {
  delete process.env.BOOKKEEPING_PO_STORE;
  process.env.BOOKKEEPING_ALLOW_MEMORY_STORE = 'true';
  const { recordSeenBill, getExistingBills } = await import(`./_store.js?t=${Date.now()}`);
  const bill = { qboVendorId: 'qbo-9', vendorName: 'Home Depot', invoiceNumber: 'INV-100', currency: 'USD', amount: 179, sourceTransactionId: 'receipt-dup-1' };
  await recordSeenBill('co-dup-test', bill);
  await recordSeenBill('co-dup-test', bill); // replay -- must be a no-op, not a second row
  const bills = await getExistingBills('co-dup-test');
  assert.equal(bills.length, 1, 'recording the same receipt twice must not create a duplicate seen-bill record');
});

test('getExistingBills (memory) is scoped to the requested company -- another company\'s bills never leak in', async () => {
  delete process.env.BOOKKEEPING_PO_STORE;
  process.env.BOOKKEEPING_ALLOW_MEMORY_STORE = 'true';
  const { recordSeenBill, getExistingBills } = await import(`./_store.js?t=${Date.now()}`);
  await recordSeenBill('co-scope-a', { invoiceNumber: 'INV-A', amount: 10, sourceTransactionId: 'rct-a' });
  await recordSeenBill('co-scope-b', { invoiceNumber: 'INV-B', amount: 20, sourceTransactionId: 'rct-b' });
  const billsA = await getExistingBills('co-scope-a');
  assert.equal(billsA.length, 1);
  assert.equal(billsA[0].invoiceNumber, 'INV-A');
});
