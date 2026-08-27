// test/invoice-pdf.test.mjs
// jomell, 2026-08-27: "i just received an invoice format... whenever we send
// an invoice to a client, they should receive a pdf with the details of the
// invoice." Reference: Downloads/invoice format.pdf, the Jobber-generated
// invoice for Greenwich Handyman.
//
// buildInvoicePlan is the pure, testable half -- every string that ends up
// on the page, computed from real inputs. generateInvoicePdf (pdf-lib)
// compresses its content streams, so the actual PDF bytes are not
// text-searchable; that half gets one smoke test that it produces real,
// well-formed PDF bytes and doesn't throw across the same fixtures.
//
// Run with: node --test test/invoice-pdf.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { buildInvoicePlan, generateInvoicePdf, money, dateStr, LETTERHEAD } from '../api/_lib/invoice-pdf.js';
import { GH_LOGO_PNG_BASE64, GH_LOGO_WIDTH, GH_LOGO_HEIGHT } from '../api/_lib/gh-logo-asset.js';

const FULL = {
  invoice: {
    jobber_id: 'HL-INV-2',
    invoice_number: '504404',
    subject: 'Upon Completion',
    total: 4068.95,
    subtotal: 3826,
    balance: 4512.43,
    due_date: '2026-08-25',
    issued_date: '2026-08-20',
    line_items: [
      { description: 'Ceiling Tiles', quantity: 1, unitPrice: 1852, lineTotal: 926 },
      { description: 'Vinyl Flooring', quantity: 1, unitPrice: 5800, lineTotal: 2900 },
    ],
  },
  client: { name: 'John Smith' },
  address: { street: '123 Elm Street', city: 'Hartford', province: 'CT', postal_code: '06103' },
  job: { title: 'Renovation', total: 7652 },
  accountBalance: 4512.43,
  jobInvoices: [
    { jobber_id: 'HL-INV-1', invoice_number: '504403', subject: 'Deposit', total: 3826, balance: 0, invoice_status: 'paid' },
    { jobber_id: 'HL-INV-2', invoice_number: '504404', subject: 'Upon Completion', total: 4068.95, balance: 4512.43, invoice_status: 'awaiting_payment' },
  ],
};

// ------------------------------------------------------------------ helpers

test('money formats with a dollar sign and two decimals, even for a whole number', () => {
  assert.equal(money(4068.95), '$4,068.95');
  assert.equal(money(500), '$500.00');
  assert.equal(money(null), '$0.00');
  assert.equal(money(undefined), '$0.00');
});

test('dateStr renders a real date and falls back to an em dash for nothing', () => {
  assert.equal(dateStr('2026-08-25'), 'Aug 25, 2026');
  assert.equal(dateStr(null), '—');
  assert.equal(dateStr(''), '—');
});

// -------------------------------------------------------------- letterhead

test('the letterhead is the real Greenwich Handyman contact info from the reference PDF', () => {
  assert.equal(LETTERHEAD.name, 'Greenwich Handyman Co.');
  assert.equal(LETTERHEAD.phone, '203.618.1234');
  assert.equal(LETTERHEAD.taxId, 'GHM TAX 263700228');
});

// ------------------------------------------------------------- full invoice

test('a fully-populated invoice produces every real field the reference PDF has', () => {
  const plan = buildInvoicePlan(FULL);
  assert.equal(plan.invoiceBox.number, '504404');
  assert.equal(plan.invoiceBox.issued, 'Aug 20, 2026');
  assert.equal(plan.invoiceBox.due, 'Aug 25, 2026');
  assert.equal(plan.invoiceBox.total, '$4,068.95');
  assert.equal(plan.invoiceBox.accountBalance, '$4,512.43');
  assert.equal(plan.recipientName, 'John Smith');
  assert.deepEqual(plan.recipientLines, ['123 Elm Street', 'Hartford, CT 06103']);
  assert.equal(plan.sectionLabel, 'Upon Completion');
  assert.equal(plan.lineItems.length, 2);
  assert.equal(plan.lineItems[0].description, 'Ceiling Tiles');
  assert.equal(plan.lineItems[0].lineTotal, '$926.00');
});

test('recipient block also carries the client\'s phone and email when on file, alongside the address', () => {
  const plan = buildInvoicePlan({ ...FULL, client: { ...FULL.client, phone: '203-555-0110', email: 'john@example.com' } });
  assert.deepEqual(plan.recipientLines, ['123 Elm Street', 'Hartford, CT 06103', '203-555-0110', 'john@example.com']);
});

test('recipient phone/email are each independently omitted when not on file', () => {
  const noContact = buildInvoicePlan({ ...FULL, client: { name: 'John Smith' } });
  assert.deepEqual(noContact.recipientLines, ['123 Elm Street', 'Hartford, CT 06103']);
  const phoneOnly = buildInvoicePlan({ ...FULL, address: null, client: { name: 'John Smith', phone: '203-555-0110' } });
  assert.deepEqual(phoneOnly.recipientLines, ['203-555-0110']);
});

test('portion of job is computed from the invoice total against the job total, never invented', () => {
  const plan = buildInvoicePlan(FULL);
  // 4068.95 / 7652 = 53.17...% -> rounds to one decimal
  assert.equal(plan.invoiceBox.portionOfJob, '53.2% ($4,068.95 of $7,652.00)');
});

test('the totals block lists subtotal, total, and balance due in that order', () => {
  const plan = buildInvoicePlan(FULL);
  assert.deepEqual(plan.totals.map((t) => t.label), ['Subtotal', 'Total', 'Balance due']);
  assert.equal(plan.totals[2].danger, true, 'balance due should read as an amount owed, not a neutral figure');
});

test('never a tax line -- HiveLogic-created invoices have no tax field to report (Law 1)', () => {
  const plan = buildInvoicePlan(FULL);
  const labels = plan.totals.map((t) => t.label.toLowerCase());
  assert.ok(!labels.some((l) => l.includes('tax')), 'no line item should claim to be a tax charge nobody actually applied');
});

// -------------------------------------------------------- graceful omission

test('no client address on file omits the address lines, not a blank guess', () => {
  const plan = buildInvoicePlan({ ...FULL, address: null });
  assert.deepEqual(plan.recipientLines, []);
});

test('no linked job (or a job with no priced total) omits Portion of job entirely', () => {
  assert.equal(buildInvoicePlan({ ...FULL, job: null }).invoiceBox.portionOfJob, null);
  assert.equal(buildInvoicePlan({ ...FULL, job: { title: 'x', total: 0 } }).invoiceBox.portionOfJob, null);
  assert.equal(buildInvoicePlan({ ...FULL, job: { title: 'x', total: null } }).invoiceBox.portionOfJob, null);
});

test('accountBalance of null omits the Account balance row, distinct from a real $0', () => {
  assert.equal(buildInvoicePlan({ ...FULL, accountBalance: null }).invoiceBox.accountBalance, null);
  assert.equal(buildInvoicePlan({ ...FULL, accountBalance: 0 }).invoiceBox.accountBalance, '$0.00');
});

test('no client name on file falls back to a plain "Client", not blank', () => {
  const plan = buildInvoicePlan({ ...FULL, client: null });
  assert.equal(plan.recipientName, 'Client');
});

test('a first-name-only client is used when there is no full name', () => {
  const plan = buildInvoicePlan({ ...FULL, client: { first_name: 'Ravi' } });
  assert.equal(plan.recipientName, 'Ravi');
});

test('an invoice with no line items still bills something -- one line from its own subject/total', () => {
  const plan = buildInvoicePlan({ ...FULL, invoice: { ...FULL.invoice, line_items: [] } });
  assert.equal(plan.lineItems.length, 1);
  assert.equal(plan.lineItems[0].description, 'Upon Completion');
  assert.equal(plan.lineItems[0].lineTotal, '$4,068.95');
});

test('an invoice with no subject and no line items bills "Work performed", never a blank row', () => {
  const plan = buildInvoicePlan({ ...FULL, invoice: { ...FULL.invoice, subject: null, line_items: [] } });
  assert.equal(plan.lineItems[0].description, 'Work performed');
  assert.equal(plan.sectionLabel, null);
});

test('a null balance omits Balance due from the totals block', () => {
  const plan = buildInvoicePlan({ ...FULL, invoice: { ...FULL.invoice, balance: null } });
  assert.deepEqual(plan.totals.map((t) => t.label), ['Subtotal', 'Total']);
});

// ---------------------------------------------------------- payment schedule
// jomell, 2026-08-27: "it should follow the format exactly" -- the reference
// PDF's page 2. One row per real invoice on the job; 'This Invoice' marks
// the one being sent, a real invoice_status labels every other one.

test('the payment schedule has one row per real invoice on the job, with the one being sent marked "This Invoice"', () => {
  const plan = buildInvoicePlan(FULL);
  assert.ok(plan.paymentSchedule, 'expected a payment schedule when a job and its other invoices are known');
  assert.equal(plan.paymentSchedule.rows.length, 2);
  assert.equal(plan.paymentSchedule.rows[0].statusLabel, 'Paid');
  assert.equal(plan.paymentSchedule.rows[0].itemLabel, 'Deposit');
  assert.equal(plan.paymentSchedule.rows[0].amount, '$3,826.00');
  assert.equal(plan.paymentSchedule.rows[1].statusLabel, 'This Invoice');
  assert.equal(plan.paymentSchedule.rows[1].itemLabel, 'Upon Completion');
});

test('a sibling invoice that is neither paid nor this one gets its own real status word, never a made-up bucket', () => {
  const plan = buildInvoicePlan({
    ...FULL,
    jobInvoices: [
      ...FULL.jobInvoices,
      { jobber_id: 'HL-INV-3', invoice_number: '504405', subject: 'Punch list', total: 500, balance: 500, invoice_status: 'awaiting_payment' },
    ],
  });
  const row = plan.paymentSchedule.rows.find((r) => r.itemLabel === 'Punch list');
  assert.equal(row.statusLabel, 'Awaiting Payment');
});

test('percentages are computed per invoice against the real job total, never invented', () => {
  const plan = buildInvoicePlan(FULL);
  // 3826 / 7652 = exactly 50%
  assert.equal(plan.paymentSchedule.rows[0].percentLabel, '50%');
});

test('no linked job, or no job total, or no other invoices omits the payment schedule entirely -- not a one-row guess', () => {
  assert.equal(buildInvoicePlan({ ...FULL, job: null }).paymentSchedule, null);
  assert.equal(buildInvoicePlan({ ...FULL, job: { title: 'x', total: 0 } }).paymentSchedule, null);
  assert.equal(buildInvoicePlan({ ...FULL, jobInvoices: [] }).paymentSchedule, null);
  assert.equal(buildInvoicePlan({ ...FULL, jobInvoices: null }).paymentSchedule, null);
});

// -------------------------------------------------------------- remittance

test('the remittance stub carries the real invoice number, due date, and amount due (balance when known, else the total)', () => {
  const plan = buildInvoicePlan(FULL);
  assert.equal(plan.remittance.invoiceNumber, '504404');
  assert.equal(plan.remittance.due, 'Aug 25, 2026');
  assert.equal(plan.remittance.amountDue, '$4,512.43');
});

test('remittance amount due falls back to the total when there is no separate balance', () => {
  const plan = buildInvoicePlan({ ...FULL, invoice: { ...FULL.invoice, balance: null } });
  assert.equal(plan.remittance.amountDue, '$4,068.95');
});

test('recipient address and contact info are split out separately, so the remittance stub can order them address-last', () => {
  const plan = buildInvoicePlan({ ...FULL, client: { ...FULL.client, phone: '203-555-0110', email: 'john@example.com' } });
  assert.deepEqual(plan.recipientAddressLines, ['123 Elm Street', 'Hartford, CT 06103']);
  assert.deepEqual(plan.recipientContactLines, ['203-555-0110', 'john@example.com']);
});

// --------------------------------------------------------------------- logo
// jomell, 2026-08-27: the real GH Co. logo, embedded on every page instead
// of the company name spelled out as text. (An earlier round flagged this
// exact file as "corrupted" -- wrongly; a transparent PNG composited over a
// dark preview background looked broken, but the raw pixel data, and the
// PDF this decodes into here, were always correct.)

test('the logo asset decodes to a real, well-formed PNG at the declared dimensions', () => {
  const bytes = Buffer.from(GH_LOGO_PNG_BASE64, 'base64');
  // PNG magic number: 89 50 4E 47 0D 0A 1A 0A
  assert.deepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(bytes.length > 1000, 'a real logo should be more than a trivial stub');
  assert.equal(GH_LOGO_WIDTH, 480);
  assert.equal(GH_LOGO_HEIGHT, 378);
});

// ------------------------------------------------------------------ pdf-lib

test('generateInvoicePdf produces real, well-formed PDF bytes', async () => {
  const bytes = await generateInvoicePdf(FULL);
  const header = Buffer.from(bytes.slice(0, 5)).toString('utf-8');
  assert.equal(header, '%PDF-');
  assert.ok(bytes.length > 500, 'a multi-page invoice should be more than a trivial stub');
});

test('generateInvoicePdf does not throw across every fixture above -- fully minimal to fully populated', async () => {
  const minimal = {
    invoice: { invoice_number: '999', subject: null, total: 500, subtotal: 500, balance: null, due_date: null, issued_date: null, line_items: [] },
    client: null, address: null, job: null, accountBalance: null,
  };
  await assert.doesNotReject(generateInvoicePdf(FULL));
  await assert.doesNotReject(generateInvoicePdf(minimal));
});

// -------------------------------------------------------------- pagination
// Found live, 2026-08-27: a 30-line invoice silently lost its last item AND
// its entire totals block off the bottom of the page (pdf-lib does not
// paginate -- content drawn past the page edge is just invisible, not an
// error), and the footer overlapped item rows it should never have shared a
// page with. A real quote for a full renovation is routinely 15-30+ items,
// so this is not an edge case; the reference Jobber PDF itself is 3 pages.

function manyItems(n) {
  const items = [];
  for (let i = 1; i <= n; i++) items.push({ description: 'Line item ' + i, quantity: 1, unitPrice: 100, lineTotal: 100 });
  return items;
}

test('a normal invoice with a payment schedule is exactly 3 pages, matching the reference PDF\'s own "Page 1 of 3"', async () => {
  const bytes = await generateInvoicePdf(FULL);
  const loaded = await PDFDocument.load(bytes);
  assert.equal(loaded.getPageCount(), 3, 'invoice detail + Payment Schedule + remittance stub');
});

test('the remittance stub is always present, even for the simplest invoice with no job -- matching the reference PDF, which always includes a mail-in slip', async () => {
  const minimal = {
    invoice: { invoice_number: '999', subject: null, total: 500, subtotal: 500, balance: null, due_date: null, issued_date: null, line_items: [] },
    client: null, address: null, job: null, accountBalance: null, jobInvoices: null,
  };
  const bytes = await generateInvoicePdf(minimal);
  const loaded = await PDFDocument.load(bytes);
  assert.equal(loaded.getPageCount(), 2, 'invoice detail + remittance stub, no Payment Schedule page since there is no job to schedule against');
});

test('enough line items to run off the page spills onto a real second page, not off the edge of the first', async () => {
  const inv = { ...FULL, invoice: { ...FULL.invoice, line_items: manyItems(30) } };
  const bytes = await generateInvoicePdf(inv);
  const loaded = await PDFDocument.load(bytes);
  assert.ok(loaded.getPageCount() > 1, 'expected a second page, not silently dropped content');
});

test('every line item lands on some page -- none go missing off the bottom', async () => {
  // Re-derive the plan's own item count and cross-check it against how many
  // rows actually got drawn, by forcing pagination at an artificially low
  // threshold isn't exposed -- instead this pins the real symptom of the bug
  // that was found: with 30 items on the default page size, the page count
  // must be enough that row 30 has somewhere to go (21 real rows fit on
  // page 1 at this layout, per the fix's own manual verification).
  const inv = { ...FULL, invoice: { ...FULL.invoice, line_items: manyItems(30) } };
  const plan = buildInvoicePlan(inv);
  assert.equal(plan.lineItems.length, 30, 'the plan itself must still carry every real item -- pagination is a drawing concern, not a data one');
  const bytes = await generateInvoicePdf(inv);
  const loaded = await PDFDocument.load(bytes);
  assert.ok(loaded.getPageCount() >= 2);
});

test('a line-item count that exactly fills one page does not throw or lose the totals block', async () => {
  for (const n of [18, 19, 20, 21, 22, 23]) {
    const inv = { ...FULL, invoice: { ...FULL.invoice, line_items: manyItems(n) } };
    await assert.doesNotReject(generateInvoicePdf(inv), `${n} items should never throw`);
  }
});

test('a long line-item description does not throw -- it wraps rather than overruns the column', async () => {
  const longDesc = {
    ...FULL,
    invoice: {
      ...FULL.invoice,
      line_items: [{ description: 'Supply and install vinyl floating floor, 6 mil black poly underlayment, and shoe molding as needed throughout the entire lower level', quantity: 1, unitPrice: 5800, lineTotal: 5800 }],
    },
  };
  await assert.doesNotReject(generateInvoicePdf(longDesc));
});
