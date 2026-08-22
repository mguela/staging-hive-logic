import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Dev To-Do reported 7 NO_OUTCOME findings in council (the Boardroom). Live
// reproduction (clicking each control against production) found:
//  - the pin/star toggle and the project-request history cards genuinely
//    work today -- those 5 findings are stale, predating fixes already
//    shipped elsewhere (confirmed: clicking a history card now opens the
//    full run, and the title/timestamp elements are display:block, so
//    innerText no longer runs them together the way the "test projectAug
//    18..." finding shows).
//  - the Previous/Next history-carousel arrows are real and still broken:
//    they call host.scrollBy(...), a genuine, correct action that no
//    existing "did anything happen?" signal can see (not a mutation, fetch,
//    overlay, or toast).
//  - label() truncates every finding's label to 44 chars and prefers raw
//    innerText over an author-supplied aria-label, which is how "→"/"←"
//    ended up as the whole label for the two arrow buttons instead of their
//    aria-label ("Next/Previous Boardroom decisions"), and how a real
//    project request ("I'd like a master project created for this
//    discussion") got chopped to "...for this d".
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

function fakeEl(props) { return Object.assign({ scrollWidth: 100, clientWidth: 100, scrollHeight: 100, clientHeight: 100, scrollLeft: 0, scrollTop: 0 }, props); }

const scrollFpSrc = extractFunction(src, 'function scrollFp(doc)');
function runScrollFp(elements) {
  const ctx = vm.createContext({ result: undefined });
  ctx.__doc = { querySelectorAll: () => elements };
  vm.runInContext(`${scrollFpSrc}\nresult = scrollFp(__doc);`, ctx);
  return ctx.result;
}

test('a genuinely scrollable element contributes its scroll position to the fingerprint', () => {
  const scrolled = fakeEl({ scrollWidth: 1848, clientWidth: 956, scrollLeft: 744 });
  assert.equal(runScrollFp([scrolled]), 744);
});

test('an element that merely has content the same size as its box (not actually scrollable) contributes nothing', () => {
  const notScrollable = fakeEl({ scrollLeft: 50 }); // scrollWidth === clientWidth
  assert.equal(runScrollFp([notScrollable]), 0);
});

test('the fingerprint changes when a real scroll happens, catching the history carousel Previous/Next click', () => {
  const before = fakeEl({ scrollWidth: 1848, clientWidth: 956, scrollLeft: 0 });
  const after = fakeEl({ scrollWidth: 1848, clientWidth: 956, scrollLeft: 744 });
  assert.notEqual(runScrollFp([before]), runScrollFp([after]));
});

test('scrollFp is wired into the before/after click measurement and into moved', () => {
  assert.match(src, /bScroll = scrollFp\(sdoc\)/);
  assert.match(src, /aScroll = scrollFp\(sdoc\)/);
  assert.match(src, /scrolled = aScroll !== bScroll/);
  // canvasChanged/styled were appended later (see
  // selftest-crawler-canvas-style-filedialog.test.mjs) -- this only checks
  // that scrolled is still one of the signals, not the exact tail of the line.
  const movedLine = src.slice(src.indexOf('var moved ='), src.indexOf('\n', src.indexOf('var moved =')));
  assert.match(movedLine, /\|\| scrolled/);
});

const labelSrc = extractFunction(src, 'function label(el)');
function runLabel(el) {
  const ctx = vm.createContext({ result: undefined });
  ctx.__el = el;
  vm.runInContext(`${labelSrc}\nresult = label(__el);`, ctx);
  return ctx.result;
}
function fakeLabelEl({ innerText, value, ariaLabel, title }) {
  return { innerText, value, title, getAttribute: (name) => (name === 'aria-label' ? ariaLabel : undefined) };
}

test('an author-supplied aria-label wins over the bare glyph innerText of an icon-only button', () => {
  assert.equal(runLabel(fakeLabelEl({ innerText: '→', ariaLabel: 'Next Boardroom decisions' })), 'Next Boardroom decisions');
  assert.equal(runLabel(fakeLabelEl({ innerText: '←', ariaLabel: 'Previous Boardroom decisions' })), 'Previous Boardroom decisions');
  assert.equal(runLabel(fakeLabelEl({ innerText: '☆', ariaLabel: 'Pin this conversation' })), 'Pin this conversation');
});

test('an element with no aria-label still falls back to innerText, value, then title, unchanged', () => {
  assert.equal(runLabel(fakeLabelEl({ innerText: 'Save changes' })), 'Save changes');
  assert.equal(runLabel(fakeLabelEl({ innerText: '', value: 'draft-value' })), 'draft-value');
  assert.equal(runLabel(fakeLabelEl({ innerText: '', value: '', title: 'tooltip text' })), 'tooltip text');
});

test('the truncation limit was raised from 44 so a real project request is not chopped to a fragment', () => {
  const full = "I'd like a master project created for this discussion";
  const labeled = runLabel(fakeLabelEl({ innerText: full }));
  assert.ok(labeled.length > 44, `expected the raised limit to keep more than the old 44 chars, got ${labeled.length}`);
  assert.equal(labeled, full.slice(0, 90));
});

// ---- stale-finding confirmation (no app code change -- documents the live
// reproduction so a future reader doesn't re-investigate from scratch) ----
test('the council history feature that produced 5 of the 7 findings is fully wired, not a stale mock', () => {
  const appJs = readFileSync(new URL('../public/app-reina-council.js', import.meta.url), 'utf8');
  assert.match(appJs, /async function togglePin\(runId\)/);
  assert.match(appJs, /action: 'update_run_metadata', runId: runId, pinned: !row\.pinned/);
  assert.match(appJs, /async function loadRun\(runId\)/);
  const css = readFileSync(new URL('../public/reina-council.css', import.meta.url), 'utf8');
  // display:block on both is what makes innerText insert a real separator
  // between the title and the timestamp today (live-confirmed via
  // el.innerText in production) -- the concatenated "test projectAug 18..."
  // finding predates this rule.
  assert.match(css, /\.rc-history-open span,\.rc-history-open b,\.rc-history-open small\{display:block\}/);
});
