// test/lowes-adapter-fetch-timeout.test.mjs
// Bug fix (2026-08-07, "Lowe's scraper down account-wide"): confirmed live
// that a failing Unwrangle scrape hung for 60+ seconds before finally
// surfacing Unwrangle's own error -- neither fetch() call in lowes.js had a
// timeout. Fixed with fetchWithTimeout(), which aborts after 20s and turns
// that into a fast, clear error instead of a long hang. These tests mock
// fetch to reject with an AbortError directly (rather than waiting out a
// real 20s timer) to prove the wrapping logic itself is correct.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.UNWRANGLE_API_KEY = 'test-unwrangle-key';

test("a fetch that aborts (times out) surfaces a fast, clear message instead of the raw AbortError", async () => {
  const original = global.fetch;
  global.fetch = async (_url, opts) => {
    // Simulate what a real aborted fetch does, without waiting out the real timer.
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    throw err;
  };
  try {
    const { search } = await import('../api/_lib/adapters/lowes.js?t=' + Date.now());
    await assert.rejects(
      () => search('drywall'),
      (err) => {
        assert.match(err.message, /timed out after 20s/);
        assert.match(err.message, /try again shortly/);
        return true;
      }
    );
  } finally {
    global.fetch = original;
  }
});

test('a genuinely failed (non-timeout) fetch still surfaces its own error unchanged', async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({ error: 'boom' }) });
  try {
    const { search } = await import('../api/_lib/adapters/lowes.js?t=' + Date.now());
    await assert.rejects(() => search('drywall'), /Unwrangle error: boom/);
  } finally {
    global.fetch = original;
  }
});

test('a normal successful fetch is unaffected by the timeout wrapper', async () => {
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ success: true, results: [{ item_number: 'X1', name: 'Test Item', price: 9.99 }] }),
  });
  try {
    const { search } = await import('../api/_lib/adapters/lowes.js?t=' + Date.now());
    const result = await search('drywall');
    assert.equal(result.connected, true);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].vendor_sku, 'X1');
  } finally {
    global.fetch = original;
  }
});
