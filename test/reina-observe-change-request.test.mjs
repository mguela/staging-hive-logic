// Reina M1a v0.1 -- observe + recommend smoke test.
//
// Exercises the real endpoint core (reinaObserveChangeRequest) with injected
// deps: a fake supabaseRequest that replays the REAL prod reads for the test
// job (Tony DiGuglielmo Sr., job "Change Order - 2478 - 01") and a fake
// Anthropic client. Proves: STEP 1 context assembly, STEP 2 grounding + the
// null-price / "needs estimator pricing" path, STEP 3 single-write row shape,
// and idempotency (a second run inserts nothing).

import test from 'node:test';
import assert from 'node:assert';
import { reinaObserveChangeRequest } from '../api/reina/observe-change-request.js';

const JOB_ID = 'Z2lkOi8vSm9iYmVyL0pvYi8xNDYxMzkzMTY=';
const CLIENT_ID = 'Z2lkOi8vSm9iYmVyL0NsaWVudC8xMTg3Mzg5MTY=';

// ---- Real prod facts (captured 2026-08-02) --------------------------------
const JOB_ROW = { jobber_id: JOB_ID, title: 'Change Order - 2478 - 01', client_id: CLIENT_ID };
const CLIENT_ROW = { jobber_id: CLIENT_ID, name: 'Tony DiGuglielmo Sr.', email: 'atd@amxcooling.com', balance: 19897.5 };
const INVOICE_BALANCES = [{ computed_balance: 19897.5 }];
const QUOTES = [
  { jobber_id: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzU5MDc0NzAw', quote_number: '1311', title: 'Change Order - 2478 - 01', quote_status: 'converted', total: 17545 },
  { jobber_id: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzU3ODcwNzE5', quote_number: '1281', title: 'Stage 2 Soffit', quote_status: 'converted', total: 3850 },
];

function res(ok, json) {
  return { ok, json: async () => json, text: async () => (ok ? 'ok' : 'err') };
}

// Fake PostgREST. `writes` collects every mutating call so the test can assert
// exactly one write happened. `existing` seeds a pre-existing approval row to
// drive the idempotency path.
function makeSupabase({ existing = [], writes }) {
  return async (path, options = {}) => {
    const isWrite = options && options.method && options.method !== 'GET';
    if (isWrite) {
      writes.push({ path, options });
      const inserted = { id: 'new-uuid', ...JSON.parse(options.body) };
      return res(true, [inserted]);
    }
    if (path.startsWith('marketing_approvals?')) return res(true, existing);
    if (path.startsWith('jobs?')) return res(true, [JOB_ROW]);
    if (path.startsWith('clients?')) return res(true, [CLIENT_ROW]);
    if (path.startsWith('invoice_balances?')) return res(true, INVOICE_BALANCES);
    if (path.startsWith('quotes?')) return res(true, QUOTES);
    if (path.startsWith('change_orders?')) return res(true, []); // none for this job
    throw new Error('unexpected supabase path: ' + path);
  };
}

function fakeAnthropic(obj, capture) {
  return {
    messages: {
      create: async (opts) => {
        if (capture) capture.prompt = opts.messages[0].content;
        return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
      },
    },
  };
}

const MODEL_OUT_NO_PRICE = {
  title: 'Change request: add recessed lighting to soffit',
  summary: 'The client asks to add four recessed lights to the new soffit run from the Stage 2 Soffit quote. This is additional scope beyond the current change order.',
  scope_delta: 'Add 4 recessed lights + wiring to the existing soffit scope.',
  client_stated_amount_cents: null,
  confidence: 72,
  risks: ['Electrical rough-in may need an inspection not currently scheduled.'],
  gaps: ['Client did not confirm fixture spec or a budget.'],
  cited_excerpt: 'can we add a few recessed lights in the new soffit?',
};

test('inserts exactly one pending row and grounds the prompt in real context (no client price -> amount null)', async () => {
  const writes = [];
  const capture = {};
  const out = await reinaObserveChangeRequest(
    { jobId: JOB_ID, requestText: 'Hey — can we add a few recessed lights in the new soffit? Let me know.' },
    { supabaseRequest: makeSupabase({ existing: [], writes }), anthropic: fakeAnthropic(MODEL_OUT_NO_PRICE, capture), now: () => '2026-08-02T00:00:00Z' },
  );

  assert.strictEqual(out.status, 201);
  assert.strictEqual(out.body.ok, true);
  assert.strictEqual(out.body.idempotent, false);
  assert.strictEqual(out.body.idempotency_key, `reina-m1a-observe-${JOB_ID}`);

  // Exactly ONE write, and it is the marketing_approvals insert.
  assert.strictEqual(writes.length, 1, 'must perform exactly one write');
  assert.strictEqual(writes[0].path, 'marketing_approvals');
  assert.strictEqual(writes[0].options.method, 'POST');

  const row = JSON.parse(writes[0].options.body);
  assert.strictEqual(row.approvable_type, 'reina_change_request');
  assert.strictEqual(row.approvable_id, JOB_ID);
  assert.strictEqual(row.requested_by, 'reina');
  assert.strictEqual(row.status, 'pending');
  assert.strictEqual(row.confidence, 72);
  assert.strictEqual(row.amount_cents, null, 'no client-stated price -> null amount');
  assert.strictEqual(row.estimate.needs_estimator_pricing, true);
  assert.match(row.rationale, /needs estimator pricing/);
  assert.match(row.rationale, /Cited from client request/);
  assert.strictEqual(row.estimate.idempotency_key, `reina-m1a-observe-${JOB_ID}`);
  assert.strictEqual(row.estimate.request_source, 'pasted_client_message');
  assert.strictEqual(row.estimate.context.client_open_ar, 19897.5);
  assert.strictEqual(row.estimate.context.quotes_count, 2);

  // Prompt was grounded in real facts and forbids inventing a price.
  assert.match(capture.prompt, /Tony DiGuglielmo Sr\./);
  assert.match(capture.prompt, /19897\.5/);
  assert.match(capture.prompt, /NEVER invent or estimate a price/i);
  assert.match(capture.prompt, /Change Order - 2478 - 01/);
});

test('is idempotent: a prior observation for the job returns it and writes nothing', async () => {
  const writes = [];
  const existing = [{ id: 'prior-uuid', status: 'pending', title: 'prior', confidence: 72, amount_cents: null, created_at: '2026-08-01T00:00:00Z' }];
  const out = await reinaObserveChangeRequest(
    { jobId: JOB_ID, requestText: 'add recessed lights' },
    { supabaseRequest: makeSupabase({ existing, writes }), anthropic: fakeAnthropic(MODEL_OUT_NO_PRICE) },
  );
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.idempotent, true);
  assert.strictEqual(out.body.approval.id, 'prior-uuid');
  assert.strictEqual(writes.length, 0, 'no write on the idempotent path');
});

test('carries a client-stated price into amount_cents when present', async () => {
  const writes = [];
  const withPrice = { ...MODEL_OUT_NO_PRICE, client_stated_amount_cents: 45000, confidence: 88 };
  const out = await reinaObserveChangeRequest(
    { jobId: JOB_ID, requestText: 'Please add the lights, my budget is $450.' },
    { supabaseRequest: makeSupabase({ existing: [], writes }), anthropic: fakeAnthropic(withPrice) },
  );
  assert.strictEqual(out.status, 201);
  const row = JSON.parse(writes[0].options.body);
  assert.strictEqual(row.amount_cents, 45000);
  assert.strictEqual(row.estimate.needs_estimator_pricing, false);
});

test('validates inputs and never writes on bad input', async () => {
  const writes = [];
  const sb = makeSupabase({ existing: [], writes });
  const a = await reinaObserveChangeRequest({ jobId: '', requestText: 'x' }, { supabaseRequest: sb, anthropic: fakeAnthropic(MODEL_OUT_NO_PRICE) });
  assert.strictEqual(a.status, 400);
  const b = await reinaObserveChangeRequest({ jobId: JOB_ID, requestText: '   ' }, { supabaseRequest: sb, anthropic: fakeAnthropic(MODEL_OUT_NO_PRICE) });
  assert.strictEqual(b.status, 400);
  assert.strictEqual(writes.length, 0);
});

test('404s when the job does not exist', async () => {
  const writes = [];
  const sb = async (path, options = {}) => {
    if (options.method && options.method !== 'GET') { writes.push(path); return res(true, [{}]); }
    if (path.startsWith('marketing_approvals?')) return res(true, []);
    if (path.startsWith('jobs?')) return res(true, []); // no such job
    return res(true, []);
  };
  const out = await reinaObserveChangeRequest({ jobId: 'nope', requestText: 'x' }, { supabaseRequest: sb, anthropic: fakeAnthropic(MODEL_OUT_NO_PRICE) });
  assert.strictEqual(out.status, 404);
  assert.strictEqual(writes.length, 0);
});
