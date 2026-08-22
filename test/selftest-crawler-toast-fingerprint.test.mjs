import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Found 2026-08-22, investigating vcx's "Hold cart" / "Update book · keep CO
// draft" / Home Depot Pro search reading NO_OUTCOME: all three call hlToast()
// and nothing else. toastText() looked for id="hlToast" or a class containing
// "toast" -- but grep across the whole app turned up ZERO elements with
// id="hlToast", ever. Every real hlToast() (public/index.html's own, plus its
// ~22 copy-pasted duplicates inside standalone iframe views like vcx)
// creates a bare `document.createElement('div')` with no id and no class,
// appended straight to <body>. Those two selectors were dead code outside a
// single unrelated view (`id="toast" class="toast"`) -- every toast-only
// action everywhere else was invisible to the crawler.
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

const toastTextSrc = extractFunction(src, 'function toastText(doc)');
function runToastText(doc) {
  const ctx = vm.createContext({ result: undefined, getComputedStyle: (el) => el.__style || {} });
  ctx.__doc = doc;
  vm.runInContext(`${toastTextSrc}\nresult = toastText(__doc);`, ctx);
  return ctx.result;
}
function fakeDiv({ id = '', className = '', text = '', style = {} } = {}) {
  return { id, className, textContent: text, __style: style };
}
function fakeDoc({ byId = null, byClass = null, bodyChildren = [] } = {}) {
  return { getElementById: () => byId, querySelector: () => byClass, body: { children: bodyChildren } };
}

test('toastText finds the real hlToast() pill via its structural fingerprint (fixed + pill radius, no id/class)', () => {
  const toast = fakeDiv({ text: 'Saved.', style: { position: 'fixed', borderRadius: '99px' } });
  assert.equal(runToastText(fakeDoc({ bodyChildren: [toast] })), 'Saved.');
});

test('an id="hlToast" or class*="toast" match, when present, still wins over the structural fallback', () => {
  const byId = fakeDiv({ id: 'hlToast', text: 'from getElementById' });
  const decoy = fakeDiv({ text: 'should not be picked', style: { position: 'fixed', borderRadius: '99px' } });
  assert.equal(runToastText(fakeDoc({ byId, bodyChildren: [decoy] })), 'from getElementById');
});

test('a fixed-position element that also carries an id or class is not mistaken for the bare toast div', () => {
  const withId = fakeDiv({ id: 'some-badge', text: 'noise', style: { position: 'fixed', borderRadius: '99px' } });
  const withClass = fakeDiv({ className: 'live-indicator', text: 'noise', style: { position: 'fixed', borderRadius: '99px' } });
  assert.equal(runToastText(fakeDoc({ bodyChildren: [withId] })), '');
  assert.equal(runToastText(fakeDoc({ bodyChildren: [withClass] })), '');
});

test('an ordinary fixed-position element (e.g. a modal backdrop) with normal corners is not mistaken for a toast', () => {
  const modal = fakeDiv({ text: 'Modal content', style: { position: 'fixed', borderRadius: '8px' } });
  assert.equal(runToastText(fakeDoc({ bodyChildren: [modal] })), '');
});

test('a pill-shaped element that is not position:fixed is not mistaken for a toast', () => {
  const pillBadge = fakeDiv({ text: 'Badge', style: { position: 'static', borderRadius: '99px' } });
  assert.equal(runToastText(fakeDoc({ bodyChildren: [pillBadge] })), '');
});

// A separate, second bug found in the same investigation: the Home Depot Pro
// search "card" is one clickable <div> with no accessible name of its own,
// wrapping three text-bearing children (a "HD" logo span, a name+description
// span, and a "SEARCH LIVE" badge span). label()'s aria-label -> innerText
// fallback chain had nothing to prefer, so it concatenated all three into one
// unreadable finding label. Fixed at the source (an explicit aria-label),
// not in the crawler -- this is a real missing accessible name, not a
// crawler heuristic gap.
test('the Home Depot Pro search card has an explicit accessible name instead of leaking its full innerText', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(page, /document\.getElementById\('vcQ'\)\.focus\(\);hlToast\('[^']*'\)&quot; style=&quot;cursor:pointer&quot; aria-label=&quot;Search Home Depot Pro&quot;/);
});

test('the real hlToast() style signature in public/index.html actually satisfies the structural match', () => {
  // Guards against the fix and the real markup drifting apart silently.
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(page.includes('window.hlToast=function(m)'), 'sanity: the app still creates hlToast this way');
  assert.ok(page.includes('position:fixed'), 'sanity: the app still uses position:fixed for its toast');
  assert.ok(page.includes('border-radius:99px'), "the real toast's border-radius must stay at/above the 40px fingerprint threshold");
});
