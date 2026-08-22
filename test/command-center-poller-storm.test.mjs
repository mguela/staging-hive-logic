// test/command-center-poller-storm.test.mjs
//
// Found during the 8/17 Dev To-Do triage ("poller storm"): the Command
// Center's 12 widgets each polled on their own staggered 60-71s setInterval.
// ccBundleFetch() only shares one /api/track1?resource=cc_bundle call across
// requests landing within its 2s cache window, so staggering the widgets 1s
// apart defeated that sharing -- most ticks fell outside the window and each
// fired their own full bundle re-fetch, close to a dozen duplicate cc_bundle
// calls a minute. None of the 12 timers were ever torn down either: they ran
// for the life of the page even while the user sat on a completely different
// view for hours.
//
// The fix collapses all 12 into one shared tick (so their ccRunIfStale()
// calls land in the same synchronous pass and genuinely share one
// ccBundleFetch()), adds a __HL_CUR_VIEW guard matching the existing
// schedVehPollStart idiom, and wires a real start/stop pair into showView()
// so the timer itself stops on view switch. These tests guard each half of
// that fix against regressing back to the staggered/always-on shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync('public/index.html', 'utf8');

// ---------- Static: the staggered per-widget timers are gone for good ------

test('no per-widget Command Center timer is staggered on its own offset anymore', () => {
  for (const ms of [60000, 61000, 62000, 63000, 64000, 65000, 66000, 67000, 68000, 69000, 70000, 71000]) {
    // 60000 is legitimately reused by the single consolidated timer, so only
    // assert the OLD per-widget call shape (one ccRunIfStale call inline in
    // its own setInterval) is gone, not the literal number.
    const oldShape = new RegExp(`setInterval\\(function\\(\\)\\{[^}]*ccRunIfStale\\([^,]+,[^,]+,\\s*30000\\);[^}]*ccMarkSynced\\(\\);\\s*\\},\\s*${ms}\\);`);
    assert.ok(!oldShape.test(html), `a standalone per-widget setInterval at ${ms}ms must not remain`);
  }
});

test('exactly one interval drives the Command Center widget poll', () => {
  const matches = html.match(/setInterval\(ccPollTick,\s*60000\)/g) || [];
  assert.equal(matches.length, 1, 'expected exactly one setInterval(ccPollTick, 60000) call');
});

// ---------- Static: showView() actually starts/stops it ---------------------

test('showView() starts the Command Center poll on cc and stops it everywhere else', () => {
  assert.match(html, /if\(v==='cc'\)\{[\s\S]*?window\.ccPollStart\(\);[\s\S]*?\}else if\(typeof window\.ccPollStop==='function'\) window\.ccPollStop\(\);/);
});

test('the shared poller only starts with a current auth token and stops on signed-out', () => {
  assert.match(html, /window\.ccPollStart = function\(\)\{\s*if\(!window\.__hlAccessToken\) return;/);
  assert.match(html, /window\.addEventListener\('hl:signed-out',[\s\S]*?window\.ccPollStop\(\)/);
  assert.match(html, /if\(_event==='SIGNED_OUT'\)[\s\S]*?new Event\('hl:signed-out'\)/);
});

test('Daily Brief, Pulse, and Recent Photos no longer own independent refresh intervals', () => {
  const pulse = fs.readFileSync('public/app-command-center-pulse.js', 'utf8');
  assert.doesNotMatch(pulse, /setInterval\(/);
  assert.doesNotMatch(html, /setInterval\(loadRecentPhotosLive/);
  assert.doesNotMatch(html, /setInterval\(load,\s*60000\)/);
});

// ---------- Functional: ccPollTick itself ------------------------------------

const startMarker = 'function ccPollTick(){';
const endMarker = "\n  var ccPollTimer = null;";
const startIdx = html.indexOf(startMarker);
const endIdx = html.indexOf(endMarker, startIdx);
assert.ok(startIdx !== -1, 'expected to find ccPollTick');
assert.ok(endIdx !== -1 && endIdx > startIdx, 'expected to find the end of ccPollTick');
const ccPollTickSrc = html.slice(startIdx, endIdx);

function makeSandbox({ hidden = false, curView = 'cc', accessToken = 'tok' } = {}) {
  const calls = [];
  const names = [
    'map', 'jobsBoard', 'jobHealth', 'jobsAttention', 'watching', 'financials',
    'leads', 'clients', 'dispatchAlerts', 'schedule', 'todaySchedule', 'teamTodo',
    'dailyBrief', 'pulse', 'recentPhotos',
  ];
  const loaders = {
    loadMapLive: () => calls.push('map'),
    loadJobsBoardLive: () => calls.push('jobsBoard'),
    loadJobHealthTicker: () => calls.push('jobHealth'),
    loadJobsAttention: () => calls.push('jobsAttention'),
    loadWatchingLive: () => calls.push('watching'),
    loadFinancials: () => calls.push('financials'),
    loadLeadsLive: () => calls.push('leads'),
    loadClientsLive: () => calls.push('clients'),
    loadDispatchAlertsLive: () => calls.push('dispatchAlerts'),
    loadScheduleLive: () => calls.push('schedule'),
    loadTodaySchedule: () => calls.push('todaySchedule'),
    teamTodoLoad: () => calls.push('teamTodo'),
  };
  let syncedCalls = 0;
  const sandbox = {
    ...loaders,
    document: { hidden },
    window: {
      __HL_CUR_VIEW: curView,
      __hlAccessToken: accessToken,
      hlDailyBriefReload: () => calls.push('dailyBrief'),
      pgReload: () => calls.push('pulse'),
      loadRecentPhotosLive: () => calls.push('recentPhotos'),
    },
    ccRunIfStale: (name, fn) => { fn(); return true; },
    ccMarkSynced: () => { syncedCalls++; },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(ccPollTickSrc + '\nthis.ccPollTick = ccPollTick;', sandbox, { filename: 'public/index.html' });
  return { sandbox, calls, names, syncedCalls: () => syncedCalls };
}

test('a tick on the cc view refreshes all 15 widget groups exactly once each', () => {
  const { sandbox, calls, names, syncedCalls } = makeSandbox({ curView: 'cc' });
  sandbox.ccPollTick();
  assert.deepEqual([...calls].sort(), [...names].sort());
  assert.equal(syncedCalls(), 1);
});

test('a tick while any other view is open is a complete no-op', () => {
  const { sandbox, calls, syncedCalls } = makeSandbox({ curView: 'schedule' });
  sandbox.ccPollTick();
  assert.deepEqual(calls, [], 'no widget should refresh while the user is not on Command Center');
  assert.equal(syncedCalls(), 0);
});

test('a tick before auth restoration or after sign-out is a complete no-op', () => {
  const { sandbox, calls, syncedCalls } = makeSandbox({ curView: 'cc', accessToken: null });
  sandbox.ccPollTick();
  assert.deepEqual(calls, [], 'no authenticated widget loader should run without a current access token');
  assert.equal(syncedCalls(), 0);
});

test('a tick with __HL_CUR_VIEW unset (initial page load, before any showView call) still runs', () => {
  const { sandbox, calls } = makeSandbox({ curView: undefined });
  sandbox.ccPollTick();
  assert.equal(calls.length, 15, 'an unset current view must be treated as cc, matching schedVehPollStart\'s own idiom');
});

test('a tick while the tab is hidden is a complete no-op', () => {
  const { sandbox, calls, syncedCalls } = makeSandbox({ hidden: true, curView: 'cc' });
  sandbox.ccPollTick();
  assert.deepEqual(calls, []);
  assert.equal(syncedCalls(), 0);
});
