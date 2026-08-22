// test/workforce-team.test.mjs
// 2026-08-13 (jomell/Chris ask): the admin-facing Remote & Production team
// board (resource=workforce_team) showed clock-in/out state but not each
// person's live availability status (Available / In a Meeting / Lunch /
// Needs Help), even though that status already exists for every clocked-in
// session (status_flag/status_emoji/status_updated_at columns, sql/005_
// workforce_status.sql) and was already surfaced elsewhere (the self-service
// Team Status card, resource=workforce_team_status). This just maps those
// same columns onto the admin team roster too.
// Fully mocked -- no network, no DB, no real secret.
// Run with: node --experimental-test-module-mocks --test test/workforce-team.test.mjs

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

let scenario = {};

function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

async function withMockedFetch(fn) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1', email: scenario.email || 'chris@ghgrp.net' });
    if (u.includes('/rest/v1/profiles') && !u.includes('order=full_name')) return jsonRes([{ id: 'user-1', email: scenario.email || 'chris@ghgrp.net', role: scenario.profileRole || null }]);
    if (u.includes('/rest/v1/profiles')) return jsonRes(scenario.profiles || []);
    if (u.includes('/rest/v1/workforce_time_sessions')) return jsonRes(scenario.sessions || []);
    if (u.includes('/rest/v1/workforce_daily_summaries')) return jsonRes(scenario.summaries || []);
    return jsonRes({ error: 'not relevant to this test' });
  };
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

const trackMod = await import('../api/track1.js');

async function callTrack1(resource, { method = 'GET', body, query = {}, authHeader = 'Bearer usertoken' } = {}) {
  const req = { method, query: Object.assign({ resource }, query), headers: { authorization: authHeader }, body };
  const r = res();
  await trackMod.default(req, r);
  return r;
}

test('workforce_team: a non-admin is rejected 403', async () => {
  scenario = { email: 'field@ghgrp.net', profileRole: 'crew' };
  const r = await withMockedFetch(() => callTrack1('workforce_team'));
  assert.equal(r.statusCode, 403);
});

test('workforce_team: a clocked-in person carries their live availability status', async () => {
  scenario = {
    email: 'chris@ghgrp.net', profileRole: 'admin',
    profiles: [{ id: 'emp-1', email: 'jane@ghgrp.net', full_name: 'Jane Smith', role: 'crew' }],
    sessions: [{
      employee_id: 'emp-1', status: 'active', clock_in: '2026-08-13T13:00:00Z',
      on_break: false, total_break_seconds: 0,
      status_flag: 'meeting', status_emoji: '📅', status_updated_at: '2026-08-13T13:30:00Z',
    }],
    summaries: [],
  };
  const r = await withMockedFetch(() => callTrack1('workforce_team'));
  assert.equal(r.statusCode, 200);
  const jane = r.body.team.find((p) => p.id === 'emp-1');
  assert.equal(jane.clockedInNow, true);
  assert.equal(jane.status, 'meeting');
  assert.equal(jane.statusLabel, 'In a Meeting');
  assert.equal(jane.statusEmoji, '📅');
  assert.equal(jane.statusUpdatedAt, '2026-08-13T13:30:00Z');
});

test('workforce_team: an active session with no status set falls back to Available', async () => {
  scenario = {
    email: 'chris@ghgrp.net', profileRole: 'admin',
    profiles: [{ id: 'emp-2', email: 'bob@ghgrp.net', full_name: 'Bob Jones', role: 'crew' }],
    sessions: [{
      employee_id: 'emp-2', status: 'active', clock_in: '2026-08-13T13:00:00Z',
      on_break: false, total_break_seconds: 0,
      status_flag: null, status_emoji: null, status_updated_at: null,
    }],
    summaries: [],
  };
  const r = await withMockedFetch(() => callTrack1('workforce_team'));
  assert.equal(r.statusCode, 200);
  const bob = r.body.team.find((p) => p.id === 'emp-2');
  assert.equal(bob.statusLabel, 'Available');
  assert.equal(bob.statusEmoji, '✅');
  assert.equal(bob.statusUpdatedAt, '2026-08-13T13:00:00Z', 'falls back to clock_in when never explicitly updated');
});

test('workforce_team: someone not clocked in has no status at all, not a stale/leftover one', async () => {
  scenario = {
    email: 'chris@ghgrp.net', profileRole: 'admin',
    profiles: [{ id: 'emp-3', email: 'sam@ghgrp.net', full_name: 'Sam Lee', role: 'crew' }],
    sessions: [{
      employee_id: 'emp-3', status: 'completed', clock_in: '2026-08-12T13:00:00Z', clock_out: '2026-08-12T21:00:00Z',
      on_break: false, total_break_seconds: 0,
      status_flag: 'lunch', status_emoji: '🍕', status_updated_at: '2026-08-12T18:00:00Z',
    }],
    summaries: [],
  };
  const r = await withMockedFetch(() => callTrack1('workforce_team'));
  assert.equal(r.statusCode, 200);
  const sam = r.body.team.find((p) => p.id === 'emp-3');
  assert.equal(sam.clockedInNow, false);
  assert.equal(sam.status, null);
  assert.equal(sam.statusLabel, null);
  assert.equal(sam.statusEmoji, null);
  assert.equal(sam.statusUpdatedAt, null);
});

test('workforce_team: "today" follows the business\'s America/New_York calendar day, not raw UTC (jomell: an EOD submitted in the evening showed as missing)', async () => {
  // 9:00pm EDT on Aug 13 is already 1:00am UTC on Aug 14. todayStr() used to
  // be new Date().toISOString().slice(0,10) -- plain UTC -- so evening clock-
  // outs/EOD submissions (exactly when they happen) could get queried under
  // the wrong calendar day. Pin "now" to that exact cross-midnight moment and
  // assert every date-scoped query still asks for the 13th (Eastern), not
  // the 14th (UTC).
  const FAKE_NOW = new Date('2026-08-14T01:00:00Z').getTime();
  const RealDate = global.Date;
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(FAKE_NOW);
      else super(...args);
    }
  }
  FakeDate.now = () => FAKE_NOW;
  global.Date = FakeDate;

  const capturedUrls = [];
  scenario = {
    email: 'chris@ghgrp.net', profileRole: 'admin',
    profiles: [{ id: 'emp-1', email: 'jane@ghgrp.net', full_name: 'Jane Smith', role: 'crew' }],
    sessions: [], summaries: [],
  };
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    capturedUrls.push(u);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1', email: scenario.email });
    if (u.includes('/rest/v1/profiles') && !u.includes('order=full_name')) return jsonRes([{ id: 'user-1', email: scenario.email, role: scenario.profileRole }]);
    if (u.includes('/rest/v1/profiles')) return jsonRes(scenario.profiles);
    if (u.includes('/rest/v1/workforce_time_sessions')) return jsonRes(scenario.sessions);
    if (u.includes('/rest/v1/workforce_daily_summaries')) return jsonRes(scenario.summaries);
    return jsonRes({ error: 'not relevant to this test' });
  };
  try {
    const r = await callTrack1('workforce_team');
    assert.equal(r.statusCode, 200);
  } finally {
    global.fetch = originalFetch;
    global.Date = RealDate;
  }

  const sessionsUrl = capturedUrls.find((u) => u.includes('workforce_time_sessions'));
  const summariesUrl = capturedUrls.find((u) => u.includes('workforce_daily_summaries'));
  assert.ok(sessionsUrl && sessionsUrl.includes('2026-08-13'), 'sessions query must use the Eastern calendar day (13th): ' + sessionsUrl);
  assert.ok(!sessionsUrl.includes('2026-08-14'), 'sessions query must NOT use the UTC calendar day (14th): ' + sessionsUrl);
  assert.ok(summariesUrl && summariesUrl.includes('2026-08-13'), 'summaries query must use the Eastern calendar day (13th): ' + summariesUrl);
});
