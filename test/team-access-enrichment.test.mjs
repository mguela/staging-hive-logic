// test/team-access-enrichment.test.mjs
//
// 2026-08-29, Team & Access redesign: resource=team's GET used to return
// only id/email/full_name/role -- the new Team Members table also shows
// Job Role, Crew Lead, Division, Vehicle Assignment, HiveConnect
// connection, Jobber sync, phone, and "last seen in app," none of which
// existed in the response before.
//
// employee_roles has NO direct FK to profiles.id -- it's reached only via
// profiles.email -> users.email -> users.jobber_id -> employee_roles.jobber_id.
// hiveconnect_account_map is the one exception: its PK IS profiles.id
// directly. These tests pin that the join actually resolves through that
// chain, and degrades to null/false (never a guess) at each broken link --
// no users row, or a users row but no employee_roles row, or a
// hiveconnect_account_map row that exists but is disabled.
//
// Fully mocked -- no network, no DB, no real secret.
// Run with: node --experimental-test-module-mocks --test test/team-access-enrichment.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

let scenario = {};

async function withMockedFetch(fn) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'requester-1', email: 'requester@ghgrp.net' });
    // getRequestingProfile's own lookup (filtered by id=eq.) vs. this
    // handler's bulk team list (no id filter, ordered by full_name) both
    // hit /rest/v1/profiles -- told apart by the order= clause only the
    // bulk list sends.
    if (u.includes('/rest/v1/profiles')) {
      if (u.includes('order=full_name.asc')) return jsonRes(scenario.profiles || []);
      return jsonRes([{ id: 'requester-1', email: 'requester@ghgrp.net', role: 'superadmin' }]);
    }
    if (u.includes('/rest/v1/users')) return jsonRes(scenario.users || []);
    if (u.includes('/rest/v1/employee_roles')) return jsonRes(scenario.employeeRoles || []);
    if (u.includes('/rest/v1/hiveconnect_account_map')) return jsonRes(scenario.hiveconnectMap || []);
    return jsonRes({ error: 'not relevant to this test' });
  };
  try { return await fn(); } finally { global.fetch = original; }
}

async function fetchTeam() {
  const mod = await import('../api/track1.js');
  const req = { method: 'GET', query: { resource: 'team' }, headers: { authorization: 'Bearer usertoken' } };
  const r = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await mod.default(req, r);
  return r;
}

test('a profile fully present in users, employee_roles, and hiveconnect_account_map resolves every field', async () => {
  scenario = {
    profiles: [{ id: 'emp-1', email: 'jomell@ghgrp.net', full_name: 'Jomell Alba', role: 'admin', mobile: '555-0100', page_build_seen_at: '2026-08-29T10:00:00Z' }],
    users: [{ jobber_id: 'jobber-1', email: 'jomell@ghgrp.net', assigned_vehicle_name: 'Truck 4', synced_at: '2026-08-29T09:00:00Z' }],
    employeeRoles: [{ jobber_id: 'jobber-1', permission_role: 'office_ar', permission_roles: ['office_ar'], is_lead: true, division: 'Operations' }],
    hiveconnectMap: [{ hivelogic_user_id: 'emp-1', status: 'active' }],
  };
  const r = await withMockedFetch(fetchTeam);
  assert.equal(r.body.ok, true);
  const row = r.body.team.find((t) => t.id === 'emp-1');
  assert.equal(row.jobRole, 'office_ar');
  assert.equal(row.isLead, true);
  assert.equal(row.division, 'Operations');
  assert.equal(row.vehicleName, 'Truck 4');
  assert.equal(row.jobberSynced, true);
  assert.equal(row.hiveConnectConnected, true);
  assert.equal(row.phone, '555-0100');
  assert.equal(row.lastSeenInApp, '2026-08-29T10:00:00Z');
});

test('no matching users row: jobberSynced is false, and there is no chain to reach employee_roles at all', async () => {
  scenario = {
    profiles: [{ id: 'emp-2', email: 'nosync@ghgrp.net', full_name: 'No Sync', role: 'crew', mobile: null, page_build_seen_at: null }],
    users: [],
    employeeRoles: [{ jobber_id: 'jobber-x', permission_role: 'field_tech', is_lead: false, division: 'Field' }],
    hiveconnectMap: [],
  };
  const r = await withMockedFetch(fetchTeam);
  const row = r.body.team.find((t) => t.id === 'emp-2');
  assert.equal(row.jobberSynced, false);
  assert.equal(row.vehicleName, null);
  assert.equal(row.jobRole, null, 'no jobber_id means no way to join employee_roles -- must not guess');
  assert.equal(row.isLead, false);
  assert.equal(row.division, null);
  assert.equal(row.hiveConnectConnected, false);
  assert.equal(row.lastSeenInApp, null);
});

test('a users row exists but no matching employee_roles row: synced is true, job-role fields stay null/false', async () => {
  scenario = {
    profiles: [{ id: 'emp-3', email: 'novend@ghgrp.net', full_name: 'No Roles Row', role: 'crew' }],
    users: [{ jobber_id: 'jobber-3', email: 'novend@ghgrp.net', assigned_vehicle_name: 'Van 2', synced_at: '2026-08-29T08:00:00Z' }],
    employeeRoles: [],
    hiveconnectMap: [],
  };
  const r = await withMockedFetch(fetchTeam);
  const row = r.body.team.find((t) => t.id === 'emp-3');
  assert.equal(row.jobberSynced, true);
  assert.equal(row.vehicleName, 'Van 2');
  assert.equal(row.jobRole, null);
  assert.equal(row.isLead, false);
  assert.equal(row.division, null);
});

test('a hiveconnect_account_map row with status=disabled is NOT reported as connected', async () => {
  scenario = {
    profiles: [{ id: 'emp-4', email: 'disabled@ghgrp.net', full_name: 'Disabled Link', role: 'crew' }],
    users: [],
    employeeRoles: [],
    hiveconnectMap: [{ hivelogic_user_id: 'emp-4', status: 'disabled' }],
  };
  const r = await withMockedFetch(fetchTeam);
  const row = r.body.team.find((t) => t.id === 'emp-4');
  assert.equal(row.hiveConnectConnected, false, 'a disabled mapping row must read the same as no row at all');
});

test('falls back to permission_roles[0] when the scalar permission_role is empty', async () => {
  scenario = {
    profiles: [{ id: 'emp-5', email: 'multi@ghgrp.net', full_name: 'Multi Role', role: 'admin' }],
    users: [{ jobber_id: 'jobber-5', email: 'multi@ghgrp.net' }],
    employeeRoles: [{ jobber_id: 'jobber-5', permission_role: null, permission_roles: ['dispatch', 'sales'], is_lead: false, division: null }],
    hiveconnectMap: [],
  };
  const r = await withMockedFetch(fetchTeam);
  const row = r.body.team.find((t) => t.id === 'emp-5');
  assert.equal(row.jobRole, 'dispatch');
});
