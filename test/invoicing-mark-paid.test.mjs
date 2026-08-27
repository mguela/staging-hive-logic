// test/invoicing-mark-paid.test.mjs
// Invoicing mark-paid (2026-08-17). The Invoicing screen can now record that an
// invoice was paid, but ONLY for invoices HiveLogic created itself ("HL-INV-*").
//
// The rule these tests exist to protect: rows synced from Jobber are owned by
// api/jobber/sync.js. Writing invoice_status on one of those here would be
// silently reverted on the next sync -- the user would see a status change that
// undoes itself. So the server refuses those ids outright, and the card renders
// a DISABLED button explaining why instead of one that fakes success.
//
// Also pinned: mark-paid is a status write only. No card is charged, nothing is
// sent to the client, no Authorize.Net/Twilio call.
//
// Fully mocked -- no network, no DB, no real secret.
// Run with: node --experimental-test-module-mocks --test test/invoicing-mark-paid.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

// ---------------------------------------------------------------- backend

let patchCalls = [];
let patchResult = { ok: true, rows: [{ jobber_id: 'HL-INV-1', invoice_status: 'paid' }] };

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (p, opts) => {
      const o = opts || {};
      if (o.method === 'PATCH') {
        patchCalls.push({ path: String(p), body: JSON.parse(o.body) });
        if (!patchResult.ok) return { ok: false, text: async () => 'boom' };
        return { ok: true, json: async () => patchResult.rows };
      }
      // getRequestingProfile's profiles lookup
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

// getRequestingProfile resolves the bearer against Supabase auth via global fetch.
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

async function markPaid(body, method = 'POST') {
  patchCalls = [];
  const req = {
    method,
    query: { resource: 'mark_invoice_paid' },
    headers: { authorization: 'Bearer test-user-token' },
    body,
  };
  const r = res();
  await trackMod.default(req, r);
  return r;
}

test('mark_invoice_paid refuses a Jobber-synced invoice and writes nothing', async () => {
  const r = await markPaid({ id: 'Z2lkOi8vSm9iYmVyL0ludm9pY2UvMTIz' });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /synced from Jobber/i);
  assert.deepEqual(patchCalls, [], 'a Jobber-owned row must never be patched here');
});

test('mark_invoice_paid sets status paid on a HiveLogic-created invoice', async () => {
  patchResult = { ok: true, rows: [{ jobber_id: 'HL-INV-1785416183523', invoice_status: 'paid' }] };
  const r = await markPaid({ id: 'HL-INV-1785416183523' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(patchCalls.length, 1);
  assert.match(patchCalls[0].path, /jobber_id=eq\.HL-INV-1785416183523/);
  assert.equal(patchCalls[0].body.invoice_status, 'paid');
});

test('mark_invoice_paid writes status only -- it never touches payment/total fields', async () => {
  await markPaid({ id: 'HL-INV-1785416183523' });
  const keys = Object.keys(patchCalls[0].body).sort();
  assert.deepEqual(keys, ['invoice_status', 'jobber_updated_at'],
    'mark-paid must not move money fields (payments/total/balance) -- it records a status, it does not process a payment');
});

test('mark_invoice_paid 404s when the invoice is gone', async () => {
  patchResult = { ok: true, rows: [] };
  const r = await markPaid({ id: 'HL-INV-does-not-exist' });
  assert.equal(r.statusCode, 404);
  assert.equal(r.body.ok, false);
  patchResult = { ok: true, rows: [{ jobber_id: 'HL-INV-1', invoice_status: 'paid' }] };
});

test('mark_invoice_paid requires an id', async () => {
  const r = await markPaid({});
  assert.equal(r.statusCode, 400);
  assert.deepEqual(patchCalls, []);
});

test('mark_invoice_paid is POST-only', async () => {
  const r = await markPaid({ id: 'HL-INV-1' }, 'GET');
  assert.equal(r.statusCode, 405);
  assert.deepEqual(patchCalls, []);
});

// --------------------------------------------------------------- frontend

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

const startSnippet = "var IVX = { invoices: [], clientsById: {}, mode: 'open', query: '' };";
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
};
sandbox.fetch = (url, opts) => {
  sandbox.fetchCalls.push({ url, opts });
  return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
};
vm.createContext(sandbox);
vm.runInContext(source.slice(start, end), sandbox);

const JOBBER_UNPAID = { id: 'Z2lkOi8vSm9iYmVy', status: 'awaiting_payment', total: 500, balance: 500, invoiceNumber: '101' };
const LOCAL_DRAFT = { id: 'HL-INV-1785416183523', status: 'draft', total: 2000, balance: 2000, invoiceNumber: '1785416183' };
const LOCAL_PAID = { id: 'HL-INV-1785416183523', status: 'paid', total: 2000, balance: 0, invoiceNumber: '1785416183' };

test('a HiveLogic-created invoice gets a live Mark paid button', () => {
  const html = sandbox.ivxCard(LOCAL_DRAFT);
  assert.match(html, /onclick="ivxMarkPaid\('HL-INV-1785416183523'\)"/);
  assert.doesNotMatch(html, /disabled/);
});

test('a Jobber-synced invoice gets a disabled button that says why, not a working one', () => {
  const html = sandbox.ivxCard(JOBBER_UNPAID);
  assert.match(html, /disabled/);
  assert.match(html, /title="[^"]*Jobber\/QuickBooks/);
  assert.doesNotMatch(html, /ivxMarkPaid/,
    'a Jobber-owned invoice must not offer a click path that would be reverted by the next sync');
});

test('an already-paid invoice offers no mark-paid button at all', () => {
  assert.doesNotMatch(sandbox.ivxCard(LOCAL_PAID), /Mark paid/);
});

test('ivxMarkPaid posts the id to the mark_invoice_paid resource', () => {
  sandbox.fetchCalls = [];
  sandbox.ivxMarkPaid('HL-INV-1785416183523');
  assert.equal(sandbox.fetchCalls.length, 1);
  const call = sandbox.fetchCalls[0];
  assert.match(call.url, /resource=mark_invoice_paid/);
  assert.equal(call.opts.method, 'POST');
  assert.deepEqual(JSON.parse(call.opts.body), { id: 'HL-INV-1785416183523' });
});

test('ivxIsLocal only claims ids HiveLogic minted itself', () => {
  assert.equal(sandbox.ivxIsLocal({ id: 'HL-INV-1' }), true);
  assert.equal(sandbox.ivxIsLocal({ id: 'Z2lkOi8vSm9iYmVy' }), false);
  assert.equal(sandbox.ivxIsLocal({}), false);
  assert.equal(sandbox.ivxIsLocal(null), false);
  assert.equal(sandbox.ivxIsLocal({ id: 'x-HL-INV-1' }), false, 'prefix must anchor at the start');
});

test('the invoicing list loader carries no leftover debug logging', () => {
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /console\.log/,
    'ivxLoad used to console.log the token state and localStorage key names on every open');
});
