import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeRowsByConflictKey } from '../api/_lib/sync-dedupe.js';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: { get: () => null },
  };
}

test('same-key rows collapse to one and the newest Jobber version wins', () => {
  const result = dedupeRowsByConflictKey([
    { jobber_id: 'job-1', title: 'new', jobber_updated_at: '2026-08-17T13:20:00Z' },
    { jobber_id: 'job-2', title: 'only', jobber_updated_at: '2026-08-17T12:00:00Z' },
    { jobber_id: 'job-1', title: 'old', jobber_updated_at: '2026-08-16T13:20:00Z' },
  ], 'jobber_id');

  assert.equal(result.duplicatesDropped, 1);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows.find((row) => row.jobber_id === 'job-1').title, 'new');
});

test('equal-timestamp pagination overlap resolves deterministically to the later node', () => {
  const result = dedupeRowsByConflictKey([
    { jobber_id: 'invoice-1', subject: 'first', jobber_updated_at: '2026-08-12T10:00:00Z' },
    { jobber_id: 'invoice-1', subject: 'second', jobber_updated_at: '2026-08-12T10:00:00Z' },
  ], 'jobber_id');
  assert.equal(result.rows[0].subject, 'second');
});

test('a missing conflict key fails before a malformed upsert can reach Postgres', () => {
  assert.throws(
    () => dedupeRowsByConflictKey([{ title: 'missing id' }], 'jobber_id'),
    /jobber_id is missing/i,
  );
});

test('the core Jobber jobs sync sends each jobber_id to PostgREST only once', async () => {
  const originalFetch = globalThis.fetch;
  let jobsPayload = null;
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    const method = (options.method || 'GET').toUpperCase();

    if (requestUrl.includes('/rest/v1/integrations')) {
      return jsonResponse([{
        access_token: 'jobber-access', refresh_token: 'jobber-refresh',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        updated_at: new Date().toISOString(),
      }]);
    }
    if (requestUrl.includes('/rest/v1/sync_cursors')) {
      return method === 'GET' ? jsonResponse([]) : jsonResponse(null, 204);
    }
    if (requestUrl.includes('getjobber.com')) {
      return jsonResponse({ data: { jobs: {
        nodes: [
          {
            id: 'job-duplicate', client: { id: 'client-1' }, jobNumber: 42,
            title: 'Older title', jobStatus: 'active', jobType: 'project', total: 100,
            startAt: null, endAt: null, completedAt: null, jobberWebUri: 'https://jobber.test/42',
            createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-16T12:00:00Z',
          },
          {
            id: 'job-duplicate', client: { id: 'client-1' }, jobNumber: 42,
            title: 'Newest title', jobStatus: 'active', jobType: 'project', total: 125,
            startAt: null, endAt: null, completedAt: null, jobberWebUri: 'https://jobber.test/42',
            createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-17T13:20:00Z',
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } });
    }
    if (requestUrl.includes('/rest/v1/jobs') && method === 'POST') {
      jobsPayload = JSON.parse(options.body);
      return jsonResponse([{ ...jobsPayload[0], uuid_id: 'uuid-job-1' }]);
    }
    if (requestUrl.includes('/rest/v1/external_refs') && method === 'POST') {
      return jsonResponse(JSON.parse(options.body), 201);
    }
    if (requestUrl.includes('/rest/v1/sync_log') && method === 'POST') {
      return jsonResponse(null, 204);
    }
    throw new Error(`Unexpected fetch: ${method} ${requestUrl}`);
  };

  try {
    const sync = await import(`../api/jobber/sync.js?dedupe=${Date.now()}`);
    const req = {
      method: 'GET',
      query: { resource: 'jobs' },
      headers: { authorization: 'Bearer test-cron-secret' },
    };
    const res = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await sync.default(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(jobsPayload.length, 1, 'duplicate conflict keys must never share one PostgREST upsert');
    assert.equal(jobsPayload[0].title, 'Newest title');
    assert.equal(res.body.counts.jobs, 1);
    assert.equal(res.body.duplicatesDropped.jobs, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
