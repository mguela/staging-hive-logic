// api/bookkeeping/ledger/_store.test.mjs
// Exercises the durable (Supabase/PostgREST) backend of _store.js against a
// mocked fetch — no real database or network involved. Proves the request
// shapes and optimistic-concurrency retry logic are correct, and that the
// memory backend auto-provisions + persists correctly for local/test use.
//
// Run: BOOKKEEPING_PO_STORE=durable SUPABASE_URL=https://x.test SUPABASE_SERVICE_KEY=test node --test api/bookkeeping/ledger/_store.test.mjs
//
// The two realChartOfAccountsFromQbo()/reseedAccountsFromQbo() tests below
// additionally require --experimental-test-module-mocks (to stub the real
// api/qbo/index.js import with a fake QuickBooks accounts response):
// node --experimental-test-module-mocks --test api/bookkeeping/ledger/_store.test.mjs

import { test, mock } from 'node:test';
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

test('getSystem (durable) reads an existing row and returns its data', async () => {
  const fakeData = { ledger: { version: 1, companies: { co1: { id: 'co1' } }, audit: [] }, controls: { approvals: [], qboOutbox: [], events: [] } };
  const calls = mockFetchSequence([{ body: [{ data: fakeData, version: 4 }] }]);
  const { getSystem } = await import(`./_store.js?t=${Date.now()}`);
  const data = await getSystem('co1');
  assert.deepEqual(data, fakeData);
  assert.match(calls[0].url, /ledger_systems\?company_id=eq\.co1/);
});

test('getSystem (durable) provisions a new company on first access when no row exists', async () => {
  const calls = mockFetchSequence([
    { body: [] }, // no existing row
    { body: [{ data: 'PROVISIONED', version: 1 }] } // insert response
  ]);
  const { getSystem } = await import(`./_store.js?t=${Date.now()}`);
  const data = await getSystem('co-new', 'New Co');
  assert.equal(data, 'PROVISIONED');
  assert.match(calls[0].url, /company_id=eq\.co-new/);
  assert.match(calls[1].url, /ledger_systems$/);
  const insertBody = JSON.parse(calls[1].options.body);
  assert.equal(insertBody[0].company_id, 'co-new');
  assert.equal(insertBody[0].version, 1);
});

test('updateSystem (durable) reads current version, writes WHERE version=<that value>, and returns the new data', async () => {
  const before = { ledger: { version: 1, companies: {}, audit: [] }, controls: { approvals: [], qboOutbox: [], events: [] } };
  const after = { ...before, controls: { approvals: [{ id: 'a1' }], qboOutbox: [], events: [] } };
  const calls = mockFetchSequence([
    { body: [{ data: before, version: 7 }] }, // read
    { body: [{ data: after, version: 8 }] }   // patch response
  ]);
  const { updateSystem } = await import(`./_store.js?t=${Date.now()}`);
  const result = await updateSystem('co1', system => ({ ...system, controls: { ...system.controls, approvals: [{ id: 'a1' }] } }));
  assert.deepEqual(result, after);
  assert.match(calls[1].url, /version=eq\.7/);
  const patchBody = JSON.parse(calls[1].options.body);
  assert.equal(patchBody.version, 8);
});

test('updateSystem (durable) retries the whole read-compute-write cycle on a concurrent-write conflict', async () => {
  const before = { ledger: { version: 1, companies: {}, audit: [] }, controls: { approvals: [], qboOutbox: [], events: [] } };
  const laterBefore = { ...before, controls: { approvals: [{ id: 'someone-else' }], qboOutbox: [], events: [] } };
  const after = { ...laterBefore, controls: { ...laterBefore.controls, approvals: [...laterBefore.controls.approvals, { id: 'mine' }] } };
  const calls = mockFetchSequence([
    { body: [{ data: before, version: 3 }] },        // attempt 1 read
    { body: [] },                                     // attempt 1 patch -> zero rows = conflict
    { body: [{ data: laterBefore, version: 4 }] },    // attempt 2 re-read (someone else's change now visible)
    { body: [{ data: after, version: 5 }] }           // attempt 2 patch succeeds
  ]);
  const { updateSystem } = await import(`./_store.js?t=${Date.now()}`);
  const result = await updateSystem('co1', system => ({ ...system, controls: { ...system.controls, approvals: [...system.controls.approvals, { id: 'mine' }] } }));
  assert.deepEqual(result, after);
  assert.match(calls[3].url, /version=eq\.4/);
});

test('memory backend auto-provisions a company with the default chart of accounts on first access', async () => {
  delete process.env.BOOKKEEPING_PO_STORE;
  process.env.BOOKKEEPING_ALLOW_MEMORY_STORE = 'true';
  const { getSystem, defaultChartOfAccounts } = await import(`./_store.js?t=${Date.now()}`);
  const data = await getSystem('co-mem', 'Memory Co');
  const company = data.ledger.companies['co-mem'];
  assert.ok(company);
  assert.equal(company.name, 'Memory Co');
  assert.equal(Object.keys(company.accounts).length, defaultChartOfAccounts().length);
  process.env.BOOKKEEPING_PO_STORE = 'durable';
  delete process.env.BOOKKEEPING_ALLOW_MEMORY_STORE;
});

test('memory backend persists mutations across calls for the same company', async () => {
  delete process.env.BOOKKEEPING_PO_STORE;
  process.env.BOOKKEEPING_ALLOW_MEMORY_STORE = 'true';
  const { getSystem, updateSystem } = await import(`./_store.js?t=${Date.now()}`);
  await updateSystem('co-persist', system => { system.controls.events.push({ id: 'e1' }); return system; });
  const data = await getSystem('co-persist');
  assert.equal(data.controls.events.length, 1);
  process.env.BOOKKEEPING_PO_STORE = 'durable';
  delete process.env.BOOKKEEPING_ALLOW_MEMORY_STORE;
});

test('reseedAccountsFromQbo builds a real chart of accounts from live QuickBooks and refuses once the company has any entry', async () => {
  delete process.env.BOOKKEEPING_PO_STORE;
  process.env.BOOKKEEPING_ALLOW_MEMORY_STORE = 'true';
  let mockAccounts = [
    { id: '35', name: 'Checking', type: 'Bank', balance: 1000 },
    { id: '80', name: 'Job Materials (Real QBO)', type: 'Expense', balance: 0 },
    { id: '12', name: 'Owner Equity (Real QBO)', type: 'Equity', balance: 0 },
    { id: '9', name: 'Unrecognized QBO Type', type: 'Some Weird Type QBO Just Added', balance: 0 }
  ];
  mock.module('../../qbo/index.js', {
    exports: { getFinancials: async () => ({ source: 'QuickBooks (test)', accounts: mockAccounts }) }
  });
  try {
    const { getSystem, reseedAccountsFromQbo, updateSystem } = await import(`./_store.js?t=${Date.now()}`);
    await getSystem('co-sync', 'Sync Co'); // auto-provisions with the placeholder chart first
    const outcome = await reseedAccountsFromQbo('co-sync');
    assert.equal(outcome.accountCount, 3); // the unrecognized QBO type is dropped, not guessed at
    const after = await getSystem('co-sync');
    const accounts = after.ledger.companies['co-sync'].accounts;
    assert.equal(Object.keys(accounts).length, 3);
    assert.equal(accounts['35'].name, 'Checking');
    assert.equal(accounts['35'].type, 'asset');
    assert.equal(accounts['35'].normalBalance, 'debit');
    assert.equal(accounts['80'].type, 'expense');
    assert.equal(accounts['12'].type, 'equity');
    assert.equal(accounts['12'].normalBalance, 'credit');
    assert.ok(!accounts['9']);

    // Now simulate this company having a real posted/pending entry, then
    // confirm a second sync refuses rather than silently reseeding under it.
    // Same mocked module (mock.module can't be re-applied mid-test), same
    // in-memory store (no cache-busting query this time) so 'co-sync' still
    // carries the accounts just synced above.
    await updateSystem('co-sync', system => { system.ledger.companies['co-sync'].entries.push({ id: 'e1', status: 'posted' }); return system; });
    await assert.rejects(() => reseedAccountsFromQbo('co-sync'), /already has 1 posted or pending journal entry/);
  } finally {
    mock.reset();
    process.env.BOOKKEEPING_PO_STORE = 'durable';
    delete process.env.BOOKKEEPING_ALLOW_MEMORY_STORE;
  }
});

test('realChartOfAccountsFromQbo throws (never falls back silently) when QuickBooks reports an error', async () => {
  mock.module('../../qbo/index.js', { exports: { getFinancials: async () => ({ error: 'QuickBooks is not connected yet. Visit /api/qbo to authorize.' }) } });
  const { realChartOfAccountsFromQbo } = await import(`./_store.js?t=${Date.now()}`);
  await assert.rejects(() => realChartOfAccountsFromQbo(), /not connected/);
  mock.reset();
});

test('FAIL CLOSED: memory mode is refused without an explicit dev/test flag', async () => {
  delete process.env.BOOKKEEPING_PO_STORE;
  delete process.env.BOOKKEEPING_ALLOW_MEMORY_STORE;
  delete process.env.NODE_ENV;
  delete process.env.VERCEL_ENV;
  await assert.rejects(() => import(`./_store.js?t=${Date.now()}`), /FAIL_CLOSED.*memory-mode/s);
  process.env.BOOKKEEPING_PO_STORE = 'durable';
});
