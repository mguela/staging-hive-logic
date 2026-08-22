import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Dev To-Do reported 6 NO_OUTCOME findings: HiveConnect's "Settings" (opens
// a class="settings-menu" panel), an estimate's "+ New RFI" (opens a
// class="jcv open" modal), and "⋯ More Actions" (efMoreMenuToggle) all
// genuinely open something -- confirmed live -- but public/tools/selftest.js's
// overlays() only recognizes specific class names ("modal"/"dialog"/"menu"/
// "dropdown"/"popover"/"sheet") or an inline style="position: fixed"/
// "z-index" attribute. Every view in this app names its overlay classes
// differently and sets position/z-index via a stylesheet rule, not an inline
// style, so none of those three real UI elements were ever going to match.
// overlayAmongMutations() instead inspects the actual elements the click's
// MutationObserver saw change, and asks a naming-independent question: did
// any of them become a visibly-sized, fixed/absolute-positioned, real
// z-indexed box? Live-confirmed against all three real cases plus a genuine
// no-op click (a plain heading) that must NOT be flagged.
const src = readFileSync(new URL('../public/tools/selftest.js', import.meta.url), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > -1, `${signature} must exist`);
  let depth = 0, i = source.indexOf('{', start);
  do {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < source.length);
  assert.equal(depth, 0, 'braces must balance');
  return source.slice(start, i);
}

const overlaySrc = extractFunction(src, 'function overlayAmongMutations(mutRecords)');

function fakeEl(nodeType, offsetHeight, offsetWidth, style) {
  return { nodeType, offsetHeight, offsetWidth, __style: style || {} };
}

function run(mutRecords, styleFor) {
  const ctx = vm.createContext({
    parseInt,
    getComputedStyle: (el) => (styleFor ? styleFor(el) : el.__style),
    result: undefined,
  });
  ctx.__records = mutRecords;
  vm.runInContext(`${overlaySrc}\nresult = overlayAmongMutations(__records);`, ctx);
  return ctx.result;
}

test('a real settings-menu-style panel (position:absolute, class name the selector never recognizes) is detected', () => {
  const target = fakeEl(1, 253, 190, { position: 'absolute', zIndex: '45' });
  assert.equal(run([{ target }]), true);
});

test('a real fixed-position modal (class="jcv open") is detected', () => {
  const target = fakeEl(1, 559, 800, { position: 'fixed', zIndex: '62' });
  assert.equal(run([{ target }]), true);
});

test('a hidden element (display:none, no layout box) is not counted, even if positioned', () => {
  const target = fakeEl(1, 0, 0, { position: 'fixed', zIndex: '70' });
  assert.equal(run([{ target }]), false);
});

test('a statically-positioned element that merely resized is not counted', () => {
  const target = fakeEl(1, 40, 300, { position: 'static', zIndex: 'auto' });
  assert.equal(run([{ target }]), false);
});

test('a positioned element with no real z-index (auto) is not counted', () => {
  const target = fakeEl(1, 40, 300, { position: 'absolute', zIndex: 'auto' });
  assert.equal(run([{ target }]), false);
});

test('a text-node mutation target (nodeType !== 1) is skipped without throwing', () => {
  const target = fakeEl(3, 40, 300, { position: 'fixed', zIndex: '10' });
  assert.equal(run([{ target }]), false);
});

test('an inert click producing only unrelated background mutations is not flagged (no false positive)', () => {
  const a = fakeEl(1, 20, 20, { position: 'static', zIndex: 'auto' });
  const b = fakeEl(1, 15, 200, { position: 'relative', zIndex: 'auto' });
  assert.equal(run([{ target: a }, { target: b }, { target: a }]), false);
});

test('the same target repeated across multiple mutation records is only style-checked once', () => {
  let calls = 0;
  const target = fakeEl(1, 253, 190, { position: 'absolute', zIndex: '45' });
  const result = run(
    [{ target }, { target }, { target }],
    (el) => { calls++; return el.__style; }
  );
  assert.equal(result, true);
  assert.equal(calls, 1, 'expected getComputedStyle to be called once per unique target, not once per mutation record');
});

// ---- disabled elements ----
// Dev To-Do also reported "Submit for review" (bookkeeping expense form,
// disabled until its own validation checklist passes) and doc-list
// "Next"/"Previous" (disabled -- only one page) as NO_OUTCOME. Live-confirmed
// all three are `disabled` buttons: a disabled element cannot fire a click
// handler at all (by spec), so reporting "nothing happened" mischaracterized
// a correctly-guarded control as broken.
test('a disabled element is skipped with its own verdict, not clicked and reported as NO_OUTCOME', () => {
  assert.match(src, /if \(el\.disabled\) \{ results\.push\(\{ view: CUR, depth: depth, label: lab, kind: kind, verdict: 'SKIPPED_DISABLED', note: 'element is disabled — not clicked' \}\); return; \}/);
});

test('the disabled check runs before the click-driven before/after measurement, so a disabled control never actually gets el.click() called', () => {
  const disabledCheckIdx = src.indexOf("verdict: 'SKIPPED_DISABLED'");
  const clickCallIdx = src.indexOf('el.click()');
  assert.ok(disabledCheckIdx > -1 && clickCallIdx > -1);
  assert.ok(disabledCheckIdx < clickCallIdx, 'the disabled short-circuit must come before the actual click');
});
