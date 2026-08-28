// test/estimate-pdf.test.mjs
// jomell, 2026-08-27: an estimate sent to a client for approval should
// carry a real PDF of its scope of work, same as invoices already do.
//
// buildEstimatePlan is the pure, testable half. generateEstimatePdf
// (pdf-lib) compresses its content streams, so the actual PDF bytes are
// not text-searchable; that half gets a smoke test that it produces real,
// well-formed PDF bytes and doesn't throw across fixtures from fully
// minimal to fully populated.
//
// Run with: node --test test/estimate-pdf.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import fs from 'node:fs';
import { buildEstimatePlan, generateEstimatePdf } from '../api/_lib/estimate-pdf.js';
import { LETTERHEAD } from '../api/_lib/invoice-pdf.js';

test('the line-items column header reads LINE ITEM, not DESCRIPTION', () => {
  const source = fs.readFileSync(new URL('../api/_lib/estimate-pdf.js', import.meta.url), 'utf8');
  assert.match(source, /drawText\('LINE ITEM'/);
  assert.doesNotMatch(source, /drawText\('DESCRIPTION'/);
});

const FULL = {
  estimate: {
    id: 'est-1', estimateNumber: 'EST-0042', title: 'Basement Bathroom',
    lifecycleStatus: 'sent', createdAt: '2026-08-20T12:00:00Z', sentAt: '2026-08-27T12:00:00Z',
    totals: { cost: 3000, price: 4200, margin: 1200, marginPct: 28.6, cardRateBps: 0, cardFee: 0, cardPrice: 4200 },
    lines: [
      { id: 'l1', type: 'labor', description: 'Demolition', qty: 1, unit: 'ea', unitCost: 1200, pmode: 'markup', markupPct: 40 },
      { id: 'l2', type: 'material', description: 'Tile and fixtures', qty: 1, unit: 'ea', unitCost: 1800, pmode: 'markup', markupPct: 40 },
    ],
    paymentSchedule: [
      { label: 'Deposit due upon approval', pct: 50, isDeposit: true, dueOn: 'approval' },
      { label: 'Balance due upon completion', pct: 50, isDeposit: false, dueOn: 'completion' },
    ],
  },
  client: { name: 'Jomell Alba', email: 'jomell@ghgrp.net', phone: '9145953184' },
  address: { street: '123 Beaver Dam Road', city: 'Bedford', province: 'NY', postal_code: '10507' },
};

test('letterhead is the real, shared brand constant -- not a duplicate copy', async () => {
  const plan = await buildEstimatePlan(FULL);
  assert.equal(plan.letterhead, LETTERHEAD);
});

test('the estimate box carries the real number, issued date, status, and total', async () => {
  const plan = await buildEstimatePlan(FULL);
  assert.equal(plan.estimateBox.number, 'EST-0042');
  assert.equal(plan.estimateBox.issued, 'Aug 27, 2026');
  assert.equal(plan.estimateBox.status, 'Sent');
  assert.equal(plan.estimateBox.total, '$4,200.00');
});

test('recipient carries name, address, phone, and email, address first', async () => {
  const plan = await buildEstimatePlan(FULL);
  assert.equal(plan.recipientName, 'Jomell Alba');
  assert.deepEqual(plan.recipientLines, ['123 Beaver Dam Road', 'Bedford, NY 10507', '9145953184', 'jomell@ghgrp.net']);
});

test('no client name on file falls back to a plain "Client", not blank', async () => {
  const plan = await buildEstimatePlan({ ...FULL, client: null });
  assert.equal(plan.recipientName, 'Client');
});

test('no address on file omits the address lines, not a blank guess', async () => {
  const plan = await buildEstimatePlan({ ...FULL, address: null });
  assert.deepEqual(plan.recipientLines, ['9145953184', 'jomell@ghgrp.net']);
});

test('line items reflect the real recorded description, qty, and unit -- computed price, never invented', async () => {
  const plan = await buildEstimatePlan(FULL);
  assert.equal(plan.lineItems.length, 2);
  assert.equal(plan.lineItems[0].description, 'Demolition');
  assert.equal(plan.lineItems[0].quantity, '1');
  assert.equal(plan.lineItems[0].unit, 'ea');
  // linePrice() with 40% markup on $1200 cost = $1680.
  assert.equal(plan.lineItems[0].lineTotal, '$1,680.00');
  assert.equal(plan.lineItems[1].lineTotal, '$2,520.00');
});

test('an estimate with no lines yet still shows one real line from its own title/total, not a blank table', async () => {
  const plan = await buildEstimatePlan({ ...FULL, estimate: { ...FULL.estimate, lines: [] } });
  assert.equal(plan.lineItems.length, 1);
  assert.equal(plan.lineItems[0].description, 'Basement Bathroom');
  assert.equal(plan.lineItems[0].lineTotal, '$4,200.00');
});

test('the one totals row is the real computed total, no invented subtotal/discount/tax breakout', async () => {
  const plan = await buildEstimatePlan(FULL);
  assert.deepEqual(plan.totals, [{ label: 'Total', value: '$4,200.00', emphasis: true }]);
});

test('card pricing, when on, drives both the estimate box total and the totals row', async () => {
  const withCard = { ...FULL.estimate, totals: { ...FULL.estimate.totals, cardPrice: 4326 } };
  const plan = await buildEstimatePlan({ ...FULL, estimate: withCard });
  assert.equal(plan.estimateBox.total, '$4,326.00');
  assert.equal(plan.totals[0].value, '$4,326.00');
});

test('the payment schedule has one row per real schedule entry, percentages against the real total', async () => {
  const plan = await buildEstimatePlan(FULL);
  assert.ok(plan.paymentSchedule);
  assert.equal(plan.paymentSchedule.rows.length, 2);
  assert.equal(plan.paymentSchedule.rows[0].statusLabel, 'Deposit');
  assert.equal(plan.paymentSchedule.rows[0].percentLabel, '50%');
  assert.equal(plan.paymentSchedule.rows[0].amount, '$2,100.00');
  assert.equal(plan.paymentSchedule.totalPct, '100%');
  assert.equal(plan.paymentSchedule.totalAmount, '$4,200.00');
});

test('no payment schedule omits the page entirely, not a fabricated one', async () => {
  const plan = await buildEstimatePlan({ ...FULL, estimate: { ...FULL.estimate, paymentSchedule: [] } });
  assert.equal(plan.paymentSchedule, null);
});

test('the section label is the estimate\'s own title, omitted when there is none', async () => {
  const plan = await buildEstimatePlan(FULL);
  assert.equal(plan.sectionLabel, 'Basement Bathroom');
  const noTitle = await buildEstimatePlan({ ...FULL, estimate: { ...FULL.estimate, title: null } });
  assert.equal(noTitle.sectionLabel, null);
});

test('a line item\'s notes are split into real bullet lines, not one joined paragraph', async () => {
  const withNotes = {
    ...FULL,
    estimate: {
      ...FULL.estimate,
      lines: [
        { type: 'labor', description: 'Plumbing', qty: 1, unit: 'ea', unitCost: 3000, pmode: 'markup', markupPct: 40,
          notes: '- Installation of plumbing vents, waste lines, and water supply lines\n- Installation of one toilet\n- Installation of shower fixtures' },
      ],
    },
  };
  const plan = await buildEstimatePlan(withNotes);
  assert.deepEqual(plan.lineItems[0].notes, [
    '- Installation of plumbing vents, waste lines, and water supply lines',
    '- Installation of one toilet',
    '- Installation of shower fixtures',
  ]);
});

test('a line item with no description on file has an empty notes list, not fabricated bullets', async () => {
  const plan = await buildEstimatePlan(FULL);
  assert.deepEqual(plan.lineItems[0].notes, []);
});

test('generateEstimatePdf produces real, well-formed PDF bytes', async () => {
  const bytes = await generateEstimatePdf(FULL);
  const loaded = await PDFDocument.load(bytes);
  assert.ok(loaded.getPageCount() >= 1);
});

test('an estimate with a payment schedule is 2 pages: scope of work + payment schedule', async () => {
  const bytes = await generateEstimatePdf(FULL);
  const loaded = await PDFDocument.load(bytes);
  assert.equal(loaded.getPageCount(), 2);
});

test('no payment schedule is a single page', async () => {
  const bytes = await generateEstimatePdf({ ...FULL, estimate: { ...FULL.estimate, paymentSchedule: [] } });
  const loaded = await PDFDocument.load(bytes);
  assert.equal(loaded.getPageCount(), 1);
});

test('generateEstimatePdf does not throw across fixtures from fully minimal to fully populated', async () => {
  const minimal = {
    estimate: { id: 'e2', estimateNumber: 'EST-0001', title: null, lifecycleStatus: 'draft', createdAt: null, totals: { price: 0, cardPrice: 0 }, lines: [], paymentSchedule: [] },
    client: null, address: null,
  };
  await assert.doesNotReject(generateEstimatePdf(minimal));
  await assert.doesNotReject(generateEstimatePdf(FULL));
});

function manyLines(n) {
  const lines = [];
  for (let i = 1; i <= n; i += 1) lines.push({ type: 'labor', description: 'Line item ' + i, qty: 1, unit: 'ea', unitCost: 100, pmode: 'markup', markupPct: 0 });
  return lines;
}

test('enough line items to run off the page spills onto a real second page, not off the edge of the first', async () => {
  const bytes = await generateEstimatePdf({ ...FULL, estimate: { ...FULL.estimate, lines: manyLines(30), paymentSchedule: [] } });
  const loaded = await PDFDocument.load(bytes);
  assert.ok(loaded.getPageCount() > 1, 'expected a second page, not silently dropped content');
});

test('a long line-item description wraps rather than overrunning the column', async () => {
  const longDesc = {
    ...FULL,
    estimate: {
      ...FULL.estimate,
      lines: [{ type: 'labor', description: 'Supply and install vinyl floating floor, 6 mil black poly underlayment, and shoe molding as needed throughout the entire lower level', qty: 1, unit: 'ea', unitCost: 5800, pmode: 'markup', markupPct: 0 }],
    },
  };
  await assert.doesNotReject(generateEstimatePdf(longDesc));
});
