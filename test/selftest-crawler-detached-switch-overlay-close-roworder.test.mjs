import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Dev To-Do reported a batch of ~26 NO_OUTCOME findings across ajx, council,
// csx, docs, and cc. Investigated live/by-code and found four genuinely
// distinct crawler blind spots (not broken product features):
//
//  1. council: an earlier click in the same crawl pass (#rc-history-refresh)
//     rebuilds its container via innerHTML, detaching every history row/pin
//     button already captured in the crawler's one-time element snapshot --
//     clicking a detached node fires no listener at all.
//  2. csx: a role-less on/off switch ("dormant client reengage") flips an
//     `off` class + aria-checked, invisible to selectedKeys() (wrong
//     selector) and under the muts > 3 fallback (only 2 records).
//  3. docs/cc: closing an already-open modal/overlay produces no positive
//     signal -- overlayAmongMutations() only looks for something NEWLY
//     appearing, skipping anything whose offsetHeight has already collapsed
//     to 0 by the time it's checked.
//  4. ajx: a sortable table header rebuilds the whole table via innerHTML --
//     row count (docFp) is unchanged, no .active/.on/.sel class is involved,
//     and the full replace collapses into a handful of top-level mutation
//     records regardless of how much text actually reordered.
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

function runFn(signature, fnName, args, extraCtx) {
  const fnSrc = extractFunction(src, signature);
  const ctx = vm.createContext(Object.assign({ result: undefined }, extraCtx || {}));
  ctx.__args = args;
  vm.runInContext(`${fnSrc}\nresult = ${fnName}.apply(null, __args);`, ctx);
  return ctx.result;
}

// ---- switchState() ----

function fakeSwitch(label, ariaChecked) {
  return {
    textContent: label,
    getAttribute(name) { return name === 'aria-checked' ? ariaChecked : null; },
  };
}

function fakeDoc(nodes) {
  return { querySelectorAll: () => nodes };
}

test('switchState fingerprints an aria-checked toggle by label + value', () => {
  const before = runFn('function switchState(doc)', 'switchState', [fakeDoc([fakeSwitch('dormant client reengage', 'false')])]);
  const after = runFn('function switchState(doc)', 'switchState', [fakeDoc([fakeSwitch('dormant client reengage', 'true')])]);
  assert.notEqual(before, after, 'flipping aria-checked must change the fingerprint');
});

test('switchState is stable when nothing about the switch changed', () => {
  const a = runFn('function switchState(doc)', 'switchState', [fakeDoc([fakeSwitch('dormant client reengage', 'false')])]);
  const b = runFn('function switchState(doc)', 'switchState', [fakeDoc([fakeSwitch('dormant client reengage', 'false')])]);
  assert.equal(a, b);
});

// ---- rowOrderFp() ----

function fakeRow(cellText) {
  return { querySelector: () => (cellText == null ? null : { textContent: cellText }) };
}

test('rowOrderFp changes when a sortable table reorders rows with the same row count', () => {
  const before = runFn('function rowOrderFp(doc)', 'rowOrderFp', [fakeDoc([fakeRow('Alpha'), fakeRow('Bravo'), fakeRow('Charlie')])]);
  const after = runFn('function rowOrderFp(doc)', 'rowOrderFp', [fakeDoc([fakeRow('Charlie'), fakeRow('Alpha'), fakeRow('Bravo')])]);
  assert.notEqual(before, after, 'reordering rows must change the fingerprint even though the row count is identical');
});

test('rowOrderFp is stable when row order is unchanged', () => {
  const a = runFn('function rowOrderFp(doc)', 'rowOrderFp', [fakeDoc([fakeRow('Alpha'), fakeRow('Bravo')])]);
  const b = runFn('function rowOrderFp(doc)', 'rowOrderFp', [fakeDoc([fakeRow('Alpha'), fakeRow('Bravo')])]);
  assert.equal(a, b);
});

test('rowOrderFp tolerates a header row with no cell match', () => {
  assert.doesNotThrow(() => runFn('function rowOrderFp(doc)', 'rowOrderFp', [fakeDoc([fakeRow(null), fakeRow('Alpha')])]));
});

// ---- overlayClosed() ----

function fakeOverlayNode(isConnected, offsetHeight) {
  return { isConnected, offsetHeight };
}

test('overlayClosed detects a panel that was visible before the click and collapsed to zero height', () => {
  const result = runFn('function overlayClosed(beforeNodes)', 'overlayClosed', [[fakeOverlayNode(true, 0)]]);
  assert.equal(result, true);
});

test('overlayClosed detects a panel that was visible before the click and was removed from the DOM entirely', () => {
  const result = runFn('function overlayClosed(beforeNodes)', 'overlayClosed', [[fakeOverlayNode(false, 300)]]);
  assert.equal(result, true);
});

test('overlayClosed is false when the previously-visible panel is still visible after the click', () => {
  const result = runFn('function overlayClosed(beforeNodes)', 'overlayClosed', [[fakeOverlayNode(true, 300)]]);
  assert.equal(result, false);
});

test('overlayClosed is false when nothing was open before the click', () => {
  const result = runFn('function overlayClosed(beforeNodes)', 'overlayClosed', [[]]);
  assert.equal(result, false);
});

// ---- detached-element guard in tryClick() ----

test('tryClick skips a detached element with its own verdict instead of clicking it and reporting NO_OUTCOME', () => {
  assert.match(src, /if \(!el\.isConnected\) \{ results\.push\(\{ view: CUR, depth: depth, label: lab, kind: kind, verdict: 'SKIPPED_DETACHED'/);
});

test('the detached-element check runs before el.click() is ever called', () => {
  const detachedCheckIdx = src.indexOf("verdict: 'SKIPPED_DETACHED'");
  const clickCallIdx = src.indexOf('el.click()');
  assert.ok(detachedCheckIdx > -1 && clickCallIdx > -1);
  assert.ok(detachedCheckIdx < clickCallIdx, 'the detached short-circuit must come before the actual click');
});

// ---- all four signals actually feed the moved computation ----

test('closed, switched, and reordered are all wired into the moved computation, not just computed and discarded', () => {
  const tryClickSrc = extractFunction(src, 'async function tryClick(el, container, depth)');
  assert.match(tryClickSrc, /var closed = overlayClosed\(bVisibleOverlays\), switched = aSwitch !== bSwitch, reordered = aRowOrder !== bRowOrder/);
  assert.match(tryClickSrc, /var moved = [^;]*\|\| closed \|\| switched \|\| reordered/);
});
