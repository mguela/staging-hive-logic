// Phase 6 -- real service-territory fact for the Plan tab's reference
// block. Reuses the exact haversine formula and office_location lookup
// already established by api/track1.js's Service Area map endpoint,
// rather than inventing a second distance calculation or office lookup.

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

const haversineFnBody = () => boundFn('function haversineMilesForPlan(lat1, lng1, lat2, lng2) {', 'async function realServiceTerritoryForPlan() {');
const territoryFnBody = () => boundFn('async function realServiceTerritoryForPlan() {', 'async function realChannelAvailabilityForPlan() {');
const handleAssumptionsGetBody = () => boundFn('async function handleAssumptionsGet(req, res) {', 'async function handleAssumptionsPost(req, res) {');

check('haversineMilesForPlan uses the same R=3958.8mi constant and formula shape as api/track1.js\'s existing haversineMiles', () => {
  const fn = haversineFnBody();
  assert.match(fn, /const R = 3958\.8;/);
  assert.match(fn, /Math\.sin\(dLat \/ 2\) \*\* 2 \+ Math\.cos\(toRad\(lat1\)\) \* Math\.cos\(toRad\(lat2\)\) \* Math\.sin\(dLng \/ 2\) \*\* 2/);
  assert.match(fn, /R \* 2 \* Math\.atan2\(Math\.sqrt\(a\), Math\.sqrt\(1 - a\)\)/);
});

check('realServiceTerritoryForPlan reads the real office_location singleton row (id=hq), the same row api/track1.js\'s map endpoint reads', () => {
  const fn = territoryFnBody();
  assert.match(fn, /fetchAllRows\('office_location', '\?id=eq\.hq&select=lat,lng'\)/);
});

check('realServiceTerritoryForPlan reads real geocoded client_locations, filtering to rows with a real lat', () => {
  const fn = territoryFnBody();
  assert.match(fn, /fetchAllRows\('client_locations', '\?select=lat,lng&lat=not\.is\.null'\)/);
});

check('realServiceTerritoryForPlan honestly reports officeSet:false when no real office_location row exists or its coordinates are not finite', () => {
  const fn = territoryFnBody();
  assert.match(fn, /if \(!office \|\| !isFinite\(Number\(office\.lat\)\) \|\| !isFinite\(Number\(office\.lng\)\)\) \{/);
  assert.match(fn, /return \{ geocodedCustomerCount: 0, avgDistanceMiles: null, maxDistanceMiles: null, officeSet: false \};/);
});

check('realServiceTerritoryForPlan honestly reports null distances when the office is set but no customer is geocoded yet', () => {
  const fn = territoryFnBody();
  assert.match(fn, /if \(!distances\.length\) \{/);
  assert.match(fn, /return \{ geocodedCustomerCount: 0, avgDistanceMiles: null, maxDistanceMiles: null, officeSet: true \};/);
});

check('realServiceTerritoryForPlan computes real average and max distance, rounded to one decimal mile, only from finite real coordinates', () => {
  const fn = territoryFnBody();
  assert.match(fn, /\.filter\(\(c\) => isFinite\(Number\(c\.lat\)\) && isFinite\(Number\(c\.lng\)\)\)/);
  assert.match(fn, /avgDistanceMiles: Math\.round\(\(sum \/ distances\.length\) \* 10\) \/ 10,/);
  assert.match(fn, /maxDistanceMiles: Math\.round\(Math\.max\(\.\.\.distances\) \* 10\) \/ 10,/);
});

check('realServiceTerritoryForPlan degrades honestly to officeSet:false on a notSynced table, and re-throws any other error', () => {
  const fn = territoryFnBody();
  assert.match(fn, /if \(e\.notSynced\) return \{ geocodedCustomerCount: 0, avgDistanceMiles: null, maxDistanceMiles: null, officeSet: false \};/);
  assert.match(fn, /throw e;\s*\n\s*\}\s*\n\}/);
});

check('handleAssumptionsGet calls realServiceTerritoryForPlan() alongside the pre-existing real facts in one Promise.all', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /const \[[^\]]*\brealServiceTerritory\b[^\]]*\] = await Promise\.all\(\[/);
  assert.match(fn, /realServiceTerritoryForPlan\(\),/);
});

check('the reference block exposes all 3 real service-territory fields', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /realServiceTerritoryCustomerCount: realServiceTerritory\.geocodedCustomerCount,/);
  assert.match(fn, /realServiceTerritoryAvgDistanceMiles: realServiceTerritory\.avgDistanceMiles,/);
  assert.match(fn, /realServiceTerritoryMaxDistanceMiles: realServiceTerritory\.maxDistanceMiles,/);
});

check('the reference block distinguishes the "office not geocoded" case from the "no customers geocoded yet" case, never a fabricated claim', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /Office location has not been geocoded yet -- set it to see real average\/max distance to your customers\./);
  assert.match(fn, /No customers have a geocoded address yet\./);
});

check('the pre-existing real facts (company-wide avg job value / historical jobs per month) are unchanged', () => {
  const fn = handleAssumptionsGetBody();
  assert.match(fn, /realAvgJobValueCents: realAvgJobValue,/);
  assert.match(fn, /realHistoricalJobsPerMonth: realHistJobsPerMonth,/);
});

check('the pre-existing Service Area map endpoint (api/track1.js handleMapLocations) is not touched by this file -- this slice only reads office_location/client_locations, same tables, no shared code changed', () => {
  // Structural sanity check: api/marketing.js must not define a second, conflicting handleMapLocations.
  assert.ok(!/function handleMapLocations/.test(api), 'api/marketing.js must not redefine handleMapLocations -- that endpoint lives in api/track1.js only');
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
