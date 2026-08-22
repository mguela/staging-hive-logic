import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Estimates reported one "Unnamed control" NO_OUTCOME (deduped across ~1000
// rows, since every row's checkbox cell shares the same empty label and
// empty className). Live-confirmed: it's <td onclick="event.stopPropagation()">
// wrapping the row's real <input type="checkbox"> -- the td's onclick exists
// solely to stop the checkbox click from bubbling up and also opening the
// row. It has no action of its own (clicking it can never produce an
// outcome, by design), and no accessible name (an empty td, not the
// checkbox), which is exactly why the label came back blank.
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

const isTestableSrc = extractFunction(src, 'function isTestable(el)');
function runIsTestable(el) {
  const ctx = vm.createContext({ result: undefined });
  ctx.__el = el;
  vm.runInContext(`${isTestableSrc}\nresult = isTestable(__el);`, ctx);
  return ctx.result;
}
function fakeEl({ tagName = 'DIV', className = '', onclick = null, role = null, children = [] } = {}) {
  return {
    tagName,
    className,
    children,
    hasAttribute: (name) => (name === 'onclick' ? onclick != null : false),
    getAttribute: (name) => (name === 'onclick' ? onclick : name === 'role' ? role : null),
  };
}

test('a td whose entire onclick is just event.stopPropagation() is not testable', () => {
  assert.equal(runIsTestable(fakeEl({ tagName: 'TD', onclick: 'event.stopPropagation()' })), false);
});

test('the trailing-semicolon form is also recognized', () => {
  assert.equal(runIsTestable(fakeEl({ tagName: 'TD', onclick: 'event.stopPropagation();' })), false);
});

test('a stopPropagation call combined with a REAL action is still testable -- only a bare stop is excluded', () => {
  assert.equal(runIsTestable(fakeEl({ tagName: 'TD', onclick: "event.stopPropagation();doSomething()" })), true);
});

test('a real BUTTON or A is never excluded by this check, even with a bare stopPropagation onclick', () => {
  assert.equal(runIsTestable(fakeEl({ tagName: 'BUTTON', onclick: 'event.stopPropagation()' })), true);
  assert.equal(runIsTestable(fakeEl({ tagName: 'A', onclick: 'event.stopPropagation()' })), true);
});

test('an element with a real onclick handler is unaffected', () => {
  assert.equal(runIsTestable(fakeEl({ tagName: 'SPAN', onclick: "mapView('jobs')" })), true);
});
