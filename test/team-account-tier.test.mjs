// test/team-account-tier.test.mjs
// 2026-08-10: superadmin/admin/crew account-tier redesign (jomell + Chris's
// plan). Covers the authorization rules on resource=team's action dispatcher:
// invite/delete/change_role are superadmin-only, reset_password is superadmin
// (anyone) or admin (crew targets only), and a superadmin can never touch
// their own account through this endpoint (self-delete/self-role-change would
// risk locking everyone out). Fully mocked -- no network, no DB, no real secret.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

// scenario is read by the mocked fetch below; each test sets it before calling the handler.
let scenario = { requesterRole: null, requesterId: 'requester-1', targetRole: null, targetId: 'target-1' };

function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

async function withMockedFetch(fn) {
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    if (u.includes('/auth/v1/user')) return jsonRes({ id: scenario.requesterId, email: 'requester@ghgrp.net' });
    if (u.includes('/auth/v1/admin/users/') && method === 'DELETE') return jsonRes({});
    if (u.includes('/auth/v1/admin/users/') && method === 'PUT') return jsonRes({ id: scenario.targetId });
    if (u.includes('/auth/v1/admin/users') && method === 'POST') return jsonRes({ id: 'new-user-id' });
    if (u.includes('/rest/v1/profiles')) {
      // getRequestingProfile's own lookup (id=eq.<requesterId>) vs. this
      // handler's lookup of the TARGET's profile row (id=eq.<userId from the
      // request body>) both hit /rest/v1/profiles -- the exact query string
      // tells them apart (identical requester===target in self-action tests
      // is fine either way, since both ids/roles are the same in those cases).
      if (u.includes(`id=eq.${scenario.requesterId}`)) {
        return jsonRes([{ id: scenario.requesterId, email: 'requester@ghgrp.net', role: scenario.requesterRole }]);
      }
      return jsonRes([{ id: scenario.targetId, email: 'target@ghgrp.net', role: scenario.targetRole }]);
    }
    return jsonRes({ error: 'not relevant to this test' });
  };
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

async function callTeam(body) {
  const mod = await import('../api/track1.js');
  const req = { method: 'POST', query: { resource: 'team' }, headers: { authorization: 'Bearer usertoken' }, body };
  const r = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await mod.default(req, r);
  return r;
}

test('crew cannot invite a new team member', async () => {
  scenario = { requesterRole: 'crew', requesterId: 'requester-1', targetRole: null, targetId: 'target-1' };
  const r = await withMockedFetch(() => callTeam({ action: 'invite', email: 'x@ghgrp.net', full_name: 'X' }));
  assert.equal(r.statusCode, 403);
});

test('admin cannot invite a new team member (superadmin-only)', async () => {
  scenario = { requesterRole: 'admin', requesterId: 'requester-1', targetRole: null, targetId: 'target-1' };
  const r = await withMockedFetch(() => callTeam({ action: 'invite', email: 'x@ghgrp.net', full_name: 'X' }));
  assert.equal(r.statusCode, 403);
});

test('superadmin can invite a new team member', async () => {
  scenario = { requesterRole: 'superadmin', requesterId: 'requester-1', targetRole: null, targetId: 'target-1' };
  const r = await withMockedFetch(() => callTeam({ action: 'invite', email: 'x@ghgrp.net', full_name: 'X' }));
  assert.notEqual(r.statusCode, 403);
});

test('admin cannot delete a team member', async () => {
  scenario = { requesterRole: 'admin', requesterId: 'requester-1', targetRole: 'crew', targetId: 'target-1' };
  const r = await withMockedFetch(() => callTeam({ action: 'delete', userId: 'target-1' }));
  assert.equal(r.statusCode, 403);
});

test('superadmin can delete a different team member', async () => {
  scenario = { requesterRole: 'superadmin', requesterId: 'requester-1', targetRole: 'crew', targetId: 'target-1' };
  const r = await withMockedFetch(() => callTeam({ action: 'delete', userId: 'target-1' }));
  assert.equal(r.statusCode, 200);
});

test('superadmin cannot delete their own account through this endpoint', async () => {
  scenario = { requesterRole: 'superadmin', requesterId: 'requester-1', targetRole: 'superadmin', targetId: 'requester-1' };
  const r = await withMockedFetch(() => callTeam({ action: 'delete', userId: 'requester-1' }));
  assert.equal(r.statusCode, 400);
});

test('admin cannot change a team member\'s role', async () => {
  scenario = { requesterRole: 'admin', requesterId: 'requester-1', targetRole: 'crew', targetId: 'target-1' };
  const r = await withMockedFetch(() => callTeam({ action: 'change_role', userId: 'target-1', role: 'admin' }));
  assert.equal(r.statusCode, 403);
});

test('superadmin can change a team member\'s role to admin', async () => {
  scenario = { requesterRole: 'superadmin', requesterId: 'requester-1', targetRole: 'crew', targetId: 'target-1' };
  const r = await withMockedFetch(() => callTeam({ action: 'change_role', userId: 'target-1', role: 'admin' }));
  assert.equal(r.statusCode, 200);
});

test('change_role rejects an invalid role value', async () => {
  scenario = { requesterRole: 'superadmin', requesterId: 'requester-1', targetRole: 'crew', targetId: 'target-1' };
  const r = await withMockedFetch(() => callTeam({ action: 'change_role', userId: 'target-1', role: 'owner' }));
  assert.equal(r.statusCode, 400);
});

test('superadmin cannot change their own role through this endpoint', async () => {
  scenario = { requesterRole: 'superadmin', requesterId: 'requester-1', targetRole: 'superadmin', targetId: 'requester-1' };
  const r = await withMockedFetch(() => callTeam({ action: 'change_role', userId: 'requester-1', role: 'admin' }));
  assert.equal(r.statusCode, 400);
});

test('admin CAN reset a crew member\'s password', async () => {
  scenario = { requesterRole: 'admin', requesterId: 'requester-1', targetRole: 'crew', targetId: 'target-1' };
  const r = await withMockedFetch(() => callTeam({ action: 'reset_password', userId: 'target-1' }));
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.tempPassword);
});

test('admin CANNOT reset another admin\'s password', async () => {
  scenario = { requesterRole: 'admin', requesterId: 'requester-1', targetRole: 'admin', targetId: 'target-1' };
  const r = await withMockedFetch(() => callTeam({ action: 'reset_password', userId: 'target-1' }));
  assert.equal(r.statusCode, 403);
});

test('admin CANNOT reset a superadmin\'s password', async () => {
  scenario = { requesterRole: 'admin', requesterId: 'requester-1', targetRole: 'superadmin', targetId: 'target-1' };
  const r = await withMockedFetch(() => callTeam({ action: 'reset_password', userId: 'target-1' }));
  assert.equal(r.statusCode, 403);
});

test('crew cannot reset anyone\'s password through this endpoint', async () => {
  scenario = { requesterRole: 'crew', requesterId: 'requester-1', targetRole: 'crew', targetId: 'target-1' };
  const r = await withMockedFetch(() => callTeam({ action: 'reset_password', userId: 'target-1' }));
  assert.equal(r.statusCode, 403);
});

test('superadmin can reset anyone\'s password, including another superadmin\'s', async () => {
  scenario = { requesterRole: 'superadmin', requesterId: 'requester-1', targetRole: 'superadmin', targetId: 'target-1' };
  const r = await withMockedFetch(() => callTeam({ action: 'reset_password', userId: 'target-1' }));
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.tempPassword);
});

test('an unknown action is rejected with 400', async () => {
  scenario = { requesterRole: 'superadmin', requesterId: 'requester-1', targetRole: null, targetId: 'target-1' };
  const r = await withMockedFetch(() => callTeam({ action: 'do_something_weird' }));
  assert.equal(r.statusCode, 400);
});
