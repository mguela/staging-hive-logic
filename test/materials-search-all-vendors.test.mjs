// test/materials-search-all-vendors.test.mjs
// Vendor Catalog "All Vendors" search (2026-08-11): api/track1.js's
// materials_search resource, given ?vendor=all, now fans out to every
// adapter with connectorType 'api' (the only ones with a live search
// endpoint -- punchout/feed connectors like Ferguson/Ring's End have none,
// see their own adapter headers) and merges the results. One adapter
// throwing must never take down the others (Promise.allSettled), and the
// response's perVendor breakdown must report exactly what happened per
// source rather than silently hiding a failure.
// Run with: node --experimental-test-module-mocks --test test/materials-search-all-vendors.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async () => ({ ok: true, json: async () => [] }),
    jobberGraphQL: async () => ({}),
  },
});

const ADAPTERS = {
  homedepot: {
    connectorType: 'api',
    label: 'Home Depot',
    module: {
      search: async () => ({ connected: true, results: [{ vendor_key: 'homedepot', vendor_title: '2x4x8 Stud', unit_price: 4.27 }] }),
    },
  },
  lowes: {
    connectorType: 'api',
    label: "Lowe's",
    module: {
      search: async () => { throw new Error('Unwrangle timed out'); },
    },
  },
  ferguson: {
    connectorType: 'punchout',
    label: 'Ferguson',
    module: {
      search: async () => ({ connected: true, applicable: false, results: [{ vendor_key: 'ferguson', vendor_title: 'should never appear' }] }),
    },
  },
};

mock.module('../api/_lib/adapters/index.js', {
  namedExports: {
    ADAPTERS,
    getAdapter: (key) => ADAPTERS[key] || null,
    listAdapters: () => [],
  },
});

const trackMod = await import('../api/track1.js');

function res() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function callSearch(query, vendor) {
  const req = {
    method: 'GET',
    query: { resource: 'materials_search', query, vendor },
    headers: { authorization: 'Bearer test-cron-secret' },
  };
  const r = res();
  await trackMod.default(req, r);
  return r;
}

test('vendor=all merges results across every "api" adapter, skips punchout/feed connectors entirely', async () => {
  const r = await callSearch('2x4 lumber', 'all');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.vendor, 'all');
  const vendorKeysInResults = r.body.results.map((x) => x.vendor_key);
  assert.ok(vendorKeysInResults.includes('homedepot'));
  assert.ok(!vendorKeysInResults.includes('ferguson'), 'Ferguson (punchout, no live search) must never appear in All Vendors results');
});

test('vendor=all is resilient: one adapter throwing does not block the others or 500 the request', async () => {
  const r = await callSearch('2x4 lumber', 'all');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  const homedepotEntry = r.body.perVendor.find((v) => v.vendor === 'homedepot');
  const lowesEntry = r.body.perVendor.find((v) => v.vendor === 'lowes');
  assert.equal(homedepotEntry.connected, true);
  assert.equal(homedepotEntry.count, 1);
  assert.equal(lowesEntry.connected, false);
  assert.match(lowesEntry.error, /Unwrangle timed out/);
});

test('vendor=all reports connected:true overall as long as at least one adapter succeeded', async () => {
  const r = await callSearch('2x4 lumber', 'all');
  assert.equal(r.body.connected, true);
});

test('a single-vendor search (vendor=homedepot, the default) is unaffected -- still goes through getAdapter, not the aggregate path', async () => {
  const r = await callSearch('2x4 lumber', 'homedepot');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.vendor, 'homedepot');
  assert.equal(r.body.perVendor, undefined);
});
