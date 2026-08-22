// Phase 6 -- real existing-leads fact for the Plan tab's reference block.
// Reads the same real lead_pipeline table already used by
// computeReferralOpportunities(), but counts every currently-active lead
// (any stage other than won/lost), not just referral-sourced ones.

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

const realExistingLeadsFnBody = () => boundFn('async function realExistingLeadsForPlan() {', 'async function realPriorCampaignResultsForPlan() {');
const handleAssumptionsGetBody = () => boundFn('async function handleAssumptionsGet(req, res) {', 'async function handleAssumptionsPost(req, res) {');

check('realExistingLeadsForPlan reads lead_pipeline with only stage and estimated_value selected', () => {
  const fn = realExistingLeadsFnBody();
  assert.match(fn, /fetchAllRows\('lead_pipeline', '\?select=stage,estimated_value'\)/);
});

check('realExistingLeadsForPlan filters to active leads (excludes won/lost) in JS, not a server-side not.in. filter', () => {
  const fn = realExistingLeadsFnBody();
  assert.match(fn, /r\.stage !== 'won' && r\.stage !== 'lost'/);
  assert.doesNotMatch(fn, /not\.in\./, 'this repo has no precedent for not.in. syntax -- filter in JS instead');
});

check('realExistingLeadsForPlan sums real estimated_value only over the active subset, rounded', () => {
  const fn = realExistingLeadsFnBody();
  assert.match(fn, /active\.reduce\(\(s, r\) => s \+ \(Number\(r\.estimated_value\) \|\| 0\), 0\)/);
  assert.match(fn, /return \{ count: active\.length, estRevenue: Math\.round\(estRevenue\) \};/);
});

check('realExistingLeadsForPlan degrades honestly to zeros on a notSynced error', () => {
  const fn = realExistingLeadsFnBody();
  assert.match(fn, /if \(e\.notSynced\) return \{ count: 0, estRevenue: 0 \};/);
});

check('realExistingLeadsForPlan re-throws any non-notSynced error rather than silently swallowing it', () => {
  const fn = realExistingLeadsFnBody();
  assert.match(fn, /catch \(e\) \{\s*\n\s*if \(e\.notSynced\) return \{ count: 0, estRevenue: 0 \};\s*\n\s*throw e;\s*\n\s*\}/);
});

check('handleAssumptionsGet calls realExistingLeadsForPlan() alongside the pre-existing real facts in one Promise.all', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /const \[[^\]]*\brealExistingLeads\b[^\]]*\] = await Promise\.all\(\[/);
  assert.match(fn, /realExistingLeadsForPlan\(\),/);
});

check('the reference block exposes realExistingLeadsCount and realExistingLeadsEstRevenue', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /realExistingLeadsCount: realExistingLeads\.count,/);
  assert.match(fn, /realExistingLeadsEstRevenue: realExistingLeads\.estRevenue,/);
});

check('the reference block honestly describes the zero-leads case rather than a fabricated claim', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /No leads are currently logged in the pipeline\./);
});

check('the pre-existing real facts (company-wide avg job value / historical jobs per month) are unchanged', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /realAvgJobValueCents: realAvgJobValue,/);
  assert.match(fn, /realHistoricalJobsPerMonth: realHistJobsPerMonth,/);
});

check('computeReferralOpportunities (the pre-existing real lead_pipeline consumer) is unchanged', () => {
  assert.match(api, /async function computeReferralOpportunities\(\) \{/);
  assert.match(api, /lead_source=eq\.referral/);
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
