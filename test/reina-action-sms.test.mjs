// test/reina-action-sms.test.mjs
// jomell, 2026-08-29: the Comms Hub's "Reina drafted -- one tap to send"
// box, for real. Extends the existing send_email approval lifecycle
// (test/reina-action-route.test.mjs) to a second action kind, send_sms --
// same issue/consume/reject/outcome rules, a different draft and send path.
//
// Pins the one property that makes this safe to add: execute_sms only ever
// sends using the actionKind the approval was actually ISSUED with (returned
// by consume, mirroring the real reina_action_consume_approval RPC), never
// whichever op happened to be called -- see the "an approval issued as
// send_email cannot be spent as an SMS" test below.
//
// Run with: node --experimental-test-module-mocks --test test/reina-action-sms.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

let clientsRows = [];
let threadRows = [];
let mainNumberRows = [{ e164: '+12035551000' }];
let smsSendResult = { ok: true, sid: 'SM123', status: 'queued' };
let insertedMessages = [];
let twilioSendCount = 0;
let authUser = { id: '22222222-2222-4222-8222-222222222222' };

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path, opts = {}) => {
      const p = String(path);
      if (opts.method === 'POST' && p.startsWith('voice_messages')) {
        const row = JSON.parse(opts.body);
        insertedMessages.push(row);
        return { ok: true, json: async () => [row] };
      }
      if (p.startsWith('clients?')) return { ok: true, json: async () => clientsRows };
      if (p.startsWith('voice_messages?')) return { ok: true, json: async () => threadRows };
      if (p.startsWith('voice_numbers?')) return { ok: true, json: async () => mainNumberRows };
      return { ok: true, json: async () => [] };
    },
    jobberGraphQL: async () => ({}),
  },
});

mock.module('../api/_lib/voice.js', {
  namedExports: {
    twilioRequest: async () => {
      twilioSendCount += 1;
      return { ok: smsSendResult.ok, json: async () => smsSendResult };
    },
    normalizeToE164: (v) => {
      if (!v) return null;
      const s = String(v).trim();
      return s.startsWith('+') ? s : `+1${s.replace(/\D/g, '')}`;
    },
  },
});

mock.module('../api/_lib/guard.js', {
  namedExports: {
    requireApiAuth: async () => (authUser ? { ok: true, user: authUser, via: 'user' } : { ok: false, user: null, via: null }),
  },
});

const { createReinaActionHandler } = await import('../api/reina-action.js');

const ENV = Object.freeze({
  REINA_ACTIONS_ENABLED: 'true',
  REINA_PILOT_PRODUCTION_ENABLED: 'true',
  VERCEL_ENV: 'development',
  OPENAI_API_KEY: 'sk-test-key-long-enough-for-the-check',
});

function response() {
  const out = { statusCode: 0, body: null };
  return { out, res: { setHeader() {}, status(c) { out.statusCode = c; return this; }, json(v) { out.body = v; return this; } } };
}

async function invoke(handler, body, { method = 'POST' } = {}) {
  const { out, res } = response();
  await handler({ method, headers: { authorization: 'Bearer session' }, body }, res);
  return out;
}

function fakeStore() {
  const rows = new Map();
  return {
    rows,
    async issue({ approvalId, proposal, actionKind }) {
      rows.set(approvalId, { proposal, actionKind, spent: false, rejected: false, outcome: null });
      return { status: 'issued', approvalId, expiresAt: '2026-08-29T00:05:00.000Z' };
    },
    async consume({ approvalId }) {
      const row = rows.get(approvalId);
      if (!row) return { status: 'not_found' };
      if (row.rejected) return { status: 'rejected' };
      if (row.spent) return { status: 'duplicate' };
      row.spent = true;
      // Mirrors the real RPC: the returned actionKind is what was ISSUED,
      // never whatever the caller passed in for digest purposes.
      return { status: 'consumed', approvalId, actionKind: row.actionKind };
    },
    async recordOutcome({ approvalId, outcome }) {
      const row = rows.get(approvalId);
      if (row) row.outcome = outcome;
      return { status: 'recorded' };
    },
    async reject({ approvalId }) {
      const row = rows.get(approvalId);
      if (!row || row.spent || row.rejected) return { status: 'not_found' };
      row.rejected = true;
      return { status: 'rejected' };
    },
  };
}

function build(overrides = {}) {
  const store = overrides.store || fakeStore();
  const handler = createReinaActionHandler({
    env: overrides.env || ENV,
    storeImpl: store,
    smsDraftImpl: overrides.smsDraftImpl || (async () => ({ body: 'Sounds good, see you then!' })),
  });
  return { handler, store };
}

function reset() {
  clientsRows = [];
  threadRows = [];
  mainNumberRows = [{ e164: '+12035551000' }];
  smsSendResult = { ok: true, sid: 'SM123', status: 'queued' };
  insertedMessages = [];
  twilioSendCount = 0;
  authUser = { id: '22222222-2222-4222-8222-222222222222' };
}

// ---------------------------------------------------------------------------

test('the route stays off unless it is switched on', async () => {
  reset();
  const { handler } = build({ env: { ...ENV, REINA_ACTIONS_ENABLED: 'false' } });
  const result = await invoke(handler, { op: 'propose_sms', to: '2035551234' });
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, 'actions_disabled');
});

test('a signed-out caller gets nowhere, for any sms op', async () => {
  reset();
  authUser = null;
  const { handler } = build();
  assert.equal((await invoke(handler, { op: 'propose_sms', to: '2035551234' })).statusCode, 401);
  assert.equal((await invoke(handler, { op: 'execute_sms', approvalId: 'x', payload: {} })).statusCode, 401);
  assert.equal((await invoke(handler, { op: 'reject_sms', approvalId: 'x' })).statusCode, 401);
});

test('proposing drafts from the real thread and client, and sends nothing', async () => {
  reset();
  clientsRows = [{ jobber_id: 'J1', name: 'John Peterson' }];
  threadRows = [{ direction: 'inbound', body: 'Any concerns so far?', created_at: '2026-08-29T09:15:00Z' }];
  let seenThread = null;
  const { handler, store } = build({
    smsDraftImpl: async ({ thread }) => { seenThread = thread; return { body: 'None so far! Tracking on schedule.' }; },
  });

  const result = await invoke(handler, { op: 'propose_sms', to: '2035551234', conversationId: 'rp.cmx', turnId: 't.one' });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.executed, false, 'proposing must never send');
  assert.equal(result.body.actionKind, 'send_sms');
  assert.equal(result.body.sensitivity, 'comms');
  assert.equal(result.body.proposal.to, '+12035551234');
  assert.equal(result.body.proposal.body, 'None so far! Tracking on schedule.');
  assert.equal(result.body.clientName, 'John Peterson');
  assert.equal(twilioSendCount, 0);
  assert.equal(store.rows.get(result.body.approvalId).actionKind, 'send_sms');
  // The draft was built from the REAL thread, not invented.
  assert.equal(seenThread.clientName, 'John Peterson');
  assert.deepEqual(seenThread.history, [{ direction: 'inbound', body: 'Any concerns so far?', at: '2026-08-29T09:15:00Z' }]);
});

test('an unmatched number still drafts -- client is honestly null, not guessed', async () => {
  reset();
  clientsRows = [];
  threadRows = [];
  const { handler } = build();
  const result = await invoke(handler, { op: 'propose_sms', to: '2035559999' });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.clientName, null);
});

test('a draft with no usable body never becomes an approval', async () => {
  reset();
  const { handler, store } = build({ smsDraftImpl: async () => ({ body: '' }) });
  const result = await invoke(handler, { op: 'propose_sms', to: '2035551234' });
  assert.equal(result.statusCode, 422);
  assert.equal(store.rows.size, 0);
});

test('a bad phone number is refused before any draft is requested', async () => {
  reset();
  let drafted = false;
  const { handler } = build({ smsDraftImpl: async () => { drafted = true; return { body: 'hi' }; } });
  const result = await invoke(handler, { op: 'propose_sms', to: '' });
  assert.equal(result.statusCode, 400);
  assert.equal(drafted, false);
});

test('approving sends exactly what was approved, over real Twilio, and logs the thread', async () => {
  reset();
  const { handler } = build();
  const proposed = await invoke(handler, { op: 'propose_sms', to: '2035551234' });

  const result = await invoke(handler, {
    op: 'execute_sms',
    approvalId: proposed.body.approvalId,
    payload: { to: proposed.body.proposal.to, body: proposed.body.proposal.body },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.executed, true);
  assert.equal(twilioSendCount, 1);
  assert.equal(insertedMessages.length, 1);
  assert.equal(insertedMessages[0].direction, 'outbound');
  assert.equal(insertedMessages[0].to_number, '+12035551234');
  assert.equal(insertedMessages[0].body, 'Sounds good, see you then!');
  assert.equal(insertedMessages[0].origin, 'reina_approved', 'a Reina-approved send must be labeled as such');
});

test('an edited draft sends the edit, not the original', async () => {
  reset();
  const { handler } = build();
  const proposed = await invoke(handler, { op: 'propose_sms', to: '2035551234' });

  const result = await invoke(handler, {
    op: 'execute_sms',
    approvalId: proposed.body.approvalId,
    payload: { to: proposed.body.proposal.to, body: 'Rewritten by the office before sending.' },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(insertedMessages[0].body, 'Rewritten by the office before sending.');
});

test('approving twice sends once', async () => {
  reset();
  const { handler } = build();
  const proposed = await invoke(handler, { op: 'propose_sms', to: '2035551234' });
  const payload = { to: proposed.body.proposal.to, body: proposed.body.proposal.body };

  const first = await invoke(handler, { op: 'execute_sms', approvalId: proposed.body.approvalId, payload });
  const second = await invoke(handler, { op: 'execute_sms', approvalId: proposed.body.approvalId, payload });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.code, 'approval_duplicate');
  assert.equal(twilioSendCount, 1, 'a second approval attempt must not text the client twice');
});

test('a Twilio failure is recorded as failed and nothing is logged to the thread', async () => {
  reset();
  smsSendResult = { ok: false, message: 'blocked' };
  const { handler, store } = build();
  const proposed = await invoke(handler, { op: 'propose_sms', to: '2035551234' });

  const result = await invoke(handler, {
    op: 'execute_sms',
    approvalId: proposed.body.approvalId,
    payload: { to: proposed.body.proposal.to, body: proposed.body.proposal.body },
  });

  assert.equal(result.statusCode, 502);
  assert.equal(result.body.code, 'send_failed');
  assert.equal(insertedMessages.length, 0);
  assert.equal(store.rows.get(proposed.body.approvalId).outcome, 'failed');
});

test('no active HiveLogic Phone number means a clean refusal, not a crash', async () => {
  reset();
  mainNumberRows = [];
  const { handler, store } = build();
  const proposed = await invoke(handler, { op: 'propose_sms', to: '2035551234' });

  const result = await invoke(handler, {
    op: 'execute_sms',
    approvalId: proposed.body.approvalId,
    payload: { to: proposed.body.proposal.to, body: proposed.body.proposal.body },
  });

  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, 'no_sms_number');
  assert.equal(twilioSendCount, 0);
  assert.equal(store.rows.get(proposed.body.approvalId).outcome, 'failed');
});

test('rejecting is final, and a rejected draft cannot then be sent', async () => {
  reset();
  const { handler } = build();
  const proposed = await invoke(handler, { op: 'propose_sms', to: '2035551234' });

  const rejected = await invoke(handler, { op: 'reject_sms', approvalId: proposed.body.approvalId });
  assert.equal(rejected.statusCode, 200);
  assert.equal(rejected.body.rejected, true);

  const attempted = await invoke(handler, {
    op: 'execute_sms',
    approvalId: proposed.body.approvalId,
    payload: { to: proposed.body.proposal.to, body: proposed.body.proposal.body },
  });
  assert.equal(attempted.statusCode, 409);
  assert.equal(twilioSendCount, 0);
});

// The property this whole design exists to guarantee: which endpoint a
// caller happens to hit is never what decides what an approval can do.
test('an approval issued as send_email cannot be spent as an SMS send', async () => {
  reset();
  const store = fakeStore();
  store.rows.set('rap.crosskind', { proposal: {}, actionKind: 'send_email', spent: false, rejected: false, outcome: null });
  const { handler } = build({ store });

  const result = await invoke(handler, {
    op: 'execute_sms',
    approvalId: 'rap.crosskind',
    payload: { to: '+12035551234', body: 'hijacked send' },
  });

  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, 'action_kind_mismatch');
  assert.equal(twilioSendCount, 0);
  assert.equal(insertedMessages.length, 0);
  assert.equal(store.rows.get('rap.crosskind').outcome, 'failed');
  // And the approval is still spent -- a mismatch is not a free retry.
  assert.equal(store.rows.get('rap.crosskind').spent, true);
});

test('an unknown op still falls through cleanly once sms ops are handled', async () => {
  reset();
  const { handler } = build();
  assert.equal((await invoke(handler, { op: 'propose_sms' }, { method: 'GET' })).statusCode, 405);
});
