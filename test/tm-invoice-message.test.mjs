// The customer-facing T&M invoice message.
//
// Two things carry real risk here: the pricing language is a legal constraint,
// and an invoice must never be emailed to a customer twice.

import test from 'node:test';
import assert from 'node:assert';
import {
  buildInvoiceMessage, buildInvoiceOutboxRow, invoiceDedupeKey,
} from '../api/_lib/tm-invoice-message.js';

const inv = (over = {}) => ({
  id: 'inv-1', invoice_number: 'TM-ABC', job_title: 'Panel swap', client_name: 'Alice',
  client_id: 'c1', total_amount: 520, cash_amount: 500, card_fee_amount: 20, ...over,
});
const PAY = 'https://example.test/pay/?t=tok';

test('the cheaper price is a cash DISCOUNT, never a card fee', () => {
  // Connecticut bans card surcharges; a cash discount is legal in CT and NY.
  // This is a legal constraint, not a wording preference.
  const { body } = buildInvoiceMessage({ invoice: inv(), payUrl: PAY, cardPricingActive: true });
  assert.match(body, /cash discount/i);
  assert.equal(/card fee|surcharge/i.test(body), false, 'must never frame it as a fee or surcharge');
});

test('with card pricing off there is only one price, and no discount talk', () => {
  const { body, subject } = buildInvoiceMessage({ invoice: inv(), payUrl: PAY, cardPricingActive: false });
  assert.match(body, /\$500\.00/);
  assert.equal(/discount/i.test(body), false);
  assert.match(subject, /\$500\.00/);
});

test('the pay link is in the body', () => {
  const { body } = buildInvoiceMessage({ invoice: inv(), payUrl: PAY, cardPricingActive: true });
  assert.ok(body.includes(PAY));
});

test('a nameless client still gets a sane greeting', () => {
  const { body } = buildInvoiceMessage({ invoice: inv({ client_name: null }), payUrl: PAY, cardPricingActive: true });
  assert.match(body, /^Hi,/);
  assert.equal(/Hi null|undefined/.test(body), false);
});

test('one invoice can only ever be queued once', () => {
  // hl_outbox.dedupe_key is uniquely indexed, so this key is what stops a
  // retry becoming a second email to the customer.
  assert.equal(invoiceDedupeKey(inv()), 'tm_invoice:inv-1');
  const a = buildInvoiceOutboxRow({ invoice: inv(), payUrl: PAY, cardPricingActive: true, clientEmail: 'a@b.test' });
  const b = buildInvoiceOutboxRow({ invoice: inv(), payUrl: PAY, cardPricingActive: true, clientEmail: 'a@b.test' });
  assert.equal(a.row.dedupe_key, b.row.dedupe_key);
});

test('no email on file is an ordinary skip, not a failure', () => {
  // Plenty of clients are phone-only. This must not take down an invoice that
  // was raised successfully.
  const out = buildInvoiceOutboxRow({ invoice: inv(), payUrl: PAY, cardPricingActive: true, clientEmail: null });
  assert.equal(out.row, undefined);
  assert.match(out.skipped, /no email address/i);
  assert.match(out.skipped, /text/i, 'should point at the fallback that does work');
});

test('a missing pay link is refused rather than emailing a dead invoice', () => {
  const out = buildInvoiceOutboxRow({ invoice: inv(), payUrl: null, cardPricingActive: true, clientEmail: 'a@b.test' });
  assert.ok(out.skipped);
});

test('the queued row is shaped for the processor', () => {
  const { row } = buildInvoiceOutboxRow({
    invoice: inv(), payUrl: PAY, cardPricingActive: true, clientEmail: 'a@b.test', now: Date.parse('2026-08-19T00:00:00Z'),
  });
  assert.equal(row.status, 'queued');
  assert.equal(row.channel, 'email');
  assert.equal(row.step, 'invoice');
  assert.equal(row.recipient_contact, 'a@b.test');
  assert.equal(row.client_id, 'c1');
  // Due now: an invoice is not a reminder, it is the thing being waited on.
  assert.equal(row.scheduled_for, '2026-08-19T00:00:00.000Z');
});
