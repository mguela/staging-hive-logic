import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReinaExtraction, runReinaBenchmark } from '../src/reina-benchmark.js';

test('Reina benchmark measures extraction, review routing, dangerous errors, and approved learning', () => {
  const benchmark = runReinaBenchmark();
  assert.equal(benchmark.curriculum.documents, 10);
  assert.ok(benchmark.summary.extractionAccuracy >= 95);
  assert.equal(benchmark.summary.reviewRoutingAccuracy, 100);
  assert.equal(benchmark.summary.learningAccuracy, 100);
  assert.equal(benchmark.summary.dangerousAutoFillErrors, 0);
  assert.equal(benchmark.summary.safe, true);
});

test('a wrong high-confidence total is never counted safe when arithmetic appears plausible', () => {
  const result = evaluateReinaExtraction(
    { documentType: 'receipt', vendor: 'ABC', transactionDate: '2026-07-20', subtotal: 100, salesTaxTotal: 6, salesTaxState: 'FL', total: 106 },
    { documentType: 'receipt', vendor: 'ABC', transactionDate: '2026-07-20', subtotal: 102, salesTaxTotal: 6, salesTaxState: 'FL', total: 108, confidence: .99, lineItems: [{ description: 'Material', subtotal: 102, confidence: .99 }] }
  );
  assert.ok(result.dangerousErrors >= 1);
});
