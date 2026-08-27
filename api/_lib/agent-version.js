// api/_lib/agent-version.js
//
// Which build of the desktop Monitor agent a given machine is actually running.
//
// WHY THIS EXISTS. The same blind spot page-build.js closed for browsers, still
// wide open for the desktop app. On 2026-08-17 the consent change (PR #364)
// shipped in two halves: the server enforces the clock-out the moment it
// deploys, while the agent's rewritten dialog -- the one that WARNS before you
// decline -- only arrives when a new build is published to
// csk5369/hivelogic-monitor and auto-updates. That build is made by hand.
//
// The version WAS recorded -- once, at pairing, and never again. That is worse
// than not recording it, because the column looks like a live report. Found by
// querying production while building this: Chris's agent read agent_version =
// '1.0.0' with a heartbeat 34 seconds old, on a device paired 2026-07-25 that
// has auto-updated repeatedly since. Anyone reading that column to answer "who
// is still on the old agent, still seeing the old dialog" would have been told
// a number several releases out of date, with nothing marking it as stale.
//
// Same shape as the two failures before it: a build marker that can silently go
// stale reports "current" while lying, and a monitor agent whose status said
// 'active' when it meant "was paired once". Publishing a release and hoping was
// the whole verification story.
//
// The agent already heartbeats every 60 seconds and the server already PATCHes
// last_seen_at on every one of them, so the live version rides along for free --
// every running agent corrects its own frozen row within a minute of the deploy
// -- and staleness becomes:
//
//   select p.email, a.agent_version, a.last_seen_at
//     from monitor_agents a join profiles p on p.id = a.employee_id
//    where a.status = 'active' and a.agent_version is distinct from '<current>';
//
// THE EXPECTED VERSION is mirrored from hivelogic-monitor-agent/package.json,
// which is what electron-builder stamps into the release and what
// electron-updater compares against. test/agent-version-reporting.test.mjs
// fails CI if the two drift, for the same reason the page build marker is
// enforced: a version constant that can silently go stale would report
// "everyone is current" while lying, which is worse than not checking at all.

// Mirrors "version" in hivelogic-monitor-agent/package.json. Bump both together
// -- the test will not let you do otherwise.
export const EXPECTED_AGENT_VERSION = '1.3.3';

// A version we would actually have shipped. Anything else is a malformed or
// forged value and must not be recorded as if it were a real build.
export function isWellFormedAgentVersion(value) {
  return typeof value === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

// What an agent is running, relative to what it should be.
//
// 'unknown' is NOT 'stale'. An agent that reports nothing is running a build
// from before this mechanism existed, so we genuinely do not know which one --
// and saying "stale" would be the same unfounded claim this file exists to
// prevent. It is still visible in the health check, named as unknown, because
// silence is exactly what we are trying to stop treating as fine.
export function agentVersionState(reported) {
  if (!isWellFormedAgentVersion(reported)) return 'unknown';
  return reported === EXPECTED_AGENT_VERSION ? 'current' : 'stale';
}
