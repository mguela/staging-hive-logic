// test/monitor-status-honesty.test.mjs
//
// Chris, 2026-08-16: "nothing is working and there is a lingering piece of the
// popup that claims im being monitored at the bottom of the screen."
//
// Two bugs, both surfaced by the same screenshot.
//
// 1. THE CLAIM WAS FALSE. monitor_status returned `paired: true` whenever an
//    agent row existed with status='active' -- which only means a pairing was
//    completed once and never revoked. It stays true forever whether or not the
//    desktop app has run since. The frontend branched on `paired` alone and
//    announced "HiveLogic Monitor is active for this session -- activity
//    records while you're clocked in." Chris saw that message every day for two
//    weeks while his agent's last_seen_at sat frozen at 2026-08-02 and nothing
//    was recorded at all.
//
//    This is the same failure as the Monitor tab showing green: claiming a
//    state nothing verified. Telling someone they ARE being recorded when they
//    are not is as wrong as the reverse, and arguably worse.
//
// 2. THE TOAST NEVER FULLY HID. Its hidden position was a flat
//    translateY(80px) against bottom:26px, so it only cleared the screen while
//    under ~54px tall. The monitoring message is the longest string in the app;
//    it wraps, grows past that, and leaves a permanent sliver on screen -- and,
//    with no pointer-events rule, that invisible strip could still swallow
//    clicks along the bottom of the page.
//
// Fully mocked -- no network, no DB.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

function res() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

const trackMod = await import('../api/track1.js');
const { MONITOR_AGENT_ALIVE_MINUTES } = trackMod;

async function monitorStatus(agentRow) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1', email: 'chris@ghgrp.net' });
    if (u.includes('/rest/v1/profiles')) return jsonRes([{ id: 'user-1', email: 'chris@ghgrp.net', role: 'superadmin' }]);
    if (u.includes('/rest/v1/monitor_agents')) return jsonRes(agentRow ? [agentRow] : []);
    return jsonRes({});
  };
  try {
    const r = res();
    await trackMod.default({ method: 'GET', query: { resource: 'monitor_status' }, headers: { authorization: 'Bearer t' } }, r);
    return r.body;
  } finally { global.fetch = original; }
}

const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();
const AGENT = { device_name: 'Chris-PC', platform: 'windows', paired_at: '2026-07-25T13:15:38Z' };

// --- The claim -------------------------------------------------------------

test('a paired agent that has not checked in for two weeks is NOT reported alive', async () => {
  // The exact production shape: paired 2026-07-25, last seen 2026-08-02,
  // reported on 2026-08-16. Fourteen days of silence.
  const body = await monitorStatus({ ...AGENT, last_seen_at: minutesAgo(14 * 24 * 60) });
  assert.equal(body.paired, true, 'the pairing is real and should still be reported');
  assert.equal(body.alive, false, 'but nothing has been recorded -- the app must not claim otherwise');
  assert.ok(body.staleMinutes > 14 * 24 * 60 - 60, 'and it must say how long it has been silent');
});

test('an agent heartbeating right now IS reported alive', async () => {
  const body = await monitorStatus({ ...AGENT, last_seen_at: minutesAgo(0) });
  assert.equal(body.paired, true);
  assert.equal(body.alive, true);
});

test('the alive threshold tolerates a brief gap but not a dead agent', async () => {
  // The agent heartbeats every 60s, so a few missed beats is a sleeping laptop,
  // not a dead one; hours is dead.
  const justInside = await monitorStatus({ ...AGENT, last_seen_at: minutesAgo(MONITOR_AGENT_ALIVE_MINUTES - 1) });
  assert.equal(justInside.alive, true, 'a short gap must not raise a false alarm');
  const wellOutside = await monitorStatus({ ...AGENT, last_seen_at: minutesAgo(MONITOR_AGENT_ALIVE_MINUTES + 60) });
  assert.equal(wellOutside.alive, false, 'an hour past the threshold is not running');
});

test('an agent that has NEVER checked in is not alive, and says so without crashing', async () => {
  // Jovie and Robert both have agent rows with last_seen_at null -- pairing
  // rows that never completed a single heartbeat.
  const body = await monitorStatus({ ...AGENT, last_seen_at: null });
  assert.equal(body.paired, true);
  assert.equal(body.alive, false);
  assert.equal(body.staleMinutes, null, 'no heartbeat ever means no age to report, not a bogus number');
});

test('no agent at all is unpaired, and still explicitly not alive', async () => {
  const body = await monitorStatus(null);
  assert.equal(body.paired, false);
  assert.equal(body.alive, false, 'alive must never be undefined -- the client branches on it');
});

// --- The message -----------------------------------------------------------

const html = fs.readFileSync('public/index.html', 'utf8');

test('the client only claims monitoring is active when the agent is actually alive', () => {
  assert.match(
    html, /if\(data\.paired && data\.alive\)\{/,
    'the "Monitor is active" branch must require alive, not merely paired',
  );
  assert.match(
    html, /\} else if\(data\.paired\)\{/,
    'paired-but-silent needs its own branch -- it is neither "active" nor "not set up"',
  );
  assert.match(
    html, /paired but has not checked in/,
    'the silent case must say plainly that nothing is being recorded',
  );
  assert.match(html, /nothing is being recorded/);
});

test('the silent message reports how long it has been silent, in human units', () => {
  assert.match(html, /function hlFmtStaleAge\(minutes\)\{/);
  // "14 days", not "20160 minutes".
  assert.match(html, /days \+ ' day'/);
});

// --- The lingering sliver --------------------------------------------------

test('the toast hides by its own height, so a wrapped message cannot leave a sliver', () => {
  const base = /\.toast\{[^}]*\}/.exec(html);
  assert.ok(base, '.toast rule must exist');
  assert.match(
    base[0], /translateY\(calc\(100% \+ 40px\)\)/,
    'the hidden offset must be height-relative; a flat 80px only clears a short toast',
  );
  assert.doesNotMatch(base[0], /translateY\(80px\)/, 'the fixed-offset hide is the bug');
});

test('the hidden toast is invisible and cannot swallow clicks', () => {
  const base = /\.toast\{[^}]*\}/.exec(html)[0];
  assert.match(base, /opacity:0/, 'off-screen alone is not gone');
  assert.match(base, /visibility:hidden/);
  assert.match(base, /pointer-events:none/, 'the hidden strip must not intercept clicks at the page bottom');
  assert.match(base, /max-width:min\(/, 'a long message must wrap to a readable block');

  const shown = /\.toast\.show\{[^}]*\}/.exec(html)[0];
  assert.match(shown, /opacity:1/);
  assert.match(shown, /visibility:visible/);
  assert.match(shown, /pointer-events:auto/);
  assert.match(shown, /translateY\(0\)/);
});
