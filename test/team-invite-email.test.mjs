// test/team-invite-email.test.mjs
// 2026-08-15 (jomell: inviting mica@ghgrp.net from Team & Access never sent
// them anything -- the invite only ever showed a one-time temp password to
// the inviting superadmin to relay manually). Adds a real, best-effort
// welcome email via the existing Resend helper (api/_lib/email.js), gated
// by RESEND_API_KEY the same way api/marketing.js's campaign sends already
// are. Covers: sends when configured, degrades honestly (never fails the
// invite itself) when not configured or when the send errors.
// Run with: node --experimental-test-module-mocks --test test/team-invite-email.test.mjs

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

let sendEmailResult = { ok: true, id: 'email-1' };
let sendEmailCalls = [];
mock.module('../api/_lib/email.js', {
  namedExports: {
    sendEmail: async (args) => { sendEmailCalls.push(args); return sendEmailResult; },
    isEmailConfigured: () => globalThis.__testEmailConfigured,
  },
});

function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

async function withMockedFetch(fn) {
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'requester-1', email: 'requester@ghgrp.net' });
    if (u.includes('/auth/v1/admin/users') && method === 'POST') return jsonRes({ id: 'new-user-id' });
    if (u.includes('/rest/v1/profiles') && method === 'POST') return jsonRes([{ id: 'new-user-id' }]);
    if (u.includes('/rest/v1/profiles')) return jsonRes([{ id: 'requester-1', email: 'requester@ghgrp.net', role: 'superadmin' }]);
    return jsonRes({ error: 'not relevant to this test' });
  };
  try { return await fn(); } finally { global.fetch = original; }
}

async function callInvite(body) {
  const mod = await import('../api/track1.js');
  const req = { method: 'POST', query: { resource: 'team' }, headers: { authorization: 'Bearer usertoken' }, body: { action: 'invite', ...body } };
  const r = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await mod.default(req, r);
  return r;
}

test('sends a real welcome email when Resend is configured, and says so honestly', async () => {
  globalThis.__testEmailConfigured = true;
  sendEmailResult = { ok: true, id: 'email-1' };
  sendEmailCalls = [];
  const r = await withMockedFetch(() => callInvite({ email: 'mica@ghgrp.net', full_name: 'Mica' }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.emailSent, true);
  assert.equal(sendEmailCalls.length, 1);
  assert.equal(sendEmailCalls[0].to, 'mica@ghgrp.net');
  assert.match(sendEmailCalls[0].html, /Mica/);
  assert.match(sendEmailCalls[0].html, new RegExp(r.body.tempPassword));
  assert.match(r.body.note, /welcome email.*sent to mica@ghgrp\.net/);
});

test('invite still succeeds and stays honest when Resend is not configured', async () => {
  globalThis.__testEmailConfigured = false;
  sendEmailCalls = [];
  const r = await withMockedFetch(() => callInvite({ email: 'mica@ghgrp.net', full_name: 'Mica' }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.emailSent, false);
  assert.equal(sendEmailCalls.length, 0, 'must not attempt to send when not configured');
  assert.ok(r.body.tempPassword, 'temp password must still be returned as the fallback');
  assert.match(r.body.note, /not configured/);
});

test('invite still succeeds and reports the real error when the send fails', async () => {
  globalThis.__testEmailConfigured = true;
  sendEmailResult = { ok: false, error: 'Resend API error (422)' };
  const r = await withMockedFetch(() => callInvite({ email: 'mica@ghgrp.net', full_name: 'Mica' }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.emailSent, false);
  assert.ok(r.body.tempPassword);
  assert.match(r.body.note, /could not be sent/);
  assert.match(r.body.note, /Resend API error \(422\)/);
});
