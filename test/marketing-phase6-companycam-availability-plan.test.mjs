// Phase 6 -- real CompanyCam photo/video availability fact for the Plan
// tab's reference block. Reads the same real media table already used by
// handleMarketingHealthGet's "content freshness" metric and by Content
// Studio caption generation, rather than inventing a second real-media
// source.

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

const realCompanyCamFnBody = () => boundFn('async function realCompanyCamAvailabilityForPlan() {', 'function haversineMilesForPlan(lat1, lng1, lat2, lng2) {');
const handleAssumptionsGetBody = () => boundFn('async function handleAssumptionsGet(req, res) {', 'async function handleAssumptionsPost(req, res) {');

check('realCompanyCamAvailabilityForPlan reads the real media table with only media_type and captured_at selected', () => {
  const fn = realCompanyCamFnBody();
  assert.match(fn, /fetchAllRows\('media', '\?select=media_type,captured_at'\)/);
});

check('realCompanyCamAvailabilityForPlan counts real PHOTO and VIDEO rows separately, matching the sql/006 media_type enum', () => {
  const fn = realCompanyCamFnBody();
  assert.match(fn, /r\.media_type === 'PHOTO'/);
  assert.match(fn, /r\.media_type === 'VIDEO'/);
});

check('realCompanyCamAvailabilityForPlan computes a real 90-day recent-capture count from real captured_at timestamps', () => {
  const fn = realCompanyCamFnBody();
  assert.match(fn, /since90 = Date\.now\(\) - 90 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(fn, /r\.captured_at && new Date\(r\.captured_at\)\.getTime\(\) >= since90/);
});

check('realCompanyCamAvailabilityForPlan honestly returns null daysSinceLastCapture when there are no real assets', () => {
  const fn = realCompanyCamFnBody();
  assert.match(fn, /let daysSinceLastCapture = null;/);
  assert.match(fn, /if \(rows\.length\) \{/);
});

check('realCompanyCamAvailabilityForPlan degrades honestly to all-zero/null on a notSynced table', () => {
  const fn = realCompanyCamFnBody();
  assert.match(fn, /if \(e\.notSynced\) return \{ totalCount: 0, photoCount: 0, videoCount: 0, recentCount: 0, daysSinceLastCapture: null \};/);
});

check('realCompanyCamAvailabilityForPlan re-throws any non-notSynced error rather than silently swallowing it', () => {
  const fn = realCompanyCamFnBody();
  assert.match(fn, /throw e;\s*\n\s*\}\s*\n\}/);
});

check('handleAssumptionsGet calls realCompanyCamAvailabilityForPlan() alongside the pre-existing real facts in one Promise.all', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /const \[[^\]]*\brealCompanyCamAvailability\b[^\]]*\] = await Promise\.all\(\[/);
  assert.match(fn, /realCompanyCamAvailabilityForPlan\(\),/);
});

check('the reference block exposes all 5 real CompanyCam fields', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /realCompanyCamTotalAssets: realCompanyCamAvailability\.totalCount,/);
  assert.match(fn, /realCompanyCamPhotoCount: realCompanyCamAvailability\.photoCount,/);
  assert.match(fn, /realCompanyCamVideoCount: realCompanyCamAvailability\.videoCount,/);
  assert.match(fn, /realCompanyCamRecentCount: realCompanyCamAvailability\.recentCount,/);
  assert.match(fn, /realCompanyCamDaysSinceLastCapture: realCompanyCamAvailability\.daysSinceLastCapture,/);
});

check('the reference block honestly describes the zero-assets case rather than a fabricated claim', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /No CompanyCam photos or videos synced yet\./);
});

check('the pre-existing real facts (company-wide avg job value / historical jobs per month) are unchanged', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /realAvgJobValueCents: realAvgJobValue,/);
  assert.match(fn, /realHistoricalJobsPerMonth: realHistJobsPerMonth,/);
});

check('the pre-existing Marketing Health content-freshness metric (also reading the real media table) is unchanged', () => {
  assert.match(api, /async function handleMarketingHealthGet\(req, res\) \{/);
  assert.match(api, /content_freshness/);
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
