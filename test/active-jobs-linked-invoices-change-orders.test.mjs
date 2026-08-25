// test/active-jobs-linked-invoices-change-orders.test.mjs
// jomell, 2026-08-26: "lets add a feature. it should show the connected
// invoices and change orders in this window. do that." (the Active Jobs
// job-detail modal).
//
// Both relationships already existed and needed no new schema: invoices
// carry job_id = the job's jobber_id since handleCreateInvoiceFromJob
// wrote it (confirmed in an earlier fix the same week), and a change
// order's jobId is the same jobber_id, set by the Change Orders form's job
// picker (option value = j.id). api/bookkeeping/change-orders/list.js
// already supported a ?jobId= filter; api/invoices.js needed one added.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf-8');
const INVOICES = fs.readFileSync(path.join(root, 'api', 'invoices.js'), 'utf-8');

function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  if (start === -1) throw new Error('not found: ' + decl);
  let depth = 1, i = start + decl.length;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

// ---- backend: api/invoices.js gets a job filter -----------------------------

test('getInvoicesData accepts a jobRef and filters by invoices.job_id', () => {
  const fn = extractFunction(INVOICES, 'export async function getInvoicesData({ limit, jobRef } = {}) {');
  assert.match(fn, /job_id=eq\.\$\{encodeURIComponent\(jobRef\)\}/);
});

test('omitting jobRef still returns every invoice, unfiltered', () => {
  const fn = extractFunction(INVOICES, 'export async function getInvoicesData({ limit, jobRef } = {}) {');
  assert.match(fn, /const jobFilter = jobRef \? `&job_id=eq\.\$\{encodeURIComponent\(jobRef\)\}`\s*:\s*'';/,
    'jobFilter must be empty (not throw or filter on undefined) when no jobRef is given');
});

test('the route handler passes req.query.jobRef through', () => {
  assert.match(INVOICES, /jobRef: req\.query\.jobRef/);
});

// ---- frontend: the job modal loads and renders both --------------------

test('opening a job kicks off both loaders', () => {
  const fn = extractFunction(HTML, 'function ajxOpen(jobId) {');
  assert.match(fn, /ajvLoadLinkedInvoices\(j\.id\);/);
  assert.match(fn, /ajvLoadLinkedChangeOrders\(j\.id\);/);
});

test('the invoice loader fetches by this job specifically, not the whole table', () => {
  const fn = extractFunction(HTML, 'function ajvLoadLinkedInvoices(jobId) {');
  assert.match(fn, /fetch\('\/api\/invoices\?jobRef=' \+ encodeURIComponent\(jobId\)\)/);
});

test('the change-order loader fetches by this job specifically', () => {
  const fn = extractFunction(HTML, 'function ajvLoadLinkedChangeOrders(jobId) {');
  assert.match(fn, /fetch\('\/api\/bookkeeping\/change-orders\/list\?jobId=' \+ encodeURIComponent\(jobId\)\)/);
});

test('an empty result says so honestly, rather than showing a blank section', () => {
  const invFn = extractFunction(HTML, 'function ajvLoadLinkedInvoices(jobId) {');
  assert.match(invFn, /No invoices for this job yet\./);
  const coFn = extractFunction(HTML, 'function ajvLoadLinkedChangeOrders(jobId) {');
  assert.match(coFn, /No change orders for this job yet\./);
});

test('a failed fetch clears the loading state instead of leaving "Loading…" forever', () => {
  const invFn = extractFunction(HTML, 'function ajvLoadLinkedInvoices(jobId) {');
  assert.match(invFn, /\.catch\(function \(\) \{ host\.innerHTML = ''; \}\);/);
  const coFn = extractFunction(HTML, 'function ajvLoadLinkedChangeOrders(jobId) {');
  assert.match(coFn, /\.catch\(function \(\) \{ host\.innerHTML = ''; \}\);/);
});

test('invoice rows reuse the real status pill styling, not a made-up one', () => {
  // ivxBadge already exists and colors by status (paid/past_due/etc.) --
  // this must reuse it, not duplicate the color logic.
  const fn = extractFunction(HTML, 'function ajvLoadLinkedInvoices(jobId) {');
  assert.match(fn, /ivxBadge\(i\.status\)/);
});

test('change-order amounts read from totals.cardPrice, falling back to totals.price', () => {
  // Matches the estimates engine's own card/cash pricing shape
  // (server/bookkeeping/src/change-orders.js's changeOrderTotals) --
  // must not invent a different field name.
  const fn = extractFunction(HTML, 'function ajvLoadLinkedChangeOrders(jobId) {');
  assert.match(fn, /c\.totals && \(c\.totals\.cardPrice \|\| c\.totals\.price\)/);
});

test('the modal shell has containers for both sections, in the body before line items', () => {
  const bodyStart = HTML.indexOf('<div class="ajv-body">');
  const linesLabel = HTML.indexOf('LINE ITEM ACTIVITIES', bodyStart);
  const invContainer = HTML.indexOf('id="ajv-invoices"', bodyStart);
  const coContainer = HTML.indexOf('id="ajv-cos"', bodyStart);
  assert.ok(invContainer > bodyStart && invContainer < linesLabel);
  assert.ok(coContainer > bodyStart && coContainer < linesLabel);
});
