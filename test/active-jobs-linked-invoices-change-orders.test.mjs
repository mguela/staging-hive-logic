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
const TRACK1 = fs.readFileSync(path.join(root, 'api', 'track1.js'), 'utf-8');

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

// ---- 2026-08-26 follow-up: title/label, editable, click-through -----------
// jomell: "the invoices and job order should have a title or label rather
// than just the number... their names should be edittable... also the
// invoices and change order should be clickable and when it is clicked, it
// should redirect to the actual invoices page and change orders page for
// that job."

test('an invoice row shows its subject, not just the bare number', () => {
  const fn = extractFunction(HTML, 'function ajvLoadLinkedInvoices(jobId) {');
  assert.match(fn, /hlEsc\(i\.subject \|\| 'Untitled invoice'\)/);
});

test('a change-order row shows its description, not just the coNumber', () => {
  const fn = extractFunction(HTML, 'function ajvLoadLinkedChangeOrders(jobId) {');
  assert.match(fn, /hlEsc\(c\.description \|\| '\(no description\)'\)/);
});

test('the invoice edit pencil is offered only on a still-draft, HiveLogic-created invoice', () => {
  const fn = extractFunction(HTML, 'function ajvLoadLinkedInvoices(jobId) {');
  assert.match(fn, /ivxIsLocal\(i\) && i\.status === 'draft' \?/);
  assert.match(fn, /ajvEditInvoice\(/);
});

test('the change-order edit pencil is offered only in draft or sent status', () => {
  const fn = extractFunction(HTML, 'function ajvLoadLinkedChangeOrders(jobId) {');
  assert.match(fn, /c\.lifecycleStatus === 'draft' \|\| c\.lifecycleStatus === 'sent'/);
  assert.match(fn, /ajvEditCoDescription\(/);
});

test('the edit pencil click does not also trigger the row\'s navigate-away handler', () => {
  const invFn = extractFunction(HTML, 'function ajvLoadLinkedInvoices(jobId) {');
  assert.match(invFn, /event\.stopPropagation\(\);ajvEditInvoice\(/);
  const coFn = extractFunction(HTML, 'function ajvLoadLinkedChangeOrders(jobId) {');
  assert.match(coFn, /event\.stopPropagation\(\);ajvEditCoDescription\(/);
});

test('the edit popup offers both title and amount, prefilled from the invoice being edited', () => {
  const fn = extractFunction(HTML, 'function ajvEditInvoice(id) {');
  assert.match(fn, /id="eiv-subject"/);
  assert.match(fn, /id="eiv-amount"/);
  assert.match(fn, /var current = \(window\._ajvInvEdit \|\| \{\}\)\[id\] \|\| \{\};/);
});

test('saving posts both the title and amount to update_invoice and reloads this job\'s list', () => {
  const fn = extractFunction(HTML, 'function ajvEditInvoice(id) {');
  assert.match(fn, /hlApiPost\('update_invoice', \{ id: id, subject: subject, amount: amount \}\)/);
  assert.match(fn, /if \(AJX\.job\) ajvLoadLinkedInvoices\(AJX\.job\.id\);/);
});

test('a blank title or a non-positive amount is refused before saving', () => {
  const fn = extractFunction(HTML, 'function ajvEditInvoice(id) {');
  assert.match(fn, /if \(!subject\) \{ err\.textContent = 'A title is required\.'/);
  assert.match(fn, /if \(!isFinite\(amount\) \|\| amount <= 0\)/);
});

test('saving a change-order description posts to the update-description action and reloads this job\'s list', () => {
  const fn = extractFunction(HTML, 'function ajvEditCoDescription(id) {');
  assert.match(fn, /coApi\('update-description', \{ id: id, description: description \}\)/);
  assert.match(fn, /if \(AJX\.job\) ajvLoadLinkedChangeOrders\(AJX\.job\.id\);/);
});

test('an invoice row is clickable and jumps to the real Invoicing tab', () => {
  const fn = extractFunction(HTML, 'function ajvLoadLinkedInvoices(jobId) {');
  assert.match(fn, /onclick="ajvGoToInvoice\(/);
});

test('ajvGoToInvoice switches to the real invx view and reloads', () => {
  const fn = extractFunction(HTML, 'function ajvGoToInvoice(id, status) {');
  assert.match(fn, /showView\('invx'\)/);
  assert.match(fn, /ivxLoad\(\)/);
  assert.match(fn, /ajvGoToInvoiceWhenReady\(id, 0\)/);
});

test('ajvGoToInvoice lands an open/draft invoice on "Open & drafts" (where it already is), and only a paid/written-off one on "All recent"', () => {
  // jomell, 2026-08-26: forcing "all" unconditionally sent a DRAFT invoice
  // to the wrong tab -- it was never hidden by the open filter to begin
  // with. Must reuse ivxIsOpen's own definition of "open" rather than a
  // second, possibly-drifting copy of that rule.
  const fn = extractFunction(HTML, 'function ajvGoToInvoice(id, status) {');
  assert.match(fn, /ivxIsOpen\(\{ status: status \}\)/);
  assert.match(fn, /ivxSetMode\(typeof ivxIsOpen === 'function' && ivxIsOpen\(\{ status: status \}\) \? 'open' : 'all'\)/);
});

test('the invoice row passes its own status through to ajvGoToInvoice, not just the id', () => {
  const fn = extractFunction(HTML, 'function ajvLoadLinkedInvoices(jobId) {');
  assert.match(fn, /ajvGoToInvoice\(\\'' \+ idEsc \+ '\\',\\'' \+ hlEsc\(i\.status \|\| ''\) \+ '\\'\)/);
});

test('a change-order row is clickable and jumps to the real Change Orders tab', () => {
  const fn = extractFunction(HTML, 'function ajvLoadLinkedChangeOrders(jobId) {');
  assert.match(fn, /onclick="ajvGoToChangeOrder\(/);
});

test('ajvGoToChangeOrder switches to the real co view and reloads', () => {
  const fn = extractFunction(HTML, 'function ajvGoToChangeOrder(id) {');
  assert.match(fn, /showView\('co'\)/);
  assert.match(fn, /coLoadList\(\)/);
  assert.match(fn, /ajvGoToCoWhenReady\(id, 0\)/);
});

test('the jump-to functions poll for the row instead of assuming it loaded instantly, and give up honestly', () => {
  const invWait = extractFunction(HTML, 'function ajvGoToInvoiceWhenReady(id, attempt) {');
  assert.match(invWait, /getElementById\('ivxrow-' \+ id\)/);
  assert.match(invWait, /attempt \|\| 0\) < 30/);
  assert.match(invWait, /chirpToast\(/);
  const coWait = extractFunction(HTML, 'function ajvGoToCoWhenReady(id, attempt) {');
  assert.match(coWait, /getElementById\('corow-' \+ id\)/);
  assert.match(coWait, /attempt \|\| 0\) < 30/);
});

test('the real Invoicing and Change Orders tabs give each row a stable id to jump to', () => {
  const ivxFn = extractFunction(HTML, 'function ivxCard(i){');
  assert.match(ivxFn, /id="ivxrow-'\+ivxEsc\(i\.id\)\+'"/);
  const coFn = extractFunction(HTML, 'function coCard(co){');
  assert.match(coFn, /id="corow-'\+cid\+'"/);
});

// ---- backend: editing an invoice's title and amount ------------------------

test('the resource dispatch routes update_invoice to the real handler', () => {
  assert.match(TRACK1, /resource === 'update_invoice'/);
  assert.match(TRACK1, /handleUpdateInvoice\(req, res\)/);
});

test('updating an invoice requires a signed-in user and a HiveLogic-created invoice', () => {
  const fn = extractFunction(TRACK1, 'async function handleUpdateInvoice(req, res) {');
  assert.match(fn, /getRequestingProfile\(req\)/);
  assert.match(fn, /if \(!id\.startsWith\('HL-INV-'\)\)/);
});

test('a Jobber-synced invoice is refused with an explanation, not a silent write that the next sync would revert', () => {
  const fn = extractFunction(TRACK1, 'async function handleUpdateInvoice(req, res) {');
  assert.match(fn, /edit it there/);
});

test('an empty title is rejected before any database write', () => {
  const fn = extractFunction(TRACK1, 'async function handleUpdateInvoice(req, res) {');
  const guardIdx = fn.indexOf("if (!subject) return res.status(400)");
  const patchIdx = fn.indexOf('supabaseRequest(');
  assert.ok(guardIdx > -1 && patchIdx > guardIdx, 'the blank-title check must happen before any lookup or write');
});

test('an invoice that has already been sent refuses the edit -- only a draft can still change', () => {
  const fn = extractFunction(TRACK1, 'async function handleUpdateInvoice(req, res) {');
  assert.match(fn, /if \(current\.invoice_status !== 'draft'\)/);
  assert.match(fn, /already been sent/);
});

test('a valid custom amount also updates subtotal and balance, not just total', () => {
  const fn = extractFunction(TRACK1, 'async function handleUpdateInvoice(req, res) {');
  assert.match(fn, /patch\.total = rounded/);
  assert.match(fn, /patch\.subtotal = rounded/);
  assert.match(fn, /patch\.balance = rounded/);
});

test('a single-line invoice has its one line item re-priced to match, keeping the itemization honest', () => {
  const fn = extractFunction(TRACK1, 'async function handleUpdateInvoice(req, res) {');
  assert.match(fn, /if \(lines\.length === 1\)/);
  assert.match(fn, /unitPrice: rounded, lineTotal: rounded/);
});

test('the update is looked up and written by jobber_id, like every other invoice action', () => {
  const fn = extractFunction(TRACK1, 'async function handleUpdateInvoice(req, res) {');
  assert.match(fn, /invoices\?jobber_id=eq\.\$\{encodeURIComponent\(id\)\}&select=invoice_status,line_items&limit=1/);
  assert.match(fn, /invoices\?jobber_id=eq\.\$\{encodeURIComponent\(id\)\}`, \{\s*method: 'PATCH'/);
});
