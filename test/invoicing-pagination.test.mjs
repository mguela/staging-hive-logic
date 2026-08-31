// test/invoicing-pagination.test.mjs
// 2026-08-29, Chris/the user: "can we also add pagination and have the
// option to choose item per page like 10 15 20..." -- Invoicing & AR's
// list (and, since the same session, its "Group by client" view) could
// grow past what's comfortable to scroll through in one page. Adds
// IVX.page/IVX.pageSize, a Per-page selector (10/15/20/50), and Previous/
// Next controls. The flat view paginates INVOICES; the grouped view
// paginates CLIENT GROUPS (not their flattened invoices) -- flattening
// across groups to hit a row-count target would defeat the point of
// grouping.
//
// Frontend-only: runs the real script block extracted from index.html in a
// vm sandbox, same pattern as invoicing-search.test.mjs.
//
// Run with: node --test test/invoicing-pagination.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

const startSnippet = "var IVX = { invoices: [], clientsById: {}, mode: 'open', query: '', groupByClient: false, page: 0, pageSize: 10 };";
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

// issuedDate climbs strictly with i (i <= 28 keeps every date inside a
// single real month, no wraparound) -- 'all' mode sorts by issuedDate
// DESCENDING, so this makes "which invoices land on which page" fully
// predictable: page 1 is the highest i values, not invoice-number order.
function invoiceFixtures(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({ id: 'HL-INV-' + i, status: 'awaiting_payment', total: 100, balance: 100, invoiceNumber: String(1000 + i), subject: 'Job ' + i, clientId: 'C' + (i % 3), issuedDate: '2026-08-' + String(i).padStart(2, '0') });
  }
  return out;
}
const CLIENTS = { C0: { id: 'C0', name: 'Client Zero' }, C1: { id: 'C1', name: 'Client One' }, C2: { id: 'C2', name: 'Client Two' } };

function loadedWith(n) {
  const sb = makeSandbox();
  sb.IVX.invoices = invoiceFixtures(n);
  sb.IVX.clientsById = CLIENTS;
  sb.ivxSetMode('all');
  return sb;
}

test('a Per-page selector exists in the toolbar, wired to ivxSetPageSize, with 10/15/20/50 options', () => {
  const block = source.slice(start - 5000, start);
  assert.match(block, /id="ivx-pagesize"/);
  assert.match(block, /onchange="ivxSetPageSize\(this\.value\)"/);
  assert.match(block, /<option value="10" selected>10<\/option>/);
  assert.match(block, /<option value="15">15<\/option>/);
  assert.match(block, /<option value="20">20<\/option>/);
  assert.match(block, /<option value="50">50<\/option>/);
});

test('defaults to 10 per page, and the flat list only renders that many invoice cards', () => {
  const sb = loadedWith(25);
  const html = sb.els['ivx-list'].innerHTML;
  assert.equal(sb.IVX.pageSize, 10);
  assert.match(html, /Showing 1 to 10 of 25 invoices/);
  assert.match(html, /1025/); // most recent by issuedDate -- 'all' mode sorts newest first
  assert.doesNotMatch(html, /1015/, 'the 11th-newest invoice must not appear on page 1');
});

test('ivxGoToPage advances to the next page and shows the correct range', () => {
  const sb = loadedWith(25);
  sb.ivxGoToPage(1);
  const html = sb.els['ivx-list'].innerHTML;
  assert.match(html, /Showing 11 to 20 of 25 invoices/);
  assert.doesNotMatch(html, /1025/);
  assert.match(html, /1011/);
});

test('ivxSetPageSize changes how many render per page and resets to page 1', () => {
  const sb = loadedWith(25);
  sb.ivxGoToPage(2); // page 3 (0-indexed) of the default 10/page
  sb.ivxSetPageSize('20');
  assert.equal(sb.IVX.page, 0, 'changing page size must not leave a stale page index that no longer makes sense');
  const html = sb.els['ivx-list'].innerHTML;
  assert.match(html, /Showing 1 to 20 of 25 invoices/);
});

test('Previous is disabled on page 1, and Next is disabled on the last page', () => {
  const sb = loadedWith(15);
  let html = sb.els['ivx-list'].innerHTML;
  assert.match(html, /onclick="ivxGoToPage\(-1\)" disabled/);
  sb.ivxGoToPage(1);
  html = sb.els['ivx-list'].innerHTML;
  assert.match(html, /onclick="ivxGoToPage\(2\)" disabled/);
});

test('a page index that no longer exists (e.g. after a search narrows results) clamps back into range instead of rendering blank', () => {
  const sb = loadedWith(25);
  sb.ivxGoToPage(2); // page 3 of 3 (25 invoices / 10 per page)
  sb.ivxSearch('Job 1'); // matches far fewer than 21-25, page 3 no longer exists
  const html = sb.els['ivx-list'].innerHTML;
  assert.doesNotMatch(html, /No matches/, 'a stale page index must not be read as "search found nothing"');
});

test('grouping paginates CLIENT GROUPS, not flattened invoices', () => {
  const sb = loadedWith(9); // 3 clients (C0/C1/C2), 3 invoices each
  sb.ivxSetPageSize('20'); // plenty of room for all 9 invoices -- isolate the "paginate groups" behavior
  sb.ivxToggleGroup(true);
  const html = sb.els['ivx-list'].innerHTML;
  assert.match(html, /Client Zero/);
  assert.match(html, /Client One/);
  assert.match(html, /Client Two/);
  assert.match(html, /Showing 1 to 3 of 3 clients/);
});

test('switching between flat and grouped pagination does not carry a stale page count label from the other view', () => {
  const sb = loadedWith(25);
  const flatHtml = sb.els['ivx-list'].innerHTML;
  assert.match(flatHtml, /of 25 invoices/);
  sb.ivxToggleGroup(true);
  const groupedHtml = sb.els['ivx-list'].innerHTML;
  assert.match(groupedHtml, /of \d+ clients/);
  assert.doesNotMatch(groupedHtml, /of 25 invoices/);
});
