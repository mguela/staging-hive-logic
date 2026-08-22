// test/workforce-clockout-explained.test.mjs
//
// Being clocked out without being told why.
//
// PR #364 made declining a required monitoring prompt end the clock-in. The
// server enforces that the moment it deploys. The desktop agent's rewritten
// dialog -- the one that warns declining will clock you out, and pops a box
// when it does -- only reaches a machine when a NEW AGENT BUILD is published to
// csk5369/hivelogic-monitor and auto-updates. Those two halves ship on
// completely different schedules, and one is built by hand.
//
// So for the whole gap between them, the old dialog still reads "Not this time"
// and says nothing, and declining looks exactly like the app clocking you out
// at random. That is the same unexplained-surprise failure this area has
// produced over and over, and it does not need an agent release to fix: the
// browser already polls clock status every 60 seconds and can say what
// happened on the next page load.
//
// The same notice covers idle timeouts, which had the identical problem for a
// smaller reason -- you come back to find yourself off the clock with nothing
// saying why.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const {
  CLOSE_REASON_DECLINED, CLOSE_REASONS_WORTH_EXPLAINING,
  CLOSE_NOTICE_WINDOW_MINUTES, closeReasonNotice,
} = await import('../api/_lib/monitor-consent.js');
const trackMod = await import('../api/track1.js');

// --- Which endings get explained -------------------------------------------

test('the two clock-outs nobody chose are the ones explained', () => {
  assert.ok(CLOSE_REASONS_WORTH_EXPLAINING.includes(CLOSE_REASON_DECLINED));
  assert.ok(CLOSE_REASONS_WORTH_EXPLAINING.includes('idle_timeout'));
});

test('closing your own browser is not announced back to you', () => {
  // You did that. The sweep acting on it is already explained by the act.
  assert.equal(CLOSE_REASONS_WORTH_EXPLAINING.includes('browser_closed'), false);
  assert.equal(closeReasonNotice('browser_closed'), null);
});

test('every explained reason actually has words, and they say what to do next', () => {
  for (const reason of CLOSE_REASONS_WORTH_EXPLAINING) {
    const n = closeReasonNotice(reason);
    assert.ok(n && n.title && n.body, `${reason} is reported but has no wording`);
    assert.match(n.body, /[Cc]lock back in/, `${reason} must tell them the way out, not just the fact`);
  }
});

test('the decline wording says it is recoverable, and that nothing was recorded', () => {
  const n = closeReasonNotice(CLOSE_REASON_DECLINED);
  assert.match(n.body, /Monitoring is required for your account/);
  assert.match(n.body, /nothing is recorded unless you do/,
    'the reassurance is the point -- someone who declined needs to know the decline was honoured');
});

// --- The endpoint ----------------------------------------------------------

function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}
function res() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

async function status({ active = null, closed = [] }) {
  const seen = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'emp-1', email: 'patrick@ghgrp.net' });
    if (u.includes('/rest/v1/profiles')) return jsonRes([{ id: 'emp-1', email: 'patrick@ghgrp.net', role: 'crew' }]);
    if (u.includes('/rest/v1/workforce_daily_summaries')) return jsonRes([]);
    if (u.includes('/rest/v1/workforce_time_sessions')) {
      seen.push(u);
      if (u.includes('status=eq.active')) return jsonRes(active ? [active] : []);
      return jsonRes(closed);
    }
    return jsonRes({});
  };
  try {
    const r = res();
    await trackMod.default(
      { method: 'GET', query: { resource: 'workforce_status' }, headers: { authorization: 'Bearer usertoken' } },
      r
    );
    return { r, seen };
  } finally { global.fetch = original; }
}

const DECLINED = { id: 'wf-9', clock_out: new Date(Date.now() - 5 * 60 * 1000).toISOString(), close_reason: 'monitoring_declined' };

test('a recent decline comes back with the words to show', async () => {
  const { r } = await status({ closed: [DECLINED] });
  assert.equal(r.body.lastClosed.id, 'wf-9');
  assert.equal(r.body.lastClosed.closeReason, 'monitoring_declined');
  assert.ok(r.body.lastClosed.notice.title, 'the wording ships with the reason -- one source of truth');
});

test('nothing is announced to someone who is on the clock', async () => {
  // They already clocked back in. Re-explaining a closed session then is noise,
  // and noise is what makes people stop reading these.
  const { r, seen } = await status({ active: { id: 'wf-10', employee_id: 'emp-1', status: 'active' }, closed: [DECLINED] });
  assert.equal(r.body.lastClosed, null);
  assert.equal(seen.filter((u) => u.includes('status=eq.completed')).length, 0,
    'and it must not even ask -- an extra query on every 60s poll for every user, for nothing');
});

test('an ending nobody needs explained is not reported', async () => {
  const { r } = await status({ closed: [{ id: 'wf-8', clock_out: new Date().toISOString(), close_reason: 'browser_closed' }] });
  assert.equal(r.body.lastClosed, null);
});

test('a normal clock-out is not reported either', async () => {
  const { r } = await status({ closed: [{ id: 'wf-7', clock_out: new Date().toISOString(), close_reason: null }] });
  assert.equal(r.body.lastClosed, null, 'they pressed the button; they know');
});

test('only recent endings are volunteered', async () => {
  const { seen } = await status({ closed: [] });
  const q = seen.find((u) => u.includes('status=eq.completed'));
  assert.ok(q, 'sanity: the lookup must have run');
  assert.match(q, /clock_out=gte\./, 'unbounded, this would greet someone with last Tuesday');
  assert.ok(CLOSE_NOTICE_WINDOW_MINUTES >= 30 && CLOSE_NOTICE_WINDOW_MINUTES <= 240,
    'long enough to survive a coffee or a slow login, short enough to stay relevant');
});

// --- The client shows it once ----------------------------------------------

const html = fs.readFileSync('public/index.html', 'utf8');

test('the notice rides the poll that already runs everywhere', () => {
  assert.match(html, /if \(data && data\.lastClosed\) hlWfExplainClockOut\(data\.lastClosed\);/);
  // workforceRefresh runs on load and on a 60s interval regardless of which
  // view is open, so this reaches people who never open the Workforce tab.
  assert.match(html, /setInterval\(function\(\)\{ if \(window\.workforceRefresh\) workforceRefresh\(\); \}, 60000\);/);
});

test('it is shown once per closed session, not once a minute', () => {
  const fn = html.match(/function hlWfExplainClockOut\(lastClosed\)\{[\s\S]*?\n\}/);
  assert.ok(fn, 'hlWfExplainClockOut must exist');
  assert.match(fn[0], /localStorage\.getItem\(key\)/, 'a 60s poll would otherwise reopen this modal forever');
  assert.match(fn[0], /localStorage\.setItem\(key, '1'\)/);
  assert.match(fn[0], /'hlWfClosedNotice:' \+ lastClosed\.id/, 'keyed per session, so the NEXT one still gets explained');
});

test('the way back is one click, not an instruction to go find a button', () => {
  const fn = html.match(/function hlWfExplainClockOut\(lastClosed\)\{[\s\S]*?\n\}/)[0];
  assert.match(fn, /label: 'Clock back in', primary: true/);
  assert.match(fn, /workforceClockIn\(\)/);
});

test('a browser that refuses localStorage still gets told', () => {
  const fn = html.match(/function hlWfExplainClockOut\(lastClosed\)\{[\s\S]*?\n\}/)[0];
  assert.match(fn, /catch \(e\) \{ \/\* private mode: show it, do not swallow it \*\/ \}/,
    'failing to read the flag must not silently suppress the message');
});
