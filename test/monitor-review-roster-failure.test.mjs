// test/monitor-review-roster-failure.test.mjs
//
// 2026-08-28, Marvin: the Monitor dashboard's "Activity & Screenshot
// Review" said "No one has set up HiveLogic Monitor yet" while his own
// agent was actively paired and recording -- the same page's Time
// Tracking and App Usage cards, fed by different endpoints, showed real
// data at the same moment.
//
// Root cause in handleMonitorReview's roster branch (no employeeId):
// `const agents = agentsRes.ok ? await agentsRes.json() : [];` treated a
// FAILED monitor_agents query exactly like a genuinely empty one. The
// frontend (mgrMonRefresh) shows that same reassuring "nobody's paired"
// message for both, so a broken query was indistinguishable from the
// honest empty state -- the worst failure mode for an admin-facing
// screen, because it reads as calm, true information when it may not be.
//
// This pins that a failed query now returns ok:false with the real
// error, not a silently faked empty roster.
//
// Fully mocked -- no network, no DB, no real secret.
// Run with: node --experimental-test-module-mocks --test test/monitor-review-roster-failure.test.mjs

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
function failedRes(status = 400, errBody = { message: 'column "last_disconnected_at" does not exist' }) {
  return { ok: false, status, json: async () => errBody, text: async () => JSON.stringify(errBody) };
}

let scenario = {};

async function withMockedFetch(fn) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'requester-1', email: scenario.email });
    if (u.includes('/rest/v1/profiles')) return jsonRes([{ id: 'requester-1', email: scenario.email, role: scenario.role }]);
    if (u.includes('/rest/v1/monitor_agents')) return scenario.agentsFail ? failedRes() : jsonRes(scenario.agents || []);
    if (u.includes('/rest/v1/monitor_sessions')) return jsonRes([]);
    return jsonRes({ error: 'not relevant to this test' });
  };
  try { return await fn(); } finally { global.fetch = original; }
}

const trackMod = await import('../api/track1.js');

async function monitorReviewRoster() {
  const req = { method: 'GET', query: { resource: 'monitor_review' }, headers: { authorization: 'Bearer usertoken' } };
  const r = res();
  await trackMod.default(req, r);
  return r;
}

test('a failed monitor_agents query is reported as an error, not a silently empty roster', async () => {
  scenario = { email: 'patrick@ghgrp.net', role: 'admin', agentsFail: true };
  const r = await withMockedFetch(monitorReviewRoster);
  assert.equal(r.body.ok, false, 'a query failure must never be reported as ok:true');
  assert.match(r.body.error, /Could not load the Monitor roster/);
  assert.match(r.body.error, /last_disconnected_at/, 'the real underlying error must be visible, not swallowed');
});

test('a genuinely empty monitor_agents table still reports ok:true with an empty roster', async () => {
  scenario = { email: 'patrick@ghgrp.net', role: 'admin', agentsFail: false, agents: [] };
  const r = await withMockedFetch(monitorReviewRoster);
  assert.equal(r.body.ok, true, 'a real empty state is not an error and must not be reported as one');
  assert.deepEqual(r.body.roster, []);
});

test('a paired agent still shows up in the roster (the query succeeding path is unaffected)', async () => {
  scenario = {
    email: 'patrick@ghgrp.net',
    role: 'admin',
    agentsFail: false,
    agents: [{ id: 'agent-1', employee_id: 'requester-1', device_name: 'DESKTOP-1', platform: 'windows', status: 'active', paired_at: '2026-08-28T00:00:00Z', last_seen_at: new Date().toISOString(), last_disconnected_at: null, agent_version: '1.3.2' }],
  };
  const r = await withMockedFetch(monitorReviewRoster);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.roster.length, 1);
  assert.equal(r.body.roster[0].employeeId, 'requester-1');
});
