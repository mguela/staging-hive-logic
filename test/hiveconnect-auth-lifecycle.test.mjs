import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  generateHiveConnectPassword,
  provisionHiveConnectPasswordUser,
  redeemHiveConnectInvite,
  resetHiveConnectPassword,
} from '../api/hiveconnect-bridge.js';
import bridgeHandler from '../api/hiveconnect-bridge.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = '11111111-1111-4111-8111-111111111111';
const CLAIM = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const ACTOR = '44444444-4444-4444-8444-444444444444';
const CHANNEL = '55555555-5555-4555-8555-555555555555';

function jsonResponse(body, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function handlerResponse() {
  const response = { code: null, body: null, headers: {} };
  response.setHeader = (name, value) => { response.headers[name.toLowerCase()] = value; };
  response.status = (code) => { response.code = code; return response; };
  response.json = (body) => { response.body = body; return response; };
  return response;
}

test('generated temporary passwords have high entropy and guaranteed character classes', () => {
  let requestedBytes = 0;
  const password = generateHiveConnectPassword({
    randomBytes(size) {
      requestedBytes = size;
      return Buffer.alloc(size, 7);
    },
  });

  assert.equal(requestedBytes, 24);
  assert.equal(password.length, 36);
  assert.match(password, /[A-Z]/);
  assert.match(password, /[a-z]/);
  assert.match(password, /[0-9]/);
  assert.match(password, /[^A-Za-z0-9]/);
});

test('invite redemption creates no password in createUser and sets it through checked updateUserById', async () => {
  const events = [];
  const deps = {
    randomUUID: () => USER,
    hcRestRequest: async (rpcPath, options = {}) => {
      const body = JSON.parse(options.body);
      events.push({ kind: 'rpc', path: rpcPath, body });
      if (rpcPath === 'rpc/hc_claim_invite_for_auth') {
        return jsonResponse({ claim_id: CLAIM, user_id: USER, email: 'bound@example.com' });
      }
      if (rpcPath === 'rpc/hc_finalize_invite_auth') {
        return jsonResponse({ email: 'bound@example.com' });
      }
      throw new Error('unexpected RPC: ' + rpcPath);
    },
    hcAdminRequest: async (adminPath, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      events.push({ kind: 'auth', path: adminPath, method: options.method, body });
      if (adminPath === 'users' && options.method === 'POST') return jsonResponse({ id: USER, email: body.email });
      if (adminPath === `users/${USER}` && options.method === 'PUT') return jsonResponse({ id: USER });
      throw new Error('unexpected Auth request: ' + adminPath);
    },
  };

  const result = await redeemHiveConnectInvite({
    token: TOKEN,
    displayName: 'Bound User',
    username: 'bound.user',
    email: '',
    password: 'User-chosen-password-42!',
  }, deps);

  assert.deepEqual(result, { id: USER, email: 'bound@example.com' });
  assert.deepEqual(events.map((event) => `${event.kind}:${event.path}`), [
    'rpc:rpc/hc_claim_invite_for_auth',
    'auth:users',
    `auth:users/${USER}`,
    'rpc:rpc/hc_finalize_invite_auth',
  ]);
  assert.equal(Object.hasOwn(events[1].body, 'password'), false, 'createUser must not receive a password');
  assert.equal(Object.hasOwn(events[1].body, 'password_hash'), false, 'createUser must not receive a password hash');
  assert.equal(events[1].body.id, USER, 'createUser must use the claim-persisted recovery id');
  assert.equal(events[2].body.password, 'User-chosen-password-42!');
});

test('a password rejected by Auth deletes the shell account and releases the invite claim', async () => {
  const events = [];
  const deps = {
    randomUUID: () => USER,
    hcRestRequest: async (rpcPath, options = {}) => {
      events.push(rpcPath);
      if (rpcPath === 'rpc/hc_claim_invite_for_auth') return jsonResponse({ claim_id: CLAIM, user_id: USER, email: 'weak@example.com' });
      if (rpcPath === 'rpc/hc_release_invite_auth_claim') return jsonResponse(null);
      throw new Error('unexpected RPC: ' + rpcPath + ' ' + options.body);
    },
    hcAdminRequest: async (adminPath, options = {}) => {
      events.push(`${options.method}:${adminPath}`);
      if (adminPath === 'users' && options.method === 'POST') return jsonResponse({ id: USER, email: 'weak@example.com' });
      if (adminPath === `users/${USER}` && options.method === 'PUT') {
        return jsonResponse({ code: 'weak_password', message: 'Password is known to be weak' }, false);
      }
      if (adminPath === `users/${USER}` && options.method === 'DELETE') return jsonResponse({});
      throw new Error('unexpected Auth request: ' + adminPath);
    },
  };

  await assert.rejects(
    () => redeemHiveConnectInvite({
      token: TOKEN,
      displayName: 'Weak User',
      username: 'weak.user',
      email: 'weak@example.com',
      password: 'password123',
    }, deps),
    (error) => error.code === 'weak_password'
  );
  assert.ok(events.includes(`DELETE:users/${USER}`), 'rejected shell account must be deleted');
  assert.ok(events.includes('rpc/hc_release_invite_auth_claim'), 'invite claim must be released');
  assert.equal(events.includes('rpc/hc_finalize_invite_auth'), false, 'rejected credentials must never finalize the invite');
});

test('invite finalization retries a committed-but-unacknowledged request without deleting the user', async () => {
  let finalizeAttempts = 0;
  let deleteAttempts = 0;
  const deps = {
    randomUUID: () => USER,
    hcRestRequest: async (rpcPath) => {
      if (rpcPath === 'rpc/hc_claim_invite_for_auth') return jsonResponse({ claim_id: CLAIM, user_id: USER, email: 'retry@example.com' });
      if (rpcPath === 'rpc/hc_finalize_invite_auth') {
        finalizeAttempts++;
        if (finalizeAttempts === 1) throw new Error('connection closed after commit');
        return jsonResponse({ email: 'retry@example.com' });
      }
      throw new Error('unexpected RPC: ' + rpcPath);
    },
    hcAdminRequest: async (adminPath, options = {}) => {
      if (adminPath === 'users' && options.method === 'POST') return jsonResponse({ id: USER, email: 'retry@example.com' });
      if (adminPath === `users/${USER}` && options.method === 'PUT') return jsonResponse({ id: USER });
      if (adminPath === `users/${USER}` && options.method === 'DELETE') {
        deleteAttempts++;
        return jsonResponse({});
      }
      throw new Error('unexpected Auth request: ' + adminPath);
    },
  };

  const result = await redeemHiveConnectInvite({
    token: TOKEN,
    displayName: 'Retry User',
    username: 'retry.user',
    email: 'retry@example.com',
    password: 'Good-password-42!',
  }, deps);

  assert.equal(result.id, USER);
  assert.equal(finalizeAttempts, 2);
  assert.equal(deleteAttempts, 0, 'an ambiguous committed finalization must not be compensated');
});

test('an ambiguous finalization is never compensated when its retry returns an explicit error', async () => {
  let finalizeAttempts = 0;
  let deleteAttempts = 0;
  let claimReleases = 0;
  const deps = {
    randomUUID: () => USER,
    hcRestRequest: async (rpcPath) => {
      if (rpcPath === 'rpc/hc_claim_invite_for_auth') return jsonResponse({ claim_id: CLAIM, user_id: USER, email: 'ambiguous@example.com' });
      if (rpcPath === 'rpc/hc_finalize_invite_auth') {
        finalizeAttempts++;
        if (finalizeAttempts === 1) throw new Error('connection closed after commit');
        return jsonResponse({ message: 'invite_used' }, false);
      }
      if (rpcPath === 'rpc/hc_release_invite_auth_claim') {
        claimReleases++;
        return jsonResponse(null);
      }
      throw new Error('unexpected RPC: ' + rpcPath);
    },
    hcAdminRequest: async (adminPath, options = {}) => {
      if (adminPath === 'users' && options.method === 'POST') return jsonResponse({ id: USER, email: 'ambiguous@example.com' });
      if (adminPath === `users/${USER}` && options.method === 'PUT') return jsonResponse({ id: USER });
      if (adminPath === `users/${USER}` && options.method === 'DELETE') {
        deleteAttempts++;
        return jsonResponse({});
      }
      throw new Error('unexpected Auth request: ' + adminPath);
    },
  };

  await assert.rejects(
    () => redeemHiveConnectInvite({
      token: TOKEN,
      displayName: 'Ambiguous User',
      username: 'ambiguous.user',
      email: 'ambiguous@example.com',
      password: 'Good-password-42!',
    }, deps),
    (error) => error.code === 'cleanup_required'
  );
  assert.equal(finalizeAttempts, 2);
  assert.equal(deleteAttempts, 0, 'a possibly committed finalization must retain the Auth user');
  assert.equal(claimReleases, 0, 'a possibly committed finalization must retain the invite claim state');
});

test('an unacknowledged Auth create fails closed and does not release its invite claim', async () => {
  let claimReleases = 0;
  const deps = {
    randomUUID: () => USER,
    hcRestRequest: async (rpcPath) => {
      if (rpcPath === 'rpc/hc_claim_invite_for_auth') return jsonResponse({ claim_id: CLAIM, user_id: USER, email: 'uncertain@example.com' });
      if (rpcPath === 'rpc/hc_release_invite_auth_claim') {
        claimReleases++;
        return jsonResponse(null);
      }
      throw new Error('unexpected RPC: ' + rpcPath);
    },
    hcAdminRequest: async (adminPath, options = {}) => {
      if (adminPath === 'users' && options.method === 'POST') throw new Error('connection closed after request');
      throw new Error('unexpected Auth request: ' + adminPath);
    },
  };

  await assert.rejects(
    () => redeemHiveConnectInvite({
      token: TOKEN,
      displayName: 'Uncertain User',
      username: 'uncertain.user',
      email: 'uncertain@example.com',
      password: 'Good-password-42!',
    }, deps),
    (error) => error.code === 'cleanup_required'
  );
  assert.equal(claimReleases, 0, 'a possibly-created Auth shell must keep the claim locked until expiry');
});

test('an acknowledged-lost Auth create recovers the exact claim-persisted shell and resumes', async () => {
  const events = [];
  const deps = {
    randomUUID: () => USER,
    hcRestRequest: async (rpcPath) => {
      events.push(rpcPath);
      if (rpcPath === 'rpc/hc_claim_invite_for_auth') {
        return jsonResponse({ claim_id: CLAIM, user_id: USER, email: 'recovered@example.com' });
      }
      if (rpcPath === 'rpc/hc_finalize_invite_auth') return jsonResponse({ email: 'recovered@example.com' });
      throw new Error('unexpected RPC: ' + rpcPath);
    },
    hcAdminRequest: async (adminPath, options = {}) => {
      events.push(`${options.method || 'GET'}:${adminPath}`);
      if (adminPath === 'users' && options.method === 'POST') throw new Error('connection closed after commit');
      if (adminPath === `users/${USER}` && !options.method) {
        return jsonResponse({
          id: USER,
          email: 'recovered@example.com',
          user_metadata: { username: 'recovered.user', display_name: 'Recovered User' },
        });
      }
      if (adminPath === `users/${USER}` && options.method === 'PUT') return jsonResponse({ id: USER });
      throw new Error('unexpected Auth request: ' + adminPath);
    },
  };

  const result = await redeemHiveConnectInvite({
    token: TOKEN,
    displayName: 'Recovered User',
    username: 'recovered.user',
    email: 'recovered@example.com',
    password: 'Good-password-42!',
  }, deps);

  assert.deepEqual(result, { id: USER, email: 'recovered@example.com' });
  assert.deepEqual(events, [
    'rpc/hc_claim_invite_for_auth',
    'POST:users',
    `GET:users/${USER}`,
    `PUT:users/${USER}`,
    'rpc/hc_finalize_invite_auth',
  ]);
});

test('admin provisioning generates the credential server-side and finalizes role plus channels atomically', async () => {
  const events = [];
  const deps = {
    randomBytes: (size) => Buffer.alloc(size, 11),
    hcAdminRequest: async (adminPath, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      events.push({ kind: 'auth', path: adminPath, method: options.method, body });
      if (adminPath === 'users' && options.method === 'POST') return jsonResponse({ id: USER, email: body.email });
      if (adminPath === `users/${USER}` && options.method === 'PUT') return jsonResponse({ id: USER });
      throw new Error('unexpected Auth request: ' + adminPath);
    },
    hcRestRequest: async (rpcPath, options = {}) => {
      events.push({ kind: 'rpc', path: rpcPath, body: JSON.parse(options.body) });
      if (rpcPath === 'rpc/hc_finalize_admin_user_auth') return jsonResponse(null);
      throw new Error('unexpected RPC: ' + rpcPath);
    },
  };

  const result = await provisionHiveConnectPasswordUser({
    email: 'new@example.com',
    displayName: 'New Person',
    username: 'new.person',
    role: 'member',
    channelIds: [CHANNEL, CHANNEL],
  }, { id: ACTOR, role: 'admin' }, deps);

  const create = events.find((event) => event.kind === 'auth' && event.path === 'users');
  const update = events.find((event) => event.kind === 'auth' && event.method === 'PUT');
  const finalize = events.find((event) => event.kind === 'rpc');
  assert.equal(Object.hasOwn(create.body, 'password'), false);
  assert.equal(update.body.password, result.password);
  assert.match(result.password, /^Hc!9/);
  assert.deepEqual(finalize.body, { p_user_id: USER, p_role: 'member', p_channel_ids: [CHANNEL] });
  assert.equal(result.channelCount, 1);
});

test('admins cannot reset owners, while owners receive a checked server-generated reset', async () => {
  let passwordUpdates = 0;
  const deps = {
    randomBytes: (size) => Buffer.alloc(size, 19),
    hcRestRequest: async () => jsonResponse([{ id: USER, role: 'owner', active: true }]),
    hcAdminRequest: async (adminPath, options = {}) => {
      if (adminPath === `users/${USER}` && !options.method) return jsonResponse({ id: USER, email: 'owner@example.com' });
      if (adminPath === `users/${USER}` && options.method === 'PUT') {
        passwordUpdates++;
        return jsonResponse({ id: USER });
      }
      throw new Error('unexpected Auth request: ' + adminPath);
    },
  };

  await assert.rejects(
    () => resetHiveConnectPassword(USER, { id: ACTOR, role: 'admin' }, deps),
    (error) => error.code === 'owner_reset_forbidden'
  );
  assert.equal(passwordUpdates, 0);

  const result = await resetHiveConnectPassword(USER, { id: ACTOR, role: 'owner' }, deps);
  assert.equal(result.email, 'owner@example.com');
  assert.match(result.password, /^Hc!9/);
  assert.equal(passwordUpdates, 1);
});

test('HTTP admin actions reject missing or inactive HiveConnect sessions before any Auth mutation', async () => {
  const previousUrl = process.env.HIVECONNECT_SUPABASE_URL;
  const previousKey = process.env.HIVECONNECT_SUPABASE_SERVICE_KEY;
  const previousFetch = globalThis.fetch;
  process.env.HIVECONNECT_SUPABASE_URL = 'https://hc.test';
  process.env.HIVECONNECT_SUPABASE_SERVICE_KEY = 'test-service-role';
  let authMutations = 0;

  try {
    const signedOut = handlerResponse();
    await bridgeHandler({
      method: 'POST',
      query: { action: 'admin_create_user' },
      headers: {},
      body: { email: 'victim@example.com', role: 'owner' },
    }, signedOut);
    assert.equal(signedOut.code, 401);

    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://hc.test/auth/v1/user') return jsonResponse({ id: ACTOR, email: 'inactive@example.com' });
      if (target.includes('/rest/v1/profiles?')) return jsonResponse([{ id: ACTOR, role: 'owner', active: false }]);
      if (target.includes('/auth/v1/admin/')) authMutations++;
      throw new Error('unexpected fetch: ' + target);
    };
    const inactive = handlerResponse();
    await bridgeHandler({
      method: 'POST',
      query: { action: 'admin_reset_password' },
      headers: { authorization: 'Bearer inactive-user-token' },
      body: { targetId: USER },
    }, inactive);
    assert.equal(inactive.code, 401);
    assert.equal(authMutations, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.HIVECONNECT_SUPABASE_URL;
    else process.env.HIVECONNECT_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.HIVECONNECT_SUPABASE_SERVICE_KEY;
    else process.env.HIVECONNECT_SUPABASE_SERVICE_KEY = previousKey;
  }
});

test('expand migration exposes only service-role helpers while contract migration removes legacy password writers', () => {
  const expandSql = fs.readFileSync(path.join(ROOT, 'sql/hiveconnect/20260818_auth_password_lifecycle.sql'), 'utf8');
  const cleanupSql = fs.readFileSync(path.join(ROOT, 'sql/hiveconnect/20260818_auth_password_lifecycle_cleanup.sql'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public/hiveconnect/app.js'), 'utf8');

  for (const helper of [
    'hc_claim_invite_for_auth',
    'hc_finalize_invite_auth',
    'hc_release_invite_auth_claim',
    'hc_finalize_admin_user_auth',
  ]) {
    assert.match(expandSql, new RegExp(`create or replace function public\\.${helper}\\(`, 'i'));
    assert.match(expandSql, new RegExp(`revoke all on function public\\.${helper}\\([\\s\\S]*?from PUBLIC, anon, authenticated, service_role`, 'i'));
    assert.match(expandSql, new RegExp(`grant execute on function public\\.${helper}\\([\\s\\S]*?to service_role`, 'i'));
    assert.doesNotMatch(expandSql, new RegExp(`grant execute on function public\\.${helper}\\([\\s\\S]*?to (?:anon|authenticated)`, 'i'));
  }

  assert.doesNotMatch(expandSql, /(?:revoke execute on|drop function) public\.(?:redeem_invite|admin_create_user|admin_reset_password)/i);
  assert.match(expandSql, /auth_user_id uuid/i);
  assert.match(expandSql, /auth_user_id := coalesce\(inv\.auth_user_id, p_user_id\)/i);
  assert.match(cleanupSql, /drop function public\.redeem_invite\(uuid, text, text, text, text\)/i);
  assert.match(cleanupSql, /drop function public\.admin_create_user\(text, text, text, text, text\)/i);
  assert.match(cleanupSql, /drop function public\.admin_reset_password\(uuid, text\)/i);
  for (const sql of [expandSql, cleanupSql]) {
    assert.doesNotMatch(sql, /insert\s+into\s+auth\.users/i);
    assert.doesNotMatch(sql, /update\s+auth\.users/i);
    assert.doesNotMatch(sql, /encrypted_password|extensions\.crypt|gen_salt/i);
  }

  assert.doesNotMatch(client, /sb\.rpc\(\s*['"](?:redeem_invite|admin_create_user|admin_reset_password)['"]/);
  assert.match(client, /hiveConnectAccountAction\('redeem_invite'/);
  assert.match(client, /hiveConnectAccountAction\('admin_create_user'/);
  assert.match(client, /hiveConnectAccountAction\('admin_reset_password'/);
});
