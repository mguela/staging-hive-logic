// test/active-jobs-invoice-popup-and-email.test.mjs
// jomell, 2026-08-25: "in active jobs, when 'creating invoice from this
// job' there should be our own popup rather than googles popup. and there
// can be multiple invoices make sure to link it to their jobs. also the
// client should be informed or mailed about the invoice since they will
// be making a deposit for this."

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf-8');
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

// ---- 1. own popup instead of window.confirm --------------------------------

test('the already-has-an-invoice warning no longer uses window.confirm', () => {
  const fn = extractFunction(HTML, 'function ajvMakeInvoice(allowDuplicate) {');
  const code = fn.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /window\.confirm/);
  assert.match(fn, /ajvConfirmSecondInvoice\(r\.existing \|\| \[\]\)/);
});

test('the replacement is a real hlModal, not a silent no-op', () => {
  const fn = extractFunction(HTML, 'function ajvConfirmSecondInvoice(existing) {');
  assert.match(fn, /hlModal\(/);
});

test('confirming creates the second invoice; cancelling just closes the popup', () => {
  const fn = extractFunction(HTML, 'function ajvConfirmSecondInvoice(existing) {');
  assert.match(fn, /ajvMakeInvoice\(true\);document\.getElementById\(\\?'hlmodal\\?'\)\.remove\(\)/);
  assert.match(fn, /Cancel<\/button>/);
});

test('the popup lists the existing invoices by number and status', () => {
  const fn = extractFunction(HTML, 'function ajvConfirmSecondInvoice(existing) {');
  assert.match(fn, /i\.invoice_number/);
  assert.match(fn, /i\.invoice_status/);
});

// ---- 2. multiple invoices stay linked to their job --------------------------

test('every invoice created from a job carries that job\'s id, first or Nth', () => {
  const fn = extractFunction(TRACK1, 'async function handleCreateInvoiceFromJob(req, res) {');
  // job_id/job_uuid are set unconditionally in the insert row, not inside
  // the "only if this is the first invoice" branch -- a duplicate invoice
  // must be just as linked as the original.
  const rowStart = fn.indexOf('const row = {');
  const rowBlock = fn.slice(rowStart, fn.indexOf('};', rowStart));
  assert.match(rowBlock, /job_id: job\.jobber_id/);
  assert.match(rowBlock, /job_uuid: job\.uuid_id \|\| null/);
  // And that row construction is reached regardless of allowDuplicate --
  // the early return for an unconfirmed duplicate happens well before it.
  const guardIdx = fn.indexOf("needsConfirm: true");
  assert.ok(guardIdx > -1 && guardIdx < rowStart, 'the duplicate guard must return before building the row, not skip linking it');
});

test('a duplicate invoice is only created after explicit confirmation, never silently', () => {
  const fn = extractFunction(TRACK1, 'async function handleCreateInvoiceFromJob(req, res) {');
  assert.match(fn, /if \(prior\.length && b\.allowDuplicate !== true\)/);
});

// ---- 3. email the client about the invoice ----------------------------------

test('the resource dispatch routes send_invoice_email to the real handler', () => {
  assert.match(TRACK1, /resource === 'send_invoice_email'/);
  assert.match(TRACK1, /handleSendInvoiceEmail\(req, res\)/);
});

test('the handler requires a signed-in user and a HiveLogic-created invoice', () => {
  const fn = extractFunction(TRACK1, 'async function handleSendInvoiceEmail(req, res) {');
  assert.match(fn, /getRequestingProfile\(req\)/);
  assert.match(fn, /if \(!id\.startsWith\('HL-INV-'\)\)/);
});

test('a missing client email or unconfigured Resend refuses cleanly, not a crash', () => {
  const fn = extractFunction(TRACK1, 'async function handleSendInvoiceEmail(req, res) {');
  assert.match(fn, /if \(!client \|\| !client\.email\) return res\.status\(422\)/);
  assert.match(fn, /if \(!isEmailConfigured\(\)\) return res\.status\(422\)/);
});

test('the email never offers a "pay now" link -- no live payment processor exists', () => {
  const fn = extractFunction(TRACK1, 'async function handleSendInvoiceEmail(req, res) {');
  assert.doesNotMatch(fn, /pay.?now/i);
  assert.doesNotMatch(fn, /href=/i, 'no link at all, fake or otherwise, belongs in this email');
});

test('a successful send moves a draft invoice to awaiting_payment, but leaves other statuses alone', () => {
  const fn = extractFunction(TRACK1, 'async function handleSendInvoiceEmail(req, res) {');
  assert.match(fn, /if \(invoice\.invoice_status === 'draft'\)/);
  assert.match(fn, /invoice_status: 'awaiting_payment'/);
});

test('a failed send never changes the invoice status', () => {
  const fn = extractFunction(TRACK1, 'async function handleSendInvoiceEmail(req, res) {');
  const sendIdx = fn.indexOf("sendEmail(");
  const patchIdx = fn.indexOf("invoice_status: 'awaiting_payment'");
  const guardIdx = fn.indexOf('if (!sent.ok) return');
  assert.ok(sendIdx > -1 && guardIdx > sendIdx && patchIdx > guardIdx,
    'the status patch must be unreachable when the send itself failed');
});

test('the frontend Send-to-client button only appears on a not-yet-paid, HiveLogic-created invoice', () => {
  const fn = extractFunction(HTML, 'function ivxCard(i){');
  assert.match(fn, /ivxIsLocal\(i\) && i\.status!=='paid' && i\.status!=='bad_debt'/);
  assert.match(fn, /ivxSendEmail\(/);
});

test('the button label reflects whether this is the first send or a resend', () => {
  const fn = extractFunction(HTML, 'function ivxCard(i){');
  assert.match(fn, /i\.status==='draft'\?'Send to client':'Resend to client'/);
});

test('ivxSendEmail reports the real error and re-enables the button on failure', () => {
  const fn = extractFunction(HTML, 'function ivxSendEmail(id){');
  assert.match(fn, /if\(d&&d\.ok\)/);
  assert.match(fn, /btn\.disabled=false; btn\.textContent='Send to client';/);
});

// ---- 2026-08-26 follow-up: customizable title + amount --------------------
// jomell: "when creating an invoice from this job, the amount should be
// customizable... since its going to be just a draft first. the name/label
// should be customizable as well as the amount."

test('the Create Invoice button opens the new popup instead of creating immediately', () => {
  assert.match(HTML, /id="ajv-inv" onclick="ajvOpenCreateInvoiceModal\(\)"/);
});

test('the popup pre-fills the job\'s own title and its line-items total (or estimated value if none)', () => {
  const fn = extractFunction(HTML, 'function ajvOpenCreateInvoiceModal() {');
  assert.match(fn, /value="' \+ hlEsc\(AJX\.job\.title \|\| ''\) \+ '"/);
  assert.match(fn, /var defaultAmount = \(AJX\.lines && AJX\.lines\.length\) \? ajvLinesSum\(\) : \(Number\(AJX\.job\.total\) \|\| 0\);/);
});

test('a blank title or a non-positive amount is refused before anything is created', () => {
  const fn = extractFunction(HTML, 'function ajvOpenCreateInvoiceModal() {');
  assert.match(fn, /if \(!subject\) \{ err\.textContent = 'A title is required\.'/);
  assert.match(fn, /if \(!isFinite\(amount\) \|\| amount <= 0\)/);
});

test('confirming stores the custom title/amount and only then calls the real create action', () => {
  const fn = extractFunction(HTML, 'function ajvOpenCreateInvoiceModal() {');
  assert.match(fn, /window\._ajvPendingInvoice = \{ subject: subject, amount: amount \};/);
  assert.match(fn, /ajvMakeInvoice\(false\);/);
});

test('ajvMakeInvoice sends the custom title/amount through to create_invoice_from_job', () => {
  const fn = extractFunction(HTML, 'function ajvMakeInvoice(allowDuplicate) {');
  assert.match(fn, /var pending = window\._ajvPendingInvoice \|\| \{\};/);
  assert.match(fn, /subject: pending\.subject, amount: pending\.amount/);
});

test('a successful create clears the pending state so a later plain retry cannot reuse a stale amount', () => {
  const fn = extractFunction(HTML, 'function ajvMakeInvoice(allowDuplicate) {');
  const clearIdx = fn.indexOf('window._ajvPendingInvoice = null;');
  const toastIdx = fn.indexOf("Draft invoice for");
  assert.ok(clearIdx > -1 && clearIdx < toastIdx, 'must clear before reporting success');
});
