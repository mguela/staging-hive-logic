// test/job-line-items.test.mjs
// Job line items + job->invoice conversion (Chris's ask, 2026-08-18).
// Fully mocked -- no network, no DB, no real secret.
// Run with: node --experimental-test-module-mocks --test test/job-line-items.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

// What the mocked Supabase hands back, per test.
let jobsFixture = [];
let lineFixture = [];
let invoicesFixture = [];
let calls = [];
let insertedInvoice = null;
let insertedLines = null;

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path, opts = {}) => {
      const method = opts.method || 'GET';
      const p = String(path);
      calls.push({ method, path: p });

      if (p.startsWith('job_line_items')) {
        if (method === 'DELETE') return { ok: true, json: async () => [], text: async () => '' };
        if (method === 'POST') {
          insertedLines = JSON.parse(opts.body);
          return { ok: true, json: async () => insertedLines, text: async () => '' };
        }
        return { ok: true, json: async () => lineFixture, text: async () => '' };
      }
      if (p.startsWith('jobs')) return { ok: true, json: async () => jobsFixture, text: async () => '' };
      if (p.startsWith('invoices')) {
        if (method === 'POST') {
          insertedInvoice = JSON.parse(opts.body);
          return { ok: true, json: async () => [insertedInvoice], text: async () => '' };
        }
        return { ok: true, json: async () => invoicesFixture, text: async () => '' };
      }
      return { ok: true, json: async () => [], text: async () => '' };
    },
    jobberGraphQL: async () => ({}),
  },
});

// getRequestingProfile() verifies the bearer token against Supabase's auth
// endpoint with a bare fetch(); the mocked supabaseRequest above covers the
// profiles lookup that follows. Same approach as crew-chaining.test.mjs.
global.fetch = async (url) => {
  if (String(url).includes('/auth/v1/user')) {
    return { ok: true, json: async () => ({ id: 'user-1', email: 'chris@ghgrp.net' }) };
  }
  throw new Error('unexpected fetch in test: ' + url);
};

const trackMod = await import('../api/track1.js');
const { replaceJobLineItems, readJobLineItems } = trackMod;

function res() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function reset() {
  jobsFixture = [];
  lineFixture = [];
  invoicesFixture = [];
  calls = [];
  insertedInvoice = null;
  insertedLines = null;
}

// ---------------------------------------------------------------- normalizing

test('line_total is computed server-side, not trusted from the client', async () => {
  reset();
  await replaceJobLineItems('HL-JOB-1', [
    // A caller claiming a line_total that does not match qty * price must not win.
    { description: 'Install vanity', quantity: 3, unitPrice: 250, line_total: 999999 },
  ], { email: 'chris@ghgrp.net' });

  assert.equal(insertedLines.length, 1);
  assert.equal(insertedLines[0].line_total, 750);
  assert.equal(insertedLines[0].quantity, 3);
  assert.equal(insertedLines[0].unit_price, 250);
});

test('blank descriptions are dropped and sort_order is re-densified', async () => {
  reset();
  await replaceJobLineItems('HL-JOB-1', [
    { description: 'First', quantity: 1, unitPrice: 10 },
    { description: '   ', quantity: 5, unitPrice: 99 },   // an untouched editor row
    { description: 'Third', quantity: 2, unitPrice: 20 },
  ], null);

  assert.equal(insertedLines.length, 2);
  assert.deepEqual(insertedLines.map((l) => l.description), ['First', 'Third']);
  // Gaps left by dropped rows would make later reordering ambiguous.
  assert.deepEqual(insertedLines.map((l) => l.sort_order), [0, 1]);
});

test('negative quantities and prices fall back instead of creating a credit', async () => {
  reset();
  await replaceJobLineItems('HL-JOB-1', [
    { description: 'Bad row', quantity: -4, unitPrice: -100 },
  ], null);

  assert.equal(insertedLines[0].quantity, 1);
  assert.equal(insertedLines[0].unit_price, 0);
  assert.equal(insertedLines[0].line_total, 0);
});

test('fractional money is rounded to cents, not left to float drift', async () => {
  reset();
  await replaceJobLineItems('HL-JOB-1', [
    { description: 'Odd', quantity: 3, unitPrice: 33.33 },
  ], null);
  assert.equal(insertedLines[0].line_total, 99.99);
});

test('saving an empty set clears the job and skips the insert', async () => {
  reset();
  const out = await replaceJobLineItems('HL-JOB-1', [], null);
  assert.deepEqual(out, []);
  assert.equal(insertedLines, null, 'should not POST an empty array');
  assert.ok(calls.some((c) => c.method === 'DELETE'), 'old lines still get cleared');
});

// ------------------------------------------------------------------ resources

test('job_line_items GET returns the job lines and their total', async () => {
  reset();
  lineFixture = [
    { description: 'A', quantity: 2, unit_price: 100, line_total: 200 },
    { description: 'B', quantity: 1, unit_price: 55.5, line_total: 55.5 },
  ];
  const r = res();
  await trackMod.default(
    { method: 'GET', query: { resource: 'job_line_items', jobRef: 'HL-JOB-1' }, headers: { authorization: 'Bearer t' } },
    r
  );
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.total, 255.5);
  assert.equal(r.body.lines.length, 2);
});

test('create_invoice_from_job builds a DRAFT invoice from the job lines', async () => {
  reset();
  jobsFixture = [{
    jobber_id: 'HL-JOB-10001', uuid_id: 'job-uuid', title: 'Basement Bathroom',
    total: 12000, client_id: 'C-1', client_uuid: 'client-uuid', project_seq: 10001,
  }];
  lineFixture = [
    { description: 'Demo', quantity: 1, unit_price: 1500, line_total: 1500 },
    { description: 'Tile', quantity: 40, unit_price: 12.5, line_total: 500 },
  ];
  const r = res();
  await trackMod.default(
    { method: 'POST', query: { resource: 'create_invoice_from_job' }, headers: { authorization: 'Bearer t' }, body: { jobRef: 'HL-JOB-10001' } },
    r
  );

  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.amount, 2000);
  assert.equal(r.body.lineCount, 2);
  // Never auto-send, and always linked back to the job it came from.
  assert.equal(insertedInvoice.invoice_status, 'draft');
  assert.equal(insertedInvoice.job_id, 'HL-JOB-10001');
  assert.equal(insertedInvoice.job_uuid, 'job-uuid');
  assert.equal(insertedInvoice.client_id, 'C-1');
  assert.equal(insertedInvoice.total, 2000);
  // The lump job total is NOT what gets billed when real lines exist.
  assert.notEqual(insertedInvoice.total, 12000);
  assert.equal(insertedInvoice.line_items.length, 2);
});

test('a job with no lines but a value invoices as a single line', async () => {
  reset();
  jobsFixture = [{ jobber_id: 'HL-JOB-2', uuid_id: 'u2', title: 'Deck repair', total: 3400, client_id: 'C-2' }];
  lineFixture = [];
  const r = res();
  await trackMod.default(
    { method: 'POST', query: { resource: 'create_invoice_from_job' }, headers: { authorization: 'Bearer t' }, body: { jobRef: 'HL-JOB-2' } },
    r
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.amount, 3400);
  assert.equal(insertedInvoice.line_items.length, 1);
  assert.equal(insertedInvoice.line_items[0].description, 'Deck repair');
});

test('a job with neither lines nor value is refused, not invoiced for $0', async () => {
  reset();
  jobsFixture = [{ jobber_id: 'HL-JOB-3', uuid_id: 'u3', title: 'Unpriced', total: null, client_id: 'C-3' }];
  lineFixture = [];
  const r = res();
  await trackMod.default(
    { method: 'POST', query: { resource: 'create_invoice_from_job' }, headers: { authorization: 'Bearer t' }, body: { jobRef: 'HL-JOB-3' } },
    r
  );
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.ok, false);
  assert.equal(insertedInvoice, null, 'no invoice row should be written');
});

test('a job that already has an invoice needs an explicit second yes', async () => {
  reset();
  jobsFixture = [{ jobber_id: 'HL-JOB-4', uuid_id: 'u4', title: 'Kitchen', total: 500, client_id: 'C-4' }];
  lineFixture = [{ description: 'Work', quantity: 1, unit_price: 500, line_total: 500 }];
  invoicesFixture = [{ jobber_id: 'HL-INV-x', invoice_number: '123', invoice_status: 'draft', total: 500 }];

  const first = res();
  await trackMod.default(
    { method: 'POST', query: { resource: 'create_invoice_from_job' }, headers: { authorization: 'Bearer t' }, body: { jobRef: 'HL-JOB-4' } },
    first
  );
  assert.equal(first.statusCode, 409, 'billing a job twice must not be silent');
  assert.equal(first.body.needsConfirm, true);
  assert.equal(insertedInvoice, null);

  // Same call with the confirmation goes through.
  const second = res();
  await trackMod.default(
    { method: 'POST', query: { resource: 'create_invoice_from_job' }, headers: { authorization: 'Bearer t' }, body: { jobRef: 'HL-JOB-4', allowDuplicate: true } },
    second
  );
  assert.equal(second.statusCode, 200, JSON.stringify(second.body));
  assert.ok(insertedInvoice);
});

test('a missing job is a 404, not a stray invoice', async () => {
  reset();
  jobsFixture = [];
  const r = res();
  await trackMod.default(
    { method: 'POST', query: { resource: 'create_invoice_from_job' }, headers: { authorization: 'Bearer t' }, body: { jobRef: 'nope' } },
    r
  );
  assert.equal(r.statusCode, 404);
  assert.equal(insertedInvoice, null);
});

// ---- 2026-08-26, jomell: customizable title + amount (e.g. a deposit) ----

test('a custom amount bills that amount, not the job\'s full line-item total', async () => {
  reset();
  jobsFixture = [{
    jobber_id: 'HL-JOB-10015', uuid_id: 'job-uuid', title: 'Test. Gutter Replacement',
    total: 20800, client_id: 'C-1',
  }];
  lineFixture = [];
  const r = res();
  await trackMod.default(
    {
      method: 'POST', query: { resource: 'create_invoice_from_job' }, headers: { authorization: 'Bearer t' },
      body: { jobRef: 'HL-JOB-10015', subject: 'Deposit', amount: 6240 },
    },
    r
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.amount, 6240, 'a 30% deposit, not the full $20,800 job value');
  assert.equal(insertedInvoice.total, 6240);
  assert.equal(insertedInvoice.subtotal, 6240);
  assert.equal(insertedInvoice.balance, 6240);
  assert.equal(insertedInvoice.line_items.length, 1);
  assert.equal(insertedInvoice.line_items[0].lineTotal, 6240);
});

test('a custom title is saved as the invoice subject instead of the job\'s own title', async () => {
  reset();
  jobsFixture = [{ jobber_id: 'HL-JOB-10015', uuid_id: 'job-uuid', title: 'Test. Gutter Replacement', total: 20800, client_id: 'C-1' }];
  lineFixture = [];
  const r = res();
  await trackMod.default(
    {
      method: 'POST', query: { resource: 'create_invoice_from_job' }, headers: { authorization: 'Bearer t' },
      body: { jobRef: 'HL-JOB-10015', subject: 'Deposit', amount: 6240 },
    },
    r
  );
  assert.equal(insertedInvoice.subject, 'Deposit');
  assert.equal(insertedInvoice.line_items[0].description, 'Deposit');
});

test('a custom amount is honored even when the job has real priced line items', async () => {
  reset();
  jobsFixture = [{ jobber_id: 'HL-JOB-10016', uuid_id: 'u16', title: 'Kitchen remodel', total: 15000, client_id: 'C-2' }];
  lineFixture = [{ description: 'Cabinets', quantity: 1, unit_price: 15000, line_total: 15000 }];
  const r = res();
  await trackMod.default(
    {
      method: 'POST', query: { resource: 'create_invoice_from_job' }, headers: { authorization: 'Bearer t' },
      body: { jobRef: 'HL-JOB-10016', subject: 'First draw', amount: 5000 },
    },
    r
  );
  assert.equal(r.body.amount, 5000, 'a custom amount overrides the real line items, not just the no-lines fallback');
  assert.equal(insertedInvoice.line_items.length, 1);
});

test('a blank or zero custom amount falls back to the normal job-line-items computation', async () => {
  reset();
  jobsFixture = [{ jobber_id: 'HL-JOB-10017', uuid_id: 'u17', title: 'Fence repair', total: 900, client_id: 'C-3' }];
  lineFixture = [{ description: 'Repair', quantity: 1, unit_price: 900, line_total: 900 }];
  const r = res();
  await trackMod.default(
    {
      method: 'POST', query: { resource: 'create_invoice_from_job' }, headers: { authorization: 'Bearer t' },
      body: { jobRef: 'HL-JOB-10017', subject: '', amount: 0 },
    },
    r
  );
  assert.equal(r.body.amount, 900);
  assert.equal(insertedInvoice.subject, 'Fence repair');
});
