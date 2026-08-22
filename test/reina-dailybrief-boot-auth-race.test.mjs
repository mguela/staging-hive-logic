import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The Daily Brief used to own a parse-time boot callback and a permanent 60s
// interval. It now exports its loader to the session-gated Command Center
// lifecycle, preventing both the original cold-login 401 and duplicate polling
// after navigation.
const source = fs.readFileSync('public/index.html', 'utf8');

test('Daily Brief exports a loader instead of fetching during script parse', () => {
  assert.match(source, /window\.hlDailyBriefReload = load;/);
  assert.doesNotMatch(source, /setInterval\(load,\s*60000\)/);
  assert.doesNotMatch(source, /addEventListener\('visibilitychange', function\(\)\{ if \(!document\.hidden\) load\(\); \}\)/);
});

test('Daily Brief first load is inside the restored-session Command Center batch', () => {
  const gateAt = source.indexOf('function ccGatedInitialWidgetLoad(force){');
  const batchAt = source.lastIndexOf('function ccInitialWidgetLoad(){', gateAt);
  assert.ok(batchAt !== -1 && gateAt > batchAt);
  const lifecycle = source.slice(batchAt, source.indexOf('var ccLastSyncAt', gateAt));
  assert.match(lifecycle, /window\.hlRequireSession\(function\(session\)/);
  assert.match(lifecycle, /if\(typeof window\.hlDailyBriefReload==='function'\) window\.hlDailyBriefReload\(\)/);
  assert.match(lifecycle, /signed out: wait for hl:signed-in; never manufacture 401s/);
});

test('Daily Brief refresh uses the consolidated authenticated poll tick', () => {
  const tickAt = source.indexOf('function ccPollTick(){');
  const tickEnd = source.indexOf('\n  var ccPollTimer = null;', tickAt);
  const tick = source.slice(tickAt, tickEnd);
  assert.match(tick, /if\(!window\.__hlAccessToken\) return;/);
  assert.match(tick, /ccRunIfStale\('dailyBrief', window\.hlDailyBriefReload, 30000\)/);
  assert.equal((source.match(/setInterval\(ccPollTick,\s*60000\)/g) || []).length, 1);
});
