// test/dispatch-role-gate.test.mjs
// Stage 2 of the permission-system redesign (2026-08-10): jomell + Chris's
// rule is "Project manager - can manage all schedules" / "Dispatch" the same,
// while Field Lead/Field Tech/Sales/Office-AR/Purchasing/Admin (Remote)
// "cannot change their schedule or anyone else's." This proves the
// DISPATCH_ALLOWED_ROLES gate -- duplicated in api/track1.js
// (canManageDispatchSettings, resource=dispatch_settings) and
// api/schedule/move-visit.js (canDispatch) -- is enforced with the new
// 9-role taxonomy in both places, and that neither gate had a pre-existing
// test (this is genuinely new coverage, not a rename of an old test).
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
    if (u.includes('/rest/v1/workforce_settings')) return jsonRes([]);
    return jsonRes({ error: 'not relevant to this test' });
  };
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

async function callTrack1DispatchSettings({ authHeader = 'Bearer usertoken' } = {}) {
  const mod = await import('../api/track1.js');
  const req = { method: 'POST', query: { resource: 'dispatch_settings' }, headers: { authorization: authHeader }, body: { enabled: true } };
  const r = res();
  await mod.default(req, r);
  return r;
}

async function callMoveVisit({ authHeader = 'Bearer usertoken' } = {}) {
  const mod = await import('../api/schedule/move-visit.js');
  // Empty-ish body: if canDispatch() passes, this fails fast with 400
  // (missing visitId/action) long before it would ever touch Jobber --
  // enough to distinguish "the role gate let this through" from a 403.
  const req = { method: 'POST', headers: { authorization: authHeader }, body: {} };
  const r = res();
  await mod.default(req, r);
  return r;
}

// ---------------------------------------------------- track1.js dispatch_settings

test('dispatch_settings: field_tech is rejected 403', async () => {
  scenario = { permissionRoles: ['field_tech'], profileRole: null };
  const r = await withMockedFetch(() => callTrack1DispatchSettings());
  assert.equal(r.statusCode, 403);
});

test('dispatch_settings: sales is rejected 403', async () => {
  scenario = { permissionRoles: ['sales'], profileRole: null };
  const r = await withMockedFetch(() => callTrack1DispatchSettings());
  assert.equal(r.statusCode, 403);
});

test('dispatch_settings: office_ar is rejected 403 (financials access does not imply scheduling access)', async () => {
  scenario = { permissionRoles: ['office_ar'], profileRole: null };
  const r = await withMockedFetch(() => callTrack1DispatchSettings());
  assert.equal(r.statusCode, 403);
});

test('dispatch_settings: project_manager is NOT blocked by the role gate', async () => {
  scenario = { permissionRoles: ['project_manager'], profileRole: null };
  const r = await withMockedFetch(() => callTrack1DispatchSettings());
  assert.notEqual(r.statusCode, 403);
});

test('dispatch_settings: dispatch is NOT blocked by the role gate', async () => {
  scenario = { permissionRoles: ['dispatch'], profileRole: null };
  const r = await withMockedFetch(() => callTrack1DispatchSettings());
  assert.notEqual(r.statusCode, 403);
});

test('dispatch_settings: coarse profiles.role=admin bypasses the gate regardless of granular role', async () => {
  scenario = { permissionRoles: ['field_tech'], profileRole: 'admin' };
  const r = await withMockedFetch(() => callTrack1DispatchSettings());
  assert.notEqual(r.statusCode, 403);
});

test('dispatch_settings: coarse profiles.role=superadmin also bypasses the gate', async () => {
  scenario = { permissionRoles: ['field_tech'], profileRole: 'superadmin' };
  const r = await withMockedFetch(() => callTrack1DispatchSettings());
  assert.notEqual(r.statusCode, 403);
});

// ---------------------------------------------------- schedule/move-visit.js

test('move-visit: field_lead cannot move any visit -- not even, per the rule, their own', async () => {
  scenario = { permissionRoles: ['field_lead'], profileRole: null };
  const r = await withMockedFetch(() => callMoveVisit());
  assert.equal(r.statusCode, 403);
});

test('move-visit: purchasing is rejected 403', async () => {
  scenario = { permissionRoles: ['purchasing'], profileRole: null };
  const r = await withMockedFetch(() => callMoveVisit());
  assert.equal(r.statusCode, 403);
});

test('move-visit: admin_remote is rejected 403', async () => {
  scenario = { permissionRoles: ['admin_remote'], profileRole: null };
  const r = await withMockedFetch(() => callMoveVisit());
  assert.equal(r.statusCode, 403);
});

test('move-visit: owner is NOT blocked by the role gate', async () => {
  scenario = { permissionRoles: ['owner'], profileRole: null };
  const r = await withMockedFetch(() => callMoveVisit());
  assert.notEqual(r.statusCode, 403);
  assert.notEqual(r.statusCode, 401);
});

test('move-visit: an anonymous request still 401s (unchanged base gate)', async () => {
  scenario = { permissionRoles: [], profileRole: null };
  const r = await withMockedFetch(() => callMoveVisit({ authHeader: '' }));
  assert.equal(r.statusCode, 401);
});
