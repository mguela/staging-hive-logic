// Chris, 2026-08-23, right after the Leads pipeline search shipped:
// "now do the same for the Jobs page."
//
// Jobs already had a board search (2026-08-18, "No search on the Job Pipeline"),
// so "the same" here means the parts Leads got and Jobs did not:
//   - it searches BOTH tabs, not just the production board
//   - a filtered column says "2 of 9", not a bare "2"
//   - the KPI cards stop describing the business while a filter is on
//   - a Clear button and Escape
//
// The KPI captions are the subtle one. "ACTIVE JOBS / 3 / Not archived" while a
// search is running reads as "the business has 3 active jobs", which is false.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Normalised: CRLF on Windows, LF in CI, and needles below span line breaks.
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8').replace(/\r\n/g, '\n');

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

// ---- the handlers have to be reachable from inline HTML --------------------

test('every handler the inline HTML names is exported to window', () => {
  // The jobs code lives inside an IIFE. An inline oninput/onclick runs in global
  // scope, so a bare name is a ReferenceError that only shows up on first use.
  // This is the same trap the Leads Clear button hit.
  for (const fn of ['jobsSearchChanged', 'jobsClearSearch', 'renderJobsBoardLive']) {
    assert.match(HTML, new RegExp('window\\.' + fn + ' = ' + fn), fn + ' must be exported');
  }
  const input = HTML.slice(HTML.indexOf('id="jwb-q"') - 200, HTML.indexOf('id="jwb-q"') + 700);
  assert.match(input, /oninput="if\(window\.jobsSearchChanged\)window\.jobsSearchChanged\(\)"/);
  assert.match(input, /onclick="if\(window\.jobsClearSearch\)window\.jobsClearSearch\(\)"/);
});

test('the box no longer claims to filter only the board', () => {
  const input = HTML.slice(HTML.indexOf('id="jwb-q"'), HTML.indexOf('id="jwb-q"') + 300);
  assert.ok(!/placeholder="Filter board/.test(input), 'the old board-only placeholder must be gone');
  assert.match(input, /placeholder="Search jobs/);
});

test('typing drives both tabs, not just the board', () => {
  const fn = extractFunction(HTML, 'function jobsSearchChanged() {');
  assert.match(fn, /renderJobsBoardLive\(\)/);
  assert.match(fn, /renderJobsMarginList\(\)/, 'the margin list must re-filter too');
  assert.match(fn, /jwb-q-clear/, 'and the Clear button follows the query');
});

test('Escape clears', () => {
  const input = HTML.slice(HTML.indexOf('id="jwb-q"'), HTML.indexOf('id="jwb-q"') + 700);
  assert.match(input, /Escape/);
  assert.match(input, /jobsClearSearch/);
});

// ---- what matches ----------------------------------------------------------

function marginMatcher() {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(HTML, 'function marginRowMatchesQuery(j, q) {'), ctx);
  return (row, q) => ctx.marginRowMatchesQuery(row, String(q).toLowerCase());
}

const ROW = { jobNumber: '10021', title: 'Deck rebuild' };

test('a margin row is searchable by the number and title it prints', () => {
  const m = marginMatcher();
  assert.equal(m(ROW, 'deck'), true);
  assert.equal(m(ROW, '10021'), true);
  assert.equal(m(ROW, ''), true, 'an empty query shows everything');
  assert.equal(m(ROW, 'plumbing'), false);
});

test('a margin row never throws on missing fields', () => {
  const m = marginMatcher();
  assert.equal(m({}, 'x'), false);
  assert.equal(m({ jobNumber: null, title: undefined }, 'x'), false);
});

// ---- what the board says while filtered ------------------------------------

test('a filtered column says "2 of 9" against the UNFILTERED bucket', () => {
  const fn = extractFunction(HTML, 'function renderJobsBoardLive() {');
  // The "of N" has to come from a count taken before filtering, or it degenerates
  // into "2 of 2" and tells him nothing.
  assert.match(fn, /allBuckets\[b\]\+\+/, 'unfiltered per-column counts must be computed');
  assert.match(fn, /list\.length \+ ' of ' \+ allBuckets\[col\.key\]/);
  assert.match(fn, /'No matches here' : 'Empty'/, 'an empty filtered column must not just say Empty');
});

test('the KPI captions stop describing the business while filtering', () => {
  const fn = extractFunction(HTML, 'function jwbMarkKpiSubs(q, totalCount) {');
  assert.match(fn, /Not archived/);
  assert.match(fn, /Matching your search/);
  // Set, never appended -- an earlier draft appended and grew the caption by one
  // phrase per keystroke.
  assert.ok(!/\.textContent \+ /.test(fn), 'captions must be set, not appended to');
  assert.match(fn, /s\.textContent = q \?/);
});

test('the value KPI sub-label is rebuilt each render, not appended', () => {
  const fn = extractFunction(HTML, 'function renderJobsBoardLive() {');
  const sub = fn.slice(fn.indexOf("jwb-kpi-value-sub"), fn.indexOf('jwb-kpi-count'));
  assert.match(sub, /of ' \+ allJobs\.length \+ ' matching your search/);
  assert.ok(!/kvs\.textContent \+ /.test(sub));
});

test('the headline summary compares matched against all, and names the miss', () => {
  const fn = extractFunction(HTML, 'function renderJobsBoardLive() {');
  assert.match(fn, /jobs\.length \+ ' of ' \+ allJobs\.length \+ ' active jobs match/);
  const changed = extractFunction(HTML, 'function jobsSearchChanged() {');
  assert.match(changed, /No job matches/);
});

// ---- the margin list keeps its data so it can re-filter --------------------

test('margin rows are cached, so filtering costs no round trip', () => {
  const loader = extractFunction(HTML, 'function loadJobsMarginListLive() {');
  assert.match(loader, /JML_STATE\.jobs = data\.jobs \|\| \[\]/);
  assert.match(loader, /JML_STATE\.coverageNote = data\.coverageNote/);
  assert.match(loader, /renderJobsMarginList\(\)/);
  // and the render must not re-fetch
  const render = extractFunction(HTML, 'function renderJobsMarginList() {');
  assert.ok(!/fetch\(/.test(render), 'rendering must read the cache, not the network');
});

test('the coverage note says how much of the data is on screen while filtered', () => {
  const render = extractFunction(HTML, 'function renderJobsMarginList() {');
  assert.match(render, /rows\.length \+ ' of ' \+ all\.length \+ ' shown/);
  assert.match(render, /No job here matches/);
  // "no jobs at all" and "no jobs matching" are different facts
  assert.match(render, /No active jobs with a contract total right now/);
});
