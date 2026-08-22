import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// A single batch of NO_OUTCOME findings spanning tox (HiveGrid), psx (Sub
// Portal), prx (Presentations), pnlx (P&L), and vcx (Vendor Catalog).
// Live-confirmed root causes, one per fix below.
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

// ---- canvasFp: HiveGrid's zoom/fit/hide-toggle redraw a <canvas>, invisible
// to every DOM-based signal -- live-confirmed WB.zoom changes and
// toDataURL() length changes on zoom in, zoom out, and fit page. ----
const canvasFpSrc = extractFunction(src, 'function canvasFp(doc)');
function runCanvasFp(canvases) {
  const ctx = vm.createContext({ result: undefined });
  ctx.__doc = { querySelectorAll: () => canvases };
  vm.runInContext(`${canvasFpSrc}\nresult = canvasFp(__doc);`, ctx);
  return ctx.result;
}
function fakeCanvas(dataUrl) { return { toDataURL: () => dataUrl }; }

test('a canvas redraw changes the fingerprint', () => {
  const before = runCanvasFp([fakeCanvas('data:image/png;base64,AAAA')]);
  const after = runCanvasFp([fakeCanvas('data:image/png;base64,BBBBBBBB')]);
  assert.notEqual(before, after);
});

test('an unchanged canvas produces an identical fingerprint', () => {
  const a = runCanvasFp([fakeCanvas('data:image/png;base64,SAME')]);
  const b = runCanvasFp([fakeCanvas('data:image/png;base64,SAME')]);
  assert.equal(a, b);
});

test('a tainted canvas (SecurityError on toDataURL) is treated as unknown, not a crash', () => {
  const tainted = { toDataURL: () => { throw new Error('SecurityError'); } };
  assert.doesNotThrow(() => runCanvasFp([tainted]));
});

test('a page with no canvas at all fingerprints identically on both sides', () => {
  assert.equal(runCanvasFp([]), runCanvasFp([]));
});

// ---- styleAmongMutations: an inline style attribute actually changing
// value is a specific-enough signal to trust, unlike a bare mutation count
// (already tried and rejected elsewhere in this file after a live-updating
// map was measured producing double-digit mutations on a genuinely inert
// click). Live-confirmed: a takeoff condition's eye toggle sets
// style="opacity:1" -> "opacity:.35"; Presentations' toast slides an inline
// transform, and its toast element has no id or class for toastText() to
// find either. ----
const styleAmongMutationsSrc = extractFunction(src, 'function styleAmongMutations(mutRecords)');
function runStyleAmongMutations(records) {
  const ctx = vm.createContext({ result: undefined });
  ctx.__records = records;
  vm.runInContext(`${styleAmongMutationsSrc}\nresult = styleAmongMutations(__records);`, ctx);
  return ctx.result;
}

test('a real inline style attribute mutation is detected', () => {
  assert.equal(runStyleAmongMutations([{ type: 'attributes', attributeName: 'style' }]), true);
});

test('an unrelated attribute mutation (e.g. class) is not mistaken for a style change', () => {
  assert.equal(runStyleAmongMutations([{ type: 'attributes', attributeName: 'class' }]), false);
});

test('a childList mutation alone is not counted (that is muts/docFp\'s job, not this one\'s)', () => {
  assert.equal(runStyleAmongMutations([{ type: 'childList', attributeName: null }]), false);
});

test('no mutations at all is correctly not styled', () => {
  assert.equal(runStyleAmongMutations([]), false);
});

// ---- both signals wired into the actual before/after measurement ----
test('canvasFp and styleAmongMutations are both captured before/after the click and folded into moved', () => {
  assert.match(src, /bCanvas = canvasFp\(sdoc\)/);
  assert.match(src, /aCanvas = canvasFp\(sdoc\)/);
  assert.match(src, /canvasChanged = aCanvas !== bCanvas/);
  assert.match(src, /styled = styleAmongMutations\(mutRecords\)/);
  assert.match(src, /var moved = aFp !== bFp \|\| aAct !== bAct \|\| muts > 3 \|\| d\.f\.length > 0 \|\| opened \|\| toastChanged \|\| selectionChanged \|\| scrolled \|\| canvasChanged \|\| styled;/);
});

// ---- MEDIA: "dictate" (Sub Portal's real-mic voice-dictation button) ----
test('a voice-dictation control is classified as media, not clicked', () => {
  const mediaLine = src.split('\n').find((l) => l.includes('var MEDIA ='));
  assert.match(mediaLine, /dictate/);
  const re = eval(mediaLine.slice(mediaLine.indexOf('/'), mediaLine.lastIndexOf('/') + 2));
  assert.equal(re.test('Dictate with voice'), true);
  assert.equal(re.test('Click to talk to Reina (dictate into this field)'), true);
  // Existing categories are unaffected.
  assert.equal(re.test('Start call'), true);
  assert.equal(re.test('Save changes'), false);
});

// ---- file-picker / download interception in installShield ----
test('installShield patches HTMLInputElement.click and HTMLAnchorElement.click so a real OS dialog never opens', () => {
  const installSrc = extractFunction(src, 'function installShield(win, doc)');
  assert.match(installSrc, /inputClick: win\.HTMLInputElement && win\.HTMLInputElement\.prototype\.click/);
  assert.match(installSrc, /anchorClick: win\.HTMLAnchorElement && win\.HTMLAnchorElement\.prototype\.click/);
  assert.match(installSrc, /if \(this\.type === 'file'\) \{ SHIELD\.stubbed\+\+; SHIELD\.calls\.push\(\{ t: performance\.now\(\), u: 'file-picker:' \+ \(this\.accept \|\| ''\), m: 'FILE-PICKER', decision: 'stub-write', s: 200 \}\); return; \}/);
  assert.match(installSrc, /if \(this\.hasAttribute\('download'\)\) \{ SHIELD\.stubbed\+\+; SHIELD\.calls\.push\(\{ t: performance\.now\(\), u: 'download:' \+ \(this\.getAttribute\('download'\) \|\| ''\), m: 'DOWNLOAD', decision: 'stub-write', s: 200 \}\); return; \}/);
});

test('a real (non-file) input click and a real (non-download) anchor click still fire normally', () => {
  const installSrc = extractFunction(src, 'function installShield(win, doc)');
  assert.match(installSrc, /return REAL\.inputClick\.apply\(this, arguments\);/);
  assert.match(installSrc, /return REAL\.anchorClick\.apply\(this, arguments\);/);
});

test('both patched .click() methods are restored on cleanup, matching every other shielded API', () => {
  const installSrc = extractFunction(src, 'function installShield(win, doc)');
  const restoreSrc = installSrc.slice(installSrc.indexOf('return function restore()'));
  assert.match(restoreSrc, /if \(REAL\.inputClick\) win\.HTMLInputElement\.prototype\.click = REAL\.inputClick;/);
  assert.match(restoreSrc, /if \(REAL\.anchorClick\) win\.HTMLAnchorElement\.prototype\.click = REAL\.anchorClick;/);
});

// ---- looksLikeTabGroup: the fourth (and hopefully last) tab-class-naming
// whack-a-mole instance -- fxtab, eqtab, tg, vsel all confirmed live ----
const looksLikeTabGroupSrc = extractFunction(src, 'function looksLikeTabGroup(el)');
function runLooksLikeTabGroup(el) {
  const ctx = vm.createContext({ result: undefined });
  ctx.__el = el;
  vm.runInContext(`${looksLikeTabGroupSrc}\nresult = looksLikeTabGroup(__el);`, ctx);
  return ctx.result;
}
function fakeTabEl(className, siblingClassNames) {
  const el = { className, matches: (sel) => /\.active|\.on|\.sel|\[aria-selected/.test(sel) && /(^|\s)(active|on|sel)(\s|$)/.test(className) };
  const siblings = (siblingClassNames || []).map((c) => ({ className: c }));
  el.parentElement = { children: [...siblings, el] };
  return el;
}

test('an element already marked selected, with a sibling sharing its base class, looks like a tab (vsel, tg, eqtab, fxtab all match this shape)', () => {
  assert.equal(runLooksLikeTabGroup(fakeTabEl('vsel on', ['vsel'])), true);
  assert.equal(runLooksLikeTabGroup(fakeTabEl('tg on', ['tg'])), true);
  assert.equal(runLooksLikeTabGroup(fakeTabEl('eqtab on', ['eqtab', 'eqtab'])), true);
});

test('an element NOT already marked selected is never treated as a tab by this check -- it can only widen the already-active skip, never suppress a real click', () => {
  assert.equal(runLooksLikeTabGroup(fakeTabEl('vsel', ['vsel on'])), false);
});

test('a lone element with no siblings sharing its class is not a tab group, even if marked active', () => {
  assert.equal(runLooksLikeTabGroup(fakeTabEl('featured on', ['unrelated-thing'])), false);
});

test('classify() reaches looksLikeTabGroup as one more path to the tab branch, alongside NAVISH and role=tab', () => {
  const classifySrc = src.slice(src.indexOf('function classify(el)'), src.indexOf('function lum(c)'));
  assert.match(classifySrc, /NAVISH\.test\(cls\) \|\| el\.getAttribute\('role'\) === 'tab' \|\| looksLikeTabGroup\(el\)/);
});
