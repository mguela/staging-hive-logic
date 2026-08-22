// Phase 18 -- real last-touch marketing attribution.
// Verifies api/marketing.js's resource=attribution (GET) now also computes
// a genuine last-touch lead/revenue model from the same real, already-synced
// campaigns/campaign_recipients/jobs data first-touch already reads -- a
// deliberately separate, independent computation (its own real fetch, not a
// shared refactor of the already-shipped/tested first-touch function) so
// first-touch's tested behavior is never put at risk by this addition.

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

// CRLF-safe indexOf-based function-body bounding -- the established
// convention from this project's prior slices.
function boundFn(startMarker, endMarker) {
  const startIdx = body.indexOf(startMarker);
  assert.ok(startIdx > -1, `start marker not found: ${startMarker}`);
  const endIdx = body.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, `end marker not found after start: ${endMarker}`);
  return body.slice(startIdx, endIdx);
}

const computeLastTouchFnBody = () => boundFn(
  'async function computeLastTouchAttribution() {',
  'export default async function handler(req, res) {',
);
const handleFnBody = () => boundFn(
  'async function handleAttributionGet(req, res) {',
  'async function computeLastTouchAttribution() {',
);

check('computeLastTouchAttribution fetches only real, already-on-origin/main tables (same tables first-touch reads)', () => {
  const fn = computeLastTouchFnBody();
  assert.match(fn, /fetchAllRows\('campaigns', '\?select=id,name,type,channel'\)/);
  assert.match(fn, /fetchAllRows\('campaign_recipients', '\?select=campaign_id,client_id,sent_at,outcome,outcome_value&sent_at=not\.is\.null'\)/);
  assert.match(fn, /fetchAllRows\('jobs', '\?select=client_id,total,completed_at&completed_at=not\.is\.null'\)/);
});

check('touches are sorted earliest-first per real client before any last-touch decision is made', () => {
  const fn = computeLastTouchFnBody();
  assert.match(fn, /list\.sort\(\(a, b\) => new Date\(a\.sentAt\)\.getTime\(\) - new Date\(b\.sentAt\)\.getTime\(\)\)/);
});

check('a job only counts as attributed when a real touch exists on/before its real completed_at, credited to the LATEST such touch (not the earliest)', () => {
  const fn = computeLastTouchFnBody();
  assert.match(fn, /const priorTouches = touches\.filter\(\(t\) => new Date\(t\.sentAt\)\.getTime\(\) <= completedMs\);/);
  assert.match(fn, /const lastTouch = priorTouches\[priorTouches\.length - 1\];/);
});

check('a job with no client_id, no real touches, or no prior touch honestly counts as unattributed (never guessed)', () => {
  const fn = computeLastTouchFnBody();
  const unattributedIncrements = (fn.match(/lastTouchUnattributedJobs\+\+/g) || []).length;
  assert.strictEqual(unattributedIncrements, 3, 'expected exactly 3 unattributed paths: no client_id, no touches, no prior touch');
});

check('revenue is only counted from a job\'s real total (> 0), rounded to cents, never fabricated', () => {
  const fn = computeLastTouchFnBody();
  assert.match(fn, /const val = Number\(j\.total\);/);
  assert.match(fn, /const cents = val > 0 \? Math\.round\(val \* 100\) : 0;/);
});

check('attributionCoveragePct is honestly null when there are zero completed jobs, never a fabricated 0 or 100', () => {
  const fn = computeLastTouchFnBody();
  assert.match(fn, /attributionCoveragePct: \(lastTouchAttributedJobs \+ lastTouchUnattributedJobs\) > 0\s*\n\s*\? Math\.round\(\(lastTouchAttributedJobs \/ \(lastTouchAttributedJobs \+ lastTouchUnattributedJobs\)\) \* 1000\) \/ 10\s*\n\s*: null,/);
});

check('an unsynced (not-yet-migrated) table degrades honestly to zeros/empty rather than failing the whole resource', () => {
  const fn = computeLastTouchFnBody();
  assert.match(fn, /if \(e\.notSynced\) \{/);
  assert.match(fn, /campaigns: \[\],\s*\n\s*totalAttributedJobs: 0,/);
});

check('a non-notSynced error is re-thrown, never silently swallowed', () => {
  const fn = computeLastTouchFnBody();
  assert.match(fn, /throw e;/);
});

check('per-campaign results expose only real last-touch job count/revenue fields, no fabricated fields', () => {
  const fn = computeLastTouchFnBody();
  assert.match(fn, /lastTouchJobCount: b\.lastTouchJobCount,/);
  assert.match(fn, /lastTouchRevenueCents: b\.lastTouchRevenueCents,/);
});

check('computeLastTouchAttribution is its own independent computation -- structural check it does not call or reuse computeFirstTouchAttribution internals', () => {
  const fn = computeLastTouchFnBody();
  assert.ok(!fn.includes('computeFirstTouchAttribution'), 'last-touch must be an independent computation, not a wrapper around first-touch');
});

check('handleAttributionGet calls both the real first-touch and last-touch computations and nests the last-touch result under lastTouch', () => {
  const fn = handleFnBody();
  assert.match(fn, /const result = await computeFirstTouchAttribution\(\);/);
  assert.match(fn, /const lastTouchResult = await computeLastTouchAttribution\(\);/);
  assert.match(fn, /lastTouch: lastTouchResult,/);
});

check('the pre-existing first-touch source label and result spread are unchanged', () => {
  const fn = handleFnBody();
  assert.match(fn, /source: 'HiveLogic \(real campaigns \+ campaign_recipients \+ jobs, first-touch attribution model\)',/);
  assert.match(fn, /\.\.\.result,/);
});

check('computeFirstTouchAttribution itself is untouched by this slice -- structural check that only one definition exists', () => {
  const matches = body.match(/async function computeFirstTouchAttribution\(\)/g) || [];
  assert.strictEqual(matches.length, 1, 'computeFirstTouchAttribution() must be defined exactly once -- this slice does not modify it');
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
