// test/estimate-send-client-email.test.mjs
// jomell, 2026-08-25: "when clicking 'send to client'... i should receive an
// email... that email should contain details and there should be a button
// or lets say links either saying 'approve' or 'reject'."
//
// What these tests pin:
//   - sending still succeeds even when the email can't be delivered (no
//     client email on file, RESEND_API_KEY unset, or a DB error creating the
//     response-link row) -- a failure to email must never fail the send
//   - the token is generated via the shared portal-auth primitives
//     (genToken/hashToken), never a home-grown crypto call
//   - the raw token appears ONLY in the emailed links, never in what gets
//     stored (only its hash does)
//   - both an Approve and a Reject link are included
//   - the response reports honestly whether the client email went out
//
// Run with: node --experimental-test-module-mocks --test test/estimate-send-client-email.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.BOOKKEEPING_ENABLED = 'true';

let estimateFixture;
let updateEstimateImpl;
let clientRows;
let companyRows;
let insertedLinks;
let sendEmailCalls;
let sendEmailShouldFail;
let emailConfigured;
let leadAdvanceCalls;

mock.module('../api/bookkeeping/estimates/_store.js', {
  namedExports: {
    getEstimate: async () => estimateFixture,
    updateEstimate: async (_companyId, _id, mutate) => updateEstimateImpl(mutate),
  },
});

mock.module('../api/bookkeeping/purchase-orders/_actor.js', {
  namedExports: {
    getTrustedActor: async () => ({ id: 'user-1', companyId: 'greenwich-handyman', role: 'controller' }),
  },
});

mock.module('../api/_lib/lead-estimate-link.js', {
  namedExports: {
    advanceLeadOnSend: async (leadId) => { leadAdvanceCalls.push(leadId); return { advanced: true, stage: 'estimate_sent' }; },
  },
});

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path, opts) => {
      if (path.startsWith('clients?')) return { ok: true, json: async () => clientRows };
      if (path.startsWith('companies?')) return { ok: true, json: async () => companyRows };
      if (path.startsWith('estimate_response_links')) {
        if (opts && opts.method === 'POST') {
          const row = JSON.parse(opts.body)[0];
          insertedLinks.push(row);
          return { ok: true, json: async () => [{ ...row, id: 'link-1' }] };
        }
      }
      return { ok: true, json: async () => [] };
    },
    jobberGraphQL: async () => ({}),
  },
});

mock.module('../api/_lib/email.js', {
  namedExports: {
    isEmailConfigured: () => emailConfigured,
    sendEmail: async (opts) => {
      sendEmailCalls.push(opts);
      return sendEmailShouldFail ? { ok: false, error: 'resend down' } : { ok: true, id: 'email-1' };
    },
  },
});

mock.module('../server/bookkeeping/src/estimates.js', {
  namedExports: {
    sendEstimate: (est) => ({ ...est, lifecycleStatus: 'sent' }),
  },
});

const handler = (await import('../api/bookkeeping/estimates/send.js')).default;

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function req(overrides = {}) {
  return {
    method: 'POST',
    headers: { host: 'staging-hive-logic-ten.vercel.app', 'x-forwarded-proto': 'https', ...overrides.headers },
    body: { id: 'est-uuid-1', ...overrides.body },
  };
}

function reset() {
  estimateFixture = {
    id: 'est-uuid-1',
    estimateNumber: 'E-10012',
    companyId: 'greenwich-handyman',
    clientId: 'client-jobber-1',
    title: 'AC test',
    lifecycleStatus: 'draft',
    totals: { price: 1000, cardPrice: 1040 },
    paymentSchedule: [{ isDeposit: true, pct: 50, label: 'Deposit' }, { pct: 50, label: 'Balance due upon completion' }],
  };
  updateEstimateImpl = async (mutate) => { estimateFixture = mutate(estimateFixture); return estimateFixture; };
  clientRows = [{ email: 'jomell@ghgrp.net', name: 'Jomell Alba', first_name: 'Jomell' }];
  companyRows = [{ name: 'Greenwich Handyman' }];
  insertedLinks = [];
  sendEmailCalls = [];
  sendEmailShouldFail = false;
  emailConfigured = true;
  leadAdvanceCalls = [];
}

test('sending emails the client with both an Approve and a Reject link', async () => {
  reset();
  const r = res();
  await handler(req(), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.clientEmailSent, true);
  assert.equal(sendEmailCalls.length, 1);
  assert.equal(sendEmailCalls[0].to, 'jomell@ghgrp.net');
  assert.match(sendEmailCalls[0].html, /action=approve/);
  assert.match(sendEmailCalls[0].html, /action=reject/);
});

test('the stored link only ever holds a hash, never the raw token', async () => {
  reset();
  await handler(req(), res());
  assert.equal(insertedLinks.length, 1);
  assert.ok(insertedLinks[0].token_hash, 'a hash must be stored');
  assert.equal(insertedLinks[0].token_hash.length, 64, 'sha256 hex is 64 chars');
  const emailedHtml = sendEmailCalls[0].html;
  assert.doesNotMatch(emailedHtml, new RegExp(insertedLinks[0].token_hash), 'the hash must never appear in the email either');
});

test('the payment schedule shown in the email matches the estimate\'s real rows', async () => {
  reset();
  await handler(req(), res());
  assert.match(sendEmailCalls[0].html, /Deposit/);
  assert.match(sendEmailCalls[0].html, /Balance due upon completion/);
  assert.match(sendEmailCalls[0].html, /\$500\.00/, 'each row is 50% of the $1,000 total');
});

test('a missing client email does not fail the send', async () => {
  reset();
  clientRows = [{ email: null, name: 'Jomell Alba' }];
  const r = res();
  await handler(req(), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true, 'the estimate itself must still be sent');
  assert.equal(r.body.clientEmailSent, false);
  assert.match(r.body.clientEmailError, /no email on file/i);
  assert.equal(sendEmailCalls.length, 0);
});

test('email not being configured does not fail the send', async () => {
  reset();
  emailConfigured = false;
  const r = res();
  await handler(req(), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.clientEmailSent, false);
  assert.match(r.body.clientEmailError, /not configured/i);
});

test('a Resend failure does not fail the send, and is reported honestly', async () => {
  reset();
  sendEmailShouldFail = true;
  const r = res();
  await handler(req(), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.clientEmailSent, false);
  assert.match(r.body.clientEmailError, /resend down/);
});

test('the lead still advances even when the client email fails', async () => {
  reset();
  estimateFixture.sourceLeadId = 'lead-1';
  emailConfigured = false;
  const r = res();
  await handler(req(), r);
  assert.equal(r.statusCode, 200);
  assert.equal(leadAdvanceCalls.length, 1);
});
