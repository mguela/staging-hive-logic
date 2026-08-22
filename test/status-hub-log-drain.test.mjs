import assert from 'node:assert/strict';
import test from 'node:test';

import handler, { parseBatch, parseVercelEntries, parseSupabaseEntries, normalizeMessage } from '../api/status-hub-log-drain.js';

function response() {
  return {
    statusCode: 0, payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test('a JSON array batch and an NDJSON batch parse to the same entries', () => {
  const entries = [{ level: 'error', message: 'boom' }, { level: 'info', message: 'fine' }];
  assert.deepEqual(parseBatch(JSON.stringify(entries)), entries);
  const ndjson = entries.map((e) => JSON.stringify(e)).join('\n');
  assert.deepEqual(parseBatch(ndjson), entries);
  assert.deepEqual(parseBatch(''), []);
  assert.deepEqual(parseBatch('not json at all'), []);
});

test('a malformed line in an NDJSON batch is skipped, not fatal to the rest', () => {
  const batch = '{"level":"error","message":"a"}\nnot json\n{"level":"error","message":"b"}';
  assert.deepEqual(parseBatch(batch), [{ level: 'error', message: 'a' }, { level: 'error', message: 'b' }]);
});

test('normalizeMessage strips the parts that change on every occurrence of the same error', () => {
  const a = normalizeMessage('Request 3f8a1c22-4b7e-4a11-9c2e-8d1f0a2b3c4d failed after 4213ms at 2026-08-18T04:09:25.130Z');
  const b = normalizeMessage('Request 9e1b2c33-5c8f-4b22-8d3f-9e2a1b3c4d5e failed after 891ms at 2026-08-18T05:11:02.400Z');
  assert.equal(a, b, 'two occurrences of the same underlying error must normalize to the same string so they fingerprint-match');
});

test('only error-level Vercel entries become findings, and the location/message drive a stable fingerprint', () => {
  const entries = [
    { level: 'error', message: 'TypeError: x is not a function', entrypoint: 'api/reina-council.js', deploymentId: 'dpl_1', requestId: 'req_1', statusCode: 500 },
    { level: 'warning', message: 'slow query' },
    { level: 'info', message: 'GET 200' },
  ];
  const findings = parseVercelEntries(entries);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].source, 'vercel_runtime');
  assert.match(findings[0].title, /api\/reina-council\.js/);
  assert.equal(findings[0].detail, 'TypeError: x is not a function');
  assert.equal(findings[0].evidence.statusCode, 500);
  assert.equal(findings[0].evidence.deploymentId, 'dpl_1');
});

test('two Vercel entries for the same error at the same location fingerprint identically', () => {
  const first = parseVercelEntries([{ level: 'error', message: 'boom at 12345', entrypoint: 'api/x.js', requestId: 'req_a' }]);
  const second = parseVercelEntries([{ level: 'error', message: 'boom at 99999', entrypoint: 'api/x.js', requestId: 'req_b' }]);
  assert.equal(first[0].fingerprint, second[0].fingerprint,
    'the volatile number and request id must not make two occurrences of the same error fingerprint differently');
});

test('Supabase entries are recognized by level/severity metadata or an error-shaped message', () => {
  const entries = [
    { event_message: 'connection refused', metadata: { level: 'error', component: 'postgres' } },
    { event_message: 'FATAL: too many connections', metadata: {} },
    { event_message: 'query completed', metadata: { level: 'info' } },
  ];
  const findings = parseSupabaseEntries(entries);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].source, 'supabase_logs');
  assert.match(findings[0].title, /postgres/);
  assert.match(findings[1].title, /database/, 'a missing component name falls back to a generic label, not a crash');
});

test('the handler requires the shared secret and rejects everything else before touching the database', async () => {
  const originalSecret = process.env.STATUS_HUB_LOG_DRAIN_SECRET;
  process.env.STATUS_HUB_LOG_DRAIN_SECRET = 'test-secret';
  try {
    const wrongMethod = response();
    await handler({ method: 'GET' }, wrongMethod);
    assert.equal(wrongMethod.statusCode, 405);

    const noAuth = response();
    await handler({ method: 'POST', headers: {}, query: { src: 'vercel' }, body: '[]' }, noAuth);
    assert.equal(noAuth.statusCode, 401);

    const wrongAuth = response();
    await handler({ method: 'POST', headers: { authorization: 'Bearer nope' }, query: { src: 'vercel' }, body: '[]' }, wrongAuth);
    assert.equal(wrongAuth.statusCode, 401);

    const badSrc = response();
    await handler({ method: 'POST', headers: { authorization: 'Bearer test-secret' }, query: {}, body: '[]' }, badSrc);
    assert.equal(badSrc.statusCode, 400);
    assert.match(badSrc.payload.error, /src=vercel or \?src=supabase/);
  } finally {
    if (originalSecret === undefined) delete process.env.STATUS_HUB_LOG_DRAIN_SECRET;
    else process.env.STATUS_HUB_LOG_DRAIN_SECRET = originalSecret;
  }
});

test('the handler fails closed (503) when no secret is configured, matching the CI intake route', async () => {
  const originalSecret = process.env.STATUS_HUB_LOG_DRAIN_SECRET;
  delete process.env.STATUS_HUB_LOG_DRAIN_SECRET;
  try {
    const res = response();
    await handler({ method: 'POST', headers: { authorization: 'Bearer anything' }, query: { src: 'vercel' }, body: '[]' }, res);
    assert.equal(res.statusCode, 503);
  } finally {
    if (originalSecret === undefined) delete process.env.STATUS_HUB_LOG_DRAIN_SECRET;
    else process.env.STATUS_HUB_LOG_DRAIN_SECRET = originalSecret;
  }
});
