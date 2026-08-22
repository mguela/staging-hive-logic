// Phase 6 -- real past-customers-in-reactivation-window fact for the Plan
// tab's reference block. Reuses the existing computeReactivateCustomers()
// (already powering the Opportunities tab's "Reactivate Past Customers"
// card) rather than a second, duplicate jobs query -- same "reuse, don't
// duplicate" pattern established by the sibling realUnsoldEstimatesForPlan
// slice.

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
// project's prior slices (a regex ending in a literal "\n}\n" never matches
// this repo's real CRLF line endings).
function boundFn(startMarker, endMarker) {
  const startIdx = api.indexOf(startMarker);
  assert.ok(startIdx > -1, `start marker not found: ${startMarker}`);
  const endIdx = api.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, `end marker not found after start: ${endMarker}`);
  return api.slice(startIdx, endIdx);
}

const realPastCustomersFnBody = () => boundFn('async function realPastCustomersForPlan() {', 'async function realExistingLeadsForPlan() {');
const handleAssumptionsGetBody = () => boundFn('async function handleAssumptionsGet(req, res) {', 'async function handleAssumptionsPost(req, res) {');

check('realPastCustomersForPlan reuses computeReactivateCustomers() -- no duplicate jobs query', () => {
  const fn = realPastCustomersFnBody();
  assert.match(fn, /const result = await computeReactivateCustomers\(\);/);
  assert.doesNotMatch(fn, /fetchAllRows\(/, 'must not run its own jobs query -- reuse the existing computation instead');
});

check('realPastCustomersForPlan forwards only the real numeric fields (count, estRevenue), never the Opportunities-card-specific fields', () => {
  const fn = realPastCustomersFnBody();
  assert.match(fn, /return \{ count: result\.count, estRevenue: result\.estRevenue \};/);
  assert.doesNotMatch(fn, /result\.label/);
  assert.doesNotMatch(fn, /result\.actionLabel/);
  assert.doesNotMatch(fn, /result\.description/);
  assert.doesNotMatch(fn, /result\.key/);
});

check('realPastCustomersForPlan degrades honestly to zeros on a notSynced error', () => {
  const fn = realPastCustomersFnBody();
  assert.match(fn, /if \(e\.notSynced\) return \{ count: 0, estRevenue: 0 \};/);
});

check('realPastCustomersForPlan re-throws any non-notSynced error rather than silently swallowing it', () => {
  const fn = realPastCustomersFnBody();
  assert.match(fn, /catch \(e\) \{\s*\n\s*if \(e\.notSynced\) return \{ count: 0, estRevenue: 0 \};\s*\n\s*throw e;\s*\n\s*\}/);
});

check('handleAssumptionsGet calls realPastCustomersForPlan() alongside the pre-existing real facts in one Promise.all', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /const \[[^\]]*\brealPastCustomers\b[^\]]*\] = await Promise\.all\(\[/);
  assert.match(fn, /realPastCustomersForPlan\(\),/);
});

check('the reference block exposes realPastCustomersCount and realPastCustomersEstRevenue', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /realPastCustomersCount: realPastCustomers\.count,/);
  assert.match(fn, /realPastCustomersEstRevenue: realPastCustomers\.estRevenue,/);
});

check('the reference block\'s source string explicitly ties the count back to the Opportunities tab, avoiding the appearance of a second independently-computed number', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /shown on the Opportunities tab/);
  assert.match(fn, /not a separate estimate/);
});

check('the reference block honestly describes the zero-past-customers case rather than a fabricated claim', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /No past customers currently fall in the 6-24 month reactivation window\./);
});

check('the pre-existing real facts (company-wide avg job value / historical jobs per month) are unchanged', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /realAvgJobValueCents: realAvgJobValue,/);
  assert.match(fn, /realHistoricalJobsPerMonth: realHistJobsPerMonth,/);
});

check('computeReactivateCustomers is still defined exactly once (reused, not duplicated)', () => {
  const occurrences = (api.match(/async function computeReactivateCustomers\(\) \{/g) || []).length;
  assert.strictEqual(occurrences, 1);
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
