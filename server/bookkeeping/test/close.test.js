import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, addCompany } from '../src/ledger.js';
import { createControlStore } from '../src/controls.js';
import { closeReadiness, buildClosePackage } from '../src/close.js';

function fixture() {
  const ledger = createLedger();
  addCompany(ledger, {
    id: 'co',
    name: 'GH Group',
    basis: 'accrual',
    accounts: [
      { id: 'cash', name: 'Cash', type: 'asset' },
      { id: 'expense', name: 'Expense', type: 'expense' },
      { id: 'equity', name: 'Equity', type: 'equity' }
    ]
  }, { id: 'controller', role: 'controller' });
  return { ledger, controls: createControlStore() };
}

test('close readiness blocks unknown ownership, missing evidence, and missing source journals', () => {
  const readiness = closeReadiness({
    system: fixture(),
    companyId: 'co',
    throughDate: '2026-06-30',
    expenses: [{
      id: 'expense-1', vendor: 'Unknown vendor', transactionDate: '2026-06-15',
      total: 25, status: 'unrecorded', allocations: [{ ownerType: 'unknown' }]
    }]
  });
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.blockers.map(item => item.id).filter(id => ['unknown_expenses', 'supporting_evidence', 'source_links'].includes(id)).sort(), ['source_links', 'supporting_evidence', 'unknown_expenses']);
  assert.throws(() => buildClosePackage({ system: fixture(), expenses: [{ id: 'expense-1', vendor: 'Unknown', transactionDate: '2026-06-15', total: 25, status: 'unrecorded', allocations: [{ ownerType: 'unknown' }] }], companyId: 'co', throughDate: '2026-06-30' }), /Period cannot close/);
});

test('accountant close package contains verified portable files', () => {
  const result = buildClosePackage({ system: fixture(), expenses: [], companyId: 'co', throughDate: '2026-06-30' });
  assert.equal(result.readiness.ready, true);
  assert.equal(result.buffer.subarray(0, 4).toString('hex'), '504b0304');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  const names = result.files.map(file => file.name);
  for (const required of ['journal-entries-qbo.csv', 'general-ledger.csv', 'trial-balance.csv', 'cash-flow-workpaper.csv', 'accounts-payable-aging.csv', 'close-review.xlsx', 'reconciliation-summary.pdf', 'manifest.json']) assert.ok(names.includes(required), `${required} is included`);
  const spreadsheet = result.files.find(file => file.name === 'close-review.xlsx');
  const pdf = result.files.find(file => file.name === 'reconciliation-summary.pdf');
  assert.equal(spreadsheet.bytes > 10_000, true);
  assert.equal(pdf.bytes > 500, true);
});

test('a configured bank account cannot disappear from close just because no feed was imported', () => {
  const system = fixture();
  system.ledger.companies.co.accounts.bank = { id: 'bank', name: 'Operating Bank', type: 'asset', normalBalance: 'debit', active: true, reconciliationRequired: true };
  const readiness = closeReadiness({ system, expenses: [], companyId: 'co', throughDate: '2026-06-30' });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.blockers.some(item => item.id === 'statements'), true);
  assert.equal(readiness.blockers.some(item => item.id === 'reconciliations'), true);
});
