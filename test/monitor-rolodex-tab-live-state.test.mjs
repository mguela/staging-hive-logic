// Regression test for the rolodex rail's Monitor tab (public/index.html).
//
// Bug (Chris, 2026-08-15): the Monitor tab in the right-edge rolodex rail was
// green all the time. Confirmed against the live app -- not clocked in, so
// nothing was being recorded, yet the tab still showed the green "on" accent.
//
// Cause: the rolodex block ran its OWN poller against
// `/api/track1?resource=monitor_review` and set `.mon-on` whenever any roster
// entry reported `status === 'active'`. That field means "this person's Monitor
// agent is paired", which is true around the clock and has nothing to do with
// whether recording is happening. So the tab was effectively hardcoded green.
//
// Fix: drive the tab from `monitor_my_status`, the endpoint that already answers
// the real question (`recording`), and do it from inside hlMonitorFabPoll() --
// the single 30s poll that already runs for the recording-warning toast. No
// second poller. recording:true -> green; everything else -> grey.
//
// Structural/string checks only -- public/index.html is a single huge static
// HTML + inline-JS file with no DOM harness wired up in this repo -- but each
// assertion anchors on an exact load-bearing string, so re-introducing the
// monitor_review poller or unhooking the tab from the poll will fail here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');

test('the Monitor tab defaults to the grey/off accent and only goes green under .mon-on', () => {
  assert.match(
    html,
    /#rolo-mon\{--rl-ac:#6b7280\}/,
    'the base #rolo-mon rule must set the grey accent, so the tab is off until proven recording'
  );
  assert.match(
    html,
    /#rolo-mon\.mon-on\{--rl-ac:#25c26e/,
    'green must be gated behind the .mon-on class, not the base rule'
  );
  // The tab markup itself must not carry an inline --rl-ac, which (as an inline
  // style) would beat both rules above and pin the tab to one colour forever.
  const tab = html.match(/<div class="rolo" id="rolo-mon"[^>]*>/);
  assert.ok(tab, 'the #rolo-mon tab must still exist in the rolodex rail');
  assert.doesNotMatch(
    tab[0],
    /--rl-ac/,
    'the Monitor tab must not hardcode an accent inline -- its colour is state, not decoration'
  );
});

test('the tab state is derived from the real recording signal, not from "a device is paired"', () => {
  assert.match(
    html,
    /window\.hlMonRoloSync = function\(recording\)\{/,
    'hlMonRoloSync(recording) must exist as the single place the tab class is set'
  );
  assert.match(
    html,
    /tab\.classList\.toggle\('mon-on', !!recording\);/,
    'the .mon-on class must track the recording flag directly'
  );
  // The old, wrong signal: roster entries whose status is 'active' (= paired).
  assert.doesNotMatch(
    html,
    /roster\.some\(function\(p\)\{return p&&p\.status==='active';\}\)/,
    'the tab must no longer light up merely because a Monitor agent is paired'
  );
  assert.doesNotMatch(
    html,
    /resource=monitor_review'[^)]*\}\)\s*\.then\(function\(r\)\{return r\.json\(\);\}\)\s*\.then\(function\(data\)\{\s*var roster/,
    'the rolodex must no longer fetch monitor_review to decide its colour'
  );
});

test('hlMonitorFabPoll drives the tab for both outcomes and for every failure path', () => {
  const poll = html.match(/window\.hlMonitorFabPoll = function\(\)\{[\s\S]*?\n\};/);
  assert.ok(poll, 'hlMonitorFabPoll must still exist');
  const body = poll[0];

  assert.match(
    body,
    /resource=monitor_my_status/,
    'the poll must still read monitor_my_status -- the endpoint that reports recording'
  );
  assert.match(body, /hlMonRoloSync\(true\);/, 'recording:true must turn the tab green');
  // Off is asserted three times over: the not-recording branch, the catch, and
  // the no-session callback. A stale green light is the exact bug being fixed,
  // so every path out of this function has to resolve the tab's state.
  assert.equal(
    (body.match(/hlMonRoloSync\(false\)/g) || []).length,
    3,
    'not-recording, request failure, and signed-out must each drive the tab grey'
  );
  assert.match(
    body,
    /\}, function\(\)\{ hlMonRoloSync\(false\); \}\);/,
    'the hlRequireSession no-session callback must clear the tab, not no-op'
  );
});

test('there is exactly one Monitor poller, and it is the one the warning toast already uses', () => {
  assert.match(
    html,
    /if\(!window\.__hlMonPollTimer\) window\.__hlMonPollTimer = setInterval\(hlMonitorFabPoll, 30000\);/,
    'the 30s poll must be registered once, guarded on window so it cannot stack'
  );
  assert.equal(
    (html.match(/setInterval\(hlMonitorFabPoll/g) || []).length,
    1,
    'hlMonitorFabPoll must be scheduled from exactly one place'
  );
  assert.equal(
    (html.match(/setInterval\(pollMon/g) || []).length,
    0,
    'the rolodex block must not run a second Monitor poller'
  );
  // The poll interval registration must sit outside the #hlMonFab existence
  // check -- the fab is hidden/absent on some routes, and the tab still needs
  // refreshing there. Previously `if(!btn) return;` short-circuited everything.
  const init = html.match(/window\.hlMonitorFabInit = function\(\)\{[\s\S]*?\n\};/);
  assert.ok(init, 'hlMonitorFabInit must still exist');
  assert.doesNotMatch(
    init[0],
    /if\(!btn\) return;/,
    'a missing #hlMonFab must not stop the poll that the rolodex tab depends on'
  );
});

test('the toast behaviour this poll also drives is untouched', () => {
  // Guardrail on the fix: only the tab's visual binding was meant to change.
  assert.match(
    html,
    /window\.__hlMonWarned = true;/,
    'the once-per-recording-session warning latch must still be set'
  );
  assert.match(
    html,
    /window\.__hlMonWarned = false;/,
    'the latch must still reset when recording stops'
  );
  assert.match(
    html,
    /btn\.title = \(data && data\.clockedIn\) \? 'Clocked in — monitoring not active' : 'Not being tracked right now';/,
    'the fab tooltip wording must be unchanged'
  );
});
