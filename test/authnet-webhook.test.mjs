// test/authnet-webhook.test.mjs
// Tests for the Authorize.Net webhook receiver (stabilization item 4).
// Every scenario is mocked: no real network call, no real secret, ever.
//
// Run with:
//   node --test test/authnet-webhook.test.mjs
//
// Covers: valid signature accepted; invalid signature rejected (401, no DB
// write); duplicate delivery is idempotent; an auth/capture (unsettled) event
// does NOT mark the invoice paid; a settled event DOES; a DB persistence
// failure returns a retryable 5xx.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// --- Environment (set before importing the handler / helpers) ---------------
// A valid Signature Key is a 128-char hex string. The handler must hex-decode
// it to 64 raw bytes and use THOSE as the HMAC-SHA512 key.
const SIGNATURE_KEY_HEX = 'A'.repeat(128);
process.env.AUTHNET_SIGNATURE_KEY = SIGNATURE_KEY_HEX;
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.AUTHNET_API_LOGIN_ID = 'test-login';
process.env.AUTHNET_TRANSACTION_KEY = 'test-txn-key';
process.env.AUTHNET_ENVIRONMENT = 'production';

const { default: handler } = await import('../api/authnet-webhook.js');
const { verifyAuthnetSignature } = await import('../api/_lib/authnet.js');

// --- Helpers ----------------------------------------------------------------

// Compute the signature the same way Authorize.Net does: HMAC-SHA512 keyed by
// the HEX-DECODED signature key, over the raw body bytes, hex-encoded.
function signRaw(rawBody) {
  const keyBytes = Buffer.from(SIGNATURE_KEY_HEX, 'hex');
  const hex = crypto.createHmac('sha512', keyBytes).update(Buffer.from(rawBody, 'utf8')).digest('hex');
  return `sha512=${hex}`;
}

function mockReq({ method = 'POST', rawBody = '', signature } = {}) {
  const headers = {};
  if (signature !== undefined) headers['x-anet-signature'] = signature;
  return {
    method,
    headers,
    on(evt, cb) {
      if (evt === 'data') cb(Buffer.from(rawBody, 'utf8'));
      if (evt === 'end') cb();
      return this;
    },
  };
}

function fakeRes() {
  const calls = [];
  return {
    calls,
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      calls.push({ code });
      return {
        json: (body) => {
          this.body = body;
          calls.push({ body });
          return body;
        },
      };
    },
  };
}

function fetchRes({ ok = true, status = 200, body = null }) {
  const text = body === null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  return { ok, status, text: async () => text, json: async () => (body && typeof body !== 'string' ? body : JSON.parse(text)) };
}

// In-memory fake of Authorize.Net + Supabase, wired through global.fetch.
function installFakes({ transaction, invoices = [], failEventInsert = false } = {}) {
  const store = {
    events: new Map(),   // notification_id -> row
    invoices: invoices.map((i) => ({ ...i })),
    counts: { authnetLookups: 0, eventInserts: 0, invoicePatches: 0, supabaseCalls: 0 },
  };
  const prev = global.fetch;

  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = (opts.method || 'GET').toUpperCase();

    // ---- Authorize.Net getTransactionDetailsRequest ----
    if (u.host.includes('authorize.net')) {
      store.counts.authnetLookups++;
      return fetchRes({
        body: {
          getTransactionDetailsResponse: {
            messages: { resultCode: 'Ok', message: [{ text: 'Ok' }] },
            transaction: {
              transactionStatus: transaction.status,
              order: { invoiceNumber: transaction.invoiceNumber },
            },
          },
        },
      });
    }

    store.counts.supabaseCalls++;
    const path = u.pathname;

    // ---- authnet_payment_events ----
    if (path.endsWith('/authnet_payment_events')) {
      if (method === 'POST') {
        store.counts.eventInserts++;
        if (failEventInsert) return fetchRes({ ok: false, status: 500, body: 'boom: db down' });
        const row = JSON.parse(opts.body);
        if (store.events.has(row.notification_id)) {
          return fetchRes({ ok: false, status: 409, body: 'duplicate key value violates unique constraint' });
        }
        const stored = { id: store.events.size + 1, applied_paid: false, ...row };
        store.events.set(row.notification_id, stored);
        return fetchRes({ status: 201, body: [stored] });
      }
      if (method === 'PATCH') {
        const nid = (u.searchParams.get('notification_id') || '').replace(/^eq\./, '');
        const patch = JSON.parse(opts.body);
        if (store.events.has(nid)) store.events.set(nid, { ...store.events.get(nid), ...patch });
        return fetchRes({ status: 204, body: null });
      }
      if (method === 'GET') {
        const nid = (u.searchParams.get('notification_id') || '').replace(/^eq\./, '');
        const row = store.events.get(nid);
        return fetchRes({ body: row ? [row] : [] });
      }
    }

    // ---- tm_invoices ----
    if (path.endsWith('/tm_invoices')) {
      if (method === 'GET') {
        const inv = (u.searchParams.get('invoice_number') || '').replace(/^eq\./, '');
        const rows = store.invoices.filter((r) => String(r.invoice_number) === inv);
        return fetchRes({ body: rows });
      }
      if (method === 'PATCH') {
        store.counts.invoicePatches++;
        const id = (u.searchParams.get('id') || '').replace(/^eq\./, '');
        const patch = JSON.parse(opts.body);
        const row = store.invoices.find((r) => String(r.id) === id);
        if (row) Object.assign(row, patch);
        return fetchRes({ status: 204, body: null });
      }
    }

    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  };

  return {
    store,
    restore() { global.fetch = prev; },
  };
}

function makeEvent({ notificationId = 'ntf-1', eventType = 'net.authorize.payment.authcapture.created', transId = 'txn-1' } = {}) {
  return { notificationId, eventType, payload: { id: transId, entityName: 'transaction' } };
}

// --- Unit: the hex-decoding bug fix ----------------------------------------

test('verifyAuthnetSignature accepts a signature computed with the HEX-DECODED key', () => {
  const raw = '{"hello":"world"}';
  assert.equal(verifyAuthnetSignature(Buffer.from(raw), signRaw(raw)), true);
});

test('verifyAuthnetSignature rejects a signature computed with the RAW (undecoded) key string', () => {
  // This is exactly what the old, buggy code produced: HMAC keyed by the hex
  // STRING rather than its bytes. It must NOT verify.
  const raw = '{"hello":"world"}';
  const buggy = 'sha512=' + crypto.createHmac('sha512', SIGNATURE_KEY_HEX).update(raw, 'utf8').digest('hex');
  assert.equal(verifyAuthnetSignature(Buffer.from(raw), buggy), false);
});

test('verifyAuthnetSignature rejects a tampered body', () => {
  const sig = signRaw('{"amount":10}');
  assert.equal(verifyAuthnetSignature(Buffer.from('{"amount":9999}'), sig), false);
});

// --- Handler: valid signature + settled -> marks paid ----------------------

test('valid signature on a SETTLED transaction marks the invoice paid', async () => {
  const fakes = installFakes({
    transaction: { status: 'settledSuccessfully', invoiceNumber: 'INV-100' },
    invoices: [{ id: 'uuid-1', invoice_number: 'INV-100', status: 'pending', total_amount: 250 }],
  });
  try {
    const raw = JSON.stringify(makeEvent());
    const res = fakeRes();
    await handler(mockReq({ rawBody: raw, signature: signRaw(raw) }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.matched, true);
    assert.equal(fakes.store.invoices[0].status, 'paid');
    assert.equal(fakes.store.invoices[0].authnet_transaction_id, 'txn-1');
    assert.equal(fakes.store.counts.invoicePatches, 1);
    const evt = fakes.store.events.get('ntf-1');
    assert.equal(evt.outcome, 'processed');
    assert.equal(evt.applied_paid, true);
  } finally {
    fakes.restore();
  }
});

// --- Handler: invalid signature -> 401, no DB write ------------------------

test('invalid signature is rejected 401 and never touches the database', async () => {
  const fakes = installFakes({
    transaction: { status: 'settledSuccessfully', invoiceNumber: 'INV-100' },
    invoices: [{ id: 'uuid-1', invoice_number: 'INV-100', status: 'pending', total_amount: 250 }],
  });
  try {
    const raw = JSON.stringify(makeEvent());
    const res = fakeRes();
    await handler(mockReq({ rawBody: raw, signature: 'sha512=deadbeef' }), res);

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.ok, false);
    assert.equal(fakes.store.counts.supabaseCalls, 0, 'no DB write on a bad signature');
    assert.equal(fakes.store.counts.authnetLookups, 0);
    assert.equal(fakes.store.invoices[0].status, 'pending');
  } finally {
    fakes.restore();
  }
});

test('missing signature header is rejected 401', async () => {
  const fakes = installFakes({ transaction: { status: 'settledSuccessfully', invoiceNumber: 'INV-100' } });
  try {
    const raw = JSON.stringify(makeEvent());
    const res = fakeRes();
    await handler(mockReq({ rawBody: raw /* no signature */ }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(fakes.store.counts.supabaseCalls, 0);
  } finally {
    fakes.restore();
  }
});

// --- Handler: auth/capture (unsettled) event does NOT mark paid ------------

test('an unsettled (capturedPendingSettlement) transaction does NOT mark the invoice paid', async () => {
  const fakes = installFakes({
    transaction: { status: 'capturedPendingSettlement', invoiceNumber: 'INV-100' },
    invoices: [{ id: 'uuid-1', invoice_number: 'INV-100', status: 'pending', total_amount: 250 }],
  });
  try {
    const raw = JSON.stringify(makeEvent()); // authcapture.created
    const res = fakeRes();
    await handler(mockReq({ rawBody: raw, signature: signRaw(raw) }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.settled, false);
    assert.equal(res.body.transactionStatus, 'capturedPendingSettlement');
    assert.equal(fakes.store.invoices[0].status, 'pending', 'invoice must stay unpaid');
    assert.equal(fakes.store.counts.invoicePatches, 0, 'no invoice write for an unsettled txn');
    assert.equal(fakes.store.events.get('ntf-1').outcome, 'unsettled');
  } finally {
    fakes.restore();
  }
});

// --- Handler: duplicate delivery is idempotent -----------------------------

test('a duplicate webhook delivery does not double-apply', async () => {
  const fakes = installFakes({
    transaction: { status: 'settledSuccessfully', invoiceNumber: 'INV-100' },
    invoices: [{ id: 'uuid-1', invoice_number: 'INV-100', status: 'pending', total_amount: 250 }],
  });
  try {
    const raw = JSON.stringify(makeEvent({ notificationId: 'ntf-dup' }));
    const sig = signRaw(raw);

    const res1 = fakeRes();
    await handler(mockReq({ rawBody: raw, signature: sig }), res1);
    assert.equal(res1.body.matched, true);

    const res2 = fakeRes();
    await handler(mockReq({ rawBody: raw, signature: sig }), res2);
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.body.duplicate, true);

    assert.equal(fakes.store.counts.invoicePatches, 1, 'invoice marked paid exactly once across two deliveries');
    assert.equal(fakes.store.invoices[0].status, 'paid');
  } finally {
    fakes.restore();
  }
});

// --- Handler: DB persistence failure -> retryable 5xx ----------------------

test('a database persistence failure returns a retryable 5xx (not a swallowed 200)', async () => {
  const fakes = installFakes({
    transaction: { status: 'settledSuccessfully', invoiceNumber: 'INV-100' },
    invoices: [{ id: 'uuid-1', invoice_number: 'INV-100', status: 'pending', total_amount: 250 }],
    failEventInsert: true,
  });
  try {
    const raw = JSON.stringify(makeEvent());
    const res = fakeRes();
    await handler(mockReq({ rawBody: raw, signature: signRaw(raw) }), res);

    assert.equal(res.statusCode >= 500 && res.statusCode < 600, true, `expected 5xx, got ${res.statusCode}`);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.retryable, true);
    assert.equal(fakes.store.invoices[0].status, 'pending', 'invoice must not be marked paid when persistence failed');
  } finally {
    fakes.restore();
  }
});

// --- Handler: non-payment event is acknowledged but not applied ------------

test('a non-payment event (e.g. refund) is acknowledged and audited, not applied', async () => {
  const fakes = installFakes({
    transaction: { status: 'settledSuccessfully', invoiceNumber: 'INV-100' },
    invoices: [{ id: 'uuid-1', invoice_number: 'INV-100', status: 'pending', total_amount: 250 }],
  });
  try {
    const raw = JSON.stringify(makeEvent({ notificationId: 'ntf-refund', eventType: 'net.authorize.payment.refund.created', transId: null }));
    const res = fakeRes();
    await handler(mockReq({ rawBody: raw, signature: signRaw(raw) }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ignored, true);
    assert.equal(fakes.store.counts.invoicePatches, 0);
    assert.equal(fakes.store.events.get('ntf-refund').outcome, 'ignored');
  } finally {
    fakes.restore();
  }
});
