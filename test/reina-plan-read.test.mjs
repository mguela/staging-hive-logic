// test/reina-plan-read.test.mjs
//
// Covers api/_lib/reina-plan-read.js -- the vision engine behind HiveGrid's
// "REINA READS SHEET" / "READ ALL SHEETS" buttons. No ANTHROPIC_API_KEY is
// set in this test run (matching every other test file in this suite), so
// every scanPlanSheetWithReina() call here exercises the honest stub
// fallback, never a live Anthropic call -- this proves the module's shape
// and safety guarantees (never fabricates a value, batch reads never let one
// failure take down the others), not model reading quality.
//
// Run: node --test test/reina-plan-read.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reinaPlanReadConfigured,
  scanPlanSheetWithReina,
  readPlanSheetsWithReina,
  extractJson,
} from '../api/_lib/reina-plan-read.js';

test('reinaPlanReadConfigured() is false when ANTHROPIC_API_KEY is not set in this environment', () => {
  assert.equal(reinaPlanReadConfigured(), false);
});

test('scanPlanSheetWithReina() requires imageBase64 and mimeType -- never silently proceeds without a real sheet', async () => {
  await assert.rejects(() => scanPlanSheetWithReina({}), /imageBase64 and mimeType are required/);
  await assert.rejects(() => scanPlanSheetWithReina({ imageBase64: 'abc' }), /imageBase64 and mimeType are required/);
  await assert.rejects(() => scanPlanSheetWithReina({ mimeType: 'image/png' }), /imageBase64 and mimeType are required/);
});

test('without a configured API key, scanPlanSheetWithReina() returns an honest stub -- never fabricates a room, dimension, or quantity', async () => {
  const scan = await scanPlanSheetWithReina({
    imageBase64: Buffer.from('fake-plan-bytes').toString('base64'),
    mimeType: 'image/png',
  });
  assert.equal(scan.needsAiConnection, true);
  assert.equal(scan.drawingType, 'other');
  assert.deepEqual(scan.rooms, []);
  assert.deepEqual(scan.symbols, []);
  assert.deepEqual(scan.takeoffCandidates, []);
  assert.equal(scan.confidence, 0);
  assert.ok(Array.isArray(scan.warnings) && /ANTHROPIC_API_KEY is not configured/.test(scan.warnings[0]));
});

test('extractJson() parses a plain JSON object', () => {
  const result = extractJson('{"drawingType":"electrical","confidence":0.8}');
  assert.equal(result.drawingType, 'electrical');
  assert.equal(result.confidence, 0.8);
});

test('extractJson() strips a ```json fence before parsing', () => {
  const result = extractJson('```json\n{"drawingType":"floor_plan"}\n```');
  assert.equal(result.drawingType, 'floor_plan');
});

test('extractJson() falls back to slicing the first {...last} block when there is preamble text', () => {
  const result = extractJson('Here is the sheet read:\n{"drawingType":"plumbing"}\nLet me know if you need anything else.');
  assert.equal(result.drawingType, 'plumbing');
});

test('extractJson() throws a clear error when no JSON object is present at all', () => {
  assert.throws(() => extractJson('no json here'), /did not contain a parseable JSON object/);
});

// --- readPlanSheetsWithReina() batch orchestration --------------------------

test('readPlanSheetsWithReina() returns one result per sheet, in the original order, with no API key configured', async () => {
  const sheets = [
    { index: 0, name: 'A-1.0', imageBase64: Buffer.from('a').toString('base64'), mimeType: 'image/png' },
    { index: 1, name: 'E-1.0', imageBase64: Buffer.from('b').toString('base64'), mimeType: 'image/png' },
    { index: 2, name: 'P-1.0', imageBase64: Buffer.from('c').toString('base64'), mimeType: 'image/png' },
  ];
  const results = await readPlanSheetsWithReina(sheets, { concurrency: 2 });
  assert.equal(results.length, 3);
  results.forEach((r, i) => {
    assert.equal(r.index, sheets[i].index);
    assert.equal(r.name, sheets[i].name);
    assert.equal(r.ok, true);
    assert.equal(r.analysis.needsAiConnection, true);
  });
});

test('readPlanSheetsWithReina() isolates a per-sheet failure -- one bad sheet does not discard the others', async () => {
  const sheets = [
    { index: 0, name: 'GOOD-1', imageBase64: Buffer.from('a').toString('base64'), mimeType: 'image/png' },
    { index: 1, name: 'BAD', imageBase64: '', mimeType: 'image/png' }, // fails the required-field check
    { index: 2, name: 'GOOD-2', imageBase64: Buffer.from('c').toString('base64'), mimeType: 'image/png' },
  ];
  const results = await readPlanSheetsWithReina(sheets, { concurrency: 3 });
  assert.equal(results.length, 3);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /imageBase64 and mimeType are required/);
  assert.equal(results[2].ok, true, 'a failure on sheet 1 must not prevent sheet 2 from completing');
});

test('readPlanSheetsWithReina() with an empty list returns an empty result set without throwing', async () => {
  const results = await readPlanSheetsWithReina([]);
  assert.deepEqual(results, []);
});
