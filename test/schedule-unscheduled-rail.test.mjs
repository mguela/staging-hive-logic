// Chris, 2026-08-23: "AFTER SAVING THE JOB FORM TO UNASSIGNED JOBS, IT DIDN'T
// SHOW IN THE UNASSIGNED JOBS LAYER ON THE SCHEDULE"
//
// It could not have. The board's `demands` array -- the thing the unscheduled
// rail renders -- was the literal `[]` in public/schedule-board/data.js. The
// rail has never shown anything to anyone: the counter has always read 0 and
// the panel has always said "No unscheduled work 🎉", on a company with 18 open
// jobs that have no slot.
//
// So "Add to Unscheduled" wrote a perfectly good job into a list nothing
// displayed. And the handoff added an hour earlier -- which takes you to the
// Schedule tab and opens that rail after making a job from a lead -- was
// pointing at an empty panel, which is worse than not pointing at all.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const DATA = fs.readFileSync(path.join(root, 'public', 'schedule-board', 'data.js'), 'utf-8');
const APP = fs.readFileSync(path.join(root, 'public', 'schedule-board', 'app.js'), 'utf-8');
const TRACK1 = fs.readFileSync(path.join(root, 'api', 'track1.js'), 'utf-8');

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

test('the rail is no longer hardcoded empty', () => {
  // This one line is the whole bug.
  assert.ok(!/demands: \[\]/.test(DATA), 'demands: [] is what made the rail permanently empty');
  assert.match(DATA, /demands: unscheduledDemands/);
});

test('there is a real source behind it', () => {
  assert.match(TRACK1, /resource === 'schedule_unscheduled'/);
  assert.match(TRACK1, /async function handleScheduleUnscheduled\(req, res\) \{/);
  assert.match(DATA, /resource=schedule_unscheduled/);
});

test('unscheduled means open, and nowhere to be', () => {
  const fn = extractFunction(TRACK1, 'async function handleScheduleUnscheduled(req, res) {');
  assert.match(fn, /completed_at=is\.null/);
  assert.match(fn, /start_at=is\.null/, 'a job with a start time is scheduled -- that is the time the client was given');
  assert.match(fn, /job_status=neq\.archived/);
});

test('a job already booked on the board is not listed twice', () => {
  const fn = extractFunction(TRACK1, 'async function handleScheduleUnscheduled(req, res) {');
  assert.match(fn, /hl_appointments\?job_ref=in\./);
  assert.match(fn, /canceled=eq\.false/);
  assert.match(fn, /booked\.has\(j\.jobber_id\)/);
});

test('a missing client name does not cost us the card', () => {
  // A job you cannot schedule because its client row is missing is worse than
  // a card that says less.
  const fn = extractFunction(TRACK1, 'async function handleScheduleUnscheduled(req, res) {');
  const enrich = fn.slice(fn.indexOf('const clientIds'));
  assert.strictEqual((enrich.match(/catch/g) || []).length, 2, 'both the name and the town lookups are wrapped');
});

test('the board degrades to an empty rail rather than failing to load', () => {
  const i = DATA.indexOf('resource=schedule_unscheduled');
  assert.match(DATA.slice(i, i + 200), /catch\(function\(\)\{ return null; \}\)/);
});

// ---- honesty about what a job actually knows -------------------------------

test('the card invents no urgency it does not have', () => {
  // The old markup printed priority, duration, skill, window and readiness
  // unconditionally, because its data was made up. A real job row has none of
  // them, so with real data it would have read "undefined · undefined" -- and
  // filling them in would put fabricated urgency on a dispatch board.
  const fn = extractFunction(APP, 'function renderUnassigned(){');
  for (const field of ['u.priority', 'u.dur', 'u.skill', 'u.window']) {
    assert.match(fn, new RegExp('if\\(' + field.replace('.', '\\.') + '\\)|\\$\\{' + field.replace('.', '\\.') + '\\?'),
      field + ' must be rendered conditionally');
  }
  assert.ok(!/<span class="pri">\$\{u\.priority\}<\/span>/.test(fn), 'no unconditional priority chip');
});

test('the mapper sets the absent fields to null on purpose', () => {
  const fn = extractFunction(DATA, 'function demandFromJob(j){');
  assert.match(fn, /dur: null, skill: null, window: null, priority: null, ready: null/);
  // And the real ones are carried.
  for (const f of ['jobRef', 'jobNo', 'title', 'client', 'city', 'total']) {
    assert.match(fn, new RegExp(f + ':'), f + ' should come through');
  }
});

test('the card escapes what it renders', () => {
  // Job titles and client names come from Jobber and from the New Job form.
  const fn = extractFunction(APP, 'function renderUnassigned(){');
  assert.match(fn, /const esc=/);
  assert.match(fn, /esc\(u\.title\)/);
  assert.match(fn, /esc\(u\.id\)/);
});

// ---- the handoff has to show FRESH data ------------------------------------

test('opening the rail refreshes it first', () => {
  // The board loads once at boot. A job created after that -- exactly the case
  // when HiveLogic sends you here straight from the job form -- would not be in
  // the list. Opening the panel on stale data is how this happens twice.
  const i = DATA.indexOf("hl-crewboard-show-unscheduled");
  const handler = DATA.slice(i, i + 900);
  // The semantics, not the text order: showing is the CONTINUATION of the
  // refresh. (`after` is declared above the refresh call and runs after it, so
  // comparing indexOf would assert the opposite of what matters.)
  assert.match(handler, /hlRefreshUnscheduled\(\)\.then\(after, after\)/);
  assert.match(handler, /var after = function\(\)\{[\s\S]*?toggleUnassigned\(true\)/,
    'showing the panel lives inside the continuation');
  assert.ok(!/toggleUnassigned\(true\);\s*[\s\S]{0,40}hlRefreshUnscheduled/.test(handler),
    'the panel must not be shown before the refresh is even asked for');
});

test('the refresh still shows the rail when the fetch fails', () => {
  // .then(after, after) -- an empty rail is a fact; a rail that never opens is
  // a button that did nothing.
  const i = DATA.indexOf("hl-crewboard-show-unscheduled");
  assert.match(DATA.slice(i, i + 900), /\.then\(after, after\)/);
});

test('the refresh mutates the array rather than replacing it', () => {
  // app.js destructured `demands` at load and holds a reference to that exact
  // array. Reassigning window.LAB.demands would leave the renderer looking at
  // the old one forever.
  const fn = extractFunction(DATA, 'window.hlRefreshUnscheduled = function(){');
  assert.match(fn, /arr\.length = 0;/);
  assert.match(fn, /arr\.push\(demandFromJob\(j\)\)/);
  assert.ok(!/window\.LAB\.demands\s*=/.test(fn), 'never reassign the array');
});

test('boot and refresh use the same mapper', () => {
  assert.match(DATA, /unsched\.map\(demandFromJob\)/);
  const fn = extractFunction(DATA, 'window.hlRefreshUnscheduled = function(){');
  assert.match(fn, /demandFromJob\(j\)/);
});

// ---- picking the time and the crew yourself --------------------------------
//
// Chris, 2026-08-24, once the rail had real jobs in it: "I like this feature,
// but you need the option to manually pick times and techs yoursself. techs
// should be list by division seleted in job setup, but an option to override to
// choose a tech from outside the listed division's list of techs"
//
// What "Schedule this" opened was a mockup, and real jobs showed him its seams:
//
//   ★ Best overall — David @ 9a
//   ✓ null qualified
//   ✓ ~12-min drive from prior job
//   ✓ No overtime
//   ✓ Fits customer window (null)
//
// Every line invented. There is no solver, no drive time, no overtime model and
// no customer window -- a job row carries none of it -- so it recommended a
// person and an hour on the strength of nothing, and the nulls were the real
// data showing through the gaps.

test('the invented recommendations are gone', () => {
  const fn = extractFunction(APP, 'scheduleThis(uid){');
  assert.ok(!fn.includes("'Best overall'"), 'no invented ranking');
  assert.ok(!fn.includes('12-min drive'), 'there is no drive-time source');
  assert.ok(!fn.includes('No overtime'), 'there is no overtime model');
  assert.ok(!fn.includes('qualified'), 'a job carries no required skill');
  assert.ok(!fn.includes('Lab preview'), 'and it is not a preview any more');
});

test('nothing pretends a job has a customer window or a duration', () => {
  const fn = extractFunction(APP, 'scheduleThis(uid){');
  assert.ok(!/u\.window/.test(fn), 'u.window is null on every real job');
  assert.ok(!/u\.skill/.test(fn));
  assert.ok(!/u\.dur\b/.test(fn), 'the length is asked for, not assumed');
});

test('it asks for a date, a time, a length and a crew', () => {
  const fn = extractFunction(APP, 'scheduleThis(uid){');
  for (const id of ['sd_date', 'sd_time', 'sd_dur', 'sd_tech']) {
    assert.ok(fn.includes(id), id + ' should be on the form');
  }
});

test('crews are listed by the job\'s division', () => {
  const fn = extractFunction(APP, 'scheduleThis(uid){');
  assert.match(fn, /const jobDiv=u\.div\|\|null;/);
  assert.match(fn, /field\.filter\(\(t\)=>t\.div===jobDiv\)/);
});

test('and there is an override to see every division', () => {
  const fn = extractFunction(APP, 'scheduleThis(uid){');
  assert.match(fn, /Show crews from every division/);
  assert.match(fn, /schedToggleAll/);
  const toggle = extractFunction(APP, 'schedToggleAll(on){');
  assert.match(toggle, /_schedCrewOpts\(!!on\)/);
});

test('the override does not throw away the time already picked', () => {
  // It re-renders the crew list in place rather than reopening the modal.
  const toggle = extractFunction(APP, 'schedToggleAll(on){');
  assert.match(toggle, /sel\.innerHTML=/);
  assert.ok(!/modal\(/.test(toggle), 'reopening would reset the date and time');
});

test('an empty division shows every crew, and says why', () => {
  // A division nobody is set up in would otherwise offer an empty picker with
  // no explanation -- a dead end.
  const fn = extractFunction(APP, 'scheduleThis(uid){');
  assert.match(fn, /const startAll=!jobDiv\|\|inDiv\.length===0;/);
  assert.match(fn, /Nobody is set up in/);
  assert.match(fn, /no division set/);
});

test('a crew from another division is labelled as such', () => {
  // Picking outside the division is allowed and should be visible, not silent.
  const fn = extractFunction(APP, 'scheduleThis(uid){');
  assert.match(fn, /t\.div&&t\.div!==jobDiv\?' · '\+esc\(t\.div\)/);
});

// ---- booking it for real ---------------------------------------------------

test('booking creates a real appointment', () => {
  // The old pickOption pushed a fabricated visit into the local array -- id
  // 'd'+Date.now(), vid 'lab_d' -- and posted nothing at all. The job looked
  // scheduled on screen and was on nobody's calendar.
  assert.ok(!APP.includes('pickOption('), 'the fake booking path is gone');
  assert.ok(!APP.includes("vid:'lab_d'"));
  const fn = extractFunction(APP, 'schedBook(uid){');
  assert.match(fn, /hlPost\('create_appointment'/);
  assert.match(fn, /crew_jids:\[tech\.jid\], lead_jid:tech\.jid/);
  assert.match(fn, /job_ref:u\.jobRef\|\|null/, 'so the appointment traces back to the job');
});

test('the job only leaves the rail once it is actually booked', () => {
  // Removing it first would lose the job off the one list showing it, on a
  // failure he cannot see.
  const fn = extractFunction(APP, 'schedBook(uid){');
  assert.ok(fn.indexOf('hlPost(') < fn.indexOf('demands.splice'),
    'the splice must be inside the success path');
  assert.match(fn, /if\(!\(r&&r\.ok\)\)\{ toast\('Not booked: '/);
});

test('a failed booking says so rather than looking scheduled', () => {
  const fn = extractFunction(APP, 'schedBook(uid){');
  assert.strictEqual((fn.match(/Not booked: /g) || []).length, 2,
    'both the rejection and the network failure report it');
  assert.match(fn, /\.catch\(/);
});

test('it refuses to book without a date or a crew', () => {
  const fn = extractFunction(APP, 'schedBook(uid){');
  assert.match(fn, /if\(!date\)\{ toast\('Pick a date first'/);
  assert.match(fn, /if\(!tech\|\|!tech\.jid\)\{ toast\('Pick a crew member first'/);
  assert.ok(fn.indexOf('Pick a crew member first') < fn.indexOf("hlPost('create_appointment'"));
});

test('the times are converted the way the rest of the board does it', () => {
  // A raw hour would land the appointment in UTC and put it on the wrong day.
  const fn = extractFunction(APP, 'schedBook(uid){');
  assert.match(fn, /window\.hlEtToUTC\(date,s\)/);
  assert.match(fn, /window\.hlEtToUTC\(date,s\+dur\)/);
});

test('nothing calls a function that lives in the other file', () => {
  // etTodayYmd is declared inside data.js's IIFE. app.js calling it would throw
  // -- the trap that has silently broken four features in this codebase.
  const fn = extractFunction(APP, 'scheduleThis(uid){');
  assert.ok(!/[^/]\betTodayYmd\(\)/.test(fn.replace(/\/\/.*$/gm, '')),
    'use TODAY, which app.js destructures from window.LAB');
  assert.match(fn, /state\.date\|\|TODAY/);
});

test('the modal escapes what it prints', () => {
  // Job titles and client names come from Jobber and from the New Job form.
  const fn = extractFunction(APP, 'scheduleThis(uid){');
  assert.match(fn, /const esc=/);
  assert.match(fn, /esc\(t\.n\)/);
});
