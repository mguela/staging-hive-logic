// api/bookkeeping/_sales_tax_store.test.mjs
// Exercises the memory backend of the new (task 7) manual sales-tax entry
// log: recording a real "tax collected" entry, a real "tax remitted"
// entry, validation of both shapes, voiding (never deleting) a mistaken
// entry, and per-company isolation.
//
// Run: BOOKKEEPING_ALLOW_MEMORY_STORE=true NODE_ENV=test node --test api/bookkeeping/_sales_tax_store.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.BOOKKEEPING_ALLOW_MEMORY_STORE = 'true';

test('recordSalesTaxEntry stores a real "collected" entry with the fields salesTaxLiability() needs', async () => {
  const { recordSalesTaxEntry, listSalesTaxEntries } = await import(`./_sales_tax_store.js?t=${Date.now()}`);
  const entry = await recordSalesTaxEntry('co-tax-1', {
    kind: 'collected', taxState: 'ct', date: '2026-03-15', taxableAmount: 1000, exemptAmount: 0, taxCollected: 63.5, jobRef: 'Job 2382'
  }, { id: 'controller-1' });
  assert.equal(entry.kind, 'collected');
  assert.equal(entry.taxState, 'CT');
  assert.equal(entry.taxCollected, 63.5);
  assert.equal(entry.status, 'active');
  assert.equal(entry.createdBy, 'controller-1');

  const list = await listSalesTaxEntries('co-tax-1');
  assert.equal(list.length, 1);
});

test('recordSalesTaxEntry stores a real "remitted" entry', async () => {
  const { recordSalesTaxEntry } = await import(`./_sales_tax_store.js?t=${Date.now()}`);
  const entry = await recordSalesTaxEntry('co-tax-2', { kind: 'remitted', taxState: 'CT', date: '2026-04-30', amount: 63.5 }, { id: 'controller-1' });
  assert.equal(entry.kind, 'remitted');
  assert.equal(entry.amount, 63.5);
});

test('rejects an unknown kind, a negative amount, and a malformed date', async () => {
  const { recordSalesTaxEntry } = await import(`./_sales_tax_store.js?t=${Date.now()}`);
  await assert.rejects(() => recordSalesTaxEntry('co-tax-3', { kind: 'bogus', taxState: 'CT', date: '2026-01-01' }));
  await assert.rejects(() => recordSalesTaxEntry('co-tax-3', { kind: 'remitted', taxState: 'CT', date: '2026-01-01', amount: -5 }));
  await assert.rejects(() => recordSalesTaxEntry('co-tax-3', { kind: 'remitted', taxState: 'CT', date: '01/01/2026', amount: 5 }));
});

test('voidSalesTaxEntry marks an entry void without deleting it (audit trail preserved)', async () => {
  const { recordSalesTaxEntry, voidSalesTaxEntry, listSalesTaxEntries } = await import(`./_sales_tax_store.js?t=${Date.now()}`);
  const entry = await recordSalesTaxEntry('co-tax-4', { kind: 'remitted', taxState: 'CT', date: '2026-01-01', amount: 10 }, { id: 'controller-1' });
  const voided = await voidSalesTaxEntry('co-tax-4', entry.id);
  assert.equal(voided.status, 'void');
  const list = await listSalesTaxEntries('co-tax-4');
  assert.equal(list.length, 1, 'voiding must not remove the row');
  assert.equal(list[0].status, 'void');
});

test('a company\'s sales-tax entries are never visible through another company\'s id (tenant isolation)', async () => {
  const { recordSalesTaxEntry, listSalesTaxEntries } = await import(`./_sales_tax_store.js?t=${Date.now()}`);
  await recordSalesTaxEntry('co-tax-5a', { kind: 'remitted', taxState: 'CT', date: '2026-01-01', amount: 10 }, { id: 'controller-1' });
  const otherCompany = await listSalesTaxEntries('co-tax-5b');
  assert.equal(otherCompany.length, 0);
});
