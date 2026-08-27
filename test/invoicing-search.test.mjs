// test/invoicing-search.test.mjs
// jomell, 2026-08-27: a search bar for Invoicing & AR -- by invoice number,
// client name, or title. Filters before the "All recent" 150-row cap (not
// after), so a search still finds an older invoice that cap would
// otherwise hide.
//
// Frontend-only: runs the real script block extracted from index.html in a
// vm sandbox, same pattern as invoicing-mark-paid.test.mjs /
// invoicing-delete.test.mjs.
//
// Run with: node --test test/invoicing-search.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

const startSnippet = "var IVX = { invoices: [], clientsById: {}, mode: 'open', query: '' };";
const start = source.indexOf(startSnippet);
assert.notEqual(start, -1, 'invoicing script block not found in index.html, or IVX.query was never added');
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
  { id: 'HL-INV-1', status: 'draft', total: 500, balance: 500, invoiceNumber: '1001', subject: 'Deck repair', clientId: 'C1', issuedDate: '2026-08-20' },
  { id: 'HL-INV-2', status: 'awaiting_payment', total: 4200, balance: 4200, invoiceNumber: '1002', subject: 'Roof replacement', clientId: 'C2', issuedDate: '2026-08-21' },
  { id: 'HL-INV-3', status: 'paid', total: 900, balance: 0, invoiceNumber: '1003', subject: 'Gutter cleaning', clientId: 'C1', issuedDate: '2026-08-19' },
];
const CLIENTS = { C1: { id: 'C1', name: 'Jomell Alba' }, C2: { id: 'C2', name: 'Sarah Jones' } };

function loaded() {
  const sb = makeSandbox();
  sb.IVX.invoices = INVOICES.slice();
  sb.IVX.clientsById = CLIENTS;
  return sb;
}

test('a search bar exists in the Invoicing & AR toolbar, wired to ivxSearch', () => {
  const block = source.slice(start - 5000, start);
  assert.match(block, /id="ivx-search"/);
  assert.match(block, /oninput="ivxSearch\(this\.value\)"/);
});

test('ivxMatchesQuery matches by invoice number', () => {
  const sb = makeSandbox();
  assert.equal(sb.ivxMatchesQuery(INVOICES[0], '1001'), true);
  assert.equal(sb.ivxMatchesQuery(INVOICES[0], '1002'), false);
});

test('ivxMatchesQuery matches by title/subject, case-insensitively', () => {
  const sb = makeSandbox();
  assert.equal(sb.ivxMatchesQuery(INVOICES[1], 'roof'), true);
  assert.equal(sb.ivxMatchesQuery(INVOICES[1], 'ROOF'), true);
});

test('ivxMatchesQuery matches by client name, resolved through clientsById', () => {
  const sb = loaded();
  assert.equal(sb.ivxMatchesQuery(INVOICES[1], 'sarah'), true);
  assert.equal(sb.ivxMatchesQuery(INVOICES[0], 'sarah'), false);
});

test('an empty query matches everything', () => {
  const sb = makeSandbox();
  assert.equal(sb.ivxMatchesQuery(INVOICES[0], ''), true);
});

test('ivxSearch stores the query and re-renders the list', () => {
  const sb = loaded();
  sb.ivxSetMode('all');
  sb.ivxSearch('roof');
  assert.equal(sb.IVX.query, 'roof');
  assert.match(sb.els['ivx-list'].innerHTML, /1002/);
  assert.doesNotMatch(sb.els['ivx-list'].innerHTML, /1001/);
});

test('search filters within Open & drafts too, not just All recent', () => {
  const sb = loaded();
  // 'gutter cleaning' (HL-INV-3) is paid, so it's excluded from Open & drafts
  // regardless of the query -- the mode filter and the search filter combine.
  sb.ivxSearch('gutter');
  assert.match(sb.els['ivx-list'].innerHTML, /No matches/);
});

test('a query that matches nothing shows the search term back, not a generic empty state', () => {
  const sb = loaded();
  sb.ivxSetMode('all');
  sb.ivxSearch('nonexistent client xyz');
  assert.match(sb.els['ivx-list'].innerHTML, /No matches/);
  assert.match(sb.els['ivx-list'].innerHTML, /nonexistent client xyz/);
});

test('the no-matches message escapes the query rather than injecting it raw', () => {
  const sb = loaded();
  sb.ivxSetMode('all');
  sb.ivxSearch('<img src=x onerror=alert(1)>');
  const html = sb.els['ivx-list'].innerHTML;
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('clearing the search restores the full list', () => {
  const sb = loaded();
  sb.ivxSetMode('all');
  sb.ivxSearch('roof');
  sb.ivxSearch('');
  const html = sb.els['ivx-list'].innerHTML;
  assert.match(html, /1001/);
  assert.match(html, /1002/);
  assert.match(html, /1003/);
});
