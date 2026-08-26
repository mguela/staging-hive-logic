// Verifies that New Invoice persists a durable draft row through the real
// track1 handler contract. Everything below is mocked: no DB, Jobber, QBO, or
// payment-provider call is made.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

let authOk = true;
let invoiceWrites = [];
let jobberCalls = 0;

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (requestPath, options = {}) => {
      if (String(requestPath).startsWith('profiles')) {
        return { ok: true, json: async () => [{ id: 'user-1', role: 'admin' }] };
      }
      if (requestPath === 'invoices' && options.method === 'POST') {
        const row = JSON.parse(options.body);
        invoiceWrites.push(row);
        return { ok: true, json: async () => [row] };
      }
      return { ok: true, json: async () => [] };
    },
    jobberGraphQL: async () => { jobberCalls += 1; return {}; },
  },
});

mock.module('../api/_lib/guard.js', {
  namedExports: {
    requireApiAuth: async () => ({ ok: true, via: 'session' }),
    checkCronSecret: () => false,
  },
});

globalThis.fetch = async () => authOk
  ? { ok: true, status: 200, json: async () => ({ id: 'user-1' }) }
  : { ok: false, status: 401, json: async () => ({}) };

const track1 = await import('../api/track1.js');

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function createInvoice(body, method = 'POST') {
  invoiceWrites = [];
  jobberCalls = 0;
  const req = {
    method,
    query: { resource: 'create_invoice' },
    headers: { authorization: 'Bearer user-token' },
    body,
  };
  const res = response();
  await track1.default(req, res);
  return res;
}

test('create_invoice writes a durable, unsent draft and returns the stored row', async () => {
  const res = await createInvoice({ amount: 1250.75, clientId: 'client-42', dueDate: '2026-09-01' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(invoiceWrites.length, 1);

  const row = invoiceWrites[0];
  assert.match(row.jobber_id, /^HL-INV-[0-9a-f-]{36}$/i);
  assert.equal(row.invoice_status, 'draft');
  assert.equal(row.total, 1250.75);
  assert.equal(row.payments, 0);
  assert.equal(row.client_id, 'client-42');
  assert.equal(row.due_date, '2026-09-01');
  assert.deepEqual(res.body.invoice, row);
  assert.match(res.body.note, /not sent.*not in Jobber\/QuickBooks/i);
  assert.equal(jobberCalls, 0, 'saving a local draft must not call Jobber');
});

test('create_invoice defaults the due date to 7 days out when none is given', async () => {
  const res = await createInvoice({ amount: 500, clientId: 'client-9' });
  assert.equal(res.statusCode, 200);
  const row = invoiceWrites[0];
  const due = new Date(row.due_date + 'T00:00:00Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  assert.equal(Math.round((due - today) / 86400000), 7);
});

test('create_invoice refuses invalid money before writing', async () => {
  const res = await createInvoice({ amount: 0 });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(invoiceWrites, []);
});

test('create_invoice is POST-only', async () => {
  const res = await createInvoice({ amount: 100 }, 'GET');
  assert.equal(res.statusCode, 405);
  assert.deepEqual(invoiceWrites, []);
});

test('create_invoice requires a verified signed-in profile', async () => {
  authOk = false;
  try {
    const res = await createInvoice({ amount: 100 });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(invoiceWrites, []);
  } finally {
    authOk = true;
  }
});
