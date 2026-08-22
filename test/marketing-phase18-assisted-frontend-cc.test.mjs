// Phase 18 -- wire the real assisted attribution model into the
// command-center Results tab, alongside the already-shipped first-touch and
// last-touch rendering. Reuses the same real per-campaign lookup-by-id
// pattern the backend already exposes (api/marketing.js's assisted.campaigns
// array, keyed by campaignId) and this file's own cc-cards-row/cc-stat-card
// styling and em-dash missing-value convention -- no new CSS.

import fs from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';

const htmlPath = 'public/marketing-command-center/index.html';
const apiPath = 'api/marketing.js';

const html = fs.readFileSync(htmlPath, 'utf8');
const api = fs.readFileSync(apiPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

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

check('api/marketing.js really does return an assisted field for the frontend to read (cross-file check)', () => {
  assert.ok(api.includes('assisted: assistedResult,'), 'backend must actually expose assisted for this frontend addition to be honest');
});

check('renderResults reads the real attr.assisted object and builds a per-campaign lookup by the real campaignId field', () => {
  const fn = renderResultsBody();
  assert.match(fn, /var assisted = attrOk \? \(attr\.assisted \|\| null\) : null;/);
  assert.match(fn, /var assistedByCampaign = \{\};/);
  assert.match(fn, /\(assisted && assisted\.campaigns \|\| \[\]\)\.forEach\(function\(c\)\{ assistedByCampaign\[c\.campaignId\] = c; \}\);/);
});

check('the assisted KPI card only renders when the backend actually returned an assisted object, and shows a real count -- not a fabricated revenue figure', () => {
  const fn = renderResultsBody();
  assert.match(fn, /\(assisted \? \(/);
  assert.match(fn, /assisted\.totalAssistedConversions \|\| 0/);
  assert.ok(!/assisted\.\w*RevenueCents/.test(fn), 'assisted KPI card must not reference a fabricated revenue field');
});

check('each campaign row looks up its own real assisted-conversion count by campaignId, falling back to this file\'s own em-dash convention (never a fabricated zero) when missing', () => {
  const fn = renderResultsBody();
  assert.match(fn, /\(assistedByCampaign\[c\.campaignId\] \? assistedByCampaign\[c\.campaignId\]\.assistedConversions : '—'\)/);
});

check('the pre-existing first-touch and last-touch fields, campaigns table, and row order are unchanged -- this slice only appends one new cell', () => {
  const fn = renderResultsBody();
  ['recipientsSent', 'respondedCount', 'bookedCount', 'firstTouchJobCount', 'firstTouchRevenueCents'].forEach((field) => {
    assert.ok(fn.includes('c.' + field), `renderResults must still read c.${field}`);
  });
  assert.match(fn, /lt \? lt\.lastTouchJobCount : '—'/);
});

check('the empty-state colspan is bumped from 8 to 9 to match the new column', () => {
  const fn = renderResultsBody();
  assert.match(fn, /colspan="9" style="text-align:center;color:var\(--muted\)"/);
});

check('the note text now explains all three models, while keeping the real notYetMeasurableReason surfaced verbatim', () => {
  const fn = renderResultsBody();
  assert.match(fn, /Assisted model: a campaign is credited whenever it touched the customer before the closing send\./);
  assert.match(fn, /esc\(attr\.notYetMeasurableReason \|\| ''\)/);
});

check('the attribution table header adds an Assisted conversions column after the existing Last-touch revenue column', () => {
  assert.match(html, /<th>Last-touch revenue<\/th><th>Assisted conversions<\/th>/);
});

check('the pre-existing campaigns table (recipients/sent/response-rate/booked/booked-value) above the attribution section is unchanged', () => {
  const fn = renderResultsBody();
  assert.match(fn, /<th>Campaign<\/th><th>Recipients<\/th><th>Sent<\/th><th>Response rate<\/th><th>Booked<\/th><th>Booked value<\/th>/);
});

check('screenFor() still dispatches the results route to renderResults, unchanged', () => {
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
