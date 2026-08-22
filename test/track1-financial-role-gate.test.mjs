// test/track1-financial-role-gate.test.mjs
// Phase 1 of the "permission roles fail-open" fix (2026-08-05): cash, leaks,
// overhead, forecast, and watching_margin_fade are raw financial reads that
// used to be reachable by any signed-in employee, regardless of role -- the
// nav already hid them from field_crew/dispatch/marketing/etc. via
// index.html's ALLOWED_GROUPS table, but that was cosmetic only (never
// blocked the API call itself). This proves the same policy is now enforced
// server-side, that the cron-secret path (leaks/watching_margin_fade) still
// bypasses it, and that resource=dailybrief (intentionally universal --
// every role's ALLOWED_STANDALONE includes nav-cc) is untouched.
// Fully mocked -- no network, no DB, no real secret.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

function res() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// scenario is read by the mocked fetch below; each test sets it before calling the handler.
let scenario = { permissionRoles: [], profileRole: null };

function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

async function withMockedFetch(fn) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1', email: 'test@ghgrp.net' });
    if (u.includes('/rest/v1/profiles')) return jsonRes([{ id: 'user-1', email: 'test@ghgrp.net', role: scenario.profileRole }]);
    if (u.includes('/rest/v1/users')) return jsonRes([{ jobber_id: 'jobber-1' }]);
    if (u.includes('/rest/v1/employee_roles')) return jsonRes([{ permission_roles: scenario.permissionRoles, permission_role: scenario.permissionRoles[0] || null }]);
    return jsonRes({ error: 'not relevant to this test' }); // any downstream Jobber/QBO call
  };
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

async function callTrack1({ resource, authHeader = 'Bearer usertoken' }) {
  const mod = await import('../api/track1.js');
  const req = { method: 'GET', query: { resource }, headers: { authorization: authHeader }, body: {} };
  const r = res();
  await mod.default(req, r);
  return r;
}

test('field_tech reading resource=cash is rejected 403', async () => {
  scenario = { permissionRoles: ['field_tech'], profileRole: null };
  const r = await withMockedFetch(() => callTrack1({ resource: 'cash' }));
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.ok, false);
});

test('dispatch reading resource=watching_margin_fade is rejected 403', async () => {
  scenario = { permissionRoles: ['dispatch'], profileRole: null };
  const r = await withMockedFetch(() => callTrack1({ resource: 'watching_margin_fade' }));
  assert.equal(r.statusCode, 403);
});

test('office_ar reading resource=cash is NOT blocked by the role gate', async () => {
  scenario = { permissionRoles: ['office_ar'], profileRole: null };
  const r = await withMockedFetch(() => callTrack1({ resource: 'cash' }));
  assert.notEqual(r.statusCode, 403);
});

test('profiles.role=admin (coarse flag) reading resource=leaks is NOT blocked, regardless of granular role', async () => {
  scenario = { permissionRoles: ['field_tech'], profileRole: 'admin' };
  const r = await withMockedFetch(() => callTrack1({ resource: 'leaks' }));
  assert.notEqual(r.statusCode, 403);
});

test('the cron-secret path (leaks/watching_margin_fade automated health check) bypasses the role gate entirely', async () => {
  scenario = { permissionRoles: [], profileRole: null };
  const r = await withMockedFetch(() => callTrack1({ resource: 'leaks', authHeader: 'Bearer test-cron-secret' }));
  assert.notEqual(r.statusCode, 403);
  assert.notEqual(r.statusCode, 401);
});

test('resource=dailybrief stays universally reachable -- the Business Pulse tile is intentionally shown to every role', async () => {
  scenario = { permissionRoles: ['field_tech'], profileRole: null };
  const r = await withMockedFetch(() => callTrack1({ resource: 'dailybrief' }));
  assert.notEqual(r.statusCode, 403);
});

test('an anonymous request to resource=cash still 401s at the base auth gate (unchanged)', async () => {
  scenario = { permissionRoles: [], profileRole: null };
  const r = await withMockedFetch(() => callTrack1({ resource: 'cash', authHeader: '' }));
  assert.equal(r.statusCode, 401);
});
