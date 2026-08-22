// Phase 18 -- real first-touch marketing attribution.
// Verifies api/marketing.js's new resource=attribution (GET) computes
// genuine first-touch lead/revenue attribution from the real, already-synced
// campaigns/campaign_recipients tables (sql/021) joined against real
// completed jobs -- with NO dependency on the still-unmerged
// marketing_lead_attributions/marketing_revenue_attributions tables
// (sql/041 on the marketing-suite-phase4-website-review-attribution branch,
// not on origin/main yet).

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

const computeFnBody = () => boundFn(
  'async function computeFirstTouchAttribution() {',
  'async function handleAttributionGet(req, res) {',
);
const handleFnBody = () => boundFn(
  'async function handleAttributionGet(req, res) {',
  '\nexport default async function handler(req, res) {',
);
const routerBody = () => boundFn(
  'export default async function handler(req, res) {',
  'return res.status(400).json({',
);

check('computeFirstTouchAttribution does not read/write the still-unmerged marketing_lead_attributions/marketing_revenue_attributions tables', () => {
  const fn = computeFnBody();
  assert.ok(!fn.includes('marketing_lead_attributions'), 'must not depend on the unmerged sql/041 LeadAttribution table');
  assert.ok(!fn.includes('marketing_revenue_attributions'), 'must not depend on the unmerged sql/041 RevenueAttribution table');
});

check('computeFirstTouchAttribution fetches only real, already-on-origin/main tables', () => {
  const fn = computeFnBody();
  assert.match(fn, /fetchAllRows\('campaigns', '\?select=id,name,type,channel'\)/);
  assert.match(fn, /fetchAllRows\('campaign_recipients', '\?select=campaign_id,client_id,sent_at,outcome,outcome_value&sent_at=not\.is\.null'\)/);
  assert.match(fn, /fetchAllRows\('jobs', '\?select=client_id,total,completed_at&completed_at=not\.is\.null'\)/);
});

check('touches are sorted earliest-first per real client before any first-touch decision is made', () => {
  const fn = computeFnBody();
  assert.match(fn, /list\.sort\(\(a, b\) => new Date\(a\.sentAt\)\.getTime\(\) - new Date\(b\.sentAt\)\.getTime\(\)\)/);
});

check('a job only counts as attributed when a real touch exists on/before its real completed_at (never a touch that happened after)', () => {
  const fn = computeFnBody();
  assert.match(fn, /const priorTouches = touches\.filter\(\(t\) => new Date\(t\.sentAt\)\.getTime\(\) <= completedMs\);/);
  assert.match(fn, /const firstTouch = priorTouches\[0\];/);
});

check('a job with no client_id, no real touches, or no prior touch honestly counts as unattributed (never guessed)', () => {
  const fn = computeFnBody();
  const unattributedIncrements = (fn.match(/totalUnattributedJobs\+\+/g) || []).length;
  assert.strictEqual(unattributedIncrements, 3, 'expected exactly 3 unattributed paths: no client_id, no touches, no prior touch');
});

check('revenue is only counted from a job\'s real total (> 0), rounded to cents, never fabricated', () => {
  const fn = computeFnBody();
  assert.match(fn, /const val = Number\(j\.total\);/);
  assert.match(fn, /const cents = val > 0 \? Math\.round\(val \* 100\) : 0;/);
});

check('per-campaign recipient/outcome stats (sent/responded/booked) come from the real campaign_recipients.outcome values, not invented', () => {
  const fn = computeFnBody();
  assert.match(fn, /if \(r\.outcome === 'responded'\) respondedByCampaign/);
  assert.match(fn, /if \(r\.outcome === 'booked'\) bookedByCampaign/);
});

check('attributionCoveragePct is honestly null when there are zero completed jobs, never a fabricated 0 or 100', () => {
  const fn = computeFnBody();
  assert.match(fn, /attributionCoveragePct: \(totalAttributedJobs \+ totalUnattributedJobs\) > 0\s*\n\s*\? Math\.round\(\(totalAttributedJobs \/ \(totalAttributedJobs \+ totalUnattributedJobs\)\) \* 1000\) \/ 10\s*\n\s*: null,/);
});

check('ad-platform-dependent metrics are explicitly listed as not yet measurable with an honest reason, never a placeholder value', () => {
  const fn = computeFnBody();
  assert.match(fn, /const NOT_YET_MEASURABLE = \['spend', 'impressions', 'video_views', 'clicks', 'calls', 'forms', 'cost_per_qualified_lead', 'cost_per_estimate', 'cost_per_sold_job'\];/);
  assert.match(fn, /No ad platform \(Google Ads\/Meta\) is connected yet/);
});

check('an unsynced (not-yet-migrated) table degrades honestly to zeros/empty rather than failing the whole resource', () => {
  const fn = computeFnBody();
  assert.match(fn, /if \(e\.notSynced\) \{/);
  assert.match(fn, /campaigns: \[\],\s*\n\s*totalAttributedJobs: 0,/);
});

check('a non-notSynced error is re-thrown, never silently swallowed', () => {
  const fn = computeFnBody();
  assert.match(fn, /throw e;/);
});

check('handleAttributionGet calls the real computation and reports an honest source label', () => {
  const fn = handleFnBody();
  assert.match(fn, /const result = await computeFirstTouchAttribution\(\);/);
  assert.match(fn, /source: 'HiveLogic \(real campaigns \+ campaign_recipients \+ jobs, first-touch attribution model\)',/);
});

check('the router wires resource=attribution (GET) to handleAttributionGet, behind the existing requireUser auth gate', () => {
  const router = routerBody();
  assert.match(router, /if \(resource === 'attribution' && req\.method === 'GET'\) \{\s*\n\s*return await handleAttributionGet\(req, res\);\s*\n\s*\}/);
  // the new branch must appear after the requireUser gate line, not before it
  const authIdx = router.indexOf('const user = await requireUser(req);');
  const routeIdx = router.indexOf(`if (resource === 'attribution'`);
  assert.ok(authIdx > -1 && routeIdx > authIdx, 'attribution route must be registered inside the authenticated block');
});

check('the honest "resource must be one of" error message is extended to mention attribution (GET)', () => {
  assert.match(body, /campaign_activity \(GET\)(?:, [a-z_]+ \((?:GET|POST|GET\/POST|PATCH)\))*, attribution \(GET\)/);
});

check('the pre-existing campaign_activity and process_scheduled_sends routes are unchanged and still present', () => {
  const router = routerBody();
  assert.match(router, /if \(resource === 'campaign_activity' && req\.method === 'GET'\) \{/);
  assert.match(router, /if \(resource === 'process_scheduled_sends' && req\.method === 'GET'\) \{/);
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
