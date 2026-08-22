// Phase 6 -- real connected-channel-availability fact for the Plan tab's
// reference block. Reuses the existing ccConnections() function (the same
// data the Command Center connections panel already shows) rather than
// inventing a second, independent connection-status computation.

import fs from 'node:fs';
import assert from 'node:assert';
import { execSync } from 'node:child_process';

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const apiPath = 'api/marketing.js';
const api = fs.readFileSync(apiPath, 'utf8');

check('api/marketing.js has valid syntax (node --check)', () => {
  execSync(`node --check ${apiPath}`, { stdio: 'pipe' });
});

// CRLF-safe indexOf-based bounding -- the established convention from this
// project's prior slices.
function boundFn(startMarker, endMarker) {
  const startIdx = api.indexOf(startMarker);
  assert.ok(startIdx > -1, `start marker not found: ${startMarker}`);
  const endIdx = api.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, `end marker not found after start: ${endMarker}`);
  return api.slice(startIdx, endIdx);
}

const availabilityFnBody = () => boundFn('async function realChannelAvailabilityForPlan() {', 'async function ccAssumptionsRow() {');
const handleAssumptionsGetBody = () => boundFn('async function handleAssumptionsGet(req, res) {', 'async function handleAssumptionsPost(req, res) {');

check('realChannelAvailabilityForPlan reuses the existing ccConnections() -- no second connection-status computation', () => {
  const fn = availabilityFnBody();
  assert.match(fn, /const connections = await ccConnections\(\);/);
});

check('realChannelAvailabilityForPlan counts real ready vs not-ready channels using the existing .ready flag ccConnections() already sets', () => {
  const fn = availabilityFnBody();
  assert.match(fn, /const readyCount = connections\.filter\(\(c\) => c\.ready\)\.length;/);
  assert.match(fn, /const notReady = connections\.filter\(\(c\) => !c\.ready\)\.map\(\(c\) => \(\{ label: c\.label, note: c\.note \}\)\);/);
});

check('realChannelAvailabilityForPlan returns readyCount, totalCount, and the real not-ready list -- no fabricated fields', () => {
  const fn = availabilityFnBody();
  assert.match(fn, /return \{ readyCount, totalCount: connections\.length, notReady \};/);
});

check('realChannelAvailabilityForPlan has no its own try\\/catch -- it deliberately lets ccConnections()\'s own notSynced handling stand, no duplicate error handling', () => {
  const fn = availabilityFnBody();
  assert.ok(!/try\s*\{/.test(fn), 'realChannelAvailabilityForPlan should not duplicate try/catch logic already inside ccConnections()');
});

check('handleAssumptionsGet calls realChannelAvailabilityForPlan() alongside the pre-existing real facts in one Promise.all', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /const \[[^\]]*\brealChannelAvailability\b[^\]]*\] = await Promise\.all\(\[/);
  assert.match(fn, /realChannelAvailabilityForPlan\(\),/);
});

check('the reference block exposes all 4 real channel-availability fields', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /realChannelAvailabilityReadyCount: realChannelAvailability\.readyCount,/);
  assert.match(fn, /realChannelAvailabilityTotalCount: realChannelAvailability\.totalCount,/);
  assert.match(fn, /realChannelAvailabilityNotReady: realChannelAvailability\.notReady,/);
});

check('the reference block distinguishes "0 channels ready" from "some channels ready", never a fabricated claim', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /channels launch-ready -- same status shown on the Command Center connections list\./);
  assert.match(fn, /channels launch-ready yet -- connect at least one to start planning a real forecast\./);
});

check('the pre-existing real facts (company-wide avg job value / historical jobs per month) are unchanged', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /realAvgJobValueCents: realAvgJobValue,/);
  assert.match(fn, /realHistoricalJobsPerMonth: realHistJobsPerMonth,/);
});

check('ccConnections() itself is untouched by this slice -- structural check that only one definition exists', () => {
  const matches = api.match(/async function ccConnections\(\)/g) || [];
  assert.strictEqual(matches.length, 1, 'ccConnections() must be defined exactly once -- this slice reuses it, not redefines it');
});

check('the Command Center endpoint (handleCommandCenterGet / ccPlan) is not modified by this slice -- structural check that only one definition exists', () => {
  const matches = api.match(/async function ccPlan\(budgetCents\)/g) || [];
  assert.strictEqual(matches.length, 1, 'ccPlan(budgetCents) must be defined exactly once -- this slice does not touch the Command Center plan logic');
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
