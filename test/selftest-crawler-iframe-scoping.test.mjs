import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// public/tools/selftest.js is the QA crawler (Settings -> Run Self-Test).
// Found 2026-08-18, investigating a batch of NO_OUTCOME findings across
// jsx/ldx: docFp(), overlays(), overlayNodes(), toastText(), and the
// MutationObserver all hardcoded the OUTER page's `document`. Every
// if-XXX embedded view (jsx, ldx, tox, repx, mpmx...) renders inside its
// own <iframe> with a completely separate contentDocument -- a click
// inside one (a map zoom, a modal open, a toast-only action, a job-card
// selection toggling its own `.sel` class) is a real, visible change, but
// entirely inside that iframe's document. Every "did anything change?"
// check kept watching the outer page and correctly saw nothing there,
// mis-flagging real, working controls as NO_OUTCOME across every
// iframe-embedded view in the app.
const src = readFileSync(new URL('../public/tools/selftest.js', import.meta.url), 'utf8');

test('the detection helpers take an explicit scope document instead of a hardcoded outer document', () => {
  assert.match(src, /function overlays\(doc\) \{ return \(doc \|\| document\)/);
  assert.match(src, /function overlayNodes\(doc\) \{ return \[\]\.slice\.call\(\(doc \|\| document\)/);
  assert.match(src, /function toastText\(doc\) \{ var d = doc \|\| document;/);
  assert.match(src, /function docFp\(doc\) \{ return \(doc \|\| document\)/);
  assert.match(src, /function closeAny\(doc\) \{/);
});

test('tryClick derives the scope document from the clicked element, not the outer page', () => {
  assert.match(src, /var sdoc = \(el\.ownerDocument\) \|\| document;/);
  // Every before/after check must use sdoc, not a bare document/element call.
  assert.match(src, /var bFp = docFp\(sdoc\), bOv = overlays\(sdoc\), bAct = sdoc\.querySelectorAll\(/);
  assert.match(src, /var aFp = docFp\(sdoc\), aOv = overlays\(sdoc\), aAct = sdoc\.querySelectorAll\(/);
  assert.match(src, /mo\.observe\(sdoc\.body,/);
  assert.match(src, /var panels = overlayNodes\(sdoc\);/);
  assert.match(src, /closeAny\(sdoc\);/);
});

test('no detection helper still reads the bare global document internally (the exact regression this fixes)', () => {
  const helpers = ['overlays', 'overlayNodes', 'toastText', 'docFp'];
  for (const name of helpers) {
    const start = src.indexOf(`function ${name}(doc)`);
    assert.ok(start > -1, `${name} must exist and take a doc parameter`);
    const body = src.slice(start, src.indexOf('\n', start));
    // The only allowed bare `document` reference is the `|| document`
    // fallback for when no scope doc is supplied.
    const bareDocumentUses = (body.match(/\bdocument\b/g) || []).length;
    const fallbackUses = (body.match(/\|\| document\b/g) || []).length;
    assert.equal(bareDocumentUses, fallbackUses,
      `${name} references \`document\` directly somewhere other than its \`|| document\` fallback -- that reintroduces the outer-page-only bug`);
  }
});

test('toastText still tries id="hlToast" / class*="toast" first, before falling back to the structural match', () => {
  // Found 2026-08-22: neither selector was ever actually reachable except by
  // one lone view -- every real hlToast() implementation in public/index.html
  // (main page and ~24 embedded views) creates a bare, id-less, class-less
  // div. Kept as the first-checked path (cheap, and correct on the one view
  // that does use them) with the structural fallback in
  // selftest-crawler-toast-fingerprint.test.mjs covering everything else.
  assert.match(src, /d\.getElementById\('hlToast'\) \|\| d\.querySelector\('\[class\*="toast"\]'\)/);
});

// ---- a second, separate bug found investigating the same NO_OUTCOME batch:
// a tab/card SWAPPING which sibling is selected leaves the page-wide
// aria-selected/.sel/.active/.on COUNT unchanged (one loses it, another
// gains it, net zero), and a minimal two-element class swap can land
// exactly at muts === 3 -- the existing `muts > 3` check requires MORE than
// 3 and misses it. Confirmed live against a real Job Setup & Readiness job
// card. Raising the threshold is not a safe fix on its own: a live-updating
// view (e.g. Live Dispatch's polling map) was measured producing muts in
// the double digits on a genuinely INERT click (an avatar-initials badge
// with no onclick at all), so a looser global threshold trades one false
// positive for a different one.
//
// The first attempt fixed this by tracking the CLICKED element's own
// className before/after -- rejected after live testing: a click handler
// that rebuilds its list via innerHTML (confirmed on the same job-card
// queue) replaces that element's DOM node entirely, so the captured
// reference's class never reflects the new element's state no matter how
// long the wait. selectedKeys() re-queries by content on both sides
// instead of holding a reference, which sidesteps replacement AND stays
// immune to unrelated background mutation noise (it only reflects the
// specific set of "selected"-looking elements, not raw DOM churn).
test('selectedKeys() identifies WHICH elements look selected by content, not by count or DOM reference', () => {
  assert.match(src, /function selectedKeys\(doc\) \{ return \[\]\.slice\.call\(\(doc \|\| document\)\.querySelectorAll\('\.active,\.on,\.sel,\[aria-selected="true"\]'\)\)\.map\(/);
});

test('tryClick compares the selected-keys snapshot before and after the click, re-queried both times', () => {
  assert.match(src, /var bSelKeys = selectedKeys\(sdoc\);/);
  assert.match(src, /var aSelKeys = selectedKeys\(sdoc\);/);
  assert.match(src, /selectionChanged = aSelKeys !== bSelKeys/);
});

test('selectionChanged is one of the signals that can mark a click as having a real outcome', () => {
  const movedLine = src.slice(src.indexOf('var moved ='), src.indexOf('\n', src.indexOf('var moved =')));
  assert.match(movedLine, /\|\| selectionChanged/);
  // The pre-existing signals must still all be present -- this is additive,
  // not a replacement for the page-wide checks (which still catch things
  // selectionChanged cannot, like a newly-opened modal or a fetch firing).
  for (const signal of ['aFp !== bFp', 'aAct !== bAct', 'muts > 3', 'd.f.length > 0', 'opened', 'toastChanged']) {
    assert.ok(movedLine.includes(signal), `expected the pre-existing "${signal}" signal to still be part of the moved check`);
  }
});
