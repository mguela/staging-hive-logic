// test/jobber-sync-external-refs.test.mjs
// Gate 0 follow-up (2026-08-07): a verification pass against production
// found 29 clients/jobs/invoices with a real jobber_id but no external_refs
// row (sql/049's Gate 1 identity mapping) -- migration 049 only backfilled
// what existed AT THE TIME it ran; every client/job/invoice synced since
// never got one, and the gap grows with every sync run. This proves the fix:
// api/jobber/sync.js now upserts a matching external_refs row for every
// client/job/invoice it syncs, using the server-assigned uuid_id from the
// main upsert's own return=representation response (not re-derived/guessed).
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

test('syncing clients also populates external_refs for every synced row, using the real server-assigned uuid_id', async () => {
  const calls = []; // every POST body sent to external_refs, for assertions
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();

    if (u.includes('/rest/v1/integrations')) {
      return jsonRes([{ access_token: 'plaintext-token', refresh_token: 'plaintext-refresh', expires_at: new Date(Date.now() + 3600000).toISOString(), updated_at: new Date().toISOString() }]);
    }
    if (u.includes('/rest/v1/sync_cursors')) {
      return method === 'GET' ? jsonRes([]) : jsonRes(null, 204);
    }
    if (u.includes('getjobber.com')) {
      // One page of two real-shaped clients, no next page.
      return jsonRes({
        data: {
          clients: {
            nodes: [
              { id: 'jobber-client-1', firstName: 'Ann', lastName: 'Otte', companyName: null, name: 'Ann Otte', isCompany: false, isLead: false, isArchived: false, balance: 0, defaultEmails: ['ann@x.com'], phones: [], jobberWebUri: 'https://x/1', createdAt: '2026-01-01', updatedAt: '2026-01-02' },
              { id: 'jobber-client-2', firstName: 'Bob', lastName: 'DeSalva', companyName: null, name: 'Bob DeSalva', isCompany: false, isLead: false, isArchived: false, balance: 0, defaultEmails: ['bob@x.com'], phones: [], jobberWebUri: 'https://x/2', createdAt: '2026-01-01', updatedAt: '2026-01-02' },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }
    if (u.includes('/rest/v1/clients') && method === 'POST') {
      // The real upsert -- server assigns uuid_id, echoed back via return=representation.
      assert.match(String(opts.headers.Prefer || ''), /return=representation/, 'the client upsert must request return=representation so callers get the server-assigned uuid_id');
      return jsonRes([
        { jobber_id: 'jobber-client-1', uuid_id: 'uuid-aaa-1', name: 'Ann Otte' },
        { jobber_id: 'jobber-client-2', uuid_id: 'uuid-bbb-2', name: 'Bob DeSalva' },
      ]);
    }
    if (u.includes('/rest/v1/external_refs') && method === 'POST') {
      const body = JSON.parse(opts.body);
      calls.push(body);
      return jsonRes(body, 201);
    }
    if (u.includes('/rest/v1/sync_log')) return jsonRes(null, 204);
    throw new Error('unexpected fetch: ' + method + ' ' + u);
  };

  try {
    const mod = await import('../api/jobber/sync.js');
    const req = { method: 'GET', query: { resource: 'clients' }, headers: { authorization: 'Bearer test-cron-secret' } };
    const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await mod.default(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1, 'exactly one external_refs upsert call for this sync run');
    const refs = calls[0];
    assert.equal(refs.length, 2);
    assert.deepEqual(refs.find((r) => r.external_id === 'jobber-client-1'), { entity_type: 'client', entity_id: 'uuid-aaa-1', system: 'jobber', external_id: 'jobber-client-1' });
    assert.deepEqual(refs.find((r) => r.external_id === 'jobber-client-2'), { entity_type: 'client', entity_id: 'uuid-bbb-2', system: 'jobber', external_id: 'jobber-client-2' });
  } finally {
    global.fetch = original;
  }
});

test('a failure writing external_refs never fails the real sync (best-effort)', async () => {
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.includes('/rest/v1/integrations')) {
      return jsonRes([{ access_token: 'plaintext-token', refresh_token: 'plaintext-refresh', expires_at: new Date(Date.now() + 3600000).toISOString(), updated_at: new Date().toISOString() }]);
    }
    if (u.includes('/rest/v1/sync_cursors')) return method === 'GET' ? jsonRes([]) : jsonRes(null, 204);
    if (u.includes('getjobber.com')) {
      return jsonRes({ data: { clients: { nodes: [
        { id: 'jobber-client-9', firstName: 'X', lastName: 'Y', companyName: null, name: 'X Y', isCompany: false, isLead: false, isArchived: false, balance: 0, defaultEmails: ['x@x.com'], phones: [], jobberWebUri: 'https://x/9', createdAt: '2026-01-01', updatedAt: '2026-01-02' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (u.includes('/rest/v1/clients') && method === 'POST') {
      return jsonRes([{ jobber_id: 'jobber-client-9', uuid_id: 'uuid-ccc-9', name: 'X Y' }]);
    }
    if (u.includes('/rest/v1/external_refs') && method === 'POST') {
      throw new Error('simulated network failure writing external_refs');
    }
    if (u.includes('/rest/v1/sync_log')) return jsonRes(null, 204);
    throw new Error('unexpected fetch: ' + method + ' ' + u);
  };
  try {
    const mod = await import('../api/jobber/sync.js');
    const req = { method: 'GET', query: { resource: 'clients' }, headers: { authorization: 'Bearer test-cron-secret' } };
    const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await mod.default(req, res);
    assert.equal(res.statusCode, 200, 'the real client sync must still report success even if external_refs failed');
  } finally {
    global.fetch = original;
  }
});
