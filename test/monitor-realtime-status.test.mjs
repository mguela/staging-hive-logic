// test/monitor-realtime-status.test.mjs
//
// 2026-08-27, Chris/the user: "can we update that like realtime?" --
// Marvin quit the desktop agent and it kept showing Online for minutes.
// Before this, "Online" could only ever go stale by timeout
// (MONITOR_AGENT_ALIVE_MINUTES), and a clean Quit had no way to tell the
// server -- it looked identical to the agent being briefly busy.
//
// Two halves pinned here:
//   1. isAgentAlive() -- the one shared "is this agent alive" answer,
//      reused by every roster/status endpoint, honoring a
//      last_disconnected_at signal without ever touching the honest
//      last_seen_at record.
//   2. handleMonitorGoingOffline (resource=monitor_going_offline) -- the
//      endpoint the tray's Quit/Unpair handlers call to set that signal,
//      agent-token authenticated like every other agent-originated call.
//
// Fully mocked -- no network, no DB, no real secret.
// Run with: node --experimental-test-module-mocks --test test/monitor-realtime-status.test.mjs

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

const trackMod = await import('../api/track1.js');
const { isAgentAlive, MONITOR_AGENT_ALIVE_MINUTES, MONITOR_AGENT_RESOURCES } = trackMod;

// --- isAgentAlive() ------------------------------------------------------

test('the alive window shrank to a few minutes, from the old 15', () => {
  // Not pinning an exact number so this doesn't fight a future tuning
  // pass -- just that it is meaningfully shorter than the old 15-minute
  // wait this whole feature exists to fix.
  assert.ok(MONITOR_AGENT_ALIVE_MINUTES < 15, `expected < 15, got ${MONITOR_AGENT_ALIVE_MINUTES}`);
  assert.ok(MONITOR_AGENT_ALIVE_MINUTES >= 1);
});

test('a recent heartbeat with no disconnect signal is alive', () => {
  const cutoff = new Date(Date.now() - 5 * 60000).toISOString();
  const agent = { last_seen_at: new Date().toISOString(), last_disconnected_at: null };
  assert.equal(isAgentAlive(agent, cutoff), true);
});

test('no heartbeat at all is never alive', () => {
  const cutoff = new Date(Date.now() - 5 * 60000).toISOString();
  assert.equal(isAgentAlive({ last_seen_at: null }, cutoff), false);
  assert.equal(isAgentAlive(null, cutoff), false);
});

test('a heartbeat older than the cutoff is not alive, regardless of the disconnect signal', () => {
  const cutoff = new Date(Date.now() - 5 * 60000).toISOString();
  const staleAgent = { last_seen_at: new Date(Date.now() - 20 * 60000).toISOString(), last_disconnected_at: null };
  assert.equal(isAgentAlive(staleAgent, cutoff), false);
});

test('a clean-quit signal AFTER the last heartbeat means offline instantly, even inside the alive window', () => {
  const cutoff = new Date(Date.now() - 5 * 60000).toISOString();
  const now = new Date();
  const lastSeen = new Date(now.getTime() - 30000).toISOString(); // 30s ago -- well inside the window
  const disconnectedAt = now.toISOString(); // reported going offline just now
  const agent = { last_seen_at: lastSeen, last_disconnected_at: disconnectedAt };
  assert.equal(isAgentAlive(agent, cutoff), false, 'a disconnect signal newer than the last heartbeat must win, not the timeout');
});

test('a heartbeat AFTER an old disconnect signal means the agent is back, alive again', () => {
  const cutoff = new Date(Date.now() - 5 * 60000).toISOString();
  const now = new Date();
  const disconnectedAt = new Date(now.getTime() - 60000).toISOString(); // quit a minute ago
  const lastSeen = now.toISOString(); // then reconnected and heartbeat just landed
  const agent = { last_seen_at: lastSeen, last_disconnected_at: disconnectedAt };
  assert.equal(isAgentAlive(agent, cutoff), true, 'reconnecting must clear the earlier disconnect, automatically, with no reset needed');
});

// --- resource=monitor_going_offline ---------------------------------------

const AGENT = { id: 'agent-1', employee_id: 'marvin-1', agent_token_hash: 'x' };
let patchedBody = null;

async function withMockedFetch(fn) {
  const original = global.fetch;
  patchedBody = null;
  global.fetch = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    if (u.includes('/rest/v1/monitor_agents') && u.includes('agent_token_hash')) return jsonRes([AGENT]);
    if (u.includes('/rest/v1/monitor_agents') && method === 'PATCH') {
      patchedBody = JSON.parse(opts.body);
      return jsonRes([{}]);
    }
    return jsonRes({ error: 'not relevant to this test' });
  };
  try { return await fn(); } finally { global.fetch = original; }
}

async function goingOffline(token) {
  const req = { method: 'POST', query: { resource: 'monitor_going_offline' }, headers: { authorization: 'Bearer ' + (token || 'whatever') } };
  const r = res();
  await trackMod.default(req, r);
  return r;
}

test('a valid agent token records last_disconnected_at, not last_seen_at', async () => {
  const r = await withMockedFetch(() => goingOffline());
  assert.equal(r.body.ok, true);
  assert.ok(patchedBody, 'monitor_agents must have been PATCHed');
  assert.ok('last_disconnected_at' in patchedBody);
  assert.equal('last_seen_at' in patchedBody, false, 'last_seen_at must stay the honest last-heartbeat record, untouched by a disconnect');
});

test('a forged/unknown token is refused, same as every other agent endpoint', async () => {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/rest/v1/monitor_agents') && u.includes('agent_token_hash')) return jsonRes([]); // no matching agent
    return jsonRes({ error: 'not relevant' });
  };
  try {
    const r = await goingOffline('forged-token');
    assert.equal(r.body.ok, false);
    assert.equal(r.statusCode, 401);
  } finally { global.fetch = original; }
});

test('GET is refused -- this is a write, same as the agent\'s other actions', async () => {
  // 401, not 405: MONITOR_AGENT_RESOURCES only exempts this resource from
  // the Supabase-session gate on POST (see api-auth-guard.test.mjs's
  // "POST-only" tests) -- a GET never reaches handleMonitorGoingOffline's
  // own method check at all, it's refused one layer earlier for carrying
  // no real session. Same shape the agent's other write-only resources
  // already have.
  const req = { method: 'GET', query: { resource: 'monitor_going_offline' }, headers: { authorization: 'Bearer x' } };
  const r = res();
  await trackMod.default(req, r);
  assert.equal(r.body.ok, false);
  assert.equal(r.statusCode, 401);
});

test('monitor_going_offline is registered as an agent-token resource, same as the heartbeat', () => {
  assert.ok(MONITOR_AGENT_RESOURCES.includes('monitor_going_offline'));
});

// --- the agent's tray actually calls it -----------------------------------

test('the tray reports going offline before Quit and before Unpair, not after', () => {
  const src = fs.readFileSync('hivelogic-monitor-agent/src/main.js', 'utf8');
  assert.match(src, /async function reportGoingOffline\(\)/);
  assert.match(src, /resource=monitor_going_offline/);
  assert.match(src, /reportGoingOffline\(\)\.finally\(\(\) => app\.quit\(\)\)/, 'Quit must await the report before the process that would send it exits');
  assert.match(src, /reportGoingOffline\(\)\.finally\(\(\) => \{/, 'Unpair must also report before clearing the pairing');
});
