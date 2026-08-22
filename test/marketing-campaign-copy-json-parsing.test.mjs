// Bug fix (2026-08-07): handleCampaignRegenerateCopyPost's JSON.parse(text)
// had zero tolerance for Claude wrapping its answer in a markdown ```json
// fence or adding a one-line lead-in -- which it reliably did for the
// review_request/estimate_recovery/reactivation campaign types (their
// sample facts embed a real job/quote title, often messy real-world text --
// ALL CAPS, slashes, apostrophes, parens -- unlike seasonal's title-free
// sample, which is why only seasonal ever parsed cleanly against
// production). Reproduced live: all 3 failed with "AI response was not
// valid JSON" on two consecutive calls each, while seasonal succeeded both
// times -- deterministic, not flaky. Fixed by stripping a fence and falling
// back to the outermost {...} substring before parsing.

import fs from 'node:fs';
import assert from 'node:assert';
import { execSync } from 'node:child_process';

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const apiPath = 'api/marketing.js';

check('api/marketing.js has valid syntax (node --check)', () => {
  execSync(`node --check ${apiPath}`, { stdio: 'pipe' });
});

const body = fs.readFileSync(apiPath, 'utf8');

function boundFn(startMarker, endMarker) {
  const startIdx = body.indexOf(startMarker);
  assert.ok(startIdx > -1, `start marker not found: ${startMarker}`);
  const endIdx = body.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, `end marker not found after start: ${endMarker}`);
  return body.slice(startIdx, endIdx);
}

const fnBody = () => boundFn(
  'async function handleCampaignRegenerateCopyPost(req, res) {',
  '\nasync function',
);

check('strips a leading markdown code fence before parsing', () => {
  assert.match(fnBody(), /replace\(\/\^```/);
});

check('falls back to the outermost {...} substring when a bare parse fails', () => {
  assert.match(fnBody(), /\\\{\[\\s\\S\]\*\\\}/);
});

check('still rejects genuinely non-JSON text with the original error message', () => {
  assert.match(fnBody(), /AI response was not valid JSON -- try again\./);
});

check('still validates subject/body are strings before returning 200', () => {
  assert.match(fnBody(), /typeof parsed\.subject !== 'string' \|\| typeof parsed\.body !== 'string'/);
});

check('does not persist to the campaigns table -- this handler only returns a draft for review', () => {
  const fn = fnBody();
  assert.ok(!/method:\s*['"]PATCH['"]/.test(fn), 'campaign_regenerate_copy must stay read-only; saving belongs to campaign_update');
});

let failed = 0;
for (const { name, fn } of checks) {
  try { fn(); console.log('ok -', name); }
  catch (e) { failed++; console.error('FAIL -', name, '\n   ', e.message); }
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed) process.exit(1);
