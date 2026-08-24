// test/hivevideo-call-log.test.mjs
//
// Chris, 2026-08-23: "we need a call log and AI summary and a transcription."
//
// Two of the three already existed -- live captions feed generateAINotes(),
// which posts Reina's write-up into the channel. The LOG did not, and the
// reason is worth stating: there was no HiveVideo table of any kind. Who called
// whom, when, how long, whether anyone answered -- all of it lived in realtime
// presence, which is in-memory in the Supabase realtime server and gone the
// instant the socket closes. A call left no trace at all.
//
// hv_calls is that trace, and the transcript now lands ON the call row, so the
// log entry is the whole record rather than a pointer to a chat message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/hiveconnect/app.js', import.meta.url), 'utf8');
const sql = readFileSync(new URL('../sql/hiveconnect/20260823_hv_call_log.sql', import.meta.url), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > -1, `${signature} must exist`);
  let depth = 0, i = source.indexOf('{', start);
  do {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < source.length);
  return source.slice(start, i);
}

function fmtCtx() {
  const ctx = vm.createContext({ Date });
  vm.runInContext([
    extractFunction(app, 'function hvCallDuration(row)'),
    extractFunction(app, 'function hvCallWhen(row)'),
  ].join('\n'), ctx);
  return ctx;
}
const dur = (row) => vm.runInContext('hvCallDuration(' + JSON.stringify(row) + ')', fmtCtx());

// ---- the schema ----

test('the log is scoped to the HiveConnect project, not HiveLogic', () => {
  // Two separate Supabase projects; running this against the wrong one creates
  // a table referencing channels/profiles that do not exist there.
  assert.match(sql, /mzyngawgpxzpsxphswmc/);
});

test('membership is checked against the table that actually exists', () => {
  // `memberships` does not exist in this project -- it is `channel_members`.
  // A policy naming a missing table fails at apply time, not at review time.
  assert.doesNotMatch(sql, /from memberships\b/);
  assert.match(sql, /from channel_members m/);
});

test('the log follows channel membership, exactly like the messages in it', () => {
  for (const p of ['hv_calls_member_select', 'hv_calls_member_insert', 'hv_calls_member_update']) {
    assert.match(sql, new RegExp(p));
  }
  assert.match(sql, /alter table hv_calls enable row level security/);
});

test('you cannot log a call as somebody else', () => {
  const ins = sql.slice(sql.indexOf('hv_calls_member_insert'), sql.indexOf('hv_calls_member_update'));
  assert.match(ins, /started_by = auth\.uid\(\)/);
});

test('anyone in the channel can close the call out, not only whoever started it', () => {
  // The person who starts a call is often not the last one to leave.
  const upd = sql.slice(sql.indexOf('hv_calls_member_update'));
  assert.doesNotMatch(upd, /started_by = auth\.uid\(\)/);
});

test('two people joining at once cannot fork the log into two half-calls', () => {
  assert.match(sql, /create unique index[\s\S]*hv_calls_one_open_per_channel[\s\S]*where ended_at is null/);
});

// ---- joining an in-flight call ----

test('losing the insert race attaches to the winners row instead of giving up', () => {
  const fn = extractFunction(app, 'async function hvLogCallStart(cid)');
  assert.match(fn, /\.is\('ended_at', null\)/, 'it looks up the open call');
  assert.match(fn, /hvCallRowId = row\.id/);
  assert.match(fn, /parts\.some\(p => p && p\.user_id === me\.id\)/, 'and adds itself once, not twice');
});

test('a call is never blocked by the log failing to write', () => {
  const start = extractFunction(app, 'async function hvLogCallStart(cid)');
  const end = extractFunction(app, 'async function hvLogCallEnd(lastOut, transcript)');
  assert.match(start, /catch \(e\) \{ hvCallRowId = null; \}/);
  assert.match(end, /catch \(e\) \{\}/);
});

// ---- what the log actually says ----

test('a call nobody answered says so, rather than reading as a four-second call', () => {
  assert.equal(dur({ started_at: '2026-08-23T10:00:00Z', ended_at: '2026-08-23T10:00:04Z', participants: [{ user_id: 'me' }] }), 'no answer');
});

test('a short call that WAS answered is a duration, not a miss', () => {
  assert.equal(dur({ started_at: '2026-08-23T10:00:00Z', ended_at: '2026-08-23T10:00:04Z', participants: [{ user_id: 'me' }, { user_id: 'allan' }] }), '4s');
});

test('durations read the way a person says them', () => {
  const base = { participants: [{}, {}] };
  assert.equal(dur({ ...base, started_at: '2026-08-23T10:00:00Z', ended_at: '2026-08-23T10:00:42Z' }), '42s');
  assert.equal(dur({ ...base, started_at: '2026-08-23T10:00:00Z', ended_at: '2026-08-23T10:07:05Z' }), '7m 05s');
  assert.equal(dur({ ...base, started_at: '2026-08-23T10:00:00Z', ended_at: '2026-08-23T11:23:00Z' }), '1h 23m');
});

test('a call still running is not given a fake duration', () => {
  assert.equal(dur({ started_at: '2026-08-23T10:00:00Z', ended_at: null, participants: [{}, {}] }), 'in progress');
});

// ---- the transcript ----

// Comments in leaveHuddle NAME these calls before the code makes them, so
// index comparisons have to run against comment-free source.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the transcript is captured before anything erases it', () => {
  const fn = stripComments(extractFunction(app, 'function leaveHuddle(silent)'));
  const snap = fn.indexOf('const logTranscript');
  const teardown = fn.indexOf('teardownHuddleExtras()');
  const disconnect = fn.indexOf('r.disconnect()');
  assert.ok(snap > -1 && teardown > -1 && disconnect > -1);
  assert.ok(snap < teardown, 'teardownHuddleExtras() empties hudTranscript');
  assert.ok(snap < disconnect, 'and the disconnect empties the room');
});

test('who-was-last-out is read while the room still knows', () => {
  const fn = stripComments(extractFunction(app, 'function leaveHuddle(silent)'));
  assert.ok(fn.indexOf('const logLastOut') < fn.indexOf('r.disconnect()'));
  assert.match(fn, /hvLogCallEnd\(logLastOut, logTranscript\)/);
});

test('only the last person out ends the call', () => {
  const fn = extractFunction(app, 'async function hvLogCallEnd(lastOut, transcript)');
  assert.match(fn, /if \(lastOut\) patch\.ended_at/);
  // Someone stepping out of a call that carries on must not close the log entry
  // on everyone still in it.
  assert.match(fn, /if \(!Object\.keys\(patch\)\.length\) return;/);
});

test('a call with no captions stores no transcript, rather than an empty one', () => {
  // Null means "nobody turned CC on", which is not the same as "nobody spoke".
  const fn = extractFunction(app, 'function leaveHuddle(silent)');
  assert.match(fn, /hudTranscript\.length[\s\S]{0,90}: null;/);
});

// ---- reading it back ----

test('a logged transcript can be summarized by Reina from the log itself', () => {
  const fn = extractFunction(app, 'function showCallTranscript(row)');
  assert.match(fn, /@reina/);
  assert.match(fn, /action items/);
  assert.match(fn, /from\('messages'\)\.insert/);
});

test('rows say whether there is a transcript to read', () => {
  const fn = extractFunction(app, 'function renderCallLog()');
  assert.match(fn, /if \(r\.transcript\)/);
  assert.match(fn, /hv-log-tag/);
});

test('a channel this person can no longer see is not rendered as a blank row', () => {
  const fn = extractFunction(app, 'function renderCallLog()');
  assert.match(fn, /hvCallLog\.filter\(r => channels\.get\(r\.channel_id\)\)/);
});

test('a failed reload keeps the last log instead of blanking the panel', () => {
  const fn = extractFunction(app, 'async function loadCallLog(force)');
  assert.doesNotMatch(fn, /catch[\s\S]{0,60}hvCallLog = \[\]/);
  assert.match(fn, /catch \(e\) \{ \/\* keep whatever we last had/);
});

test('ending a call invalidates the cached log, so the panel is not stale', () => {
  assert.match(extractFunction(app, 'async function hvLogCallEnd(lastOut, transcript)'), /hvCallLogAt = 0/);
});

test('the panel shows recent calls, which it never could before', () => {
  const fn = extractFunction(app, 'function renderHuddlesPanel()');
  assert.match(fn, /Recent calls/);
  assert.match(fn, /loadCallLog\(\)\.then\(renderCallLog\)/);
});
