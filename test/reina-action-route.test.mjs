import test from 'node:test';
import assert from 'node:assert/strict';

import { createReinaActionHandler } from '../api/reina-action.js';
import {
  normalizeEmailPayload,
  payloadDigest,
  requiresApproval,
} from '../api/_lib/reina/action-approvals.js';

const ENV = Object.freeze({
  REINA_ACTIONS_ENABLED: 'true',
  REINA_PILOT_PRODUCTION_ENABLED: 'true',
  VERCEL_ENV: 'development',
  OPENAI_API_KEY: 'sk-test-key-long-enough-for-the-check',
});

const USER = { uid: '11111111-1111-4111-8111-111111111111', realm: 'main' };

function response() {
  const out = { statusCode: 0, body: null, headers: {} };
  return {
    out,
    res: {
      setHeader(name, value) { out.headers[name] = value; },
      status(code) { out.statusCode = code; return this; },
      json(value) { out.body = value; return this; },
    },
  };
}

async function invoke(handler, body, { method = 'POST' } = {}) {
  const { out, res } = response();
  await handler({ method, headers: { authorization: 'Bearer session' }, body }, res);
  return out;
}

// A stand-in for the real approval table that keeps the ONE rule that matters:
// an approval can be consumed exactly once.
function fakeStore({ issueStatus = 'issued' } = {}) {
  const rows = new Map();
  const calls = [];
  return {
    rows,
    calls,
    async issue({ approvalId, proposal, actionKind }) {
      calls.push('issue');
      if (issueStatus !== 'issued') return { status: issueStatus };
      rows.set(approvalId, { proposal, actionKind, spent: false, rejected: false, outcome: null });
      return { status: 'issued', approvalId, expiresAt: '2026-08-24T00:05:00.000Z' };
    },
    async consume({ approvalId, payload, actionKind }) {
      calls.push('consume');
      const row = rows.get(approvalId);
      if (!row) return { status: 'not_found' };
      if (row.rejected) return { status: 'rejected' };
      if (row.spent) return { status: 'duplicate' };
      row.spent = true;
      row.digest = payloadDigest(actionKind, payload);
      return { status: 'consumed', approvalId };
    },
    async recordOutcome({ approvalId, outcome }) {
      calls.push('recordOutcome');
      const row = rows.get(approvalId);
      if (row) row.outcome = outcome;
      return { status: 'recorded' };
    },
    async reject({ approvalId }) {
      calls.push('reject');
      const row = rows.get(approvalId);
      if (!row || row.spent || row.rejected) return { status: 'not_found' };
      row.rejected = true;
      return { status: 'rejected' };
    },
  };
}

function fakeMail({ user = USER, sendResult = { ok: true, from: 'chris@ghgrp.net' } } = {}) {
  const sent = [];
  return {
    sent,
    async resolveMailUser() { return user; },
    async mailboxesForUser() { return [{ address: 'chris@ghgrp.net', name: 'Chris' }]; },
    async sendMailForUser(args) { sent.push(args); return sendResult; },
  };
}

const GOOD_DRAFT = {
  to: ['allan@ghgrp.net', 'andy@ghgrp.net'],
  cc: [],
  bcc: [],
  subject: 'Productivity plan',
  body: 'Here is the plan we discussed.',
};

function build(overrides = {}) {
  const store = overrides.store || fakeStore();
  const mail = overrides.mail || fakeMail();
  const handler = createReinaActionHandler({
    env: overrides.env || ENV,
    storeImpl: store,
    mailImpl: mail,
    draftImpl: overrides.draftImpl || (async () => GOOD_DRAFT),
  });
  return { handler, store, mail };
}

// ---------------------------------------------------------------------------

test('the whole route is off unless it is switched on', async () => {
  const { handler, mail } = build({ env: { ...ENV, REINA_ACTIONS_ENABLED: 'false' } });
  const result = await invoke(handler, { op: 'propose', utterance: 'email allan the plan' });
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, 'actions_disabled');
  assert.equal(mail.sent.length, 0);
});

test('production additionally requires the pilot to be live', async () => {
  const { handler } = build({
    env: { ...ENV, VERCEL_ENV: 'production', REINA_PILOT_PRODUCTION_ENABLED: 'false' },
  });
  assert.equal((await invoke(handler, { op: 'propose', utterance: 'x' })).statusCode, 503);
});

test('a signed-out caller gets nowhere', async () => {
  const { handler, mail } = build({ mail: fakeMail({ user: null }) });
  const result = await invoke(handler, { op: 'propose', utterance: 'email allan the plan' });
  assert.equal(result.statusCode, 401);
  assert.equal(mail.sent.length, 0);
});

test('proposing writes an approval and sends nothing', async () => {
  const { handler, store, mail } = build();
  const result = await invoke(handler, {
    op: 'propose',
    utterance: 'send an email of this plan to allan and andy',
    conversationId: 'rp.conv',
    turnId: 't.one',
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.executed, false, 'proposing must never execute');
  assert.equal(result.body.needsApproval, true);
  assert.equal(result.body.sensitivity, 'comms');
  assert.match(result.body.approvalId, /^rap\.[0-9a-f]{32}$/);
  assert.deepEqual(result.body.proposal.to, GOOD_DRAFT.to);
  assert.equal(mail.sent.length, 0, 'nothing may be sent at proposal time');
  assert.equal(store.rows.size, 1);
});

test('a draft that is not a valid email never becomes an approval', async () => {
  const { handler, store, mail } = build({
    draftImpl: async () => ({ to: ['not-an-address'], subject: 'x', body: 'y' }),
  });
  const result = await invoke(handler, { op: 'propose', utterance: 'email someone' });
  assert.equal(result.statusCode, 422);
  assert.equal(store.rows.size, 0, 'an unexecutable draft must not leave an approval behind');
  assert.equal(mail.sent.length, 0);
});

test('approving sends exactly what was approved', async () => {
  const { handler, mail } = build();
  const proposed = await invoke(handler, { op: 'propose', utterance: 'email allan the plan' });

  const result = await invoke(handler, {
    op: 'execute',
    approvalId: proposed.body.approvalId,
    payload: proposed.body.proposal,
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.executed, true);
  assert.equal(mail.sent.length, 1);
  assert.deepEqual(
    mail.sent[0].message.toRecipients.map((r) => r.emailAddress.address),
    GOOD_DRAFT.to,
  );
  assert.equal(mail.sent[0].message.subject, 'Productivity plan');
});

// Chris chose an editable preview. What he changes is what must go out -- if the
// server sent the original draft, the edit box would be a lie.
test('an edited draft sends the edit, not the original', async () => {
  const { handler, store, mail } = build();
  const proposed = await invoke(handler, { op: 'propose', utterance: 'email allan the plan' });

  const edited = {
    ...proposed.body.proposal,
    to: ['kevin@ghgrp.net'],
    subject: 'Productivity plan (revised)',
    body: 'Rewritten by hand before sending.',
  };
  const result = await invoke(handler, {
    op: 'execute',
    approvalId: proposed.body.approvalId,
    payload: edited,
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(mail.sent[0].message.toRecipients.map((r) => r.emailAddress.address), ['kevin@ghgrp.net']);
  assert.equal(mail.sent[0].message.subject, 'Productivity plan (revised)');
  // And the record says what actually went, not what she drafted.
  const row = store.rows.get(proposed.body.approvalId);
  assert.equal(row.digest, payloadDigest('send_email', normalizeEmailPayload(edited)));
});

// The failure this design exists to prevent.
test('approving twice sends once', async () => {
  const { handler, mail } = build();
  const proposed = await invoke(handler, { op: 'propose', utterance: 'email allan the plan' });
  const payload = proposed.body.proposal;

  const first = await invoke(handler, { op: 'execute', approvalId: proposed.body.approvalId, payload });
  const second = await invoke(handler, { op: 'execute', approvalId: proposed.body.approvalId, payload });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.code, 'approval_duplicate');
  assert.equal(mail.sent.length, 1, 'a second approval must not become a second email');
});

test('an approval nobody issued cannot be spent', async () => {
  const { handler, mail } = build();
  const result = await invoke(handler, {
    op: 'execute',
    approvalId: 'rap.00000000000000000000000000000000',
    payload: GOOD_DRAFT,
  });
  assert.equal(result.statusCode, 404);
  assert.equal(mail.sent.length, 0);
});

test('rejecting is final, and a rejected draft cannot then be sent', async () => {
  const { handler, mail } = build();
  const proposed = await invoke(handler, { op: 'propose', utterance: 'email allan the plan' });

  const rejected = await invoke(handler, { op: 'reject', approvalId: proposed.body.approvalId });
  assert.equal(rejected.statusCode, 200);
  assert.equal(rejected.body.rejected, true);

  const attempted = await invoke(handler, {
    op: 'execute',
    approvalId: proposed.body.approvalId,
    payload: proposed.body.proposal,
  });
  assert.equal(attempted.statusCode, 409);
  assert.equal(mail.sent.length, 0);
});

test('a send that fails is recorded as failed and the approval stays spent', async () => {
  const mail = fakeMail({ sendResult: { ok: false, error: 'mailbox rejected the message' } });
  const { handler, store } = build({ mail });
  const proposed = await invoke(handler, { op: 'propose', utterance: 'email allan the plan' });

  const result = await invoke(handler, {
    op: 'execute',
    approvalId: proposed.body.approvalId,
    payload: proposed.body.proposal,
  });
  assert.equal(result.statusCode, 502);
  assert.equal(result.body.code, 'send_failed');
  assert.equal(store.rows.get(proposed.body.approvalId).outcome, 'failed');

  // Retrying is a new approval, not a second go at the old one. Otherwise a
  // send that failed AFTER the mail server accepted it could go twice.
  const retried = await invoke(handler, {
    op: 'execute',
    approvalId: proposed.body.approvalId,
    payload: proposed.body.proposal,
  });
  assert.equal(retried.statusCode, 409);
});

test('a payload that is not a sendable email is refused before the approval is touched', async () => {
  const { handler, store, mail } = build();
  const proposed = await invoke(handler, { op: 'propose', utterance: 'email allan the plan' });

  const result = await invoke(handler, {
    op: 'execute',
    approvalId: proposed.body.approvalId,
    payload: { ...proposed.body.proposal, subject: 'Subject\r\nBcc: someone@else.com' },
  });

  assert.equal(result.statusCode, 422);
  assert.equal(mail.sent.length, 0);
  assert.equal(store.rows.get(proposed.body.approvalId).spent, false, 'a rejected payload must not burn the approval');
});

test('an unknown operation does nothing at all', async () => {
  const { handler, mail } = build();
  assert.equal((await invoke(handler, { op: 'send_it_now' })).statusCode, 400);
  assert.equal((await invoke(handler, { op: 'propose' }, { method: 'GET' })).statusCode, 405);
  assert.equal(mail.sent.length, 0);
});

// Classification is what decides whether a human is asked at all, so the
// dangerous default is the one where forgetting to classify means "no popup".
test('an unclassified action is treated as needing approval', () => {
  assert.equal(requiresApproval('send_email'), true);
  assert.equal(requiresApproval('wire_the_deposit'), true);
  assert.equal(requiresApproval(undefined), true);
});
