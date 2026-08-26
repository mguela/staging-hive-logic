// test/monitor-agent-dedupe.test.mjs
//
// Bug (Marvin, 2026-08-26): unpairing HiveLogic Monitor from the tray menu
// only clears the desktop app's local config -- it never tells the server
// (see hivelogic-monitor-agent/src/main.js's "Unpair this device"). The old
// monitor_agents row stayed 'active' forever. Re-pairing inserted a second
// row, and both Monitor Settings and the dashboard's Activity & Screenshot
// Review roster built one row PER AGENT instead of per person, so Marvin
// showed up twice -- once online (the real, current device) and once
// offline (the orphaned one), with nothing telling them apart.
//
// Two halves are fixed and pinned here:
//   1. handleMonitorPair revokes any other 'active' row for the employee
//      the moment a new pairing completes, so this can't recur going
//      forward;
//   2. both rosters collapse to one row per employee (pickBestMonitorAgent),
//      so any duplicate that already exists in the data doesn't reach the
//      screen either.
//
// Fully mocked -- no network, no DB, no real secret.
// Run with: node --experimental-test-module-mocks --test test/monitor-agent-dedupe.test.mjs

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

const ADMIN_PROFILE = { id: 'admin-1', email: 'chris@ghgrp.net', role: 'superadmin' };
const MARVIN = { id: 'marvin-1', full_name: 'Marvin', email: 'marvin@ghgrp.net', monitoring_enabled: true };

// The old (offline, orphaned) pairing and the new (online, current) one --
// same employee, same shape a real "unpair then re-pair" leaves behind.
const OLD_AGENT = {
  id: 'agent-old', employee_id: 'marvin-1', device_name: 'Marvin-OldPC', platform: 'windows',
  status: 'active', paired_at: '2026-08-01T00:00:00Z', last_seen_at: '2026-08-01T00:05:00Z', agent_version: '1.2.0',
};
const NEW_AGENT = {
  id: 'agent-new', employee_id: 'marvin-1', device_name: 'Marvin-PC', platform: 'windows',
  status: 'active', paired_at: '2026-08-26T00:00:00Z', last_seen_at: new Date().toISOString(), agent_version: '1.3.0',
};

async function withMockedFetch(agents, fn) {
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'admin-1', email: ADMIN_PROFILE.email });
    if (u.includes('/rest/v1/profiles')) {
      if (u.includes('id=eq.admin-1')) return jsonRes([ADMIN_PROFILE]);
      return jsonRes([MARVIN]);
    }
    if (u.includes('/rest/v1/monitor_agents')) return jsonRes(agents);
    if (u.includes('/rest/v1/workforce_settings')) return jsonRes([]);
    if (u.includes('/rest/v1/monitor_sessions')) return jsonRes([]);
    if (u.includes('/rest/v1/monitor_activity_samples')) return jsonRes([]);
    return jsonRes({ error: 'not relevant to this test' });
  };
  try { return await fn(); } finally { global.fetch = original; }
}

const trackMod = await import('../api/track1.js');

test('Monitor Settings shows one row for Marvin, not one per orphaned pairing', async () => {
  const r = await withMockedFetch([OLD_AGENT, NEW_AGENT], async () => {
    const req = { method: 'GET', query: { resource: 'monitor_settings' }, headers: { authorization: 'Bearer admintoken' } };
    const response = res();
    await trackMod.default(req, response);
    return response;
  });
  assert.equal(r.body.ok, true);
  const marvinRows = r.body.roster.filter((p) => p.employeeId === 'marvin-1');
  assert.equal(marvinRows.length, 1, 'Marvin must appear exactly once, not once per device he has ever paired');
  assert.equal(marvinRows[0].deviceName, 'Marvin-PC', 'the row shown must be the most-recently-paired one, not whichever the query happened to return first');
});

test('the dashboard roster (monitor_review) collapses the same way', async () => {
  const r = await withMockedFetch([OLD_AGENT, NEW_AGENT], async () => {
    const req = { method: 'GET', query: { resource: 'monitor_review' }, headers: { authorization: 'Bearer admintoken' } };
    const response = res();
    await trackMod.default(req, response);
    return response;
  });
  assert.equal(r.body.ok, true);
  const marvinRows = r.body.roster.filter((p) => p.employeeId === 'marvin-1');
  assert.equal(marvinRows.length, 1, 'Marvin must appear exactly once here too');
  assert.equal(marvinRows[0].deviceName, 'Marvin-PC');
});

test('a person with no paired device at all still shows exactly one row', async () => {
  const r = await withMockedFetch([], async () => {
    const req = { method: 'GET', query: { resource: 'monitor_settings' }, headers: { authorization: 'Bearer admintoken' } };
    const response = res();
    await trackMod.default(req, response);
    return response;
  });
  assert.equal(r.body.ok, true);
  const marvinRows = r.body.roster.filter((p) => p.employeeId === 'marvin-1');
  assert.equal(marvinRows.length, 1);
  assert.equal(marvinRows[0].status, 'not_installed');
});
