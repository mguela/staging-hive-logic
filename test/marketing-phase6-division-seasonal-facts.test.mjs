// Phase 6 -- real per-division + seasonal job facts feeding the Plan tab.
// Verifies api/marketing.js's handleAssumptionsGet now returns two new real,
// derived reference facts alongside the pre-existing company-wide
// realAvgJobValueCents/realHistoricalJobsPerMonth: a per-division breakdown
// (JOB_DIVISIONS, classified via the existing real jobDivisionServer --
// never a second, fabricated division mapping) and a per-calendar-month
// breakdown (real completed-job counts by month, for seasonal timing).
// Both are computed from a single shared fetch of real completed jobs and
// both honestly degrade (empty arrays / null averages) rather than
// fabricating a number when there isn't enough real data yet.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert';

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const apiPath = 'api/marketing.js';

check('api/marketing.js has valid syntax (node --check)', () => {
  execSync(`node --check ${apiPath}`, { stdio: 'pipe' });
});

const body = fs.readFileSync(apiPath, 'utf8');

// Bound each function's body by indexOf between its own start marker and the
// next function's start marker -- CRLF-safe (this repo's real files use CRLF
// line endings, so a regex ending in a literal "\n}\n" would never match;
// this indexOf-bounding pattern is the established safe convention from
// this session's prior slices).
function boundFn(startMarker, endMarker) {
  const startIdx = body.indexOf(startMarker);
  assert.ok(startIdx > -1, `start marker not found: ${startMarker}`);
  const endIdx = body.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, `end marker not found after start: ${endMarker}`);
  return body.slice(startIdx, endIdx);
}

const realJobFactsFnBody = () => boundFn(
  'async function realJobFactsByDivisionAndMonth() {',
  'async function handleAssumptionsGet(req, res) {',
);
const handleAssumptionsGetBody = () => boundFn(
  'async function handleAssumptionsGet(req, res) {',
  '\nasync function handleAssumptionsPost',
);

// Extract jobDivisionServer's real return values directly from its own
// function body, so JOB_DIVISIONS can never silently drift from the actual
// classifier it's meant to enumerate.
function realJobDivisionServerValues() {
  const fn = boundFn('function jobDivisionServer(title) {', '\nconst NEIGHBORHOOD_GRID_DEGREES');
  const matches = [...fn.matchAll(/return '([^']+)';/g)].map((m) => m[1]);
  // jobDivisionServer's final line is `return 'Handyman';` (the fallback),
  // duplicating the earlier explicit Handyman branch -- dedupe for a clean set.
  return [...new Set(matches)];
}

check('JOB_DIVISIONS matches the real jobDivisionServer classifier’s return values exactly', () => {
  const jsMatch = body.match(/const JOB_DIVISIONS = \[([^\]]+)\];/);
  assert.ok(jsMatch, 'JOB_DIVISIONS not found');
  const jsValues = jsMatch[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  const realValues = realJobDivisionServerValues();
  assert.deepStrictEqual(jsValues.slice().sort(), realValues.slice().sort(), 'JOB_DIVISIONS must exactly match jobDivisionServer’s real division set, never a second fabricated mapping');
});

check('MONTH_NAMES_UTC has all 12 real calendar months, in order', () => {
  const jsMatch = body.match(/const MONTH_NAMES_UTC = \[([^\]]+)\];/);
  assert.ok(jsMatch, 'MONTH_NAMES_UTC not found');
  const months = jsMatch[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepStrictEqual(months, ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
});

check('realJobFactsByDivisionAndMonth fetches only real completed jobs (title/total/completed_at)', () => {
  const fn = realJobFactsFnBody();
  assert.match(fn, /fetchAllRows\('jobs', '\?select=title,total,completed_at&completed_at=not\.is\.null'\)/);
});

check('realJobFactsByDivisionAndMonth classifies via the real jobDivisionServer function, never a fabricated mapping', () => {
  const fn = realJobFactsFnBody();
  assert.match(fn, /jobDivisionServer\(r\.title\)/);
});

check('realJobFactsByDivisionAndMonth honestly falls back to null avgJobValueCents when a division has no priced jobs', () => {
  const fn = realJobFactsFnBody();
  assert.match(fn, /avgJobValueCents: b\.pricedJobCount > 0 \? Math\.round\(b\.totalCents \/ b\.pricedJobCount\) : null/, 'must never fabricate an average when pricedJobCount is 0');
});

check('realJobFactsByDivisionAndMonth only counts a job toward totalCents when total > 0 (real priced jobs only)', () => {
  const fn = realJobFactsFnBody();
  assert.match(fn, /if \(val > 0\) \{/);
});

check('realJobFactsByDivisionAndMonth buckets real completed jobs by real calendar month (getUTCMonth)', () => {
  const fn = realJobFactsFnBody();
  assert.match(fn, /new Date\(r\.completed_at\)\.getUTCMonth\(\)/);
});

check('realJobFactsByDivisionAndMonth honestly degrades to empty arrays (never fabricated data) when jobs is not synced', () => {
  const fn = realJobFactsFnBody();
  assert.match(fn, /if \(e\.notSynced\) return \{ realJobFactsByDivision: \[\], realSeasonalDistribution: \[\] \};/);
});

check('handleAssumptionsGet now calls realJobFactsByDivisionAndMonth() alongside the pre-existing real facts', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /const \[[^\]]*\brealDivisionMonthFacts\b[^\]]*\] = await Promise\.all\(\[/);
  assert.match(fn, /realJobFactsByDivisionAndMonth\(\),/);
});

check('handleAssumptionsGet’s response reference block includes the two new real facts with honest source descriptions', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /realJobFactsByDivision: realDivisionMonthFacts\.realJobFactsByDivision,/);
  assert.match(fn, /realJobFactsByDivisionSource: 'Real completed jobs \(Jobber sync\) classified by the same division rules used elsewhere in Marketing/);
  assert.match(fn, /realSeasonalDistribution: realDivisionMonthFacts\.realSeasonalDistribution,/);
  assert.match(fn, /realSeasonalDistributionSource: 'Count of real completed jobs by calendar month, all history combined -- a reference for seasonal timing, not a forecast of next year\.'/, 'must be explicit that this is a historical reference, not a prediction -- matches this file’s house style of never overclaiming');
});

check('handleAssumptionsGet’s pre-existing real facts (company-wide avg job value / historical jobs per month) are unchanged', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /realAvgJobValueCents: realAvgJobValue,/);
  assert.match(fn, /realHistoricalJobsPerMonth: realHistJobsPerMonth,/);
});

let pass = 0, fail = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    pass++;
    console.log(`ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`not ok - ${name}\n  ${e.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
