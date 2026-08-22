// test/invoice-balance-deposit-aware.test.mjs
//
// Found during the 8/17 Dev To-Do triage while confirming whether the 7/31
// "deposit-aware money-math" fix (track1.js's Financial Intelligence past-due
// aggregation: total - payments - deposit - discount) had actually reached
// every UI surface that computes an invoice balance. It had not: both
// api/invoices.js's getInvoicesData() and api/clientportal.js's mapInvoice()
// still computed balance as plain total - payments, silently ignoring any
// deposit or discount already on the invoice -- overstating what's actually
// owed. The client portal instance is customer-facing: a client who paid a
// deposit would see they still owe more than they actually do.
//
// Both functions read from the SAME `invoices` table track1.js's fix already
// selects deposit/discount from (both call sites here already used
// select=*), so no query change was needed -- only the arithmetic.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

function makeInvoice(overrides) {
  return {
    jobber_id: 'inv-1', client_id: 'c1', invoice_number: '1001', invoice_status: 'sent',
    subject: 'Deck repair', total: 1000, payments: 0, deposit: 0, discount: 0,
    due_date: '2026-08-01', issued_date: '2026-07-01', jobber_web_uri: 'https://x',
    ...overrides,
  };
}

async function withMockedInvoicesFetch(rows, fn) {
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: (h) => h.toLowerCase() === 'content-range' ? `0-${rows.length - 1}/${rows.length}` : null },
    json: async () => rows,
    text: async () => JSON.stringify(rows),
  });
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

test('api/invoices.js: an invoice with a deposit applied owes less than total minus payments alone', async () => {
  const rows = [makeInvoice({ total: 1000, payments: 0, deposit: 300 })];
  const { getInvoicesData } = await import('../api/invoices.js');
  const data = await withMockedInvoicesFetch(rows, () => getInvoicesData({ limit: 10 }));
  assert.equal(data.invoices[0].balance, 700, 'the $300 deposit must reduce the balance owed');
  assert.equal(data.invoices[0].deposit, 300, 'the deposit amount must be surfaced, not just folded silently into balance');
});

test('api/invoices.js: deposit and discount both reduce the balance, and it never goes below zero', async () => {
  const rows = [
    makeInvoice({ jobber_id: 'inv-2', total: 1000, payments: 200, deposit: 300, discount: 100 }),
    makeInvoice({ jobber_id: 'inv-3', total: 500, payments: 0, deposit: 900 }), // overpaid via deposit
  ];
  const { getInvoicesData } = await import('../api/invoices.js');
  const data = await withMockedInvoicesFetch(rows, () => getInvoicesData({ limit: 10 }));
  assert.equal(data.invoices[0].balance, 400, '1000 - 200 payments - 300 deposit - 100 discount = 400');
  assert.equal(data.invoices[1].balance, 0, 'balance must clamp at zero, never go negative');
});

test('api/invoices.js: an invoice with no deposit or discount is unaffected', async () => {
  const rows = [makeInvoice({ total: 800, payments: 300 })];
  const { getInvoicesData } = await import('../api/invoices.js');
  const data = await withMockedInvoicesFetch(rows, () => getInvoicesData({ limit: 10 }));
  assert.equal(data.invoices[0].balance, 500);
});

test('api/clientportal.js mapInvoice: matches api/invoices.js exactly, including the deposit reduction', async () => {
  const { mapInvoice } = await import('../api/clientportal.js');
  const withDeposit = mapInvoice(makeInvoice({ total: 1000, payments: 0, deposit: 300 }));
  assert.equal(withDeposit.balance, 700, 'a client who paid a deposit must see a correspondingly lower balance due');
  assert.equal(withDeposit.deposit, 300);

  const overpaidViaDeposit = mapInvoice(makeInvoice({ total: 500, payments: 0, deposit: 900 }));
  assert.equal(overpaidViaDeposit.balance, 0, 'a client must never be shown a negative balance');
});
