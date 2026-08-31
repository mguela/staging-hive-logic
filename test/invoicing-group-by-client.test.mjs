// test/invoicing-group-by-client.test.mjs
// 2026-08-29, Chris/the user: "I need to categorize the invoices per
// company/client" -- Invoicing & AR's flat, sorted-by-status list of every
// open/recent invoice made it hard to see one client's whole picture at a
// glance. Adds an opt-in "Group by client" toggle (IVX.groupByClient) that
// buckets the same already-loaded rows (ivxClientName/IVX.clientsById
// already resolved per-invoice client names, just never grouped by them)
// into one collapsible section per client, subtotaled by balance owed and
// sorted highest-owed first.
//
// Frontend-only: runs the real script block extracted from index.html in a
// vm sandbox, same pattern as invoicing-search.test.mjs.
//
// Run with: node --test test/invoicing-group-by-client.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

const startSnippet = "var IVX = { invoices: [], clientsById: {}, mode: 'open', query: '', groupByClient: false };";
const start = source.indexOf(startSnippet);
assert.notEqual(start, -1, 'invoicing script block not found in index.html, or the IVX initializer changed shape');
const end = source.indexOf('</script>', start);
assert.notEqual(end, -1, 'invoicing script block has no closing tag');

function fakeEl() {
  return { _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; } };
}

function makeSandbox() {
  const els = { 'ivx-list': fakeEl(), 'ivx-summary': fakeEl() };
  const sandbox = {
    window: { API: '' },
    document: { getElementById: (id) => els[id] || null },
    hlTokenSync: () => 'tok',
    chirpToast: () => {},
    console,
    els,
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end), sandbox);
  return sandbox;
}

const INVOICES = [
  { id: 'HL-INV-1', status: 'awaiting_payment', total: 500, balance: 500, invoiceNumber: '1001', subject: 'Deck repair', clientId: 'C1', issuedDate: '2026-08-20' },
  { id: 'HL-INV-2', status: 'past_due', total: 4200, balance: 4200, invoiceNumber: '1002', subject: 'Roof replacement', clientId: 'C2', issuedDate: '2026-08-21' },
  { id: 'HL-INV-3', status: 'paid', total: 900, balance: 0, invoiceNumber: '1003', subject: 'Gutter cleaning', clientId: 'C1', issuedDate: '2026-08-19' },
  { id: 'HL-INV-4', status: 'awaiting_payment', total: 300, balance: 300, invoiceNumber: '1004', subject: 'Fence repair', clientId: 'C1', issuedDate: '2026-08-22' },
];
const CLIENTS = { C1: { id: 'C1', name: 'Jomell Alba' }, C2: { id: 'C2', name: 'Sarah Jones' } };

function loaded() {
  const sb = makeSandbox();
  sb.IVX.invoices = INVOICES.slice();
  sb.IVX.clientsById = CLIENTS;
  sb.ivxSetMode('all');
  return sb;
}

test('a "Group by client" toggle exists in the toolbar, wired to ivxToggleGroup', () => {
  const block = source.slice(start - 5000, start);
  assert.match(block, /id="ivx-group-toggle"/);
  assert.match(block, /onchange="ivxToggleGroup\(this\.checked\)"/);
});

test('ivxToggleGroup sets IVX.groupByClient and re-renders', () => {
  const sb = loaded();
  assert.equal(sb.IVX.groupByClient, false);
  sb.ivxToggleGroup(true);
  assert.equal(sb.IVX.groupByClient, true);
});

test('grouped view buckets invoices under their real client name, not a flat list', () => {
  const sb = loaded();
  sb.ivxToggleGroup(true);
  const html = sb.els['ivx-list'].innerHTML;
  assert.match(html, /Jomell Alba/);
  assert.match(html, /Sarah Jones/);
  // Jomell Alba has 3 invoices (C1) in one group.
  assert.match(html, /3 invoices/);
  assert.match(html, /1 invoice</); // Sarah Jones has exactly 1
});

test('groups are subtotaled by balance owed, and sorted highest-owed first', () => {
  const sb = loaded();
  sb.ivxToggleGroup(true);
  const html = sb.els['ivx-list'].innerHTML;
  // Sarah Jones owes $4,200 (one invoice), Jomell Alba owes $800 total
  // (500 + 0 paid + 300) -- Sarah's group must render before Jomell's.
  const sarahAt = html.indexOf('Sarah Jones');
  const jomellAt = html.indexOf('Jomell Alba');
  assert.ok(sarahAt >= 0 && jomellAt >= 0);
  assert.ok(sarahAt < jomellAt, 'the higher-balance client group must render first');
  assert.match(html, /\$4,200\.00 owed/);
  assert.match(html, /\$800\.00 owed/);
});

test('a client with nothing owed (fully paid) says so honestly, not $0.00', () => {
  const sb = makeSandbox();
  sb.IVX.invoices = [{ id: 'HL-INV-5', status: 'paid', total: 200, balance: 0, invoiceNumber: '1005', subject: 'Paint touch-up', clientId: 'C3', issuedDate: '2026-08-18' }];
  sb.IVX.clientsById = { C3: { id: 'C3', name: 'Paid In Full LLC' } };
  sb.ivxSetMode('all');
  sb.ivxToggleGroup(true);
  const html = sb.els['ivx-list'].innerHTML;
  assert.match(html, /Nothing owed/);
  assert.doesNotMatch(html, /\$0\.00 owed/);
});

test('grouping still respects the active search filter', () => {
  const sb = loaded();
  sb.ivxToggleGroup(true);
  sb.ivxSearch('roof');
  const html = sb.els['ivx-list'].innerHTML;
  assert.match(html, /Sarah Jones/);
  assert.doesNotMatch(html, /Jomell Alba/, 'a client with no matching invoice must not get an empty group');
});

test('an invoice with no clientId groups under an honest placeholder, not a blank header', () => {
  const sb = makeSandbox();
  sb.IVX.invoices = [{ id: 'HL-INV-6', status: 'draft', total: 100, balance: 100, invoiceNumber: '1006', subject: 'Misc', clientId: null, issuedDate: '2026-08-18' }];
  sb.IVX.clientsById = {};
  sb.ivxSetMode('all');
  sb.ivxToggleGroup(true);
  const html = sb.els['ivx-list'].innerHTML;
  assert.match(html, /No client on file/);
});

test('the client name in a group header is escaped, not injected raw', () => {
  const sb = makeSandbox();
  sb.IVX.invoices = [{ id: 'HL-INV-7', status: 'draft', total: 100, balance: 100, invoiceNumber: '1007', subject: 'x', clientId: 'C9', issuedDate: '2026-08-18' }];
  sb.IVX.clientsById = { C9: { id: 'C9', name: '<img src=x onerror=alert(1)>' } };
  sb.ivxSetMode('all');
  sb.ivxToggleGroup(true);
  const html = sb.els['ivx-list'].innerHTML;
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('turning grouping back off restores the flat list', () => {
  const sb = loaded();
  sb.ivxToggleGroup(true);
  sb.ivxToggleGroup(false);
  const html = sb.els['ivx-list'].innerHTML;
  assert.doesNotMatch(html, /class="ivx-group"/);
  assert.match(html, /1001/);
  assert.match(html, /1002/);
});
