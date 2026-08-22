// test/marketing-command-center-nav.test.mjs
// Marketing Suite Phase 3 -- Ready for You nav promotion regression test.
// Reads the real shipped public/marketing-command-center/index.html (no copy,
// no mock file) and checks its actual NAV array and screenFor() dispatcher
// structurally: the whole inline script is a self-invoking IIFE that fetches
// real data and mutates the DOM the moment it loads, so it is not safely
// executable in a headless Node test without a browser -- this test instead
// asserts on the real source text, which is enough to catch the two ways this
// promotion could regress: the nav entry disappearing, or the route stopping
// dispatching to renderReadyForYou.
//
// Run with:
//
//   node test/marketing-command-center-nav.test.mjs
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

check('NAV array has exactly one ready_for_you entry, labeled "Ready for You"', () => {
  const nav = extractBlock(source, 'var NAV = [', '];');
  const matches = nav.match(/key:'ready_for_you'/g) || [];
  assert.equal(matches.length, 1, 'expected exactly one ready_for_you NAV entry, found ' + matches.length);
  assert.match(nav, /\{key:'ready_for_you', label:'Ready for You', icon:'rocket'\}/, 'ready_for_you entry must have the exact expected shape');
});

check('ready_for_you sits between plan and calendar in NAV (matches the target final ordering)', () => {
  const nav = extractBlock(source, 'var NAV = [', '];');
  const planIdx = nav.indexOf("key:'plan'");
  const rfyIdx = nav.indexOf("key:'ready_for_you'");
  const calIdx = nav.indexOf("key:'calendar'");
  assert.ok(planIdx > -1 && rfyIdx > -1 && calIdx > -1, 'all three keys must be present');
  assert.ok(planIdx < rfyIdx && rfyIdx < calIdx, 'expected order plan -> ready_for_you -> calendar, got indices ' + JSON.stringify({planIdx, rfyIdx, calIdx}));
});

check('screenFor() dispatches the ready_for_you route directly to renderReadyForYou', () => {
  const fn = extractBlock(source, 'function screenFor(route, data){', '// home: adaptive');
  assert.match(fn, /if \(route === 'ready_for_you'\) return renderReadyForYou\(data\);/, 'expected an explicit ready_for_you route branch');
});

check('the pre-existing Home-adaptive fallback to Ready for You is unchanged (no regression)', () => {
  const fn = extractBlock(source, '// home: adaptive', 'function route(){');
  assert.match(fn, /if \(data\.readyForYou\.items\.length\) return renderReadyForYou\(data\);/, 'Home must still fall back to Ready for You when there are items -- this must not regress just because it also has a direct nav entry now');
});

check('renderReadyForYou is still defined and unmodified in shape', () => {
  assert.match(source, /function renderReadyForYou\(data\)\{/, 'renderReadyForYou function definition must still exist');
});

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
