// server/bookkeeping/test/reina-scan.test.js
//
// Covers server/bookkeeping/src/reina-scan.js -- the new (task 8) receipt/OCR
// engine. No ANTHROPIC_API_KEY is set in this test run (matching every other
// test file in this suite -- see package.json/CI, none export a live key),
// so every scanReceiptWithReina() call here exercises the honest stub
// fallback path, never a live Anthropic call. That is deliberate: this file
// proves the module's *shape and safety guarantees* (never fabricates a
// value, matches annotateScanConfidence()'s expected fields, extractJson()'s
// fence-stripping/fallback-slicing), not model output quality -- there is no
// way to unit test real OCR accuracy without a network call and a real key.
//
// Run: node --test server/bookkeeping/test/reina-scan.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reinaScanConfigured, scanReceiptWithReina, extractJson } from '../src/reina-scan.js';
import { annotateScanConfidence } from '../src/reina-learning.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'reina-scan.js'), 'utf8');

// Bug fix (2026-08-07): a degenerate image (blank, degraded, unrelated to
// bookkeeping) used to force the model into a real document category
// (including "other"), inviting it to fabricate a plausible-looking vendor/
// date/amount rather than admit it couldn't read anything. A self-
// consistent fabrication also slips past the arithmetic-reconciliation
// check below, since that only catches internally inconsistent fakes.
// "unreadable" gives the model a sanctioned, honest place to land instead.
test('the classification prompt offers an explicit "unreadable" category instead of forcing a guess', () => {
  assert.match(promptSource, /receipt, vendor_bill, bank_statement, credit_card_statement, loan_statement, payroll_summary, tax_notice, unreadable, or other/);
  assert.match(promptSource, /Use "unreadable" -- never a guessed category/);
  assert.match(promptSource, /Never invent a plausible-looking vendor, date, or amount/);
});

test('an honest "unreadable" scan result is never auto-filled -- annotateScanConfidence forces review', () => {
  const scan = {
    documentType: 'unreadable',
    vendor: null, transactionDate: null, subtotal: null, total: null,
    lineItems: [],
    confidence: 0.15,
    fieldConfidence: {},
    warnings: ['Image is too blurry to identify any document.'],
  };
  const annotated = annotateScanConfidence(scan);
  assert.equal(annotated.fieldDecisions.documentType.decision, 'unknown');
  assert.notEqual(annotated.fieldDecisions.documentType.decision, 'auto_fill');
  // "unreadable" isn't a receipt/vendor_bill/statement type, so no OTHER
  // field becomes required -- only documentType itself, and its own low
  // confidence is what correctly forces review here.
  assert.equal(annotated.reviewSummary.requiresReview, true);
});

test('reinaScanConfigured() is false when ANTHROPIC_API_KEY is not set in this environment', () => {
  assert.equal(reinaScanConfigured(), false);
});

test('scanReceiptWithReina() requires imageBase64 and mimeType -- never silently proceeds without a real document', async () => {
  await assert.rejects(() => scanReceiptWithReina({}), /imageBase64 and mimeType are required/);
  await assert.rejects(() => scanReceiptWithReina({ imageBase64: 'abc' }), /imageBase64 and mimeType are required/);
  await assert.rejects(() => scanReceiptWithReina({ mimeType: 'image/png' }), /imageBase64 and mimeType are required/);
});

test('without a configured API key, scanReceiptWithReina() returns the honest stub -- echoes known fields, never fabricates unknown ones', async () => {
  const scan = await scanReceiptWithReina({
    imageBase64: Buffer.from('fake-receipt-bytes').toString('base64'),
    mimeType: 'image/png',
    vendor: 'Home Depot',
    total: 42.5
  });
  assert.equal(scan.needsAiConnection, true);
  assert.equal(scan.vendor, 'Home Depot');
  assert.equal(scan.total, 42.5);
  assert.equal(scan.documentType, 'other');
  assert.ok(Array.isArray(scan.warnings) && scan.warnings.length > 0);
  assert.ok(/ANTHROPIC_API_KEY is not configured/.test(scan.warnings[0]));
});

test('the stub never invents a vendor, date, or amount that was not already known to the caller', async () => {
  const scan = await scanReceiptWithReina({
    imageBase64: Buffer.from('fake').toString('base64'),
    mimeType: 'image/png'
  });
  assert.equal(scan.vendor, '');
  assert.equal(scan.transactionDate, '');
  assert.equal(scan.total, 0);
  assert.deepEqual(scan.lineItems, []);
});

test('the stub scan output feeds directly into annotateScanConfidence() without shape errors', async () => {
  const scan = await scanReceiptWithReina({
    imageBase64: Buffer.from('fake').toString('base64'),
    mimeType: 'image/png',
    vendor: 'ABC Supply',
    subtotal: 100,
    total: 100,
    lineItems: [{ description: 'Pipe', subtotal: 100, confidence: 0.4 }]
  });
  const annotated = annotateScanConfidence(scan);
  assert.ok(annotated.fieldDecisions);
  assert.ok(annotated.reviewSummary);
  // Low, honest confidence on a stub scan must never be reported as auto_fill.
  assert.notEqual(annotated.fieldDecisions.vendor.decision, 'auto_fill');
});

test('extractJson() parses a plain JSON object', () => {
  const result = extractJson('{"vendor":"Home Depot","total":42.5}');
  assert.equal(result.vendor, 'Home Depot');
  assert.equal(result.total, 42.5);
});

test('extractJson() strips a ```json fence before parsing', () => {
  const result = extractJson('```json\n{"vendor":"Lowes","total":10}\n```');
  assert.equal(result.vendor, 'Lowes');
  assert.equal(result.total, 10);
});

test('extractJson() falls back to slicing the first {...last} block when there is preamble text', () => {
  const result = extractJson('Here is the classification:\n{"vendor":"ABC","total":5}\nLet me know if you need anything else.');
  assert.equal(result.vendor, 'ABC');
  assert.equal(result.total, 5);
});

test('extractJson() throws a clear error when no JSON object is present at all', () => {
  assert.throws(() => extractJson('no json here'), /did not contain a parseable JSON object/);
});

test('reinaScanConfigured() and scanReceiptWithReina() never throw when called back to back (module-level client is created once, safely)', async () => {
  assert.equal(reinaScanConfigured(), false);
  const scan = await scanReceiptWithReina({ imageBase64: 'YQ==', mimeType: 'image/jpeg' });
  assert.equal(scan.needsAiConnection, true);
});
