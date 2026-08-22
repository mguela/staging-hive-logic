// test/production-tracker.test.mjs
// Real replacement (2026-08-12) for the fully-fabricated "Daily Production
// Tracker" on the Remote Work & Production page -- that table hardcoded
// invoice/PO/permit numbers with zero backing. Only two real data points
// exist: purchase_orders carries a real requestedBy (the creating profile's
// id), so POs can be attributed per employee; invoices have no employee
// column at all (synced straight from Jobber), so invoicesSentToday is a
// company-wide count only, never attributed to a person.
// Fully mocked -- no network, no DB, no real secret.
// Run with: node --experimental-test-module-mocks --test test/production-tracker.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

function res() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

let scenario = {};

function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

async function withMockedFetch(fn) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1', email: scenario.email || 'chris@ghgrp.net' });
    if (u.includes('/rest/v1/profiles') && u.includes('id=in.(')) return jsonRes(scenario.actorProfiles || []);
    if (u.includes('/rest/v1/profiles')) return jsonRes([{ id: 'user-1', email: scenario.email || 'chris@ghgrp.net', role: scenario.profileRole || null }]);
    if (u.includes('/rest/v1/invoices')) return jsonRes(scenario.invoiceRows || []);
    if (u.includes('/rest/v1/purchase_orders')) return jsonRes(scenario.poRows || []);
    return jsonRes({ error: 'not relevant to this test' });
  };
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

const trackMod = await import('../api/track1.js');

async function callTrack1(resource, { method = 'GET', body, query = {}, authHeader = 'Bearer usertoken' } = {}) {
  const req = { method, query: Object.assign({ resource }, query), headers: { authorization: authHeader }, body };
  const r = res();
  await trackMod.default(req, r);
  return r;
}

test('production_tracker: an anonymous request 401s', async () => {
  const r = await withMockedFetch(() => callTrack1('production_tracker', { authHeader: '' }));
  assert.equal(r.statusCode, 401);
});

test('production_tracker: a non-admin is rejected 403', async () => {
  scenario = { email: 'field@ghgrp.net', profileRole: 'crew' };
  const r = await withMockedFetch(() => callTrack1('production_tracker'));
  assert.equal(r.statusCode, 403);
});

test('production_tracker: invoicesSentToday is a plain company-wide count, not attributed to anyone', async () => {
  scenario = {
    email: 'chris@ghgrp.net', profileRole: 'admin',
    invoiceRows: [{ invoice_number: 'INV-1' }, { invoice_number: 'INV-2' }, { invoice_number: 'INV-3' }],
    poRows: [],
  };
  const r = await withMockedFetch(() => callTrack1('production_tracker'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.invoicesSentToday, 3);
  assert.equal(r.body.poByEmployee.length, 0);
});

test('production_tracker: POs are grouped and counted per the real requestedBy actor id, resolved to a display name', async () => {
  scenario = {
    email: 'chris@ghgrp.net', profileRole: 'admin',
    invoiceRows: [],
    poRows: [
      { po_number: 'PO-001', data: { requestedBy: 'actor-1' }, created_at: '2026-08-12T10:00:00Z' },
      { po_number: 'PO-002', data: { requestedBy: 'actor-1' }, created_at: '2026-08-12T11:00:00Z' },
      { po_number: 'PO-003', data: { requestedBy: 'actor-2' }, created_at: '2026-08-12T12:00:00Z' },
    ],
    actorProfiles: [
      { id: 'actor-1', full_name: 'Patrick Dean Amit', email: 'patrick@ghgrp.net' },
      { id: 'actor-2', full_name: null, email: 'allan@ghgrp.net' },
    ],
  };
  const r = await withMockedFetch(() => callTrack1('production_tracker'));
  assert.equal(r.statusCode, 200);
  const patrick = r.body.poByEmployee.find((e) => e.employeeId === 'actor-1');
  const allan = r.body.poByEmployee.find((e) => e.employeeId === 'actor-2');
  assert.equal(patrick.employeeName, 'Patrick Dean Amit');
  assert.equal(patrick.count, 2);
  assert.deepEqual(patrick.poNumbers.sort(), ['PO-001', 'PO-002']);
  assert.equal(allan.employeeName, 'allan@ghgrp.net', 'falls back to email when full_name is null');
  assert.equal(allan.count, 1);
});

test('production_tracker: a PO with no requestedBy on its data is skipped rather than crashing or miscounting', async () => {
  scenario = {
    email: 'chris@ghgrp.net', profileRole: 'admin',
    invoiceRows: [],
    poRows: [{ po_number: 'PO-999', data: {}, created_at: '2026-08-12T10:00:00Z' }],
    actorProfiles: [],
  };
  const r = await withMockedFetch(() => callTrack1('production_tracker'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.poByEmployee.length, 0);
});
