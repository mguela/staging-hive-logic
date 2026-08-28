// test/estimate-client-pricing.test.mjs
// jomell, 2026-08-27: the client profile modal's "Recent pricing" section --
// what a client was quoted for a line item next to what the job it became
// actually carries for that same line item.
//
// Pins the real join rule: only estimates that actually converted to a job
// are considered, matched to that job's real line items by description text
// (trimmed, case-insensitive) -- no fabricated numbers when nothing matches.
//
// Run with: node --experimental-test-module-mocks --test test/estimate-client-pricing.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.BOOKKEEPING_ENABLED = 'true';

let estimatesFixture;
let jobLineItemsByJobRef;

mock.module('../api/bookkeeping/estimates/_store.js', {
  namedExports: {
    listEstimates: async (_companyId, opts) => estimatesFixture.filter((e) => !opts.clientId || e.clientId === opts.clientId),
  },
});

mock.module('../api/bookkeeping/purchase-orders/_actor.js', {
  namedExports: {
    getTrustedActor: async () => ({ id: 'user-1', companyId: 'greenwich-handyman', role: 'controller' }),
  },
});

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path) => {
      const m = String(path).match(/job_ref=eq\.([^&]+)/);
      const jobRef = m ? decodeURIComponent(m[1]) : null;
      return { ok: true, json: async () => jobLineItemsByJobRef[jobRef] || [] };
    },
    jobberGraphQL: async () => ({}),
  },
});

const handler = (await import('../api/bookkeeping/estimates/client-pricing.js')).default;

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function req(query) {
  return { method: 'GET', query };
}

function reset() {
  estimatesFixture = [];
  jobLineItemsByJobRef = {};
}

test('requires a clientId', async () => {
  reset();
  const r = res();
  await handler(req({}), r);
  assert.equal(r.statusCode, 400);
});

test('an open (not converted) estimate contributes no rows -- there is no job yet to compare against', async () => {
  reset();
  estimatesFixture = [{
    id: 'e1', clientId: 'C1', lifecycleStatus: 'sent', convertedJobId: null,
    lines: [{ type: 'labor', description: 'Demolition', qty: 1, unitCost: 500, pmode: 'markup', markupPct: 0 }],
  }];
  const r = res();
  await handler(req({ clientId: 'C1' }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.rows, []);
});

test('a converted estimate matches its lines to the real job line items by description', async () => {
  reset();
  estimatesFixture = [{
    id: 'e1', clientId: 'C1', lifecycleStatus: 'converted', convertedJobId: 'J1', sentAt: '2026-05-20T00:00:00Z', createdAt: '2026-05-18T00:00:00Z',
    lines: [
      { type: 'labor', description: 'Demolition', qty: 1, unitCost: 3000, pmode: 'manual', manualUnitPrice: 4200 },
      { type: 'labor', description: 'Dump Fees', qty: 1, unitCost: 650, pmode: 'manual', manualUnitPrice: 650 },
    ],
  }];
  jobLineItemsByJobRef.J1 = [
    { description: 'Demolition', line_total: 4200, created_at: '2026-05-29T00:00:00Z' },
    { description: 'Dump Fees', line_total: 650, created_at: '2026-05-29T00:00:00Z' },
  ];
  const r = res();
  await handler(req({ clientId: 'C1' }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.rows.length, 2);
  const demo = r.body.rows.find((row) => row.lineItem === 'Demolition');
  assert.equal(demo.quoted.amount, 4200);
  assert.equal(demo.quoted.date, '2026-05-20T00:00:00Z');
  assert.equal(demo.job.amount, 4200);
  assert.equal(demo.job.date, '2026-05-29T00:00:00Z');
});

test('a quoted line with no matching job line reports job: null, not a fabricated number', async () => {
  reset();
  estimatesFixture = [{
    id: 'e1', clientId: 'C1', lifecycleStatus: 'converted', convertedJobId: 'J1', sentAt: '2026-05-20T00:00:00Z',
    lines: [{ type: 'labor', description: 'Electrical rewiring', qty: 1, unitCost: 1000, pmode: 'manual', manualUnitPrice: 1400 }],
  }];
  jobLineItemsByJobRef.J1 = [{ description: 'Something else entirely', line_total: 900, created_at: '2026-05-29T00:00:00Z' }];
  const r = res();
  await handler(req({ clientId: 'C1' }), r);
  const row = r.body.rows[0];
  assert.equal(row.job, null);
});

test('the match is case/whitespace-insensitive', async () => {
  reset();
  estimatesFixture = [{
    id: 'e1', clientId: 'C1', lifecycleStatus: 'converted', convertedJobId: 'J1', sentAt: '2026-05-20T00:00:00Z',
    lines: [{ type: 'labor', description: '  Demolition  ', qty: 1, unitCost: 500, pmode: 'manual', manualUnitPrice: 700 }],
  }];
  jobLineItemsByJobRef.J1 = [{ description: 'DEMOLITION', line_total: 700, created_at: '2026-05-29T00:00:00Z' }];
  const r = res();
  await handler(req({ clientId: 'C1' }), r);
  assert.equal(r.body.rows[0].job.amount, 700);
});

test('discount and tax lines are excluded -- they are not a priced line item of work', async () => {
  reset();
  estimatesFixture = [{
    id: 'e1', clientId: 'C1', lifecycleStatus: 'converted', convertedJobId: 'J1', sentAt: '2026-05-20T00:00:00Z',
    lines: [
      { type: 'labor', description: 'Demolition', qty: 1, unitCost: 500, pmode: 'manual', manualUnitPrice: 700 },
      { type: 'discount', description: 'Discount', qty: 1, unitCost: 0, pmode: 'manual', manualUnitPrice: 100 },
    ],
  }];
  jobLineItemsByJobRef.J1 = [];
  const r = res();
  await handler(req({ clientId: 'C1' }), r);
  assert.equal(r.body.rows.length, 1);
  assert.equal(r.body.rows[0].lineItem, 'Demolition');
});

test('rows sort by most recently quoted first', async () => {
  reset();
  estimatesFixture = [
    { id: 'e1', clientId: 'C1', convertedJobId: 'J1', sentAt: '2026-01-01T00:00:00Z', lines: [{ type: 'labor', description: 'Old work', qty: 1, unitCost: 0, pmode: 'manual', manualUnitPrice: 100 }] },
    { id: 'e2', clientId: 'C1', convertedJobId: 'J2', sentAt: '2026-06-01T00:00:00Z', lines: [{ type: 'labor', description: 'New work', qty: 1, unitCost: 0, pmode: 'manual', manualUnitPrice: 200 }] },
  ];
  jobLineItemsByJobRef.J1 = [];
  jobLineItemsByJobRef.J2 = [];
  const r = res();
  await handler(req({ clientId: 'C1' }), r);
  assert.equal(r.body.rows[0].lineItem, 'New work');
  assert.equal(r.body.rows[1].lineItem, 'Old work');
});

test('a client with no estimates at all reports an empty list, not an error', async () => {
  reset();
  const r = res();
  await handler(req({ clientId: 'C-nobody' }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.rows, []);
});
