// test/invoicing-delete.test.mjs
// jomell, 2026-08-27: a way to clean up test invoices piling up in
// Invoicing & AR.
//
// Same HL-INV- rule as mark-paid (see invoicing-mark-paid.test.mjs): a
// Jobber-synced invoice is owned by api/jobber/sync.js and would just come
// back on the next hourly sync, so deleting one here is refused outright.
// Unlike mark-paid/update, NOT restricted to draft/unpaid -- a sent or paid
// test invoice is still test data someone wants gone.
//
// Fully mocked -- no network, no DB, no real secret.
// Run with: node --experimental-test-module-mocks --test test/invoicing-delete.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

// ---------------------------------------------------------------- backend

let deleteCalls = [];
let deleteResult = { ok: true };

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (p, opts) => {
      const o = opts || {};
      if (o.method === 'DELETE') {
        deleteCalls.push({ path: String(p) });
        if (!deleteResult.ok) return { ok: false, text: async () => 'boom' };
        return { ok: true, json: async () => [], text: async () => '' };
      }
      if (String(p).startsWith('profiles')) return { ok: true, json: async () => [{ id: 'u1', role: 'admin' }] };
      return { ok: true, json: async () => [] };
    },
    jobberGraphQL: async () => ({}),
  },
});

mock.module('../api/_lib/guard.js', {
  namedExports: {
    requireApiAuth: async () => ({ ok: true, via: 'session' }),
    checkCronSecret: () => false,
  },
});

globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'u1' }) });

const trackMod = await import('../api/track1.js');

function res() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function deleteInvoice(body, method = 'POST') {
  deleteCalls = [];
  const req = {
    method,
    query: { resource: 'delete_invoice' },
    headers: { authorization: 'Bearer test-user-token' },
    body,
  };
  const r = res();
  await trackMod.default(req, r);
  return r;
}

test('delete_invoice refuses a Jobber-synced invoice and deletes nothing', async () => {
  const r = await deleteInvoice({ id: 'Z2lkOi8vSm9iYmVyL0ludm9pY2UvMTIz' });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /synced from Jobber/i);
  assert.deepEqual(deleteCalls, [], 'a Jobber-owned row must never be deleted here');
});

test('delete_invoice deletes a HiveLogic-created invoice by jobber_id', async () => {
  const r = await deleteInvoice({ id: 'HL-INV-1785416183523' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(deleteCalls.length, 1);
  assert.match(deleteCalls[0].path, /jobber_id=eq\.HL-INV-1785416183523/);
});

test('delete_invoice works regardless of status -- sent/paid test invoices are still deletable', async () => {
  // No status check anywhere in the handler for this reason -- proven here by
  // never passing a status at all and still succeeding.
  const r = await deleteInvoice({ id: 'HL-INV-anything' });
  assert.equal(r.statusCode, 200);
});

test('delete_invoice requires an id', async () => {
  const r = await deleteInvoice({});
  assert.equal(r.statusCode, 400);
  assert.deepEqual(deleteCalls, []);
});

test('delete_invoice requires a signed-in user', async () => {
  deleteCalls = [];
  const req = { method: 'POST', query: { resource: 'delete_invoice' }, headers: {}, body: { id: 'HL-INV-1' } };
  const r = res();
  await trackMod.default(req, r);
  assert.equal(r.statusCode, 401);
});

test('delete_invoice is POST-only', async () => {
  const r = await deleteInvoice({ id: 'HL-INV-1' }, 'DELETE');
  assert.equal(r.statusCode, 405);
  assert.deepEqual(deleteCalls, []);
});

test('a failed delete surfaces the real error', async () => {
  deleteResult = { ok: false };
  const r = await deleteInvoice({ id: 'HL-INV-1' });
  assert.equal(r.statusCode, 500);
  assert.equal(r.body.ok, false);
  deleteResult = { ok: true };
});

// --------------------------------------------------------------- frontend

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

const startSnippet = "var IVX = { invoices: [], clientsById: {}, mode: 'open' };";
const start = source.indexOf(startSnippet);
assert.notEqual(start, -1, 'invoicing script block not found in index.html');
const end = source.indexOf('</script>', start);
assert.notEqual(end, -1, 'invoicing script block has no closing tag');

const sandbox = {
  window: { API: '' },
  document: { getElementById: () => null },
  hlTokenSync: () => 'tok',
  chirpToast: () => {},
  console,
  fetchCalls: [],
  modalCalls: [],
};
sandbox.fetch = (url, opts) => {
  sandbox.fetchCalls.push({ url, opts });
  return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
};
sandbox.hlModal = (title, body) => { sandbox.modalCalls.push({ title, body }); };
vm.createContext(sandbox);
vm.runInContext(source.slice(start, end), sandbox);

const LOCAL_DRAFT = { id: 'HL-INV-1785416183523', status: 'draft', total: 2000, balance: 2000, invoiceNumber: '1785416183' };
const LOCAL_PAID = { id: 'HL-INV-1785416183523', status: 'paid', total: 2000, balance: 0, invoiceNumber: '1785416183' };
const JOBBER_UNPAID = { id: 'Z2lkOi8vSm9iYmVy', status: 'awaiting_payment', total: 500, balance: 500, invoiceNumber: '101' };

test('a HiveLogic-created invoice gets a live Delete button', () => {
  const html = sandbox.ivxCard(LOCAL_DRAFT);
  assert.match(html, /onclick="ivxOpenDeleteModal\('HL-INV-1785416183523'/);
});

test('delete is offered on a paid local invoice too, not just drafts', () => {
  const html = sandbox.ivxCard(LOCAL_PAID);
  assert.match(html, /onclick="ivxOpenDeleteModal\('HL-INV-1785416183523'/);
});

test('a Jobber-synced invoice gets no delete button at all', () => {
  const html = sandbox.ivxCard(JOBBER_UNPAID);
  assert.doesNotMatch(html, /ivxOpenDeleteModal/,
    'a Jobber-owned invoice must not offer a delete path the server would refuse anyway');
});

test('deleting does not use a native browser confirm', () => {
  sandbox.modalCalls = [];
  sandbox.ivxOpenDeleteModal('HL-INV-1', '#101');
  assert.equal(sandbox.modalCalls.length, 1);
  assert.match(sandbox.modalCalls[0].body, /cannot be undone/i);
});

test('confirming posts the id to the delete_invoice resource', () => {
  sandbox.fetchCalls = [];
  sandbox.ivxConfirmDelete('HL-INV-1785416183523');
  assert.equal(sandbox.fetchCalls.length, 1);
  const call = sandbox.fetchCalls[0];
  assert.match(call.url, /resource=delete_invoice/);
  assert.equal(call.opts.method, 'POST');
  assert.deepEqual(JSON.parse(call.opts.body), { id: 'HL-INV-1785416183523' });
});
