// test/workforce-idle-while-working.test.mjs
//
// Being clocked out for "idle" while you are demonstrably working.
//
// Found 2026-08-16 by checking production rather than asserting a fix was
// good. Chris clocked in at 11:02:13 and the app auto-clocked him out at
// 11:19:03 with close_reason 'idle_timeout' -- seventeen minutes into a
// 45-minute allowance (30 warning + 15 grace). The monitor agent had been
// sampling him the entire time, and the sample one minute before the
// clock-out reads activity_level 100, idle_seconds 0, active_app 'Claude'.
// He was working. Two independent defects put him there:
//
// DEFECT 1 -- the idle clock never reset. hlWfLastActivity is set at page
// load and by input events, and the every-30s check reset hlWfIdleWarningShown
// while clocked out but never hlWfLastActivity itself. So the counter kept
// running through the clocked-out gap and the next clock-in inherited whatever
// had accumulated. The arithmetic matches to the second: last in-tab input
// ~10:34, +30 warning = 11:04, +15 grace = 11:19:03. He was clocked out on
// time he had never been given.
//
// DEFECT 2 -- "idle" meant "not touching this browser tab". Chris spent that
// session in Outlook, a terminal and other apps; every one of those is
// invisible to a document-level event listener. The desktop agent measures
// real machine-wide input and knew he was active, and nothing consulted it.
// Fixing defect 1 alone would only have moved the wrongful clock-out to
// 11:47.
//
// The fix: hold the clock at now() while clocked out, merge the agent's
// reading with the tab's (whichever saw them more recently wins), and
// re-check at the moment the grace timer fires instead of trusting a flag
// set a quarter of an hour earlier.
//
// The client half is exercised for real -- hlWfIdleSinceMs is extracted from
// public/index.html and run -- rather than string-matched, because the bug
// was in behaviour, not in wording.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

// --- The merged idle signal, actually executed -----------------------------

// Pull the real source out of the page and run it against a fake window, so
// these assertions test the shipped logic instead of a paraphrase of it.
function loadIdleFn({ lastActivity, deskIdle }) {
  const constSrc = html.match(/var HL_DESK_IDLE_TRUST_MS = [^;]+;/);
  assert.ok(constSrc, 'HL_DESK_IDLE_TRUST_MS must exist -- a desk reading is only trusted while fresh');
  const fnSrc = html.match(/function hlWfIdleSinceMs\(\)\{[\s\S]*?\n\}/);
  assert.ok(fnSrc, 'hlWfIdleSinceMs() must exist as the single place idleness is decided');
  const factory = new Function('window', 'hlWfLastActivity', `
    ${constSrc[0]}
    ${fnSrc[0]}
    return hlWfIdleSinceMs;
  `);
  return factory({ __hlDeskIdle: deskIdle }, lastActivity);
}

const MIN = 60 * 1000;

test('someone working in another app is not idle, however long the tab sat untouched', () => {
  const now = Date.now();
  // The exact shape of Chris's 11:18 sample: agent reported 0 idle seconds,
  // heard 10 seconds ago. The tab has not been touched in 45 minutes.
  const idle = loadIdleFn({
    lastActivity: now - 45 * MIN,
    deskIdle: { seconds: 0, at: now - 10 * 1000 },
  })();
  assert.ok(idle < MIN, `working at your desk must read as active, got ${Math.round(idle / MIN)} minutes idle`);
});

test('the agent reporting real idle time does not mask a genuine absence', () => {
  const now = Date.now();
  // Agent is alive and reporting, but reporting that nobody has touched the
  // machine for 40 minutes. That must count as idle -- the point is honesty
  // in both directions, not keeping everyone clocked in forever.
  const idle = loadIdleFn({
    lastActivity: now - 40 * MIN,
    deskIdle: { seconds: 40 * 60, at: now - 20 * 1000 },
  })();
  assert.ok(idle >= 39 * MIN, `a real absence must still register, got ${Math.round(idle / MIN)} minutes`);
});

test('idle_seconds is measured back from when the sample was taken, not from when we heard it', () => {
  const now = Date.now();
  // Heard 3 minutes ago that they had then been idle 2 minutes: last real
  // input was 5 minutes ago. Reading the reading time alone would call this
  // 3 minutes and quietly credit two minutes of absence as presence.
  const idle = loadIdleFn({
    lastActivity: now - 60 * MIN,
    deskIdle: { seconds: 2 * 60, at: now - 3 * MIN },
  })();
  assert.ok(idle >= 4.5 * MIN && idle <= 5.5 * MIN, `expected ~5 minutes, got ${(idle / MIN).toFixed(1)}`);
});

test('a stale desk reading is discarded rather than trusted forever', () => {
  const now = Date.now();
  // The agent said "fully active" but that was half an hour ago and nothing
  // has confirmed it since -- the app was quit, the laptop slept. An
  // unconfirmed reading must not hold someone clocked in indefinitely.
  const idle = loadIdleFn({
    lastActivity: now - 50 * MIN,
    deskIdle: { seconds: 0, at: now - 30 * MIN },
  })();
  assert.ok(idle >= 49 * MIN, 'a stale agent reading must fall back to the tab timer');
});

test('with no agent at all the tab timer still governs, unchanged', () => {
  const now = Date.now();
  const idle = loadIdleFn({ lastActivity: now - 33 * MIN, deskIdle: null })();
  assert.ok(idle >= 32 * MIN && idle <= 34 * MIN, 'no agent paired must degrade to the old behaviour, not to "never idle"');
});

// --- The clock that never reset --------------------------------------------

test('the idle clock is held at now() for the whole time someone is clocked out', () => {
  const branch = html.match(/if \(!window\.hlWorkforceIsClockedIn \|\| !window\.hlWorkforceIsClockedIn\(\)\) \{[\s\S]*?\n    \}/);
  assert.ok(branch, 'the clocked-out branch of the idle interval must still exist');
  assert.match(branch[0], /hlWfLastActivity = Date\.now\(\);/,
    'this is the whole of defect 1: without it the counter runs across the gap and the next clock-in inherits it');
  assert.match(branch[0], /clearTimeout\(hlWfIdleGraceTimer\)/,
    'a grace timer armed by the previous clock-in must not survive into the next one');
});

test('the grace timer re-checks at the moment it fires instead of trusting a stale flag', () => {
  const timer = html.match(/hlWfIdleGraceTimer = setTimeout\(function\(\)\{[\s\S]*?\}, graceMin \* 60 \* 1000\);/);
  assert.ok(timer, 'the grace timeout must still exist');
  assert.match(timer[0], /hlWfIdleSinceMs\(\) < warningMs/,
    'coming back during the grace window must cancel the clock-out, not merely close the dialog');
});

test('coming back during the grace window stands the warning down', () => {
  assert.match(
    html,
    /if \(idleMs < warningMs && hlWfIdleWarningShown\) \{/,
    'the periodic check must be able to un-arm a warning, otherwise only the modal button can'
  );
});

// --- The server half -------------------------------------------------------

const trackMod = await import('../api/track1.js');

function res() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

async function myStatus({ session, sample }) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1', email: 'chris@ghgrp.net' });
    if (u.includes('/rest/v1/profiles')) return jsonRes([{ id: 'user-1', email: 'chris@ghgrp.net', role: 'admin', monitoring_enabled: true }]);
    if (u.includes('/rest/v1/monitor_sessions')) return jsonRes(session ? [session] : []);
    if (u.includes('/rest/v1/monitor_activity_samples')) return jsonRes(sample ? [sample] : []);
    return jsonRes({});
  };
  try {
    const r = res();
    await trackMod.default(
      { method: 'GET', query: { resource: 'monitor_my_status' }, headers: { authorization: 'Bearer usertoken' } },
      r
    );
    return r;
  } finally { global.fetch = original; }
}

test('monitor_my_status reports how long since the person actually touched their machine', async () => {
  const sampledAt = new Date(Date.now() - 60 * 1000).toISOString(); // sampled a minute ago
  const r = await myStatus({
    session: { id: 'ms-1', consent: 'allowed', ended_at: null },
    sample: { sampled_at: sampledAt, idle_seconds: 0 },
  });
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.deskIdleSeconds >= 55 && r.body.deskIdleSeconds <= 70,
    `expected ~60s, got ${r.body.deskIdleSeconds}`);
});

test('the reported idle time counts back from the sample, not from the sample time', async () => {
  const sampledAt = new Date(Date.now() - 60 * 1000).toISOString();
  const r = await myStatus({
    session: { id: 'ms-1', consent: 'allowed', ended_at: null },
    sample: { sampled_at: sampledAt, idle_seconds: 120 }, // idle 2 min as of a minute ago
  });
  assert.ok(r.body.deskIdleSeconds >= 175 && r.body.deskIdleSeconds <= 190,
    `last input was ~3 minutes ago, got ${r.body.deskIdleSeconds}`);
});

test('it reports null rather than guessing when there is nothing to go on', async () => {
  const noSample = await myStatus({ session: { id: 'ms-1', consent: 'allowed', ended_at: null }, sample: null });
  assert.equal(noSample.body.deskIdleSeconds, null, 'no samples means no answer, not "active"');
  const noSession = await myStatus({ session: null, sample: null });
  assert.equal(noSession.body.deskIdleSeconds, null, 'clocked out means no answer either');
  assert.equal(noSession.body.clockedIn, false);
});

test('activity is reported even when screenshot consent was declined', async () => {
  // Samples are recorded before the consent branch, deliberately: declining
  // screenshots must not cost you the evidence that you were working. Chris's
  // 11:03 session had consent 'denied' and still sampled him at 100% -- that
  // is exactly the session he was wrongly clocked out of.
  const r = await myStatus({
    session: { id: 'ms-1', consent: 'denied', ended_at: null },
    sample: { sampled_at: new Date(Date.now() - 30 * 1000).toISOString(), idle_seconds: 0 },
  });
  assert.equal(r.body.recording, false, 'declined consent must still mean no recording');
  assert.ok(r.body.deskIdleSeconds !== null && r.body.deskIdleSeconds < 60,
    'but their presence must still count against a wrongful idle clock-out');
});

// --- No second poller ------------------------------------------------------

test('the desk reading rides the poll that already exists', () => {
  assert.match(html, /window\.__hlDeskIdle = \{ seconds: data\.deskIdleSeconds, at: Date\.now\(\) \}/,
    'it must be captured inside hlMonitorFabPoll, which already runs every 30s');
  const pollers = html.match(/setInterval\(hlMonitorFabPoll/g) || [];
  assert.equal(pollers.length, 1, 'exactly one monitor poll, still');
});

// --- No witness, no clock-out ----------------------------------------------
//
// THE REGRESSION THIS CLOSES. The consent change removed the very evidence the
// idle fix depends on. Declining meant no activity samples; no samples meant
// the server could not compute deskIdleSeconds; and the browser then "silently
// fell back to witness 1" -- one browser tab -- and started ending shifts on
// it. Chris, 2026-08-18:
//
//   10:58:42 -> 11:44:28   46 min   0 activity samples   close_reason idle_timeout
//
// 46 minutes is the 30-minute warning plus the 15-minute grace, to the minute.
// He was working the whole time, in other applications.
//
// The fallback itself was not wrong -- degrading to the tab reading is fine for
// deciding whether to show a nudge. Ending someone's paid time on it is not.
// "We watched and saw nothing" and "we were not watching" are different
// findings, and only the first is grounds for clocking someone out.
//
// Now a supported configuration too: monitoring can be turned off per person,
// and for those people the idle timeout simply does not apply.
//
// These are source assertions. The timer is closure-scoped inside a 30-second
// interval in the page, so there is no seam to drive it through from a test --
// stated plainly rather than dressed up as behavioural coverage.

test('there is a named test for whether the machine is being watched at all', () => {
  assert.match(html, /function hlWfHasDeskWitness\(\)\{/,
    'the difference between "saw nothing" and "was not watching" needs a name');
  assert.match(html, /return !!\(desk && \(Date\.now\(\) - desk\.at\) <= HL_DESK_IDLE_TRUST_MS\);/,
    'and it must mean FRESH -- a reading nobody has confirmed in minutes is not a witness');
});

test('the idle poll gives up before it does any idle maths', () => {
  const poll = html.slice(html.indexOf('if (!hlWfSettings) return;'));
  const guard = poll.indexOf('if (!hlWfHasDeskWitness())');
  const maths = poll.indexOf('var idleMs = hlWfIdleSinceMs();');
  assert.ok(guard > -1, 'the poll must check for a witness');
  assert.ok(guard < maths, 'and it must check BEFORE computing an idle time it cannot act on');
});

test('an agent that goes quiet mid-grace cannot cash in its countdown', () => {
  // The warning may already be on screen with a 15-minute timer armed. If the
  // witness disappears in that window, the claim behind the countdown is gone
  // and the countdown goes with it.
  const poll = html.slice(html.indexOf('if (!hlWfHasDeskWitness())'));
  const standDown = poll.slice(0, 400);
  assert.match(standDown, /hlWfIdleWarningShown = false;/, 'the armed warning must stand down');
  assert.match(standDown, /clearTimeout\(hlWfIdleGraceTimer\); hlWfIdleGraceTimer = null;/,
    'and the grace timer must actually be cleared, not just flagged');
});

test('the grace timer re-checks the witness itself, not just the clock', () => {
  // It fires on its own timer, so the poll standing down is not enough if the
  // agent went quiet in the last thirty seconds of the grace.
  const cb = html.slice(html.indexOf('hlWfIdleGraceTimer = setTimeout(function(){'));
  const end = cb.indexOf('graceMin * 60 * 1000');
  const body = cb.slice(0, end);
  assert.match(body, /if \(!hlWfHasDeskWitness\(\)\) \{ hlWfIdleWarningShown = false; return; \}/,
    'the moment of truth must re-establish that we were watching');
  assert.ok(body.indexOf('hlWfHasDeskWitness') < body.indexOf('workforceAutoClockOut'),
    'and it must do so before clocking anyone out');
});
