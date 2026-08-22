// test/chat-business-data-filter.test.mjs
// 2026-08-15 (jomell/Chris): "what is the profit margin on AnnaMaria Desalva
// job?" made Reina's real chat engine (api/chat.js) hit its tool-round limit
// and give up. Root cause: get_business_data's list-with-filter used strict
// case-insensitive EQUALITY, so any filterValue that wasn't a
// character-for-character match of the stored name (different spacing or
// casing than the real client, e.g. "Anna Maria DeSalva") returned zero
// rows every single time -- Claude burned its whole tool-round budget
// retrying name-guess variations instead of ever finding the record.
// Exercises the real runBusinessData() function end-to-end; only the
// underlying data-source modules are mocked.
// Run with: node --experimental-test-module-mocks --test test/chat-business-data-filter.test.mjs

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

mock.module('../api/clients.js', {
  namedExports: {
    getClientsData: async () => ({
      clients: [
        { id: 'c1', name: 'Anna Maria DeSalva' },
        { id: 'c2', name: 'Kevin McCabe' }
      ]
    }),
  },
});
mock.module('../api/jobs.js', { namedExports: { getJobsListData: async () => ({ jobs: [] }) } });
mock.module('../api/invoices.js', { namedExports: { getInvoicesData: async () => ({ invoices: [] }) } });
mock.module('../api/snapshot.js', { namedExports: { getSnapshotData: async () => ({}) } });
mock.module('../api/qbo/index.js', { namedExports: { getFinancials: async () => ({}) } });
mock.module('../api/track1.js', { namedExports: { getTrackResourceData: async () => ({ records: [] }) } });

const { runBusinessData } = await import('../api/chat.js');

test('a partial, differently-cased name now finds the real client (previously required an exact match)', async () => {
  const result = await runBusinessData({ action: 'list', collection: 'clients', filterField: 'name', filterValue: 'annamaria desalva' });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, 'c1');
});

test('a substring of just the last name also matches', async () => {
  const result = await runBusinessData({ action: 'list', collection: 'clients', filterField: 'name', filterValue: 'desalva' });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, 'c1');
});

test('a non-matching filter still returns zero records, not everything', async () => {
  const result = await runBusinessData({ action: 'list', collection: 'clients', filterField: 'name', filterValue: 'nobody with this name' });
  assert.equal(result.records.length, 0);
});
