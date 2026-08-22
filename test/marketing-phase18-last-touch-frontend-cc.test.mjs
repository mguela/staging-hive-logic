// Phase 18 -- wire the real last-touch attribution model into the
// command-center Results tab, alongside the already-shipped first-touch
// rendering. Reuses the same real per-campaign lookup-by-id pattern the
// backend already exposes (api/marketing.js's lastTouch.campaigns array,
// keyed by campaignId) and this file's own cc-cards-row/cc-stat-card
// styling -- no new CSS, mirroring the legacy dashboard's equivalent slice.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';

const htmlPath = 'public/marketing-command-center/index.html';
const apiPath = 'api/marketing.js';

const html = fs.readFileSync(htmlPath, 'utf8');
const api = fs.readFileSync(apiPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// CRLF-safe indexOf-based bounding -- the established convention from this
// project's prior slices.
function boundFn(text, startMarker, endMarker) {
  const startIdx = text.indexOf(startMarker);
  assert.ok(startIdx > -1, `start marker not found: ${startMarker}`);
  const endIdx = text.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, `end marker not found after start: ${endMarker}`);
  return text.slice(startIdx, endIdx);
}

const renderResultsBody = () => boundFn(html, 'function renderResults(data){', 'function screenFor(route, data){');

check('the inline <script> is still syntactically valid JavaScript', () => {
  const scriptTagRe = /<script(?![^>]*src=)[^>]*>/i;
  const m = scriptTagRe.exec(html);
  assert.ok(m, 'inline <script> tag not found');
  const start = m.index + m[0].length;
  const end = html.indexOf('</script>', start);
  new vm.Script(html.slice(start, end));
});

check('api/marketing.js really does return a lastTouch field for the frontend to read (cross-file check)', () => {
  assert.ok(api.includes('lastTouch: lastTouchResult,'), 'backend must actually expose lastTouch for this frontend addition to be honest');
});

check('renderResults reads the real attr.lastTouch object and builds a per-campaign lookup by the real campaignId field', () => {
  const fn = renderResultsBody();
  assert.match(fn, /var lastTouch = attrOk \? \(attr\.lastTouch \|\| null\) : null;/);
  assert.match(fn, /var lastTouchByCampaign = \{\};/);
  assert.match(fn, /\(lastTouch && lastTouch\.campaigns \|\| \[\]\)\.forEach\(function\(c\)\{ lastTouchByCampaign\[c\.campaignId\] = c; \}\);/);
});

check('the last-touch KPI card only renders when the backend actually returned a lastTouch object -- never fabricated on an older response', () => {
  const fn = renderResultsBody();
  assert.match(fn, /\(lastTouch \? \(/);
});

check('the last-touch KPI card converts totalAttributedRevenueCents to dollars before money(), same convention as the first-touch KPI, and reuses the existing cc-card/cc-stat-card classes', () => {
  const fn = renderResultsBody();
  assert.match(fn, /money\(\(lastTouch\.totalAttributedRevenueCents \|\| 0\) \/ 100\)/);
  assert.match(fn, /attributed revenue \(last-touch\)/);
});

check("each campaign row looks up its own real last-touch stats by campaignId, falling back to the file's existing em-dash convention (never a fabricated zero) when missing", () => {
  const fn = renderResultsBody();
  assert.match(fn, /var lt = lastTouchByCampaign\[c\.campaignId\];/);
  assert.match(fn, /\(lt \? lt\.lastTouchJobCount : '—'\)/);
  assert.match(fn, /\(lt && lt\.lastTouchRevenueCents \? money\(lt\.lastTouchRevenueCents \/ 100\) : '—'\)/);
});

check('the pre-existing first-touch fields, campaigns table, and row order are unchanged -- this slice only appends two new cells', () => {
  const fn = renderResultsBody();
  ['recipientsSent', 'respondedCount', 'bookedCount', 'firstTouchJobCount', 'firstTouchRevenueCents'].forEach((field) => {
    assert.ok(fn.includes('c.' + field), `renderResults must still read c.${field}`);
  });
  assert.match(fn, /money\(attrOk \? \(attr\.totalAttributedRevenueCents \|\| 0\) \/ 100 : 0\)/);
});

check('the empty-state colspan matches the true total column count -- 9 as of the later assisted-attribution slice, not a weakened check', () => {
  const fn = renderResultsBody();
  assert.match(fn, /colspan="9" style="text-align:center;color:var\(--muted\)"/);
});

check('the note text now explains both models, not just first-touch, while keeping the real notYetMeasurableReason surfaced verbatim', () => {
  const fn = renderResultsBody();
  assert.match(fn, /Last-touch model: the same real jobs credited to the latest real send instead\./);
  assert.match(fn, /esc\(attr\.notYetMeasurableReason \|\| ''\)/);
});

check('the attribution table header adds Last-touch jobs / Last-touch revenue columns after the existing First-touch revenue column', () => {
  assert.match(html, /<th>First-touch revenue<\/th><th>Last-touch jobs<\/th><th>Last-touch revenue<\/th>/);
});

check('the pre-existing campaigns table (recipients/sent/response-rate/booked/booked-value) above the attribution section is unchanged', () => {
  const fn = renderResultsBody();
  assert.match(fn, /<th>Campaign<\/th><th>Recipients<\/th><th>Sent<\/th><th>Response rate<\/th><th>Booked<\/th><th>Booked value<\/th>/);
});

check("screenFor() still dispatches the results route to renderResults, unchanged", () => {
  assert.match(html, /if \(route === 'results'\) return renderResults\(data\);/);
});

check('renderResults is still defined exactly once -- structural check, no duplication', () => {
  assert.strictEqual((html.match(/function renderResults\(data\)\{/g) || []).length, 1);
});

let pass = 0, fail = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  not ok  - ${name}\n    ${e.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed (of ${checks.length})`);
process.exit(fail ? 1 : 0);
