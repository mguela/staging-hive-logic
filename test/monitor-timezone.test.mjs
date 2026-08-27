// test/monitor-timezone.test.mjs
//
// Chris/the user, 2026-08-26: "make it flexible so anyone who will be
// monitored regardless of the location and timezone... the system must
// automatically detect my location and timezone." Investigating
// "screenshots not working for Marvin" (Manila, PH) found three places
// that assumed everyone is in America/New_York:
//
//   1. The desktop agent's own hardcoded local-clock gate (6am-8pm) --
//      independent of and could silently override the server's real
//      shouldCapture decision. Fixed by deleting the gate outright.
//   2. hlWorkforceArmStaleSessionPrompt (public/index.html) compared
//      calendar dates in a hardcoded America/New_York.
//   3. handleMonitorAppUsage's "today" window was hardcoded ET, so a
//      remote employee's own day could bucket into the wrong "today".
//
// This file pins the server-side halves: the agent now reports its OS
// timezone on every heartbeat, the server keeps it on profiles.settings
// (api/user-settings.js's per-user blob), and handleMonitorAppUsage
// resolves "today" against THAT timezone instead of a hardcoded one.
//
// Fully mocked -- no network, no DB, no real secret.
// Run with: node --experimental-test-module-mocks --test test/monitor-timezone.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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

// --- the agent's source -----------------------------------------------

test('the desktop agent has no local business-hours gate left', () => {
  const src = fs.readFileSync('hivelogic-monitor-agent/src/main.js', 'utf8');
  assert.doesNotMatch(src, /function withinBusinessHours/, 'the redundant local-clock gate must be gone, not just unused');
  assert.doesNotMatch(src, /businessHoursStart|businessHoursEnd/, 'no hardcoded local-hour config should remain');
  assert.match(src, /data\.shouldCapture \?\s*'Recording'/, 'capture status must be read from the server alone');
});

test('the heartbeat reports the machine\'s real timezone', () => {
  const src = fs.readFileSync('hivelogic-monitor-agent/src/main.js', 'utf8');
  assert.match(src, /timezone: Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/,
    'must read the OS zone via Intl -- no geolocation, no manual config');
});

// --- the server records what the agent reports -------------------------

const AGENT = { id: 'agent-1', employee_id: 'marvin-1', agent_token_hash: 'x' };
let requestedSettingsWrite = null;

async function withMockedFetch({ existingSettings = {} } = {}, fn) {
  const original = global.fetch;
  requestedSettingsWrite = null;
  global.fetch = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    if (u.includes('/rest/v1/monitor_agents') && method === 'PATCH') return jsonRes([{}]);
    if (u.includes('/rest/v1/profiles') && u.includes('select=settings')) return jsonRes([{ settings: existingSettings }]);
    if (u.includes('/rest/v1/profiles') && method === 'PATCH') {
      requestedSettingsWrite = JSON.parse(opts.body);
      return jsonRes([{}]);
    }
    if (u.includes('/rest/v1/workforce_time_sessions')) return jsonRes([]); // not clocked in -- ends the handler early
    if (u.includes('/rest/v1/monitor_sessions')) return jsonRes([]);
    return jsonRes({ error: 'not relevant to this test' });
  };
  try { return await fn(); } finally { global.fetch = original; }
}

const trackMod = await import('../api/track1.js');
const { hashAgentToken } = await import('../api/_lib/monitor.js');

async function heartbeatWith(body) {
  // getRequestingAgent hashes the bearer token and looks it up -- mock the
  // lookup response inline here since it is not part of what this file is
  // pinning (that path is covered by monitor-security.test.mjs already).
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/rest/v1/monitor_agents') && u.includes('agent_token_hash')) return jsonRes([AGENT]);
    return original(url, opts);
  };
  try {
    const req = { method: 'POST', query: { resource: 'monitor_heartbeat' }, headers: { authorization: 'Bearer whatever' }, body };
    const r = res();
    await trackMod.default(req, r);
    return r;
  } finally { global.fetch = original; }
}

test('a valid reported timezone is merged into profiles.settings, alongside whatever was already there', async () => {
  await withMockedFetch({ existingSettings: { theme: 'dark' } }, async () => {
    await heartbeatWith({ timezone: 'Asia/Manila' });
  });
  assert.ok(requestedSettingsWrite, 'the heartbeat must have written profiles.settings');
  assert.equal(requestedSettingsWrite.settings.timezone, 'Asia/Manila');
  assert.equal(requestedSettingsWrite.settings.theme, 'dark', 'an unrelated existing setting must survive the merge');
});

test('an invalid/garbled timezone is never written -- Intl must not be handed forged input', async () => {
  await withMockedFetch({}, async () => {
    await heartbeatWith({ timezone: 'Not/AZone' });
  });
  assert.equal(requestedSettingsWrite, null);
});

test('a heartbeat with no timezone field at all does not write settings', async () => {
  await withMockedFetch({}, async () => {
    await heartbeatWith({});
  });
  assert.equal(requestedSettingsWrite, null);
});

test('the same timezone reported again does not trigger a redundant write', async () => {
  await withMockedFetch({ existingSettings: { timezone: 'Asia/Manila' } }, async () => {
    await heartbeatWith({ timezone: 'Asia/Manila' });
  });
  assert.equal(requestedSettingsWrite, null);
});

// --- handleMonitorAppUsage resolves "today" per-employee ----------------

test('App Usage - Today resolves "today" against the requester\'s own timezone, not a hardcoded one', async () => {
  const original = global.fetch;
  let sessionQueryUrl = null;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'marvin-1', email: 'marvin@ghgrp.net' });
    if (u.includes('/rest/v1/profiles')) {
      return jsonRes([{ id: 'marvin-1', email: 'marvin@ghgrp.net', role: 'crew', monitoring_enabled: true, settings: { timezone: 'Asia/Manila' } }]);
    }
    if (u.includes('/rest/v1/monitor_sessions')) { sessionQueryUrl = u; return jsonRes([]); }
    return jsonRes({ error: 'not relevant' });
  };
  try {
    const req = { method: 'GET', query: { resource: 'monitor_app_usage' }, headers: { authorization: 'Bearer usertoken' } };
    const r = res();
    await trackMod.default(req, r);
    assert.ok(sessionQueryUrl, 'must have queried monitor_sessions for "today"');
    const startedGte = decodeURIComponent(sessionQueryUrl.match(/started_at=gte\.([^&]+)/)[1]);
    // Manila local midnight, carrying Manila's own +08:00 offset -- a
    // hardcoded America/New_York window would instead carry -04:00/-05:00.
    assert.match(startedGte, /T00:00:00\+08:00$/, `expected a Manila midnight boundary, got ${startedGte}`);
  } finally { global.fetch = original; }
});
