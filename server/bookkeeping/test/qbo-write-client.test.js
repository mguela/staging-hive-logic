import test from 'node:test';
import assert from 'node:assert/strict';
import { createQboWriteClient, qboRequestId } from '../src/qbo-write-client.js';

test('QBO write client sends a stable requestid and idempotency envelope', async () => {
  const calls = [];
  const client = createQboWriteClient({ enabled: true, url: 'https://books.example/qbo/write', token: 'secret', fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return { ok: true, status: 200, json: async () => ({ qboId: '987' }) }; } });
  const item = { companyId: 'co', entityType: 'purchase', entityId: 'e1', operation: 'create', idempotencyKey: 'co:purchase:e1:create', payload: { TotalAmt: 10 } };
  const first = await client.send(item);
  const second = await client.send(item);
  assert.equal(first.qboId, '987');
  assert.equal(second.requestId, first.requestId);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, new RegExp(`requestid=${qboRequestId(item.idempotencyKey)}`));
  assert.equal(calls[0].options.headers['x-idempotency-key'], item.idempotencyKey);
  assert.equal(JSON.parse(calls[0].options.body).payload.TotalAmt, 10);
});

test('QBO write client classifies transient failures for safe retry', async () => {
  const client = createQboWriteClient({ enabled: true, url: 'https://books.example/qbo/write', fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: 'slow down' }) }) });
  const result = await client.send({ idempotencyKey: 'same', payload: {} });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.error, 'slow down');
});

test('QBO write client accepts the permanent ID from a Bill response', async () => {
  const client = createQboWriteClient({ enabled: true, url: 'https://books.example/qbo/write', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ Bill: { Id: 'bill-44' } }) }) });
  const result = await client.send({ idempotencyKey: 'bill:44', payload: {}, entityType: 'bill' });
  assert.equal(result.ok, true);
  assert.equal(result.qboId, 'bill-44');
});

test('a disabled client refuses to send and never calls fetch', async () => {
  let called = false;
  const client = createQboWriteClient({ enabled: false, url: 'https://books.example/qbo/write', fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; } });
  const result = await client.send({ idempotencyKey: 'x', payload: {} });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(called, false);
});

test('an enabled client with no url stays disabled', async () => {
  const client = createQboWriteClient({ enabled: true, url: '' });
  assert.equal(client.enabled, false);
});
