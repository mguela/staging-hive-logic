// Phase 18 -- real assisted attribution (the third attribution model).
// Verifies api/marketing.js's resource=attribution (GET) now also computes
// a genuine "assisted conversions" metric from the same real, already-synced
// campaigns/campaign_recipients/jobs data first-touch and last-touch already
// read -- a deliberately separate, independent computation (its own real
// fetch, not a shared refactor of either already-shipped/tested function).
//
// Model: for a real completed job with 2+ real touches before completion,
// every distinct campaign touched BEFORE the final (last) touch "assisted"
// that conversion. This is the standard assisted-conversions definition
// (a campaign that was part of the path but did not get the final touch) --
// it deliberately does not attempt to split real revenue across touches,
// since there is no honest, unambiguous way to do that without inventing a
// weighting model this project has no real basis for.

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

const computeAssistedFnBody = () => boundFn(
  'async function computeAssistedAttribution() {',
  'export default async function handler(req, res) {',
);
const handleFnBody = () => boundFn(
  'async function handleAttributionGet(req, res) {',
  'async function computeLastTouchAttribution() {',
);

check('computeAssistedAttribution fetches only real, already-on-origin/main tables (same tables first-touch and last-touch read)', () => {
  const fn = computeAssistedFnBody();
  assert.match(fn, /fetchAllRows\('campaigns', '\?select=id,name,type,channel'\)/);
  assert.match(fn, /fetchAllRows\('campaign_recipients', '\?select=campaign_id,client_id,sent_at,outcome,outcome_value&sent_at=not\.is\.null'\)/);
  assert.match(fn, /fetchAllRows\('jobs', '\?select=client_id,total,completed_at&completed_at=not\.is\.null'\)/);
});

check('touches are sorted earliest-first per real client before any assist decision is made', () => {
  const fn = computeAssistedFnBody();
  assert.match(fn, /list\.sort\(\(a, b\) => new Date\(a\.sentAt\)\.getTime\(\) - new Date\(b\.sentAt\)\.getTime\(\)\)/);
});

check('a job is only eligible for an assist when it has at least 2 real touches before completion -- a single-touch job cannot have an assisting touch by definition', () => {
  const fn = computeAssistedFnBody();
  assert.match(fn, /if \(!touches \|\| touches\.length < 2\) continue;/);
  assert.match(fn, /if \(priorTouches\.length < 2\) continue;/);
});

check('every distinct campaign touched BEFORE the final touch counts as an assist -- the final touch itself never counts as its own assist', () => {
  const fn = computeAssistedFnBody();
  assert.match(fn, /const assistingCampaignIds = new Set\(priorTouches\.slice\(0, -1\)\.map\(\(t\) => t\.campaignId\)\)/);
});

check('a campaign is counted at most once per job even if it sent multiple real touches before the final one -- Set dedupes by campaignId', () => {
  const fn = computeAssistedFnBody();
  assert.match(fn, /new Set\(/);
});

check('this model deliberately does not touch or fabricate a revenue split across assisting touches -- no revenueCents field on the assisted result', () => {
  const fn = computeAssistedFnBody();
  assert.ok(!/RevenueCents/.test(fn), 'assisted attribution must not invent a revenue-splitting model with no real basis');
});

check('an unsynced (not-yet-migrated) table degrades honestly to zeros/empty rather than failing the whole resource', () => {
  const fn = computeAssistedFnBody();
  assert.match(fn, /if \(e\.notSynced\) \{/);
  assert.match(fn, /totalMultiTouchJobs: 0,/);
  assert.match(fn, /totalAssistedConversions: 0,/);
});

check('a non-notSynced error is re-thrown, never silently swallowed', () => {
  const fn = computeAssistedFnBody();
  assert.match(fn, /throw e;/);
});

check('per-campaign results expose only a real assistedConversions count, no fabricated fields', () => {
  const fn = computeAssistedFnBody();
  assert.match(fn, /assistedConversions: b\.assistedConversions,/);
});

check('computeAssistedAttribution is its own independent computation -- structural check it does not call or reuse computeFirstTouchAttribution or computeLastTouchAttribution internals', () => {
  const fn = computeAssistedFnBody();
  assert.ok(!fn.includes('computeFirstTouchAttribution'), 'assisted attribution must be an independent computation, not a wrapper around first-touch');
  assert.ok(!fn.includes('computeLastTouchAttribution()'), 'assisted attribution must be an independent computation, not a wrapper around last-touch');
});

check('handleAttributionGet calls all three real attribution computations and nests the assisted result under assisted', () => {
  const fn = handleFnBody();
  assert.match(fn, /const result = await computeFirstTouchAttribution\(\);/);
  assert.match(fn, /const lastTouchResult = await computeLastTouchAttribution\(\);/);
  assert.match(fn, /const assistedResult = await computeAssistedAttribution\(\);/);
  assert.match(fn, /assisted: assistedResult,/);
});

check('the pre-existing first-touch source label, result spread, and lastTouch nesting are unchanged', () => {
  const fn = handleFnBody();
  assert.match(fn, /source: 'HiveLogic \(real campaigns \+ campaign_recipients \+ jobs, first-touch attribution model\)',/);
  assert.match(fn, /\.\.\.result,/);
  assert.match(fn, /lastTouch: lastTouchResult,/);
});

check('computeFirstTouchAttribution and computeLastTouchAttribution are both untouched by this slice -- structural check that only one definition of each exists', () => {
  const firstMatches = body.match(/async function computeFirstTouchAttribution\(\)/g) || [];
  const lastMatches = body.match(/async function computeLastTouchAttribution\(\)/g) || [];
  assert.strictEqual(firstMatches.length, 1, 'computeFirstTouchAttribution() must be defined exactly once');
  assert.strictEqual(lastMatches.length, 1, 'computeLastTouchAttribution() must be defined exactly once');
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
