// Task #105 — client notification on an approved Reina change request.
// Extracts the real handler block from api/marketing.js and runs it in a vm
// sandbox with a fake PostgREST and a fake email transport, so every branch of
// notifyClientOfApprovedChangeRequest() is exercised without touching a real
// inbox. Same extraction pattern as reina-change-request-approvals.test.mjs.
//
// The load-bearing assertions here are the negative ones: sendEmail must NOT
// be called unless the deployment has BOTH a RESEND_API_KEY and
// MARKETING_EMAIL_SEND_ENABLED=true. That gate is what keeps a real client
// from being emailed while this is still prototype-phase.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';

const marketingPath = 'api/marketing.js';
const marketing = fs.readFileSync(marketingPath, 'utf8');

function extractHandlers() {
  const start = marketing.indexOf('// ===== Reina M1a: change-request recommendations');
  const end = marketing.indexOf('// ===== end Reina M1a change-request approvals =====');
  assert.ok(start > -1 && end > start, 'handler block markers must be present');
  return marketing.slice(start, end);
}

const JOB = { jobber_id: 'JOB1', title: 'Kitchen remodel', client_id: 'CLI1' };
const CLIENT = { jobber_id: 'CLI1', name: 'Tony Stark', email: 'tony@example.com' };

// A pending row as the decide handler would have just PATCHed it to approved.
function approvedRow(over = {}) {
  return {
    id: 'a1',
    approvable_id: 'JOB1',
    status: 'approved',
    decided_by: 'chris@ghgrp.net',
    decided_at: '2026-08-15T01:00:00Z',
    title: 'Add 4 recessed lights',
    rationale: 'Client asked in a text message',
    amount_cents: 45000,
    estimate: { scope_delta: 'Add 4 recessed lights to the kitchen ceiling' },
    target_description: 'Job X for Tony',
    ...over,
  };
}

function loadHandlers(fixtures = {}) {
  const writes = [];
  const sent = [];
  const sandbox = {
    fetchAllRows: async () => fixtures.rows || [],
    // Path-aware fake PostgREST: the notify path reads jobs then clients, the
    // decide path PATCHes marketing_approvals.
    supabaseRequest: async (path, options) => {
      if (path.startsWith('jobs?')) {
        return { ok: fixtures.jobReadOk !== false, json: async () => ('job' in fixtures ? (fixtures.job ? [fixtures.job] : []) : [JOB]) };
      }
      if (path.startsWith('clients?')) {
        return { ok: fixtures.clientReadOk !== false, json: async () => ('client' in fixtures ? (fixtures.client ? [fixtures.client] : []) : [CLIENT]) };
      }
      writes.push({ path, options });
      return {
        ok: true,
        json: async () => (fixtures.updated || [approvedRow()]),
        text: async () => 'db error',
      };
    },
    isEmailConfigured: () => fixtures.configured !== false,
    isEmailSendEnabled: () => fixtures.enabled === true,
    sendEmail: async (msg) => {
      sent.push(msg);
      if (fixtures.sendThrows) throw new Error('resend exploded');
      return fixtures.sendOk === false ? { ok: false, error: 'resend rejected it' } : { ok: true };
    },
    money: (n) => `$${Number(n).toFixed(2)}`,
    String, Array, Number, encodeURIComponent, Date, JSON, console,
  };
  sandbox.__writes = writes;
  sandbox.__sent = sent;
  vm.createContext(sandbox);
  vm.runInContext(extractHandlers(), sandbox);
  return sandbox;
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  return res;
}

const approve = (sb, res) => sb.handleReinaChangeRequestDecidePost(
  { hlUser: { email: 'chris@ghgrp.net' }, body: { id: 'a1', decision: 'approved' } },
  res,
);

// ---------------------------------------------------------------- the gate --

test('SAFETY: nothing is emailed while sending is disabled (the default)', async () => {
  const sb = loadHandlers({ enabled: false });
  const res = fakeRes();
  await approve(sb, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.notification.status, 'skipped_disabled');
  assert.strictEqual(sb.__sent.length, 0, 'sendEmail must not be called when disabled');
});

test('SAFETY: nothing is emailed when no RESEND_API_KEY is configured', async () => {
  const sb = loadHandlers({ configured: false, enabled: true });
  const res = fakeRes();
  await approve(sb, res);
  assert.strictEqual(res.body.notification.status, 'skipped_not_configured');
  assert.strictEqual(sb.__sent.length, 0);
});

test('SAFETY: a rejection never notifies the client', async () => {
  const sb = loadHandlers({ enabled: true, updated: [approvedRow({ status: 'rejected' })] });
  const res = fakeRes();
  await sb.handleReinaChangeRequestDecidePost(
    { hlUser: { email: 'chris@ghgrp.net' }, body: { id: 'a1', decision: 'rejected' } },
    res,
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.notification.status, 'not_applicable');
  assert.strictEqual(sb.__sent.length, 0);
});

// ------------------------------------------------------------ missing data --

test('skips honestly when the change request has no linked job', async () => {
  const sb = loadHandlers({ enabled: true, updated: [approvedRow({ approvable_id: null })] });
  const res = fakeRes();
  await approve(sb, res);
  assert.strictEqual(res.body.notification.status, 'skipped_no_job');
  assert.strictEqual(sb.__sent.length, 0);
});

test('skips honestly when the job is not found in the synced mirror', async () => {
  const sb = loadHandlers({ enabled: true, job: null });
  const res = fakeRes();
  await approve(sb, res);
  assert.strictEqual(res.body.notification.status, 'skipped_no_job');
  assert.strictEqual(sb.__sent.length, 0);
});

test('skips honestly when the client has no email on file', async () => {
  const sb = loadHandlers({ enabled: true, client: { jobber_id: 'CLI1', name: 'Tony', email: null } });
  const res = fakeRes();
  await approve(sb, res);
  assert.strictEqual(res.body.notification.status, 'skipped_no_email');
  assert.strictEqual(sb.__sent.length, 0);
});

// -------------------------------------------------------------- happy path --

test('when fully enabled it emails the real client with the job and price', async () => {
  const sb = loadHandlers({ enabled: true });
  const res = fakeRes();
  await approve(sb, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.notification.status, 'sent');
  assert.strictEqual(res.body.notification.to, 'tony@example.com');
  assert.strictEqual(sb.__sent.length, 1, 'exactly one email');

  const msg = sb.__sent[0];
  assert.strictEqual(msg.to, 'tony@example.com');
  assert.match(msg.subject, /Kitchen remodel/);
  assert.match(msg.subject, /approved/i);
  assert.match(msg.text, /Hi Tony Stark,/);
  assert.match(msg.text, /Add 4 recessed lights to the kitchen ceiling/);
  assert.match(msg.text, /\$450\.00/, 'the approved amount is stated in dollars, not cents');
  assert.ok(msg.html.includes('<p>'), 'an html part is sent too');
});

test('says pricing will follow instead of inventing a number when amount is unknown', async () => {
  const sb = loadHandlers({ enabled: true, updated: [approvedRow({ amount_cents: null })] });
  const res = fakeRes();
  await approve(sb, res);
  assert.strictEqual(res.body.notification.status, 'sent');
  const msg = sb.__sent[0];
  assert.match(msg.text, /follow up with pricing/i);
  assert.doesNotMatch(msg.text, /\$/, 'no fabricated price');
});

test('falls back to a greeting that is not blank when the client has no name', async () => {
  const sb = loadHandlers({ enabled: true, client: { jobber_id: 'CLI1', email: 'x@y.z' } });
  const res = fakeRes();
  await approve(sb, res);
  assert.match(sb.__sent[0].text, /Hi there,/);
});

// ------------------------------------------------------------ failure mode --

test('a rejected send is reported as failed and never unwinds the approval', async () => {
  const sb = loadHandlers({ enabled: true, sendOk: false });
  const res = fakeRes();
  await approve(sb, res);
  assert.strictEqual(res.statusCode, 200, 'the human decision still stands');
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.approval.status, 'approved');
  assert.strictEqual(res.body.notification.status, 'failed');
  assert.match(res.body.notification.reason, /resend rejected it/);
});

test('a throwing email transport is caught, not surfaced as a 500', async () => {
  const sb = loadHandlers({ enabled: true, sendThrows: true });
  const res = fakeRes();
  await approve(sb, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.notification.status, 'failed');
  assert.strictEqual(res.body.approval.status, 'approved');
});

test('the notification outcome is persisted back onto the approval row', async () => {
  const sb = loadHandlers({ enabled: true });
  const res = fakeRes();
  await approve(sb, res);
  const outcomeWrite = sb.__writes.at(-1);
  assert.strictEqual(outcomeWrite.options.method, 'PATCH');
  const body = JSON.parse(outcomeWrite.options.body);
  assert.strictEqual(body.estimate.execution.notification.status, 'sent');
  assert.ok(body.estimate.execution.executed_at, 'stamped with when it ran');
});

test('no change order is auto-created -- it reports why instead of inventing cost data', async () => {
  const sb = loadHandlers({ enabled: true });
  const res = fakeRes();
  await approve(sb, res);
  assert.strictEqual(res.body.changeOrder.status, 'not_available');
  assert.match(res.body.changeOrder.reason, /fabricat/i);
});
