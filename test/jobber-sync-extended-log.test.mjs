// test/jobber-sync-extended-log.test.mjs
// Bug fix (2026-08-07): api/jobber/sync.js has always written a sync_log row
// every run; api/jobber/sync-extended.js never did, so a stalled/failing
// extended sync (discovered live: quiet since 2026-08-06 18:45 UTC) was only
// detectable by manually diffing synced_at across its 8 tables by hand.
// sql/063 adds source/details columns to sync_log; this file proves
// sync-extended.js now writes one, and that a failure to write it never
// turns a real sync result into an error response (best-effort, same
// standard as sync.js's own external_refs write).
// Fully mocked -- no network, no DB, no real Jobber/Supabase credentials.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

function jsonRes(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: { get: (h) => headers[h.toLowerCase()] || null },
  };
}

const req = () => ({ method: 'GET', query: { resource: 'quotes' }, headers: { authorization: 'Bearer test-cron-secret' } });
const res = () => ({ statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

test('a clean quotes sync writes a sync_log row with source=sync_extended and per-resource details', async () => {
  const logCalls = [];
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.includes('/rest/v1/integrations')) {
      return jsonRes([{ access_token: 'plaintext-token', refresh_token: 'plaintext-refresh', expires_at: new Date(Date.now() + 3600000).toISOString(), updated_at: new Date().toISOString() }]);
    }
    if (u.includes('/rest/v1/sync_cursors')) return method === 'GET' ? jsonRes([]) : jsonRes(null, 204);
    if (u.includes('getjobber.com')) {
      return jsonRes({ data: { quotes: { nodes: [
        { id: 'q1', quoteNumber: 1, title: 'Deck', quoteStatus: 'approved', amounts: { total: 500 }, client: { id: 'c1', name: 'Ann' }, createdAt: '2026-01-01', updatedAt: '2026-01-02' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (u.includes('/rest/v1/quotes') && method === 'POST') return jsonRes(null, 204);
    if (u.includes('/rest/v1/sync_log') && method === 'POST') {
      logCalls.push(JSON.parse(opts.body));
      return jsonRes(null, 204);
    }
    throw new Error('unexpected fetch: ' + method + ' ' + u);
  };
  try {
    const mod = await import('../api/jobber/sync-extended.js');
    const r = res();
    await mod.default(req(), r);
    assert.equal(r.statusCode, 200);
    assert.equal(logCalls.length, 1, 'exactly one sync_log write for this run');
    assert.equal(logCalls[0].source, 'sync_extended');
    assert.equal(logCalls[0].status, 'success');
    assert.deepEqual(logCalls[0].details, { quotes: 1 });
  } finally {
    global.fetch = original;
  }
});

test('a resource that errors is logged as status=error with the error message in details, without crashing the response', async () => {
  const logCalls = [];
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.includes('/rest/v1/integrations')) {
      return jsonRes([{ access_token: 'plaintext-token', refresh_token: 'plaintext-refresh', expires_at: new Date(Date.now() + 3600000).toISOString(), updated_at: new Date().toISOString() }]);
    }
    if (u.includes('/rest/v1/sync_cursors')) return method === 'GET' ? jsonRes([]) : jsonRes(null, 204);
    if (u.includes('getjobber.com')) return jsonRes({ errors: [{ message: 'Field "quotes" doesn\'t exist' }] });
    if (u.includes('/rest/v1/sync_log') && method === 'POST') {
      logCalls.push(JSON.parse(opts.body));
      return jsonRes(null, 204);
    }
    throw new Error('unexpected fetch: ' + method + ' ' + u);
  };
  try {
    const mod = await import('../api/jobber/sync-extended.js');
    const r = res();
    await mod.default(req(), r);
    assert.equal(r.statusCode, 207, 'a failed resource still returns 207, unchanged from before this fix');
    assert.equal(logCalls.length, 1);
    assert.equal(logCalls[0].source, 'sync_extended');
    assert.equal(logCalls[0].status, 'error');
    assert.ok(logCalls[0].details.errors && logCalls[0].details.errors.quotes, 'the resource error is captured in details.errors');
  } finally {
    global.fetch = original;
  }
});

test('a failure writing sync_log never fails the real sync response (best-effort)', async () => {
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.includes('/rest/v1/integrations')) {
      return jsonRes([{ access_token: 'plaintext-token', refresh_token: 'plaintext-refresh', expires_at: new Date(Date.now() + 3600000).toISOString(), updated_at: new Date().toISOString() }]);
    }
    if (u.includes('/rest/v1/sync_cursors')) return method === 'GET' ? jsonRes([]) : jsonRes(null, 204);
    if (u.includes('getjobber.com')) {
      return jsonRes({ data: { quotes: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (u.includes('/rest/v1/quotes') && method === 'POST') return jsonRes(null, 204);
    if (u.includes('/rest/v1/sync_log') && method === 'POST') throw new Error('simulated network failure writing sync_log');
    throw new Error('unexpected fetch: ' + method + ' ' + u);
  };
  try {
    const mod = await import('../api/jobber/sync-extended.js');
    const r = res();
    await mod.default(req(), r);
    assert.equal(r.statusCode, 200, 'the real sync must still report success even if sync_log failed to write');
  } finally {
    global.fetch = original;
  }
});
