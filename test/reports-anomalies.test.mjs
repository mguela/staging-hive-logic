// test/reports-anomalies.test.mjs
// 2026-08-14 (jomell: "we should make it functional" -- the Reports page's
// Anomalies card used to show two hardcoded fake findings forever, with a
// "Send" button that only popped a toast). This exercises the real
// api/reports/anomalies.js handler end-to-end, including the real (not
// mocked) approvedActualCostsForJobCosting() engine function for the
// after-the-fact-spend check -- only auth, the revenue computation, and the
// PO store are mocked.
// Run with: node --experimental-test-module-mocks --test test/reports-anomalies.test.mjs

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let authedUser = { id: 'u1' };
mock.module('../api/_lib/auth.js', {
  namedExports: { requireUser: async () => authedUser },
});

let revenueMTDStub = { value: 100, priorPeriodValue: 100, trendPct: 0, asOfDate: '2026-08-14', priorPeriodLabel: 'same days, prior month' };
mock.module('../api/reports/summary.js', {
  namedExports: { computeRevenueMTD: async () => revenueMTDStub },
});

let poFixture = [];
mock.module('../api/bookkeeping/purchase-orders/_store.js', {
  namedExports: { listPurchaseOrders: async () => poFixture },
});
mock.module('../api/bookkeeping/purchase-orders/_actor.js', {
  namedExports: { SINGLE_TENANT_COMPANY_ID: 'greenwich-handyman', getTrustedActor: async () => null },
});

const { default: handler } = await import('../api/reports/anomalies.js');

function res() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function req() {
  return { method: 'GET', headers: { authorization: 'Bearer usertoken' } };
}

test('401 when not signed in', async () => {
  authedUser = null;
  const r = res();
  await handler(req(), r);
  assert.equal(r.statusCode, 401);
  authedUser = { id: 'u1' };
});

test('no anomalies + honest skip note when revenue is flat and bookkeeping is disabled', async () => {
  delete process.env.BOOKKEEPING_ENABLED;
  revenueMTDStub = { value: 100, priorPeriodValue: 100, trendPct: 2, asOfDate: '2026-08-14', priorPeriodLabel: 'same days, prior month' };
  const r = res();
  await handler(req(), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.anomalies, []);
  assert.equal(r.body.skippedChecks.length, 1);
  assert.match(r.body.skippedChecks[0].reason, /not enabled/);
});

test('flags a real revenue swing over the threshold', async () => {
  delete process.env.BOOKKEEPING_ENABLED;
  revenueMTDStub = { value: 50000, priorPeriodValue: 70000, trendPct: -28.6, asOfDate: '2026-08-14', priorPeriodLabel: 'same days, prior month' };
  const r = res();
  await handler(req(), r);
  assert.equal(r.body.anomalies.length, 1);
  assert.match(r.body.anomalies[0].title, /down 28\.6%/);
  assert.match(r.body.anomalies[0].detail, /\$50,000/);
});

test('flags real after-the-fact purchase spend via the actual engine function, when bookkeeping is enabled', async () => {
  process.env.BOOKKEEPING_ENABLED = 'true';
  revenueMTDStub = { value: 100, priorPeriodValue: 100, trendPct: 0, asOfDate: '2026-08-14', priorPeriodLabel: 'same days, prior month' };
  poFixture = [{
    id: 'po-1', companyId: 'greenwich-handyman', poNumber: 'PO-1', jobId: 'job-1',
    lifecycleStatus: 'approved', approvedAt: new Date().toISOString(), notPreapproved: true,
    updatedAt: new Date().toISOString(), exceptions: [],
    lines: [{ id: 'l1', type: 'material', description: 'Emergency copper buy', receivedAmount: 450 }]
  }];
  const r = res();
  await handler(req(), r);
  const found = r.body.anomalies.find(a => a.id === 'after-the-fact-spend');
  assert.ok(found, 'expected an after-the-fact-spend anomaly: ' + JSON.stringify(r.body));
  assert.match(found.detail, /\$450/);
  process.env.BOOKKEEPING_ENABLED = 'false';
  poFixture = [];
});

test('does not flag a fully preapproved purchase order as after-the-fact', async () => {
  process.env.BOOKKEEPING_ENABLED = 'true';
  revenueMTDStub = { value: 100, priorPeriodValue: 100, trendPct: 0, asOfDate: '2026-08-14', priorPeriodLabel: 'same days, prior month' };
  poFixture = [{
    id: 'po-2', companyId: 'greenwich-handyman', poNumber: 'PO-2', jobId: 'job-2',
    lifecycleStatus: 'approved', approvedAt: new Date().toISOString(), notPreapproved: false,
    updatedAt: new Date().toISOString(), exceptions: [],
    lines: [{ id: 'l1', type: 'material', description: 'Planned lumber order', receivedAmount: 900 }]
  }];
  const r = res();
  await handler(req(), r);
  assert.equal(r.body.anomalies.find(a => a.id === 'after-the-fact-spend'), undefined);
  process.env.BOOKKEEPING_ENABLED = 'false';
  poFixture = [];
});
