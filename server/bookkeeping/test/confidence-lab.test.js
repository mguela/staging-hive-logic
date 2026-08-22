import test from 'node:test';
import assert from 'node:assert/strict';
import { runConfidenceLab } from '../src/confidence-lab.js';

test('bookkeeper confidence lab proves a realistic contractor month and catches intentional exceptions', () => {
  const lab = runConfidenceLab();
  assert.equal(lab.summary.failed, 0);
  assert.equal(lab.summary.score, 100);
  assert.equal(lab.financialSnapshot.trialBalanced, true);
  assert.equal(lab.financialSnapshot.balanceSheetBalanced, true);
  assert.ok(lab.checks.some(check => check.title === 'Duplicate receipts are stopped' && check.passed));
  assert.ok(lab.checks.some(check => check.title === 'Locked months cannot be rewritten' && check.passed));
});
