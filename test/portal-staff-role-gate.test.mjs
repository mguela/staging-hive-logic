// test/portal-staff-role-gate.test.mjs
// Phase 2 of the "permission roles fail-open" fix (2026-08-06): the Sub
// Portal and Client Portal STAFF admin surfaces (invite, RFQ/RFI/schedule/
// invoice management, client approval creation, photo sharing) were only
// gated by getStaffProfile(req) -- any signed-in employee, regardless of
// role. Unlike track1.js's financial-resource gate (Phase 1), there was no
// pre-existing nav-side policy to mirror here, so this is a new role list
// (owner/project_manager/office_ar as of the Stage 2 permission redesign,
// 2026-08-10 -- see sql/066_permission_roles_v2.sql) -- proves it's actually
// enforced, that the coarse admin bypass still works,
// and that the SUB/CLIENT-facing session actions (redeem, me, jobs, ...)
// are untouched since they never went through getStaffProfile.
// Fully mocked -- no network, no DB, no real secret.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

function res() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

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
    return jsonRes([]); // any other table read -- e.g. subs_list's own queries
  };
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

async function callHandler(modulePath, { action, method = 'GET', query = {}, authHeader = 'Bearer usertoken' }) {
  const mod = await import(modulePath);
  const req = { method, query: { action, ...query }, headers: { authorization: authHeader }, body: {} };
  const r = res();
  await mod.default(req, r);
  return r;
}

// ---------------------------------------------------------------- Sub Portal

test('subportal: field_tech hitting subs_list (staff admin surface) is rejected 403', async () => {
  scenario = { permissionRoles: ['field_tech'], profileRole: null };
  const r = await withMockedFetch(() => callHandler('../api/subportal.js', { action: 'subs_list' }));
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.ok, false);
});

test('subportal: project_manager hitting subs_list is NOT blocked by the role gate', async () => {
  scenario = { permissionRoles: ['project_manager'], profileRole: null };
  const r = await withMockedFetch(() => callHandler('../api/subportal.js', { action: 'subs_list' }));
  assert.notEqual(r.statusCode, 403);
});

test('subportal: profiles.role=admin (coarse flag) bypasses the gate regardless of granular role', async () => {
  scenario = { permissionRoles: ['field_tech'], profileRole: 'admin' };
  const r = await withMockedFetch(() => callHandler('../api/subportal.js', { action: 'docs_expiring' }));
  assert.notEqual(r.statusCode, 403);
});

test('subportal: an anonymous request still 401s (unchanged base gate)', async () => {
  scenario = { permissionRoles: [], profileRole: null };
  const r = await withMockedFetch(() => callHandler('../api/subportal.js', { action: 'subs_list', authHeader: '' }));
  assert.equal(r.statusCode, 401);
});

test('subportal: sales role attempting rfq_create (a write action) is rejected 403', async () => {
  scenario = { permissionRoles: ['sales'], profileRole: null };
  const r = await withMockedFetch(() => callHandler('../api/subportal.js', { action: 'rfq_create', method: 'POST' }));
  assert.equal(r.statusCode, 403);
});

// ------------------------------------------------------------- Client Portal

test('clientportal: dispatch role hitting approval_create is rejected 403', async () => {
  scenario = { permissionRoles: ['dispatch'], profileRole: null };
  const r = await withMockedFetch(() => callHandler('../api/clientportal.js', { action: 'approval_create', method: 'POST' }));
  assert.equal(r.statusCode, 403);
});

test('clientportal: office_ar role hitting approval_create is NOT blocked by the role gate', async () => {
  scenario = { permissionRoles: ['office_ar'], profileRole: null };
  const r = await withMockedFetch(() => callHandler('../api/clientportal.js', { action: 'approval_create', method: 'POST' }));
  assert.notEqual(r.statusCode, 403);
});

test('clientportal: field_tech attempting to invite a client is rejected 403', async () => {
  scenario = { permissionRoles: ['field_tech'], profileRole: null };
  const r = await withMockedFetch(() => callHandler('../api/clientportal.js', { action: 'invite', method: 'POST' }));
  assert.equal(r.statusCode, 403);
});

test('clientportal: an anonymous request to approval_create still 401s (unchanged base gate)', async () => {
  scenario = { permissionRoles: [], profileRole: null };
  const r = await withMockedFetch(() => callHandler('../api/clientportal.js', { action: 'approval_create', method: 'POST', authHeader: '' }));
  assert.equal(r.statusCode, 401);
});

// The client's OWN session actions never go through getStaffProfile at all,
// so they must be entirely unaffected by this change -- no employee role
// gate applies to a client's own portal session.
test('clientportal: the redeem action (client session, not staff) is untouched by the staff role gate', async () => {
  scenario = { permissionRoles: [], profileRole: null };
  const r = await withMockedFetch(() => callHandler('../api/clientportal.js', { action: 'redeem', method: 'GET', query: { token: 'sometoken' } }));
  // Expect the action's OWN logic to run (400/404 for a bad token), never the staff-role 403.
  assert.notEqual(r.statusCode, 403);
});
