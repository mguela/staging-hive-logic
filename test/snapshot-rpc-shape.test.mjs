// NOTE: run with  node --experimental-test-module-mocks --test test/snapshot-rpc-shape.test.mjs
// Verifies api/snapshot.js (snapshot_aggregates RPC rework, 2026-07-30) calls
// the RPC once via POST and passes the DB's aggregate object through untouched.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const DB_RESULT = {
  counts: { clients: 8667, activeClients: 8633, leads: 338, jobs: 2740, invoices: 2788 },
  jobsByStatus: { archived: 2652, requires_invoicing: 19, action_required: 18 },
  ar: {
    openInvoices: 43, outstanding: 323244.12, overdueCount: 35,
    excluded: {
      draftUnsent: { count: 5, amount: 7902.72 },
      writtenOffBadDebt: { count: 15, amount: 104140.29 },
      markedPaid: { count: 390, amount: 1243010.5 },
    },
  },
};

const calls = [];
mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path, options) => {
      calls.push({ path, options });
      return { ok: true, json: async () => DB_RESULT };
    },
  },
});
mock.module('../api/_lib/auth.js', {
  namedExports: { requireUser: async () => ({ id: 'u1' }) },
});

const { getSnapshotData } = await import('../api/snapshot.js');

test('one POST to rpc/snapshot_aggregates, result passed through', async () => {
  const snap = await getSnapshotData();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'rpc/snapshot_aggregates');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(snap, DB_RESULT);
  // legacy top-level shape keys intact
  assert.deepEqual(Object.keys(snap), ['counts', 'jobsByStatus', 'ar']);
  assert.deepEqual(Object.keys(snap.counts), ['clients','activeClients','leads','jobs','invoices']);
  assert.deepEqual(Object.keys(snap.ar), ['openInvoices','outstanding','overdueCount','excluded']);
});
