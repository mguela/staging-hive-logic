// test/monitor-screenshot-access.test.mjs
//
// 2026-08-26, Chris/the user: "Only System Admin/Owner must be able to
// view the screenshots." Before this, handleMonitorReview's per-employee
// branch (screenshots + sessions + activity samples) was gated the same
// as every other Monitor endpoint -- any 'admin' (an office manager, a
// project manager) could open it. This pins the tightened rule:
// Superadmin (profiles.role) or Owner (employee_roles.permission_roles)
// only -- and that the plain roster (no employeeId, no images) is
// UNCHANGED, still open to any admin/superadmin.
//
// Also pins handleWorkforceStatus's new canViewScreenshots flag, which the
// Monitor dashboard uses to disable "View All" honestly instead of
// showing a button that will just 403.
//
// Fully mocked -- no network, no DB, no real secret.
// Run with: node --experimental-test-module-mocks --test test/monitor-screenshot-access.test.mjs

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
function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

let scenario = {};

async function withMockedFetch(fn) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'requester-1', email: scenario.email });
    if (u.includes('/rest/v1/profiles')) return jsonRes([{ id: 'requester-1', email: scenario.email, role: scenario.role }]);
    // isOwner() -> getPermissionRoles(): users.email -> jobber_id -> employee_roles.permission_roles
    if (u.includes('/rest/v1/users')) return jsonRes([{ jobber_id: 'jobber-1' }]);
    if (u.includes('/rest/v1/employee_roles')) return jsonRes([{ permission_roles: scenario.permissionRoles || [], permission_role: null }]);
    if (u.includes('/rest/v1/monitor_agents')) return jsonRes([]);
    if (u.includes('/rest/v1/monitor_sessions')) return jsonRes([]);
    if (u.includes('/rest/v1/workforce_time_sessions')) return jsonRes([]);
    if (u.includes('/rest/v1/workforce_daily_summaries')) return jsonRes([]);
    return jsonRes({ error: 'not relevant to this test' });
  };
  try { return await fn(); } finally { global.fetch = original; }
}

const trackMod = await import('../api/track1.js');

async function monitorReview(employeeId) {
  const query = { resource: 'monitor_review' };
  if (employeeId) query.employeeId = employeeId;
  const req = { method: 'GET', query, headers: { authorization: 'Bearer usertoken' } };
  const r = res();
  await trackMod.default(req, r);
  return r;
}

async function workforceStatus() {
  const req = { method: 'GET', query: { resource: 'workforce_status' }, headers: { authorization: 'Bearer usertoken' } };
  const r = res();
  await trackMod.default(req, r);
  return r;
}

test('a plain admin is refused the per-employee screenshot view', async () => {
  scenario = { email: 'patrick@ghgrp.net', role: 'admin', permissionRoles: ['office_manager'] };
  const r = await withMockedFetch(() => monitorReview('someone-else'));
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /Superadmin\/Owner/);
});

test('a superadmin can open the per-employee screenshot view', async () => {
  scenario = { email: 'jomell@ghgrp.net', role: 'superadmin', permissionRoles: ['project_manager'] };
  const r = await withMockedFetch(() => monitorReview('someone-else'));
  assert.equal(r.body.ok, true);
  assert.ok('screenshots' in r.body);
});

test('an Owner can open it even with the plain admin login role', async () => {
  scenario = { email: 'lori@greenwichhandyman.net', role: 'admin', permissionRoles: ['owner'] };
  const r = await withMockedFetch(() => monitorReview('someone-else'));
  assert.equal(r.body.ok, true);
  assert.ok('screenshots' in r.body);
});

test('the plain roster (no employeeId, no images) is unchanged -- any admin still sees it', async () => {
  scenario = { email: 'patrick@ghgrp.net', role: 'admin', permissionRoles: ['office_manager'] };
  const r = await withMockedFetch(() => monitorReview(null));
  assert.equal(r.body.ok, true);
  assert.ok('roster' in r.body);
  assert.equal('screenshots' in r.body, false, 'the roster branch must never carry image data');
});

test('workforce_status tells a plain admin they cannot view screenshots', async () => {
  scenario = { email: 'patrick@ghgrp.net', role: 'admin', permissionRoles: ['office_manager'] };
  const r = await withMockedFetch(workforceStatus);
  assert.equal(r.body.canViewScreenshots, false);
});

test('workforce_status tells a superadmin they can', async () => {
  scenario = { email: 'jomell@ghgrp.net', role: 'superadmin', permissionRoles: [] };
  const r = await withMockedFetch(workforceStatus);
  assert.equal(r.body.canViewScreenshots, true);
});

test('workforce_status tells an Owner they can, even without the superadmin login role', async () => {
  scenario = { email: 'lori@greenwichhandyman.net', role: 'admin', permissionRoles: ['owner'] };
  const r = await withMockedFetch(workforceStatus);
  assert.equal(r.body.canViewScreenshots, true);
});
