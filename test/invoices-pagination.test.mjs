// test/invoices-pagination.test.mjs
// api/invoices.js's getInvoicesData() silently truncated to PostgREST's own
// default 1000-row cap regardless of a higher ?limit= -- same issue already
// documented/fixed in track1.js's fiFetchAllRows for this same `invoices`
// table (~2,700+ rows). Discovered while trying to verify a "$1.24M paid-
// but-underpaid across 390 invoices" tracker claim: the first 1000 rows
// (most recent, since order=issued_date.desc) silently hid ~1,800 older
// invoices from any caller asking for more.
// Fully mocked -- no network, no DB, no real secret.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

function makeInvoice(i) {
  return { jobber_id: 'inv-' + i, client_id: 'c1', invoice_number: String(i), invoice_status: 'paid', subject: 's', total: 100, payments: 100, due_date: null, issued_date: '2026-01-01', jobber_web_uri: 'https://x' };
}

test('getInvoicesData pages past PostgREST\'s 1000-row cap to fetch the full requested limit', async () => {
  const TOTAL_REAL_ROWS = 2810; // matches this table's real approximate size
  const allRows = Array.from({ length: TOTAL_REAL_ROWS }, (_, i) => makeInvoice(i));

  const original = global.fetch;
  const seenOffsets = [];
  global.fetch = async (url) => {
    const u = new URL(String(url));
    const limit = Number(u.searchParams.get('limit'));
    const offset = Number(u.searchParams.get('offset')) || 0;
    seenOffsets.push(offset);
    const page = allRows.slice(offset, offset + limit);
    const end = Math.min(offset + limit, TOTAL_REAL_ROWS) - 1;
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => h.toLowerCase() === 'content-range' ? `${offset}-${end}/${TOTAL_REAL_ROWS}` : null },
      json: async () => page,
      text: async () => JSON.stringify(page),
    };
  };

  try {
    const { getInvoicesData } = await import('../api/invoices.js');
    const data = await getInvoicesData({ limit: 2810 });
    assert.equal(data.totalCount, TOTAL_REAL_ROWS, 'totalCount should reflect the real row count from content-range');
    assert.equal(data.returned, TOTAL_REAL_ROWS, 'returned should be the FULL requested set, not capped at 1000');
    assert.equal(data.invoices.length, TOTAL_REAL_ROWS);
    // 3 pages: 0, 1000, 2000 (last page short at 810 rows -> loop stops there)
    assert.deepEqual(seenOffsets, [0, 1000, 2000]);
  } finally {
    global.fetch = original;
  }
});

test('getInvoicesData still respects a small requested limit (does not over-fetch)', async () => {
  const allRows = Array.from({ length: 200 }, (_, i) => makeInvoice(i));
  const original = global.fetch;
  let callCount = 0;
  global.fetch = async (url) => {
    callCount++;
    const u = new URL(String(url));
    const limit = Number(u.searchParams.get('limit'));
    const offset = Number(u.searchParams.get('offset')) || 0;
    const page = allRows.slice(offset, offset + limit);
    return {
      ok: true, status: 200,
      headers: { get: (h) => h.toLowerCase() === 'content-range' ? `${offset}-${offset + page.length - 1}/200` : null },
      json: async () => page,
      text: async () => JSON.stringify(page),
    };
  };
  try {
    const { getInvoicesData } = await import('../api/invoices.js');
    const data = await getInvoicesData({ limit: 50 });
    assert.equal(data.returned, 50);
    assert.equal(callCount, 1, 'a request within one 1000-row chunk should only make one call');
  } finally {
    global.fetch = original;
  }
});
