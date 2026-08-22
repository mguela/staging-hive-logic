// test/marketing-command-center-results-attribution.test.mjs
// Marketing Suite Phase 18 -- wire the command-center Results tab to the
// real attribution engine (resource=attribution), closing the gap the
// Phase 18 Progress Log entry explicitly flagged: "the newer command-center
// Results tab still reuses the campaigns resource directly and has not yet
// been wired to resource=attribution (this slice only wired the legacy UI)."
//
// Reads the real shipped public/marketing-command-center/index.html (no
// copy, no mock file) and checks its actual renderResults() function
// structurally: the whole inline script is a self-invoking IIFE that fetches
// real data and mutates the DOM the moment it loads, so it is not safely
// executable in a headless Node test without a browser -- this test instead
// asserts on the real source text, the same technique the pre-existing
// marketing-command-center-nav.test.mjs uses.
//
// Run with:
//
//   node test/marketing-command-center-results-attribution.test.mjs
//
// Exit code 0 if every check passes, 1 if anything fails.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, '..', 'public', 'marketing-command-center', 'index.html');
const source = readFileSync(FILE, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function extractBlock(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error('start marker not found: ' + startMarker);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error('end marker not found after start: ' + endMarker);
  return src.slice(start, end + endMarker.length);
}

const renderResultsFn = () => extractBlock(source, 'function renderResults(data){', '\n  }');

check('inline script is still syntactically valid JavaScript', async () => {
  const vm = await import('node:vm');
  const scriptTagRe = /<script(?![^>]*src=)[^>]*>/i;
  const m = scriptTagRe.exec(source);
  assert.ok(m, 'inline <script> tag not found');
  const start = m.index + m[0].length;
  const end = source.indexOf('</script>', start);
  const scriptSrc = source.slice(start, end);
  new vm.Script(scriptSrc, { filename: 'marketing-command-center-inline.js' });
});

check('renderResults fetches the real attribution resource alongside campaigns, in one Promise.all', () => {
  const fn = renderResultsFn();
  assert.match(fn, /Promise\.all\(\[\s*api\('campaigns'\),\s*api\('attribution'\)\.catch\(function\(\)\{ return null; \}\),/,
    'expected campaigns + attribution fetched together, with attribution honestly degrading on its own failure');
});

check('the pre-existing campaigns table (recipients/sent/response-rate/booked/booked-value) is unchanged', () => {
  const fn = renderResultsFn();
  assert.match(fn, /c\.recipientCount/);
  assert.match(fn, /c\.sent/);
  assert.match(fn, /c\.responseRate==null \? '—' : c\.responseRate \+ '%'/);
  assert.match(fn, /c\.booked \+ '<\/td><td>' \+ money\(c\.bookedValue\)/);
});

check('attribution coverage/attributed-revenue/unattributed-jobs cards reuse the existing cc-cards-row/cc-stat-card styling, no new CSS classes', () => {
  const fn = renderResultsFn();
  assert.match(fn, /cc-cards-row/);
  assert.match(fn, /cc-card cc-stat-card/g);
  assert.match(fn, /attribution coverage/);
  assert.match(fn, /attributed revenue \(first-touch\)/);
  assert.match(fn, /unattributed jobs/);
});

check('coverage card honestly shows "Not yet" rather than a fabricated percent when coverage is null', () => {
  const fn = renderResultsFn();
  assert.match(fn, /coverage != null \? coverage \+ '%' : 'Not yet'/);
});

check('attributed revenue is converted from real cents to dollars before money(), matching the legacy panel\'s convention', () => {
  const fn = renderResultsFn();
  assert.match(fn, /money\(attrOk \? \(attr\.totalAttributedRevenueCents \|\| 0\) \/ 100 : 0\)/);
});

check('unattributed jobs card falls back to an honest dash, never a fabricated zero, when attribution failed to load', () => {
  const fn = renderResultsFn();
  assert.match(fn, /attrOk \? \(attr\.totalUnattributedJobs \|\| 0\) : '—'/);
});

check('per-campaign attribution table reads the real firstTouchJobCount/firstTouchRevenueCents fields, not the campaigns-resource fields', () => {
  const fn = renderResultsFn();
  assert.match(fn, /c\.recipientsSent/);
  assert.match(fn, /c\.respondedCount/);
  assert.match(fn, /c\.bookedCount/);
  assert.match(fn, /c\.firstTouchJobCount/);
  assert.match(fn, /c\.firstTouchRevenueCents \? money\(c\.firstTouchRevenueCents \/ 100\) : '—'/);
});

check('honest empty-state text distinguishes "no campaigns yet" from "attribution failed to load"', () => {
  const fn = renderResultsFn();
  assert.match(fn, /No campaigns yet -- attribution will populate once real campaigns send and jobs complete\./);
  assert.match(fn, /Could not load attribution\./);
});

check('the real notYetMeasurableReason text from the backend is surfaced verbatim, not a hardcoded frontend claim', () => {
  const fn = renderResultsFn();
  assert.match(fn, /attr\.notYetMeasurableReason \|\| ''/);
});

check('screenFor() still dispatches the results route to renderResults, unchanged', () => {
  const fn = extractBlock(source, 'function screenFor(route, data){', '// home: adaptive');
  assert.match(fn, /if \(route === 'results'\) return renderResults\(data\);/);
});

check('the pre-existing Plan tab (also reading cc-cards-row/cc-stat-card) is unchanged', () => {
  assert.match(source, /function renderPlan\(data\)\{/);
  assert.match(source, /Your Marketing Plan/);
});

// ---------- runner ----------
let pass = 0, fail = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log('  ok  -', name);
    pass++;
  } catch (e) {
    console.log('  FAIL -', name, '\n       ', e.message);
    fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed (of ${checks.length})`);
process.exit(fail ? 1 : 0);
