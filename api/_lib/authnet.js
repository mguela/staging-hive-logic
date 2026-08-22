// api/_lib/authnet.js — Authorize.Net helper (Chris's processor: United
// Payment Corp, gateway: Authorize.Net). Same discipline as _lib/jobber.js:
// small, honest, no SDK dependency (this repo's convention is raw fetch()
// against vendor APIs, see supabaseRequest).
//
// HONESTY NOTE (Law #1): if AUTHNET_API_LOGIN_ID / AUTHNET_TRANSACTION_KEY
// aren't set in the environment, every function here returns a clear
// "payment processor not connected yet" result instead of throwing an
// opaque error or silently pretending to succeed.
import crypto from 'crypto';

export function authnetConfigured() {
  return !!(process.env.AUTHNET_API_LOGIN_ID && process.env.AUTHNET_TRANSACTION_KEY);
}

function authnetBaseUrl() {
  // AUTHNET_ENVIRONMENT=production switches off sandbox. Defaults to
  // sandbox so nothing can accidentally run live before Chris flips it.
  return process.env.AUTHNET_ENVIRONMENT === 'production'
    ? 'https://api.authorize.net/xml/v1/request.api'
    : 'https://apitest.authorize.net/xml/v1/request.api';
}

function authnetHostedFormUrl() {
  return process.env.AUTHNET_ENVIRONMENT === 'production'
    ? 'https://accept.authorize.net/payment/payment'
    : 'https://test.authorize.net/payment/payment';
}

async function authnetCall(transactionRequestBody) {
  const payload = {
    ...transactionRequestBody,
    merchantAuthentication: {
      name: process.env.AUTHNET_API_LOGIN_ID,
      transactionKey: process.env.AUTHNET_TRANSACTION_KEY,
    },
  };
  const res = await fetch(authnetBaseUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Authorize.Net's JSON API wants the whole payload wrapped in a key
    // named after the request type -- callers pass that wrapper already.
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  // Authorize.Net occasionally prefixes the JSON body with a UTF-8 BOM.
  const clean = text.replace(/^﻿/, '');
  let json;
  try { json = JSON.parse(clean); } catch (e) {
    throw new Error(`Authorize.Net returned non-JSON (status ${res.status}): ${clean.slice(0, 300)}`);
  }
  return json;
}

// Builds a hosted payment page token for Accept Hosted. amount is a number
// (dollars), invoiceNumber must be <=20 chars (Authorize.Net limit) --
// callers pass tm_invoices.invoice_number, never the uuid id.
export async function getHostedPaymentPageToken({ amount, invoiceNumber, description, returnUrl }) {
  if (!authnetConfigured()) {
    return { ok: false, error: 'Payment processor not connected yet -- ask the office to finish Authorize.Net setup.' };
  }
  const body = {
    getHostedPaymentPageRequest: {
      transactionRequest: {
        transactionType: 'authCaptureTransaction',
        amount: Number(amount).toFixed(2),
        order: {
          invoiceNumber: String(invoiceNumber).slice(0, 20),
          description: String(description || '').slice(0, 255),
        },
      },
      hostedPaymentSettings: {
        setting: [
          { settingName: 'hostedPaymentReturnOptions', settingValue: JSON.stringify({ showReceipt: true, url: returnUrl || '', urlText: 'Done', cancelUrl: returnUrl || '', cancelUrlText: 'Cancel' }) },
          { settingName: 'hostedPaymentButtonOptions', settingValue: JSON.stringify({ text: 'Pay' }) },
          { settingName: 'hostedPaymentOrderOptions', settingValue: JSON.stringify({ show: true }) },
          { settingName: 'hostedPaymentPaymentOptions', settingValue: JSON.stringify({ cardCodeRequired: true, showCreditCard: true, showBankAccount: false }) },
        ],
      },
    },
  };
  const json = await authnetCall(body);
  const result = json && json.getHostedPaymentPageResponse;
  const resultCode = result && result.messages && result.messages.resultCode;
  if (resultCode !== 'Ok' || !result.token) {
    const msg = (result && result.messages && result.messages.message && result.messages.message[0] && result.messages.message[0].text) || 'Authorize.Net declined to issue a payment form.';
    return { ok: false, error: msg };
  }
  return { ok: true, formToken: result.token, postUrl: authnetHostedFormUrl() };
}

// Looks up a completed transaction's order.invoiceNumber so the webhook
// handler can match it back to our tm_invoices row (Authorize.Net's webhook
// payload itself only includes the transaction id, not our invoice number).
export async function getTransactionInvoiceNumber(transId) {
  if (!authnetConfigured()) return { ok: false, error: 'Payment processor not connected.' };
  const body = { getTransactionDetailsRequest: { transId: String(transId) } };
  const json = await authnetCall(body);
  const result = json && json.getTransactionDetailsResponse;
  const resultCode = result && result.messages && result.messages.resultCode;
  if (resultCode !== 'Ok') {
    const msg = (result && result.messages && result.messages.message && result.messages.message[0] && result.messages.message[0].text) || 'Could not look up transaction.';
    return { ok: false, error: msg };
  }
  const tx = result.transaction || {};
  const invoiceNumber = tx.order && tx.order.invoiceNumber;
  const status = tx.transactionStatus;
  return { ok: true, invoiceNumber: invoiceNumber || null, status: status || null, raw: tx };
}

// Transaction settlement status: getTransactionDetailsRequest returns
// transaction.transactionStatus. Only 'settledSuccessfully' means the funds
// have actually settled into the merchant's batch -- 'capturedPendingSettlement'
// (what an authCapture/authcapture.created event produces) is NOT settled yet.
// We only mark an invoice paid on true settlement, never on auth/capture.
export const SETTLED_TRANSACTION_STATUS = 'settledSuccessfully';
export function isSettledTransactionStatus(status) {
  return String(status || '') === SETTLED_TRANSACTION_STATUS;
}

// Verifies the X-ANET-Signature header. Authorize.Net computes an
// HMAC-SHA512 over the RAW, byte-for-byte request body, keyed by the
// merchant's Signature Key, and sends it as "sha512=<HEX>".
//
// CRITICAL (was the bug): the Signature Key shown in the merchant portal is a
// 128-character HEXADECIMAL string. It must be decoded to its raw 64 bytes and
// those bytes used as the HMAC key. The previous version passed the hex STRING
// straight into createHmac (treating it as a utf8 key), so every signature we
// computed was wrong and no real Authorize.Net webhook could ever verify.
// See https://developer.authorize.net/api/reference/features/webhooks.html
// ("convert the Signature Key ... into binary").
//
// rawBody must be a Buffer (or string) of the untouched request body -- never
// a parsed-then-re-stringified object, whose key order / whitespace would
// differ from what Authorize.Net signed. The comparison is timing-safe.
export function verifyAuthnetSignature(rawBody, headerValue) {
  const signatureKeyHex = process.env.AUTHNET_SIGNATURE_KEY;
  if (!signatureKeyHex || !headerValue) return false;

  // Hex -> raw bytes. Reject a malformed (non-hex / odd-length) key rather
  // than silently HMAC with a truncated key.
  if (!/^[0-9a-fA-F]+$/.test(signatureKeyHex) || signatureKeyHex.length % 2 !== 0) return false;
  const keyBytes = Buffer.from(signatureKeyHex, 'hex');
  if (keyBytes.length === 0) return false;

  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = crypto.createHmac('sha512', keyBytes).update(bodyBuf).digest(); // Buffer (64 bytes)

  const givenHex = String(headerValue).replace(/^sha512=/i, '').trim();
  if (!/^[0-9a-fA-F]+$/.test(givenHex)) return false;
  const givenBuf = Buffer.from(givenHex, 'hex');

  // timingSafeEqual throws on length mismatch -- guard first.
  if (givenBuf.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(expected, givenBuf);
  } catch (e) {
    return false;
  }
}
