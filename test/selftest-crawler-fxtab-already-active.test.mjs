import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Financial Intelligence reported 3 of its 4 tab-strip clicks as stale
// NO_OUTCOME (the selectedKeys() content-diff fix, already shipped, already
// covers a real tab swap -- live-confirmed clicking "Leak Radar" switches the
// active tab correctly). The 4th, "CASH & DEPOSITS", was a real gap: it's
// the ALREADY-active tab, and clicking an already-active tab is correctly a
// no-op everywhere else in the app via the `kind === 'tab'` already-active
// skip -- but Financial Intelligence's tab strip uses class="fxtab", not the
// bare word "tab", so classify() fell through to 'action' and never applied
// that skip. Live-confirmed: clicking the already-active tab again produces
// zero change (correct behavior), but with no skip to say so it read as a
// broken control instead of a working, already-satisfied one.
const src = readFileSync(new URL('../public/tools/selftest.js', import.meta.url), 'utf8');

function extractNavish(source) {
  const start = source.indexOf('var NAVISH = ');
  assert.ok(start > -1, 'NAVISH must exist');
  const end = source.indexOf(';', start);
  return source.slice(start, end + 1);
}

function runNavish(className) {
  const ctx = vm.createContext({ result: undefined });
  vm.runInContext(`${extractNavish(src)}\nresult = NAVISH.test(${JSON.stringify(className)});`, ctx);
  return ctx.result;
}

test('a class ending in "tab" (a view-prefixed tab strip, not the bare word) is recognized as tab-ish', () => {
  assert.equal(runNavish('fxtab on'), true);
  assert.equal(runNavish('fxtab'), true);
});

test('the bare word "tab" and the previously-explicit "ptab" still match, unchanged', () => {
  assert.equal(runNavish('tab active'), true);
  assert.equal(runNavish('ptab'), true);
});

test('an unrelated class is still not matched', () => {
  assert.equal(runNavish('qcard sel'), false);
  assert.equal(runNavish('rc-history-pin'), false);
});

test('classify() reaches the tab branch before falling through to action, so the already-active skip now applies to fxtab', () => {
  const classifySrc = src.slice(src.indexOf('function classify(el)'), src.indexOf('function lum(c)'));
  const navishIdx = classifySrc.indexOf('NAVISH.test(cls)');
  const actionIdx = classifySrc.indexOf("return 'action'");
  assert.ok(navishIdx > -1 && actionIdx > -1 && navishIdx < actionIdx);
});
