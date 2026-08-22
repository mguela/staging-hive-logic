// Verifies the webhook_events retention cleanup added to api/jobber/webhook.js
// (2026-08-01): runWebhookCleanup() builds the correct delete filter and
// default/custom retention window, propagates DB errors, and the handler's
// new ?cleanup=1 cron dispatch mirrors the existing ?drain=1 CRON_SECRET gate.
// NOTE: run with  node --experimental-test-module-mocks --test test/webhook-cleanup.test.mjs
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let lastPath = null;
let lastOptions = null;
let mockOk = true;
let mockErrorText = 'db error';

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    jobberGraphQL: async () => ({}),
    supabaseRequest: async (path, options) => {
      lastPath = path;
      lastOptions = options;
      return {
        ok: mockOk,
        text: async () => mockErrorText,
      };
    },
  },
});

const { runWebhookCleanup, default: handler } = await import('../api/jobber/webhook.js');

function makeRes() {
  const res = {};
  res.status = (code) => { res._status = code; return res; };
  res.json = (body) => { res._json = body; return res; };
  return res;
}

test('runWebhookCleanup: default 30-day retention, deletes only done rows past cutoff', async () => {
  mockOk = true;
  const before = Date.now();
  const result = await runWebhookCleanup();
  assert.match(lastPath, /^webhook_events\?status=eq\.done&processed_at=lt\./);
  assert.equal(lastOptions.method, 'DELETE');
  assert.equal(result.retention_days, 30);
  const cutoffMs = new Date(result.cutoff).getTime();
  const expectedMs = before - 30 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(cutoffMs - expectedMs) < 5000, 'cutoff should be ~30 days before now');
});

test('runWebhookCleanup: custom retention days is honored', async () => {
  mockOk = true;
  const result = await runWebhookCleanup(7);
  assert.equal(result.retention_days, 7);
  const cutoffMs = new Date(result.cutoff).getTime();
  const expectedMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(cutoffMs - expectedMs) < 5000, 'cutoff should be ~7 days before now');
});

test('runWebhookCleanup: propagates a DB error instead of silently succeeding', async () => {
  mockOk = false;
  mockErrorText = 'permission denied for table webhook_events';
  await assert.rejects(
    () => runWebhookCleanup(),
    /Failed to clean up webhook_events: permission denied for table webhook_events/
  );
  mockOk = true;
});

test('handler ?cleanup=1: rejects with 401 when CRON_SECRET does not match', async () => {
  process.env.CRON_SECRET = 'test-secret';
  const req = { query: { cleanup: '1' }, headers: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 401);
  assert.equal(res._json.ok, false);
  assert.match(res._json.error, /Cleanup runs on Vercel Cron only/);
  delete process.env.CRON_SECRET;
});

test('handler ?cleanup=1: runs cleanup when Authorization bearer matches CRON_SECRET', async () => {
  process.env.CRON_SECRET = 'test-secret';
  mockOk = true;
  const req = { query: { cleanup: '1' }, headers: { authorization: 'Bearer test-secret' } };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.retention_days, 30);
  assert.match(lastPath, /^webhook_events\?status=eq\.done&processed_at=lt\./);
  delete process.env.CRON_SECRET;
});

test('handler ?cleanup=1: ?key= query param also authenticates, matching the ?drain=1 pattern', async () => {
  process.env.CRON_SECRET = 'test-secret';
  mockOk = true;
  const req = { query: { cleanup: '1', key: 'test-secret' }, headers: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  delete process.env.CRON_SECRET;
});
