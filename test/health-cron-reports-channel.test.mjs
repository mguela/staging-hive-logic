import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Chris (2026-08-23): "Daily health check seems to be landing in Admin hub and
// not Reina's Reports."
//
// Confirmed against the HiveConnect DB (project mzyngawgpxzpsxphswmc): all 26
// "Daily Health Check" messages sat in #admin-hub (6b9d6d08-...), and the
// #Reina's Reports channel (35be9f8f-...) had existed since 2026-08-06 with the
// Reina bot already a member.
//
// Root cause was an inverted `||`. The code read:
//
//   const channelId = process.env.REINA_BOT_DEFAULT_CHANNEL_ID || REINA_REPORTS_CHANNEL_ID;
//
// REINA_BOT_DEFAULT_CHANNEL_ID is the SHARED Reina-bot catch-all (#admin-hub)
// used by voice-webhook.js, reina/scan-change-requests.js and track1.js, and it
// is always set in prod -- so it always won and the hardcoded Reina's Reports id
// was unreachable dead code. The comment directly above it said the opposite
// ("hardcoded, with an optional env override"), which is how it survived review.
//
// These tests pin the precedence itself, not just the spelling: the expression
// is lifted out of the source and evaluated under both env states.
const src = readFileSync(new URL('../api/health-cron.js', import.meta.url), 'utf8');

const REPORTS_CHANNEL_ID = '35be9f8f-f83d-4ba2-9748-4ac05ce859a3';

// Pull the two real lines out of the handler and run them for real.
function resolveChannelIdWith(env) {
  const constLine = src.match(/^\s*const REINA_REPORTS_CHANNEL_ID = .*$/m);
  const pickLine = src.match(/^\s*const channelId = .*$/m);
  assert.ok(constLine, 'expected a REINA_REPORTS_CHANNEL_ID constant in api/health-cron.js');
  assert.ok(pickLine, 'expected a `const channelId = ...` line in api/health-cron.js');
  const body = `${constLine[0]}\n${pickLine[0]}\nreturn channelId;`;
  return new Function('process', body)({ env });
}

test('with no env override, the report goes to #Reina\'s Reports', () => {
  assert.equal(resolveChannelIdWith({}), REPORTS_CHANNEL_ID);
});

test('the shared Reina-bot catch-all channel can no longer hijack the report', () => {
  // This is the exact prod condition that caused the bug: the shared default is
  // set to #admin-hub. The daily report must ignore it.
  const adminHub = '6b9d6d08-7c9b-4156-854f-0aa1d832a569';
  const got = resolveChannelIdWith({ REINA_BOT_DEFAULT_CHANNEL_ID: adminHub });
  assert.notEqual(got, adminHub, 'daily health check must not post to the shared #admin-hub catch-all');
  assert.equal(got, REPORTS_CHANNEL_ID);
});

test('a dedicated REINA_REPORTS_CHANNEL_ID env var still overrides the hardcoded id', () => {
  const other = '00000000-1111-2222-3333-444444444444';
  assert.equal(resolveChannelIdWith({ REINA_REPORTS_CHANNEL_ID: other }), other);
});

test('health-cron.js does not read the shared Reina-bot default channel at all', () => {
  // Other Reina features legitimately use REINA_BOT_DEFAULT_CHANNEL_ID; the
  // daily report must not, or the inversion can quietly come back.
  assert.doesNotMatch(src, /process\.env\.REINA_BOT_DEFAULT_CHANNEL_ID/);
});
