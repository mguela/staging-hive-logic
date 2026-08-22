// test/agent-version-reporting.test.mjs
//
// "Publish a release and hope" was the entire verification story.
//
// The desktop Monitor agent updates on its own schedule, from a build made by
// hand and published to csk5369/hivelogic-monitor. So a server-side rule can be
// live while the agent-side half of the same change has reached nobody. That is
// not hypothetical: on 2026-08-17 the consent change (PR #364) started clocking
// people out for declining, while the dialog that WARNS you it will do that sat
// in an unreleased build.
//
// The version WAS in the database -- written once at pairing and never again,
// which is worse than absent because the column reads like a live report.
// Production proved it while this was being built: Chris's agent showed
// agent_version '1.0.0' with a 34-second-old heartbeat, on a device paired
// 2026-07-25 and auto-updated several times since.
//
// Same blind spot test/page-build-marker.test.mjs closed for browsers, closed
// the same way: the thing states what it is, on the call it already makes, and
// staleness becomes a query instead of a hope.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const { EXPECTED_AGENT_VERSION, isWellFormedAgentVersion, agentVersionState } =
  await import('../api/_lib/agent-version.js');
const trackMod = await import('../api/track1.js');

const agentPkg = JSON.parse(fs.readFileSync('hivelogic-monitor-agent/package.json', 'utf8'));

// --- The constant must match what actually ships ---------------------------

test('the expected version equals the agent package.json it mirrors', () => {
  // electron-builder stamps package.json's version into the release and
  // electron-updater compares against it, so this is THE number. A constant
  // that can drift would report "everyone is current" while lying, which is
  // worse than not checking.
  assert.equal(
    EXPECTED_AGENT_VERSION, agentPkg.version,
    'api/_lib/agent-version.js and hivelogic-monitor-agent/package.json disagree -- bump both together'
  );
});

test('the agent was bumped for the consent dialog release', () => {
  // 1.2.3 shipped the dialog that says "Not this time" and warns about nothing.
  // Leaving the version alone would mean no machine ever downloads the new one.
  assert.notEqual(agentPkg.version, '1.2.3', 'a release without a version bump updates nobody');
});

test('a malformed or forged version is not accepted as real', () => {
  assert.equal(isWellFormedAgentVersion('1.2.4'), true);
  assert.equal(isWellFormedAgentVersion('1.2.4-beta'), false);
  assert.equal(isWellFormedAgentVersion('latest'), false);
  assert.equal(isWellFormedAgentVersion(''), false);
  assert.equal(isWellFormedAgentVersion(124), false);
  assert.equal(isWellFormedAgentVersion(null), false);
});

test('an agent that reports nothing is "unknown", never "stale"', () => {
  // It predates version reporting, so we genuinely do not know what it is.
  // Calling it stale would be the same unfounded claim this exists to prevent.
  for (const v of [null, undefined, '', 'nonsense']) {
    assert.equal(agentVersionState(v), 'unknown');
  }
  assert.equal(agentVersionState(EXPECTED_AGENT_VERSION), 'current');
  assert.equal(agentVersionState('1.0.0'), 'stale');
});

// --- The agent sends it, on the call it already makes -----------------------

test('the heartbeat carries the version', () => {
  const src = fs.readFileSync('hivelogic-monitor-agent/src/main.js', 'utf8');
  assert.match(src, /agentVersion: app\.getVersion\(\)/,
    'read from the app itself, not a second constant that could disagree with package.json');
  assert.match(src, /body: JSON\.stringify\(\{ activityLevel, idleSeconds, displayCount, activeApp, agentVersion/,
    'it must ride the existing heartbeat -- no new call, no new schedule');
});

// --- The server records it, on the write it already makes -------------------

function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}
function res() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

async function heartbeat({ agentVersion, stored = null }) {
  const patches = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    if (u.includes('/rest/v1/monitor_agents')) {
      if (method === 'PATCH') { patches.push(JSON.parse(opts.body)); return jsonRes([{}]); }
      return jsonRes([{ id: 'agent-1', employee_id: 'emp-1', status: 'active', agent_version: stored }]);
    }
    if (u.includes('/rest/v1/workforce_time_sessions')) return jsonRes([]);
    return jsonRes({});
  };
  try {
    const r = res();
    await trackMod.default(
      { method: 'POST', query: { resource: 'monitor_heartbeat' }, headers: { authorization: 'Bearer agenttoken' },
        body: { activityLevel: 100, idleSeconds: 0, activeApp: 'Outlook', displayCount: 2, agentVersion } },
      r
    );
    return patches;
  } finally { global.fetch = original; }
}

test('a reported version is stored on the heartbeat PATCH that already runs', async () => {
  const patches = await heartbeat({ agentVersion: '1.2.4' });
  assert.equal(patches.length, 1, 'no extra write -- it rides the last_seen_at update');
  assert.equal(patches[0].agent_version, '1.2.4');
  assert.ok(patches[0].last_seen_at, 'and must not have replaced what that PATCH was for');
});

test('an unchanged version is not rewritten every 60 seconds', async () => {
  const patches = await heartbeat({ agentVersion: '1.2.4', stored: '1.2.4' });
  assert.equal(patches[0].agent_version, undefined, 'a value that changes twice a year need not be written every minute');
  assert.ok(patches[0].last_seen_at, 'the heartbeat itself must still record');
});

test('an update is recorded the moment it lands', async () => {
  const patches = await heartbeat({ agentVersion: '1.2.4', stored: '1.2.3' });
  assert.equal(patches[0].agent_version, '1.2.4', 'this is the whole point -- seeing the rollout happen');
});

test('a forged version never overwrites a real observation', async () => {
  const patches = await heartbeat({ agentVersion: '../../etc/passwd', stored: '1.2.4' });
  assert.equal(patches[0].agent_version, undefined);
});

test('an old agent that sends nothing still heartbeats normally', async () => {
  const patches = await heartbeat({ agentVersion: undefined });
  assert.equal(patches[0].agent_version, undefined, 'leaving it NULL, which reads as unknown');
  assert.ok(patches[0].last_seen_at, 'and must not be broken by the new field');
});

// --- Surfaced where someone will see it ------------------------------------

test('the migration records what the column now means, and what it used to', () => {
  const sql = fs.readFileSync('supabase/migrations/20260817220000_monitor_agents_agent_version.sql', 'utf8');
  assert.match(sql, /add column if not exists agent_version text/, 'idempotent -- the column already existed');
  assert.match(sql, /LAST HEARTBEAT/, 'the comment must say it is live, not a pairing-time fossil');
  assert.match(sql, /1\.0\.0/, 'the evidence that it had gone stale belongs in the record');
  assert.match(sql, /unknown rather than stale/, 'the distinction must be written down, not just implemented');
});

test('nothing hand-fixes the stale values -- the agents correct themselves', () => {
  const sql = fs.readFileSync('supabase/migrations/20260817220000_monitor_agents_agent_version.sql', 'utf8');
  assert.doesNotMatch(sql, /^\s*update public\.monitor_agents/mi,
    'overwriting them by hand would be guessing; a running agent reports the truth within 60s');
});

test('health-cron names agents on an old build, and unknown ones separately', () => {
  const src = fs.readFileSync('api/health-cron.js', 'utf8');
  assert.match(src, /Monitor agents on the current build/);
  assert.match(src, /last_seen_at=gte\.\$\{since\}/, 'a stale version last seen in July is a disused machine, not a failed update');
  assert.match(src, /not reporting a version at all/, 'unknown must not be silently folded in with stale');
  assert.match(src, /could not check which agent build machines are running/, 'and it must not be silent when it cannot answer');
});

test('the admin roster shows the version alongside the device', () => {
  const src = fs.readFileSync('api/track1.js', 'utf8');
  assert.match(src, /agentVersion: a\.agent_version \|\| null,/);
  assert.match(src, /agentVersionState: agentVersionState\(a\.agent_version\),/);
  assert.match(src, /select=id,employee_id,device_name,platform,status,last_seen_at,agent_version/);
});

// --- And it has to be READABLE, not just recorded --------------------------
//
// Sending a field the UI drops on the floor is the same half-shipped shape one
// layer up: the API had carried agentVersion and agentVersionState on the
// monitor roster since the reporting landed, and the roster row rendered only
// "platform · last seen", so the sole way to answer "who is still on the old
// build" was a database query -- and when database access was unavailable, the
// answer was nobody's to have. Recorded but unreadable is not shipped.

// Reads the monitor roster renderer out of the page. Anchored on the two
// function names that bracket it -- and it THROWS on a miss, because
// String.indexOf returns -1 and slice(-1) hands back a near-empty string that
// every assertion below would fail against for the wrong reason.
function rosterRenderer() {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const start = html.indexOf('window.mgrMonRefresh');
  const end = html.indexOf('window.mgrMonOpenEmployee');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('cannot locate the monitor roster renderer in public/index.html -- did it get renamed?');
  }
  return html.slice(start, end);
}

test('the roster row shows which build each machine is running', () => {
  const row = rosterRenderer();
  assert.match(row, /p\.agentVersionState/, 'the roster must render the state the API sends');
  assert.match(row, /p\.agentVersion/, 'and the version itself, not just a colour');
});

test('the roster names an unreported version unknown, never stale', () => {
  assert.match(rosterRenderer(), /version unknown/,
    'an agent from before the reporting existed tells us nothing -- calling that stale is the unfounded claim this file exists to prevent');
  assert.equal(agentVersionState(undefined), 'unknown');
});

test('the "update pending" badge is measured against a version the server sent', () => {
  // If the page hardcoded the current version, the badge and the release could
  // drift and the roster would say "update pending" against a number nobody
  // remembers -- the same lie in a nicer colour.
  const api = fs.readFileSync('api/track1.js', 'utf8');
  assert.match(api, /expectedAgentVersion: EXPECTED_AGENT_VERSION/,
    'the monitor roster response must carry the expected version');
  assert.match(rosterRenderer(), /data\.expectedAgentVersion/, 'and the page must use it rather than a literal');
});

// --- The update check has to say what it did ------------------------------

test('every auto-update outcome leaves a line in the log', () => {
  // The error handler was `() => {}` with the comment "offline or no release
  // yet - stay quiet", and that one line is why "did the update land?" had no
  // answer on the machine itself. A failed check -- bad feed, no network, a
  // release with no latest.yml -- left an agent sitting on an old build
  // indefinitely, looking exactly like one that was up to date. On 2026-08-18,
  // ninety minutes after 1.2.4 was published and verified reachable, Chris's
  // agent was heartbeating live, reporting no version, with nothing on disk to
  // say whether it had even tried.
  const main = fs.readFileSync('hivelogic-monitor-agent/src/main.js', 'utf8');
  const setup = main.slice(main.indexOf('function setupMonitorAutoUpdate'));
  assert.ok(setup.length > 0, 'the auto-update setup must still exist');

  assert.doesNotMatch(setup, /on\('error',\s*\(\)\s*=>\s*\{\s*\/\*[^}]*\*\/\s*\}\)/,
    'the error handler must not swallow the failure silently');
  for (const event of ['error', 'checking-for-update', 'update-not-available', 'update-available']) {
    const handler = setup.slice(setup.indexOf(`on('${event}'`));
    assert.ok(setup.includes(`on('${event}'`), `${event} must be handled`);
    assert.match(handler.slice(0, 400), /logLine\(/,
      `${event} must write a line to monitor.log -- silence is what we stopped treating as fine`);
  }
});

// --- The write between them must not be able to fail in silence ------------

test('a failed heartbeat row update is reported, not swallowed', () => {
  // On 2026-08-18 Chris's agent was on 1.2.5, sending app.getVersion() every
  // sixty seconds, and the roster still said "version unknown" for an hour.
  // The agent was right and the server was right; the one step between them --
  // a bare `await supabaseRequest(... PATCH ...)` whose result nothing read --
  // could fail and still answer ok:true. A write whose failure is invisible is
  // the shape of every bug in this area so far.
  const api = fs.readFileSync('api/track1.js', 'utf8');
  const handler = api.slice(api.indexOf('async function handleMonitorHeartbeat'));
  assert.ok(handler.length > 0, 'the heartbeat handler must still exist');
  assert.doesNotMatch(handler.slice(0, 3000), /^\s*await supabaseRequest\(`monitor_agents\?id=eq/m,
    'the monitor_agents PATCH result must be captured, not discarded');
  assert.match(handler.slice(0, 3000), /const patchRes = await supabaseRequest\(`monitor_agents\?id=eq/);
  assert.match(handler.slice(0, 3000), /heartbeatWriteError/);
});

test('every heartbeat response carries the write result', () => {
  // ok:true with a row that did not move is precisely the lie this closes, so
  // the field has to ride EVERY exit from the handler, not just the happy one.
  const api = fs.readFileSync('api/track1.js', 'utf8');
  const start = api.indexOf('async function handleMonitorHeartbeat');
  const handler = api.slice(start, api.indexOf('\nasync function ', start + 10));
  const okReturns = [...handler.matchAll(/return res\.status\(200\)\.json\(\{[\s\S]*?\}\);/g)].map((m) => m[0]);
  assert.ok(okReturns.length >= 3, `expected several 200 exits, found ${okReturns.length}`);
  for (const r of okReturns) {
    assert.match(r, /heartbeatWriteError/, `a 200 response omits heartbeatWriteError:\n${r}`);
  }
});

test('the agent logs a heartbeat the server could not record', () => {
  const main = fs.readFileSync('hivelogic-monitor-agent/src/main.js', 'utf8');
  assert.match(main, /data\.heartbeatWriteError.*logLine\(/s);
});

test('the tray says which build is actually running', () => {
  // "Which version is on this machine" was answerable only from the database,
  // and when the database said unknown there was nowhere else to look. The
  // machine itself should be able to answer it.
  const main = fs.readFileSync('hivelogic-monitor-agent/src/main.js', 'utf8');
  const tray = main.slice(main.indexOf('function refreshTrayMenu'), main.indexOf('function notifyMonitoringStarting'));
  assert.ok(tray.length > 0, 'the tray menu builder must still exist');
  assert.match(tray, /HiveLogic Monitor v\$\{app\.getVersion\(\)\}/,
    'the tray menu must name the running version');
  assert.match(tray, /setToolTip\(`HiveLogic Monitor v\$\{app\.getVersion\(\)\}/,
    'and so must the tooltip, which is what you see without clicking');
});

test('the heartbeat echoes the version the server actually received', () => {
  // Every link checked out on paper while the column stayed NULL for hours:
  // agent confirmed on 1.2.5, sending app.getVersion() every sixty seconds,
  // server code demonstrably correct. That is the point at which reasoning
  // stops paying and the wire has to say what it carried. null distinguishes
  // "arrived without it" from "the write did not land".
  const api = fs.readFileSync('api/track1.js', 'utf8');
  const start = api.indexOf('async function handleMonitorHeartbeat');
  const handler = api.slice(start, api.indexOf('\nasync function ', start + 10));
  assert.match(handler, /const agentVersionSeen = typeof reportedVersion === 'string' \? reportedVersion : null;/);
  for (const r of [...handler.matchAll(/return res\.status\(200\)\.json\(\{[\s\S]*?\}\);/g)].map((m) => m[0])) {
    assert.match(r, /agentVersionSeen/, `a 200 response omits agentVersionSeen:\n${r}`);
  }
});

test('the agent logs a sent-vs-seen disagreement, and only that', () => {
  const main = fs.readFileSync('hivelogic-monitor-agent/src/main.js', 'utf8');
  assert.match(main, /data\.agentVersionSeen !== app\.getVersion\(\)/,
    'it must compare, so a matching pair stays silent instead of logging once a minute');
  assert.match(main, /Version mismatch: this agent sent/);
});

// --- The installer has to be able to run with nobody watching ---------------

test('the Windows installer is one-click, so an update can apply unattended', () => {
  // THE BUG THIS CLOSES. The agent downloaded updates correctly and never
  // applied them. With oneClick:false electron-builder produces the ASSISTED
  // installer -- a wizard that, when it finds the app running, stops on
  // "HiveLogic Monitor cannot be closed. Please close it manually and click
  // Retry to continue." An auto-update runs with nobody at the screen, so that
  // modal is never answered and the machine stays on the old build forever,
  // looking exactly like one that is up to date. Chris saw that dialog on
  // 2026-08-18 doing the install by hand, which is how we finally caught it:
  // 1.2.4 and 1.2.5 both had to be installed manually.
  //
  // The one-click installer closes the running app itself and applies silently,
  // which is what electron-updater's quitAndInstall and autoInstallOnAppQuit
  // both assume.
  const pkg = JSON.parse(fs.readFileSync('hivelogic-monitor-agent/package.json', 'utf8'));
  const nsis = pkg.build && pkg.build.nsis;
  assert.ok(nsis, 'the nsis block must exist');
  assert.equal(nsis.oneClick, true,
    'an assisted installer stops on a modal that an unattended update can never answer');
  // Mutually exclusive with oneClick -- electron-builder rejects the pair, so a
  // leftover copy of this key would fail the BUILD rather than the update, at
  // the far end of an eight-minute Windows job.
  assert.ok(!('allowToChangeInstallationDirectory' in nsis),
    'allowToChangeInstallationDirectory cannot be set alongside oneClick');
  // Per-user, so applying an update never needs an elevation prompt either --
  // the same "nobody is there to click it" problem wearing a different hat.
  assert.equal(nsis.perMachine, false,
    'a per-machine install would raise UAC on every silent update');
});
