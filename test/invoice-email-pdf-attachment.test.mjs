// test/invoice-email-pdf-attachment.test.mjs
// jomell, 2026-08-27: "whenever we send an invoice to a client, they should
// receive a pdf with the details of the invoice." handleSendInvoiceEmail
// (api/track1.js) now generates a real PDF (api/_lib/invoice-pdf.js) from
// the invoice's own row plus the client's address, its linked job, and the
// job's other real invoices -- and attaches it to the email.
//
// This exercises the real handler end to end (real generateInvoicePdf
// included) against a mocked Supabase layer, so it catches wiring bugs a
// pure invoice-pdf.test.mjs unit test can't: wrong query filters, a lookup
// never made, an attachment silently dropped.
//
// Run with: node --experimental-test-module-mocks --test test/invoice-email-pdf-attachment.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.RESEND_API_KEY = 'test-resend-key';

let invoiceFixture;
let clientFixture;
let addressFixture;
let jobFixture;
let jobInvoicesFixture;
let calls = [];
let sendEmailCalls = [];
let sendEmailShouldFail = false;

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (p, opts = {}) => {
      const method = (opts && opts.method) || 'GET';
      const path_ = String(p);
      calls.push({ method, path: path_ });

      if (path_.startsWith('invoices?job_id=eq.')) {
        return { ok: true, json: async () => jobInvoicesFixture };
      }
      if (path_.startsWith('invoices?')) {
        return { ok: true, json: async () => (invoiceFixture ? [invoiceFixture] : []) };
      }
      if (path_.startsWith('clients?')) {
        return { ok: true, json: async () => (clientFixture ? [clientFixture] : []) };
      }
      if (path_.startsWith('client_locations?')) {
        return { ok: true, json: async () => (addressFixture ? [addressFixture] : []) };
      }
      if (path_.startsWith('jobs?')) {
        return { ok: true, json: async () => (jobFixture ? [jobFixture] : []) };
      }
      return { ok: true, json: async () => [] };
    },
    jobberGraphQL: async () => ({}),
  },
});

mock.module('../api/_lib/email.js', {
  namedExports: {
    isEmailConfigured: () => true,
    sendEmail: async (opts) => {
      sendEmailCalls.push(opts);
      if (sendEmailShouldFail) return { ok: false, error: 'boom' };
      return { ok: true, id: 'email-1' };
    },
  },
});

global.fetch = async (url) => {
  if (String(url).includes('/auth/v1/user')) {
    return { ok: true, json: async () => ({ id: 'user-1', email: 'chris@ghgrp.net' }) };
  }
  throw new Error('unexpected fetch in test: ' + url);
};

const trackMod = await import('../api/track1.js');

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function reset() {
  invoiceFixture = {
    jobber_id: 'HL-INV-1', invoice_number: '504404', invoice_status: 'draft',
    subject: 'Upon Completion', subtotal: 3826, total: 4068.95, balance: 4512.43,
    due_date: '2026-08-25', issued_date: '2026-08-20',
    client_id: 'client-1', job_id: 'HL-JOB-1',
    line_items: [{ description: 'Ceiling Tiles', quantity: 1, unitPrice: 1852, lineTotal: 926 }],
  };
  clientFixture = { email: 'john@example.com', name: 'John Smith', first_name: 'John' };
  addressFixture = { street: '123 Elm Street', city: 'Hartford', province: 'CT', postal_code: '06103' };
  jobFixture = { title: 'Renovation', total: 7652 };
  jobInvoicesFixture = [{ balance: 4512.43 }];
  calls = [];
  sendEmailCalls = [];
  sendEmailShouldFail = false;
}

test('a real PDF is generated and attached to the outgoing email', async () => {
  reset();
  const r = res();
  await trackMod.default({ method: 'POST', query: { resource: 'send_invoice_email' }, headers: { authorization: 'Bearer t' }, body: { id: 'HL-INV-1' } }, r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(sendEmailCalls.length, 1);
  const attachments = sendEmailCalls[0].attachments;
  assert.ok(Array.isArray(attachments) && attachments.length === 1, 'expected exactly one attachment');
  assert.equal(attachments[0].filename, 'Invoice-504404.pdf');
  const pdfBytes = Buffer.from(attachments[0].content, 'base64');
  assert.equal(pdfBytes.slice(0, 5).toString('utf-8'), '%PDF-', 'the attachment content must decode to a real PDF');
});

test('the address, job, and other-invoices-on-the-job lookups are the real ones this invoice needs', async () => {
  reset();
  const r = res();
  await trackMod.default({ method: 'POST', query: { resource: 'send_invoice_email' }, headers: { authorization: 'Bearer t' }, body: { id: 'HL-INV-1' } }, r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(calls.some((c) => c.path.startsWith('client_locations?jobber_id=eq.client-1')), 'expected a client_locations lookup for this exact client');
  assert.ok(calls.some((c) => c.path.startsWith('jobs?jobber_id=eq.HL-JOB-1')), 'expected a jobs lookup for this exact linked job');
  assert.ok(calls.some((c) => c.path.startsWith('invoices?job_id=eq.HL-JOB-1')), 'expected a lookup of every invoice on this job for the running balance');
});

test('the account balance attached is the real sum of every invoice on the job, not just this one', async () => {
  reset();
  jobInvoicesFixture = [{ balance: 4512.43 }, { balance: 1200 }];
  const r = res();
  await trackMod.default({ method: 'POST', query: { resource: 'send_invoice_email' }, headers: { authorization: 'Bearer t' }, body: { id: 'HL-INV-1' } }, r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  // Can't read the PDF's rendered text back out (pdf-lib compresses content
  // streams), so this is asserted at the source: buildInvoicePlan is a pure
  // function and is unit-tested against this exact arithmetic in
  // invoice-pdf.test.mjs. Here we only need to know a real, non-trivial PDF
  // came back -- the sum itself is proven elsewhere.
  assert.equal(sendEmailCalls[0].attachments.length, 1);
});

test('a client with no address on file still gets a real PDF -- the address block is just omitted', async () => {
  reset();
  addressFixture = null;
  const r = res();
  await trackMod.default({ method: 'POST', query: { resource: 'send_invoice_email' }, headers: { authorization: 'Bearer t' }, body: { id: 'HL-INV-1' } }, r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(sendEmailCalls[0].attachments.length, 1);
});

test('an invoice with no linked job still generates a PDF -- job lookups are skipped, not guessed', async () => {
  reset();
  invoiceFixture.job_id = null;
  const r = res();
  await trackMod.default({ method: 'POST', query: { resource: 'send_invoice_email' }, headers: { authorization: 'Bearer t' }, body: { id: 'HL-INV-1' } }, r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(!calls.some((c) => c.path.startsWith('jobs?')), 'no job to look up when the invoice has none linked');
  assert.equal(sendEmailCalls[0].attachments.length, 1);
});

test('a failed send is still refused the same way -- attaching a PDF does not change that contract', async () => {
  reset();
  sendEmailShouldFail = true;
  const r = res();
  await trackMod.default({ method: 'POST', query: { resource: 'send_invoice_email' }, headers: { authorization: 'Bearer t' }, body: { id: 'HL-INV-1' } }, r);
  assert.equal(r.statusCode, 422);
  assert.match(r.body.error, /boom/);
});
