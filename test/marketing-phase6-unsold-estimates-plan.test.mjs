// Phase 6 -- real unsold-estimates facts for the Plan tab.
// Verifies api/marketing.js's handleAssumptionsGet now also returns
// realUnsoldEstimates alongside the pre-existing real facts, by reusing the
// Opportunity Engine's existing computeUnsoldEstimates() (real quotes table)
// rather than a second, duplicate query. computeUnsoldEstimates() itself
// does not catch a notSynced error, so this slice's own
// realUnsoldEstimatesForPlan() wrapper must catch it and honestly degrade to
// zeros rather than ever failing the whole Plan tab over an unsynced table.

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
// convention from this session's prior slices (a regex ending in a literal
// "\n}\n" never matches this repo's real CRLF line endings).
function boundFn(startMarker, endMarker) {
  const startIdx = body.indexOf(startMarker);
  assert.ok(startIdx > -1, `start marker not found: ${startMarker}`);
  const endIdx = body.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, `end marker not found after start: ${endMarker}`);
  return body.slice(startIdx, endIdx);
}

const realUnsoldEstimatesFnBody = () => boundFn(
  'async function realUnsoldEstimatesForPlan() {',
  'async function handleAssumptionsGet(req, res) {',
);
const handleAssumptionsGetBody = () => boundFn(
  'async function handleAssumptionsGet(req, res) {',
  '\nasync function handleAssumptionsPost',
);

check('realUnsoldEstimatesForPlan reuses the real computeUnsoldEstimates(), never a duplicate query', () => {
  const fn = realUnsoldEstimatesFnBody();
  assert.match(fn, /const estimates = await computeUnsoldEstimates\(\);/);
  assert.ok(!/fetchAllRows\('quotes'/.test(fn), 'must not run a second, duplicate quotes query -- reuse the existing function');
});

check('realUnsoldEstimatesForPlan only forwards the real numeric fields (count/estRevenue/staleCount/staleValue), not the opportunity-UI-specific fields', () => {
  const fn = realUnsoldEstimatesFnBody();
  assert.match(fn, /count: estimates\.count,/);
  assert.match(fn, /estRevenue: estimates\.estRevenue,/);
  assert.match(fn, /staleCount: estimates\.staleCount,/);
  assert.match(fn, /staleValue: estimates\.staleValue,/);
  assert.ok(!fn.includes('estimates.label') && !fn.includes('estimates.actionLabel') && !fn.includes('estimates.key'), 'must not leak Opportunities-card-specific fields (label/actionLabel/key) into Plan\'s reference block');
});

check('realUnsoldEstimatesForPlan honestly degrades to zeros (never fabricated data) when quotes is not synced', () => {
  const fn = realUnsoldEstimatesFnBody();
  assert.match(fn, /if \(e\.notSynced\) return \{ count: 0, estRevenue: 0, staleCount: 0, staleValue: 0 \};/);
});

check('realUnsoldEstimatesForPlan re-throws any non-notSynced error (never silently swallows a real failure)', () => {
  const fn = realUnsoldEstimatesFnBody();
  assert.match(fn, /throw e;/);
});

check('handleAssumptionsGet now calls realUnsoldEstimatesForPlan() alongside the pre-existing real facts', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /const \[[^\]]*\brealUnsoldEstimates\b[^\]]*\] = await Promise\.all\(\[/);
  assert.match(fn, /realUnsoldEstimatesForPlan\(\),/);
});

check('handleAssumptionsGet’s reference block includes realUnsoldEstimates with an honest, count-aware source description', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /realUnsoldEstimates,/);
  assert.match(fn, /realUnsoldEstimatesSource: realUnsoldEstimates\.count \? \(/);
  assert.match(fn, /: 'No open estimates are currently awaiting a client response\.',/);
});

check('the source description explicitly ties this back to the Opportunities tab (never presented as a second, independent estimate)', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /the same figures shown on the Opportunities tab, not a separate estimate/);
});

check('handleAssumptionsGet’s pre-existing real facts (company-wide avg job value / historical jobs per month) are unchanged', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /realAvgJobValueCents: realAvgJobValue,/);
  assert.match(fn, /realHistoricalJobsPerMonth: realHistJobsPerMonth,/);
});

check('computeUnsoldEstimates is still the single real source of unsold-estimate data (not redefined or duplicated)', () => {
  const matches = body.match(/async function computeUnsoldEstimates\(\)/g) || [];
  assert.strictEqual(matches.length, 1, 'computeUnsoldEstimates should still be defined exactly once, reused not duplicated');
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
