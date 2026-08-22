// api/_lib/tm-invoice-message.js
// The customer-facing message for a T&M invoice.
//
// Raising an invoice produced a pay link and an `sms:` href — a message the
// TECH still had to tap send on, from their own phone, from their own number.
// That works, but it means the business has no record of what went out or
// whether it ever did, and nothing goes out at all if the tech forgets.
//
// This builds the row for hl_outbox instead, so an invoice is delivered by the
// same gated, logged, retrying path as every other client message. The tech's
// sms: link is deliberately kept as a fallback — a customer standing in front
// of you asking for the link should not have to wait for a cron.
//
// PRICING LANGUAGE IS A LEGAL CONSTRAINT, not a style choice. Connecticut bans
// card surcharges; a cash discount is legal in CT and NY. The copy must
// therefore describe the lower price as a DISCOUNT for cash/check, never the
// higher one as a card FEE. Same rule the existing SMS copy follows — see
// server/bookkeeping/src/card-pricing.js.

/** Stable key so one invoice can never be queued twice (unique index). */
export function invoiceDedupeKey(invoice) {
  const id = invoice && (invoice.id || invoice.invoice_number);
  return id ? `tm_invoice:${id}` : null;
}

function money(n) {
  return '$' + Number(n || 0).toFixed(2);
}

/**
 * Subject and body for the invoice email.
 * `cardPricingActive` decides whether the cash-discount alternative is offered
 * at all — when the pricing columns are not live there is only one price.
 */
export function buildInvoiceMessage({ invoice, payUrl, cardPricingActive }) {
  const jobTitle = (invoice && invoice.job_title) || 'your service';
  const name = (invoice && invoice.client_name) || '';
  const hello = name ? `Hi ${name},` : 'Hi,';
  const total = money(invoice && invoice.total_amount);
  const cash = money(invoice && invoice.cash_amount);
  const fee = Number((invoice && invoice.card_fee_amount) || 0);

  const subject = `Your invoice for ${jobTitle} — ${cardPricingActive ? total : cash}`;

  const lines = [hello, ''];
  if (cardPricingActive && fee > 0) {
    lines.push(
      `Here's your invoice for ${jobTitle}: ${total}.`,
      '',
      `Pay securely online: ${payUrl}`,
      '',
      // Discount framing, never a surcharge. See the header note.
      `Prefer cash or check? Save ${money(fee)} with our cash discount — ${cash} paid directly to your tech.`,
    );
  } else {
    lines.push(
      `Here's your invoice for ${jobTitle}: ${cash}.`,
      '',
      `Pay securely online: ${payUrl}`,
    );
  }
  lines.push('', 'Thank you for your business.');
  return { subject, body: lines.join('\n') };
}

/**
 * The hl_outbox row, or a reason it cannot be built.
 *
 * Returns { row } or { skipped: '<why>' } rather than throwing: a missing
 * customer email is an ordinary situation (plenty of clients are phone-only),
 * and it must never take down the invoice that was just raised successfully.
 */
export function buildInvoiceOutboxRow({ invoice, payUrl, cardPricingActive, clientEmail, now = Date.now() }) {
  if (!invoice) return { skipped: 'no invoice' };
  if (!payUrl) return { skipped: 'no pay link' };
  if (!clientEmail) {
    return { skipped: 'no email address on file for this client — send the link by text instead' };
  }
  const dedupe = invoiceDedupeKey(invoice);
  if (!dedupe) return { skipped: 'invoice has no id to key on' };

  const { subject, body } = buildInvoiceMessage({ invoice, payUrl, cardPricingActive });
  return {
    row: {
      step: 'invoice',
      channel: 'email',
      recipient_name: invoice.client_name || null,
      recipient_contact: clientEmail,
      client_id: invoice.client_id || null,
      subject,
      body,
      // Due immediately: an invoice is not a reminder, it is the thing the
      // customer is waiting for.
      scheduled_for: new Date(now).toISOString(),
      status: 'queued',
      dedupe_key: dedupe,
    },
  };
}
