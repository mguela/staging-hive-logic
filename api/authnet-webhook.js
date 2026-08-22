// api/authnet-webhook.js — Authorize.Net webhook receiver (Chris's ask,
// 2026-07-22: tech generates the invoice, client pays via a link; this is
// how the app finds out the payment actually went through).
//
// Separate file from fieldops.js on purpose: webhook signature verification
// needs the RAW request body, which means disabling Vercel's default JSON
// body parser -- fieldops.js's other actions all rely on the parsed
// req.body, so this can't share that file's config.
//
// HONESTY / SAFETY NOTE (Law #1): tm_invoices.status is set to 'paid' ONLY
// from this handler, after Authorize.Net's own signature-verified webhook is
// received AND a second server-to-server getTransactionDetailsRequest confirms
// the transaction status is 'settledSuccessfully'. A capture (authcapture) is
// NOT settlement, so an auth/capture event alone never marks an invoice paid.
// The client-side redirect after Accept Hosted is never trusted on its own.
//
// Idempotency + audit (2026-08-01, stabilization item 4): every delivered
// event is recorded in authnet_payment_events (sql/044). The webhook
// notificationId is the idempotency key (unique) -- a duplicate/retried
// delivery is detected and never double-applies. Marking an invoice paid is
// additionally guarded by tm_invoices.status ('paid' -> no-op). If any
// database write fails, we return a 5xx so Authorize.Net retries the delivery
// rather than dropping the event.

import { supabaseRequest } from './_lib/jobber.js';
import {
  verifyAuthnetSignature,
  getTransactionInvoiceNumber,
  isSettledTransactionStatus,
} from './_lib/authnet.js';

export const config = { api: { bodyParser: false } };

// Collect the untouched request body as a Buffer. The signature must be
// verified against these exact bytes -- never a parsed-then-re-stringified
// object (key order / whitespace would differ from what Authorize.Net signed).
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Thrown for a database persistence failure so the top-level handler can turn
// it into a retryable 5xx (Authorize.Net will redeliver).
class RetryableDbError extends Error {}

async function sbJson(path, options) {
  let res;
  try {
    res = await supabaseRequest(path, options);
  } catch (e) {
    throw new RetryableDbError(`Supabase network error on ${path}: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new RetryableDbError(`Supabase error on ${path}: ${res.status} ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Insert the audit/idempotency row. Returns { inserted, existing } where a
// unique-violation (409) on notification_id means this event was seen before.
async function recordEventReceived(row) {
  let res;
  try {
    res = await supabaseRequest('authnet_payment_events', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
  } catch (e) {
    throw new RetryableDbError(`Supabase network error inserting payment event: ${e.message}`);
  }
  if (res.status === 409) {
    // Duplicate delivery (same notificationId). Fetch the prior row so we can
    // decide whether it was already fully applied.
    const prior = await sbJson(
      `authnet_payment_events?notification_id=eq.${encodeURIComponent(row.notification_id)}&select=*`,
    );
    return { inserted: false, existing: (prior && prior[0]) || null };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new RetryableDbError(`Supabase error inserting payment event: ${res.status} ${body}`);
  }
  const text = await res.text();
  const rows = text ? JSON.parse(text) : null;
  return { inserted: true, existing: (rows && rows[0]) || null };
}

async function updateEventOutcome(notificationId, fields) {
  await sbJson(`authnet_payment_events?notification_id=eq.${encodeURIComponent(notificationId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...fields, processed_at: new Date().toISOString() }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Could not read request body.' });
  }

  const signatureHeader = req.headers['x-anet-signature'] || req.headers['X-ANET-Signature'];
  if (!verifyAuthnetSignature(rawBody, signatureHeader)) {
    // Wrong/missing signature -- do not process, do not touch the database.
    console.error('authnet-webhook: signature verification failed');
    return res.status(401).json({ ok: false, error: 'Signature verification failed.' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Invalid JSON payload.' });
  }

  const eventType = (event && event.eventType) || null;
  const transId = (event && event.payload && event.payload.id) || null;
  // Idempotency key. Prefer Authorize.Net's own notificationId; fall back to a
  // stable composite so an event without one still can't be double-processed.
  const notificationId =
    (event && event.notificationId) || (eventType && transId ? `${eventType}:${transId}` : null);

  if (!notificationId) {
    return res.status(400).json({ ok: false, error: 'Event missing notificationId.' });
  }

  try {
    // 1) Record the delivery (idempotency + audit ledger).
    const { inserted, existing } = await recordEventReceived({
      notification_id: notificationId,
      event_type: eventType,
      transaction_id: transId,
      outcome: 'received',
      applied_paid: false,
      raw_event: event,
    });

    if (!inserted) {
      // Duplicate delivery. If it was already applied, this is a pure no-op.
      // If a previous attempt died before applying, fall through and retry --
      // marking paid is idempotent (guarded by tm_invoices.status below).
      if (!existing || existing.applied_paid || existing.outcome === 'ignored' || existing.outcome === 'unsettled' || existing.outcome === 'unmatched') {
        return res.status(200).json({ ok: true, duplicate: true, outcome: existing ? existing.outcome : 'received' });
      }
    }

    // 2) Only payment events with a transaction id are candidates. Everything
    // else (refunds, voids, fraud notifications) is acknowledged + audited but
    // not applied in this pass.
    if (!transId || !String(eventType || '').startsWith('net.authorize.payment.')) {
      await updateEventOutcome(notificationId, { outcome: 'ignored' });
      return res.status(200).json({ ok: true, ignored: true, eventType });
    }

    // 3) Confirm the real transaction state server-to-server. The webhook
    // payload cannot be trusted to tell us settlement; we ask Authorize.Net.
    const lookup = await getTransactionInvoiceNumber(transId);
    if (!lookup.ok) {
      // Could not reach / resolve the transaction. Not a DB failure; log and
      // acknowledge (a retry won't fix a permanently-unresolvable transaction,
      // and the audit row preserves it for manual recovery).
      console.error('authnet-webhook: transaction lookup failed for', transId, lookup.error);
      await updateEventOutcome(notificationId, { outcome: 'unresolved', transaction_status: null });
      return res.status(200).json({ ok: true, resolved: false, error: lookup.error || 'lookup failed' });
    }

    await updateEventOutcome(notificationId, {
      transaction_status: lookup.status || null,
      invoice_number: lookup.invoiceNumber || null,
      raw_transaction: lookup.raw || null,
    });

    // 4) THE settlement gate: only a settled transaction marks an invoice paid.
    if (!isSettledTransactionStatus(lookup.status)) {
      await updateEventOutcome(notificationId, { outcome: 'unsettled' });
      return res.status(200).json({ ok: true, settled: false, transactionStatus: lookup.status || null });
    }

    if (!lookup.invoiceNumber) {
      await updateEventOutcome(notificationId, { outcome: 'unmatched' });
      return res.status(200).json({ ok: true, matched: false, error: 'No invoiceNumber on transaction.' });
    }

    // 5) Resolve our invoice row.
    const rows = await sbJson(`tm_invoices?invoice_number=eq.${encodeURIComponent(lookup.invoiceNumber)}&select=*`);
    const invoice = rows && rows[0];
    if (!invoice) {
      console.error('authnet-webhook: no tm_invoices row for invoice_number', lookup.invoiceNumber);
      await updateEventOutcome(notificationId, { outcome: 'unmatched' });
      return res.status(200).json({ ok: true, matched: false, error: 'No matching invoice found.' });
    }

    if (invoice.status === 'paid') {
      // Already recorded -- idempotent no-op (guards against double-apply even
      // across distinct notificationIds for the same settled transaction).
      await updateEventOutcome(notificationId, { outcome: 'processed', applied_paid: true, invoice_id: invoice.id });
      return res.status(200).json({ ok: true, alreadyPaid: true, invoiceId: invoice.id });
    }

    // 6) Mark paid. A failure here is a DB persistence failure -> retryable.
    const paidFields = {
      status: 'paid',
      authnet_transaction_id: transId,
      authnet_response: lookup.raw || null,
      paid_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    // paid_method/paid_amount are from sql/033_card_pricing.sql -- retry
    // without them if that migration hasn't been run yet, so a real settled
    // payment is never left unrecorded over two optional bookkeeping columns.
    let patchRes;
    try {
      patchRes = await supabaseRequest(`tm_invoices?id=eq.${encodeURIComponent(invoice.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...paidFields, paid_method: 'card', paid_amount: invoice.total_amount }),
      });
    } catch (e) {
      throw new RetryableDbError(`Supabase network error marking invoice paid: ${e.message}`);
    }
    if (!patchRes.ok) {
      const errText = await patchRes.text().catch(() => '');
      if (!/paid_method|paid_amount|column/i.test(errText)) {
        throw new RetryableDbError(`Supabase error marking invoice paid: ${patchRes.status} ${errText}`);
      }
      // Optional columns missing -- retry with the core fields only.
      await sbJson(`tm_invoices?id=eq.${encodeURIComponent(invoice.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(paidFields),
      });
    }

    // 7) Finalise the audit row.
    await updateEventOutcome(notificationId, { outcome: 'processed', applied_paid: true, invoice_id: invoice.id });

    return res.status(200).json({ ok: true, matched: true, invoiceId: invoice.id });
  } catch (e) {
    if (e instanceof RetryableDbError) {
      // Persistence failed -- return 503 so Authorize.Net redelivers instead of
      // silently dropping the event. Nothing here is swallowed.
      console.error('authnet-webhook: retryable DB failure:', e.message);
      return res.status(503).json({ ok: false, retryable: true, error: 'Temporary storage error; please retry.' });
    }
    console.error('authnet-webhook error:', e);
    // Unknown/unexpected error -- also retryable (5xx) rather than a false 200.
    return res.status(500).json({ ok: false, error: e.message });
  }
}
