// Phase 6 -- real prior-campaign-results fact for the Plan tab's reference
// block. Reuses Phase 18's existing computeFirstTouchAttribution() (the
// resource=attribution engine, computed live from
// campaigns/campaign_recipients/jobs) rather than a second, duplicate
// attribution computation. This branch was created off origin/main and then
// had the Phase 18 backend commit (e2c0cb3) cherry-picked onto it, since this
// slice has a genuine functional dependency on computeFirstTouchAttribution
// existing -- the same reasoned exception used for the attribution-frontend
// slice, not the "independent sibling, don't cherry-pick" pattern.

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

const realPriorCampaignFnBody = () => boundFn('async function realPriorCampaignResultsForPlan() {', 'async function realCompanyCamAvailabilityForPlan() {');
const handleAssumptionsGetBody = () => boundFn('async function handleAssumptionsGet(req, res) {', 'async function handleAssumptionsPost(req, res) {');

check('computeFirstTouchAttribution (Phase 18\'s attribution engine, brought in via cherry-pick) exists on this branch', () => {
  assert.match(api, /async function computeFirstTouchAttribution\(\) \{/);
});

check('realPriorCampaignResultsForPlan reuses computeFirstTouchAttribution() -- no duplicate attribution computation', () => {
  const fn = realPriorCampaignFnBody();
  assert.match(fn, /const result = await computeFirstTouchAttribution\(\);/);
  assert.doesNotMatch(fn, /fetchAllRows\(/, 'must not run its own campaigns/jobs query -- reuse the existing engine instead');
});

check('realPriorCampaignResultsForPlan has no try/catch of its own -- computeFirstTouchAttribution already degrades honestly', () => {
  const fn = realPriorCampaignFnBody();
  assert.doesNotMatch(fn, /try \{/);
  assert.doesNotMatch(fn, /catch \(/);
});

check('realPriorCampaignResultsForPlan forwards the exact real field names computeFirstTouchAttribution returns', () => {
  const fn = realPriorCampaignFnBody();
  assert.match(fn, /attributedJobs: result\.totalAttributedJobs,/);
  assert.match(fn, /unattributedJobs: result\.totalUnattributedJobs,/);
  assert.match(fn, /attributedRevenueCents: result\.totalAttributedRevenueCents,/);
  assert.match(fn, /coveragePct: result\.attributionCoveragePct,/);
});

check('handleAssumptionsGet calls realPriorCampaignResultsForPlan() alongside the pre-existing real facts in one Promise.all', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /const \[[^\]]*\brealPriorCampaignResults\b[^\]]*\] = await Promise\.all\(\[/);
  assert.match(fn, /realPriorCampaignResultsForPlan\(\),/);
});

check('the reference block exposes all 4 real prior-campaign-results fields', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /realPriorCampaignAttributedJobs: realPriorCampaignResults\.attributedJobs,/);
  assert.match(fn, /realPriorCampaignUnattributedJobs: realPriorCampaignResults\.unattributedJobs,/);
  assert.match(fn, /realPriorCampaignAttributedRevenueCents: realPriorCampaignResults\.attributedRevenueCents,/);
  assert.match(fn, /realPriorCampaignCoveragePct: realPriorCampaignResults\.coveragePct,/);
});

check('the reference block\'s source string ties the fact back to the Results & Attribution panel, avoiding the appearance of a second independently-computed attribution model', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /Same first-touch attribution model shown on the Results & Attribution panel/);
});

check('the reference block honestly describes the no-attributed-jobs case rather than a fabricated claim', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /No completed jobs with a real prior campaign send yet\./);
});

check('the pre-existing real facts (company-wide avg job value / historical jobs per month) are unchanged', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /realAvgJobValueCents: realAvgJobValue,/);
  assert.match(fn, /realHistoricalJobsPerMonth: realHistJobsPerMonth,/);
});

check('computeFirstTouchAttribution is still defined exactly once (reused, not duplicated)', () => {
  const occurrences = (api.match(/async function computeFirstTouchAttribution\(\) \{/g) || []).length;
  assert.strictEqual(occurrences, 1);
});

check('the pre-existing resource=attribution GET route (handleAttributionGet) is unchanged', () => {
  assert.match(api, /async function handleAttributionGet\(req, res\) \{/);
  assert.match(api, /resource === 'attribution' && req\.method === 'GET'/);
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
