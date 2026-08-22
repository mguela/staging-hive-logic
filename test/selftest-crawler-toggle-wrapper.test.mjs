import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Command Center's map legend reported "Active Jobs Tech Locations All" as
// one NO_OUTCOME finding -- the label itself was the tell: it's the
// concatenated text of THREE separate <span onclick="mapView(...)"> options
// (Active Jobs / Tech Locations / All) living inside a <div class="toggle">
// wrapper. isTestable()'s class-name heuristic (meant to catch real controls
// wired via delegated listeners rather than an onclick attribute) matched
// "toggle" on the WRAPPER, not a control -- the div has no click handler of
// its own. Live-confirmed: clicking the wrapper does nothing; clicking a
// child span correctly switches the active map view.
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
function fakeEl({ tagName = 'DIV', className = '', onclick = false, role = null, children = [] } = {}) {
  return {
    tagName,
    className,
    children,
    hasAttribute: (name) => (name === 'onclick' ? onclick : false),
    getAttribute: (name) => (name === 'role' ? role : null),
  };
}

test('a class="toggle" wrapper whose children carry the real onclick handlers is not itself testable', () => {
  const child = fakeEl({ tagName: 'SPAN', onclick: true });
  const wrapper = fakeEl({ className: 'toggle', children: [child] });
  assert.equal(runIsTestable(wrapper), false);
});

test('a class="toggle" element with no onclick-bearing children is still testable (a real toggle control, not a group wrapper)', () => {
  const wrapper = fakeEl({ className: 'toggle', children: [] });
  assert.equal(runIsTestable(wrapper), true);
});

test('the child span itself is still testable via its own onclick attribute, independent of the wrapper fix', () => {
  const child = fakeEl({ tagName: 'SPAN', onclick: true });
  assert.equal(runIsTestable(child), true);
});

test('a real element with an onclick of its own is unaffected even if a sibling class also matches the heuristic', () => {
  // Guard against an overly broad fix: an element that legitimately owns its
  // own onclick must not be skipped just because it also has children.
  const grandchild = fakeEl({ tagName: 'SPAN' });
  const ownOnclick = fakeEl({ tagName: 'DIV', onclick: true, children: [grandchild] });
  assert.equal(runIsTestable(ownOnclick), true);
});

test('an unrelated class name is unaffected by the children check', () => {
  const wrapper = fakeEl({ className: 'not-a-recognized-class', children: [fakeEl({ onclick: true })] });
  assert.equal(runIsTestable(wrapper), false);
});
