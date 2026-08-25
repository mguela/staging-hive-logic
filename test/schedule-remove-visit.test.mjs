// test/schedule-remove-visit.test.mjs
// jomell, 2026-08-25: "in schedule tab when clicking a job for example lets
// go for 'home renovation' there should be an option or button to remove
// the schedule."
//
// That job (#2382, Jobber-managed) opens openLockedSheet(), whose own
// "Mirror-only mode" box already says the deal: "Jobber runs this. You can
// PLAN an override (scenario only) but can't publish it until this crew is
// HiveLogic Live." The existing "Plan override (scenario)" button next to
// it is a real, already-shipped example of that exact shape (stageChange,
// undoable, no fetch anywhere in this file's override path -- the file's
// own header says "local-only, no network"). "Remove from schedule" is
// built the same way: a HiveLogic-side proposal that never touches Jobber,
// shown beside the still-live Jobber visit until this crew goes Live.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(root, 'public', 'schedule-board', 'app.js'), 'utf-8');

function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  if (start === -1) throw new Error('not found: ' + decl);
  let depth = 1, i = start + decl.length;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

test('removing a visit never calls the network, same as the existing override flow', () => {
  const fn = extractFunction(APP, 'function removeVisitScenario(vid){');
  assert.ok(!/hlPost|fetch\(/.test(fn), 'this must stay a local scenario proposal, never a live write to anything');
  assert.match(fn, /stageChange\(/, 'must go through the same undoable staging mechanism as commitOverride');
});

test('removing replaces any existing time/crew override rather than layering onto it', () => {
  const fn = extractFunction(APP, 'function removeVisitScenario(vid){');
  assert.match(fn, /v\.override\s*=\s*\{removed:true,lifecycle:'proposed'\}/);
});

test('restoring clears the override entirely, undoably', () => {
  const fn = extractFunction(APP, 'function restoreVisitScenario(vid){');
  assert.match(fn, /v\.override\s*=\s*null/);
  assert.match(fn, /stageChange\(/);
});

test('isEffectivelyRemoved only excludes a visit once the crew is actually Live', () => {
  // A proposed removal must still show (flagged) in mirror/planning mode --
  // only 'live' mode is allowed to make it disappear, matching the exact
  // same proposed/effective duality already used for time overrides.
  const fn = extractFunction(APP, 'function isEffectivelyRemoved(v){');
  assert.match(fn, /isRemoved\(v\)\s*&&\s*state\.controlMode===\s*'live'/);
});

test('dayVisits excludes an effectively-removed visit from every board computation', () => {
  // The single choke point: hours worked, conflict zones and the crew "N
  // jobs" badge all read through dayVisits, so filtering there is what
  // makes a Live removal actually count everywhere, not just visually.
  const i = APP.indexOf('const dayVisits =');
  const line = APP.slice(i, APP.indexOf('\n', i));
  assert.match(line, /!isEffectivelyRemoved\(v\)/);
});

test('renderMonth applies the same removal filter as the day/week views', () => {
  const fn = extractFunction(APP, 'function renderMonth(){');
  assert.match(fn, /isEffectivelyRemoved\(v\)/);
});

test('a proposed removal is visually distinct on the day board, not just silently there', () => {
  const fn = extractFunction(APP, 'function renderDay(){');
  assert.match(fn, /'PROPOSED REMOVAL'/);
  assert.match(fn, /isRemoved\(v\)\?';opacity:\.5':''/, 'must be visually dimmed, not indistinguishable from a normal job');
  assert.match(fn, /isRemoved\(v\)\?'<s>'\+v\.type\+'<\/s>':v\.type/, 'the title should read as struck-through');
});

test('the job detail modal offers Remove when active, and Restore once removed', () => {
  const fn = extractFunction(APP, 'function openLockedSheet(vid){');
  assert.match(fn, /Remove from schedule/);
  assert.match(fn, /Restore to schedule/);
  assert.match(fn, /removeVisitScenario\(vid\)/);
  assert.match(fn, /restoreVisitScenario\(vid\)/);
});

test('the source-history box does not crash on a removal (no v.override.s/e to read)', () => {
  const fn = extractFunction(APP, 'function openLockedSheet(vid){');
  const removedBranch = fn.slice(fn.indexOf('isRemoved(v)) body+='), fn.indexOf('else if(hasOv)'));
  assert.ok(!/v\.override\.s|v\.override\.e/.test(removedBranch),
    'a removal override has no s/e -- reading them would print "undefined"');
});

test('the icon legend explains the removal marker distinctly from a time-change proposal', () => {
  const fn = extractFunction(APP, 'function iconLegendFor(v){');
  assert.match(fn, /Proposed removal/);
});
