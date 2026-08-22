// test/monitor-consent-required.test.mjs
//
// A consent prompt that records you anyway.
//
// The desktop agent asked, at every clock-in: "HiveLogic Monitor will record
// activity level and periodic screenshots while you're clocked in... Allow
// monitoring for this clock-in?" with an [Allow] / [Not this time] pair.
//
// "Not this time" stopped the screenshots and nothing else. handleMonitorHeartbeat
// wrote the activity sample -- activity level, idle seconds, and the name of the
// application in front -- BEFORE it ever looked at consent, so declining bought
// nothing. Chris's own 2026-08-17 06:33 session was declined and still logged
// 176 samples across three hours. The admin off-switch had the same hole:
// monitoring_enabled = false suppressed capture but not sampling, so "monitoring
// is off for this person" was equally untrue.
//
// Chris, 2026-08-17: "only when an employee is clocked in should it monitor. if
// an employee is clocked in they must approve monitoring or it can't clock in.
// this also needs to be set in permissions as you setup the user for the
// software."
//
// So: nothing records without an explicit yes, and for anyone whose account
// requires it, declining ends the clock-in. Both permissions are per-user and
// set when the account is created.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const { monitoringPolicy, monitoringDecision, CLOSE_REASON_DECLINED } =
  await import('../api/_lib/monitor-consent.js');
const trackMod = await import('../api/track1.js');

// --- The policy itself -----------------------------------------------------

test('declining records nothing at all -- not just no screenshots', () => {
  const d = monitoringDecision({ monitoring_enabled: true }, 'denied');
  assert.equal(d.recordActivity, false, 'this is the whole bug: activity kept recording through a decline');
  assert.equal(d.captureScreenshots, false);
});

test('a pending answer records nothing either', () => {
  // The dialog is still on screen. Treating silence as agreement is the same
  // broken promise in a smaller window.
  const d = monitoringDecision({ monitoring_enabled: true, monitoring_required: true }, 'pending');
  assert.equal(d.recordActivity, false);
  assert.equal(d.captureScreenshots, false);
  assert.equal(d.clockOut, false, 'nobody is clocked out for not having answered yet');
  assert.equal(d.prompt, true);
});

test('the admin off-switch really means off, sampling included', () => {
  for (const consent of ['pending', 'allowed', 'denied']) {
    const d = monitoringDecision({ monitoring_enabled: false, monitoring_required: true }, consent);
    assert.equal(d.recordActivity, false, `monitoring_enabled=false must not sample (consent=${consent})`);
    assert.equal(d.captureScreenshots, false);
    assert.equal(d.clockOut, false, 'someone we are not monitoring can never be clocked out over it');
    assert.equal(d.prompt, false, 'and must not be nagged for permission we will not use');
  }
});

test('an explicit yes is what turns recording on', () => {
  const d = monitoringDecision({ monitoring_enabled: true, monitoring_required: true }, 'allowed');
  assert.equal(d.recordActivity, true);
  assert.equal(d.captureScreenshots, true);
  assert.equal(d.clockOut, false);
});

test('declining ends the clock-in for anyone who is monitored', () => {
  assert.equal(monitoringDecision({ monitoring_enabled: true }, 'denied').clockOut, true);
  // The old exemption -- monitored, but declining is respected -- is gone, and
  // a leftover column must not resurrect it. That state produced no activity
  // samples, which left the idle timeout with no machine-wide witness, which
  // clocked Chris out three times on 2026-08-18 while he was working.
  assert.equal(monitoringDecision({ monitoring_enabled: true, monitoring_required: false }, 'denied').clockOut, true,
    'monitored means agreeing is a condition of being on the clock -- there is no middle state any more');
});

test('the exempt case is "not monitored", and it is a real supported state', () => {
  const d = monitoringDecision({ monitoring_enabled: false }, 'denied');
  assert.equal(d.enabled, false);
  assert.equal(d.required, false);
  assert.equal(d.prompt, false, 'no prompt for permission we will never use');
  assert.equal(d.clockOut, false, 'and never clocked out over a decision we did not ask them to make');
});

test('the permission defaults to the policy when the column is missing', () => {
  // A profile row read before the migration, or the fallback object
  // getRequestingProfile returns when the lookup fails. Defaulting to
  // unmonitored would silently opt people out of a policy Chris set.
  for (const profile of [undefined, null, {}, { monitoring_enabled: true }]) {
    const p = monitoringPolicy(profile);
    assert.equal(p.enabled, true);
    assert.equal(p.required, true);
  }
});

test('required is never true while monitoring is off', () => {
  const p = monitoringPolicy({ monitoring_enabled: false, monitoring_required: true });
  assert.equal(p.enabled, false);
  assert.equal(p.required, false, 'requiring consent to something that never happens is meaningless');
});

test('required tracks enabled exactly, and the dead column cannot move it', () => {
  // A value that can only ever equal `enabled` is a value that can drift from
  // it, which is why it stopped being stored. If monitoring_required is ever
  // read again, this fails.
  for (const stale of [true, false, undefined, null]) {
    const p = monitoringPolicy({ monitoring_enabled: true, monitoring_required: stale });
    assert.equal(p.required, true, `monitoring_required=${stale} must not change the answer`);
  }
});

// --- The heartbeat, end to end ---------------------------------------------

function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}
function res() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

const AGENT = { id: 'agent-1', employee_id: 'emp-1', status: 'active' };
const WF = { id: 'wf-1', employee_id: 'emp-1', status: 'active' };

async function heartbeat({ consent, profile }) {
  const writes = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    if (method !== 'GET') writes.push({ url: u, method, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (u.includes('/rest/v1/monitor_agents')) return jsonRes([AGENT]);
    if (u.includes('/rest/v1/workforce_time_sessions')) return jsonRes(method === 'GET' ? [WF] : [WF]);
    if (u.includes('/rest/v1/monitor_sessions')) {
      return jsonRes([{ id: 'ms-1', workforce_session_id: WF.id, consent, ended_at: null }]);
    }
    if (u.includes('/rest/v1/profiles')) return jsonRes([profile]);
    if (u.includes('/rest/v1/monitor_activity_samples')) return jsonRes([{}], 201);
    if (u.includes('/rest/v1/workforce_settings')) return jsonRes([{ monitor_screenshot_interval_minutes: 5, monitor_blur_screenshots: true }]);
    return jsonRes({});
  };
  try {
    const r = res();
    await trackMod.default(
      { method: 'POST', query: { resource: 'monitor_heartbeat' }, headers: { authorization: 'Bearer agenttoken' },
        body: { activityLevel: 100, idleSeconds: 0, activeApp: 'Microsoft Outlook', displayCount: 2 } },
      r
    );
    return { r, writes };
  } finally { global.fetch = original; }
}

const sampled = (writes) => writes.filter((w) => w.url.includes('monitor_activity_samples')).length;
const clockedOut = (writes) => writes.find((w) => w.url.includes('workforce_time_sessions') && w.method === 'PATCH' && w.body && w.body.close_reason);

test('a declined heartbeat writes no activity sample', async () => {
  const { writes } = await heartbeat({ consent: 'denied', profile: { monitoring_enabled: true } });
  assert.equal(sampled(writes), 0, '176 of these were written through a decline on 2026-08-17');
});

test('an allowed heartbeat still records normally', async () => {
  const { r, writes } = await heartbeat({ consent: 'allowed', profile: { monitoring_enabled: true, monitoring_required: true } });
  assert.equal(sampled(writes), 1);
  assert.equal(r.body.shouldCapture, true);
  assert.equal(r.body.monitoringRequired, true, 'the agent needs this to say what declining costs BEFORE asking');
});

test('a pending heartbeat records nothing while the dialog is still up', async () => {
  const { r, writes } = await heartbeat({ consent: 'pending', profile: { monitoring_enabled: true, monitoring_required: true } });
  assert.equal(sampled(writes), 0);
  assert.equal(r.body.shouldCapture, false);
});

test('monitoring_enabled=false records nothing and clocks nobody out', async () => {
  const { r, writes } = await heartbeat({ consent: 'denied', profile: { monitoring_enabled: false, monitoring_required: true } });
  assert.equal(sampled(writes), 0);
  assert.equal(clockedOut(writes), undefined);
  assert.equal(r.body.clockedIn, true);
});

test('a required decline ends the clock-in, tagged as a decline', async () => {
  const { r, writes } = await heartbeat({ consent: 'denied', profile: { monitoring_enabled: true, monitoring_required: true } });
  const close = clockedOut(writes);
  assert.ok(close, 'the session must actually be closed, not merely reported closed');
  assert.equal(close.body.close_reason, CLOSE_REASON_DECLINED);
  assert.equal(close.body.status, 'completed');
  assert.ok(close.body.clock_out, 'clock_out must be stamped or the timesheet stays open forever');
  assert.equal(r.body.clockedIn, false);
  assert.equal(sampled(writes), 0);
});

test('the monitor session is closed too, so nothing is left looking live', async () => {
  const { writes } = await heartbeat({ consent: 'denied', profile: { monitoring_enabled: true, monitoring_required: true } });
  const ended = writes.find((w) => w.url.includes('monitor_sessions') && w.method === 'PATCH' && w.body && w.body.ended_at);
  assert.ok(ended, 'a monitor session left open would keep the Monitor tab claiming a live recording');
});

// --- Permissions are set where the account is set up -----------------------

test('the invite sets the permission with the account', () => {
  const src = fs.readFileSync('api/track1.js', 'utf8');
  assert.match(src, /monitoring_enabled: monitoringEnabled,/,
    'Chris: "this also needs to be set in permissions as you setup the user"');
  assert.match(src, /const monitoringEnabled = body\.monitoringEnabled !== false;/,
    'monitored by default -- opting someone out has to be a deliberate act');
});

test('nothing reads or writes the retired column any more', () => {
  // The COLUMN still exists, on purpose: dropping it mid-deploy would pull it
  // out from under the build that is still serving. But no code may touch it,
  // or the state it represents comes back.
  //
  // Scoped to the snake_case column name on purpose. The camelCase
  // monitoringRequired is a different thing -- a field in the heartbeat
  // response that the desktop agent reads to word its dialog -- and the test
  // below requires it to keep being sent.
  for (const f of ['api/track1.js', 'api/_lib/monitor-consent.js', 'public/index.html']) {
    const src = fs.readFileSync(f, 'utf8');
    const live = src.split('\n').filter((l) => l.includes('monitoring_required') && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    assert.deepEqual(live, [], `${f} still uses the retired column:\n${live.join('\n')}`);
  }
});

test('the agent is still told what declining costs', () => {
  // Derived from the one permission now, but it still has to reach the agent:
  // it is what turns the dialog button into "Decline and clock out" instead of
  // a cheerful "Not this time" that costs someone their shift without warning.
  const src = fs.readFileSync('api/track1.js', 'utf8');
  assert.match(src, /monitoringRequired: decision\.required,/);
});

test('the one permission is refused when absent, not silently defaulted', () => {
  const src = fs.readFileSync('api/track1.js', 'utf8');
  assert.match(src, /const patch = \{ monitoring_enabled: !!monitoringEnabled \};/);
  assert.match(src, /Nothing to change/, 'an empty request must be refused, not silently succeed');
});

test('the column is gone, and the migration says what it discarded', () => {
  // Dropped a day after it stopped being read -- not the same day, because a
  // deploy is not instantaneous and pulling a column out from under the build
  // still serving turns a cleanup into an outage.
  const sql = fs.readFileSync('supabase/migrations/20260819010000_drop_monitoring_required.sql', 'utf8');
  assert.match(sql, /drop column if exists monitoring_required/);
  assert.match(sql, /exactly ONE held a value other than the default/,
    'dropping data should say what it dropped, not wave past it');
  assert.match(sql, /Rollback:/, 'and how to undo the shape, plus what cannot be undone');
  assert.match(sql, /No policy, view,\s*\n-- index, constraint or trigger referenced the column; checked before running/,
    'the dependency check must be recorded as done, not claimed in passing');
});

test('the migration records why the second permission was retired', () => {
  const sql = fs.readFileSync('supabase/migrations/20260818190000_monitoring_one_permission.sql', 'utf8');
  assert.match(sql, /idle_timeout/, 'the failure it caused has to be written down, not remembered');
  assert.match(sql, /46 min/, 'including the number that identifies it: 30 warning + 15 grace');
  assert.match(sql, /not dropped here|NOT DROPPED HERE/i,
    'and why the column survives the change that retires it');
});

test('the migration defaults every existing account to required', () => {
  const sql = fs.readFileSync('supabase/migrations/20260817200000_profiles_monitoring_required.sql', 'utf8');
  assert.match(sql, /add column if not exists monitoring_required boolean not null default true/);
  assert.match(sql, /Owner/, 'the blast radius, including on Chris himself, must be written down not discovered');
});

// --- The dialog has to say what declining costs ----------------------------

test('the agent warns that declining will clock them out, before they answer', () => {
  const src = fs.readFileSync('hivelogic-monitor-agent/src/main.js', 'utf8');
  assert.match(src, /Monitoring is required for your account: if you decline, you'll be clocked out/,
    'offering the choice while hiding its price is how you get a decision nobody meant to make');
  assert.match(src, /'Decline and clock out'/, 'the button must not read "Not this time" when it ends the shift');
  assert.match(src, /nothing is recorded for this clock-in and you stay on the clock/,
    'and the exempted case must state the truth it now actually keeps');
});

test('being clocked out is said out loud, not just logged', () => {
  const src = fs.readFileSync('hivelogic-monitor-agent/src/main.js', 'utf8');
  assert.match(src, /message: "You've been clocked out\."/);
  assert.match(src, /lastStatus = 'Clocked out — monitoring declined'/, 'and the tray must agree with reality');
});
