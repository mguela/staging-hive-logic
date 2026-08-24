import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Found 2026-08-22 investigating docs: "Create" (New Folder's confirm
// button) read NO_OUTCOME even after the empty-name toast fix was confirmed
// working in isolation. Root cause was in the crawler, not the app: New
// Folder's "Cancel" button sits BEFORE "Create" in DOM order inside the
// same modal. The overlay-exploration loop in tryClick tests every testable
// child of a just-opened panel in DOM order -- clicking "Cancel" first
// (live-confirmed) closes the modal and clears its confirm callback
// (HLDOC.modalOnConfirm = null), so the very next click on "Create" fires
// against a callback that no longer exists: a silent no-op caused by the
// loop's own ordering, not a broken button. closeAny() already has a
// proven-safe regex for identifying a panel's own dismiss control (used to
// auto-close panels between clicks) -- reused here to leave those controls
// for closeAny() to handle instead of clicking them mid-exploration.
const src = readFileSync(new URL('../public/tools/selftest.js', import.meta.url), 'utf8');

test('the overlay-exploration loop excludes close/cancel-labeled children before testing the rest', () => {
  const start = src.indexOf('if (opened && depth < 2)');
  const end = src.indexOf('closeAny(sdoc);', start);
  const block = src.slice(start, end);
  assert.match(block, /var CLOSEISH = \/close\|cancel\|not now\|stay\|got it\|dismiss\|×\|✕\|back\/i;/,
    'must reuse the exact same regex closeAny() already uses, not a new one that could drift out of sync');
  assert.match(block, /!CLOSEISH\.test\(label\(e\)\)/);
});

test('the exclusion regex is identical to the one closeAny() uses to find a dismiss control', () => {
  const closeAnyStart = src.indexOf('function closeAny(doc)');
  const closeAnyEnd = src.indexOf('\n  }', closeAnyStart);
  const closeAnySrc = src.slice(closeAnyStart, closeAnyEnd);
  const closeAnyMatch = closeAnySrc.match(/\/close\|cancel\|not now\|stay\|got it\|dismiss\|×\|✕\|back\/i/);
  const overlayLoopMatch = src.match(/var CLOSEISH = (\/close\|cancel\|not now\|stay\|got it\|dismiss\|×\|✕\|back\/i);/);
  assert.ok(closeAnyMatch && overlayLoopMatch, 'both regexes must exist');
  assert.equal(overlayLoopMatch[1], closeAnyMatch[0]);
});

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > -1, `${signature} must exist`);
  let depth = 0, i = source.indexOf('{', start);
  do {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < source.length);
  return source.slice(start, i);
}

const labelSrc = extractFunction(src, 'function label(el)');
function runLabel(el) {
  const ctx = vm.createContext({ result: undefined });
  ctx.__el = el;
  vm.runInContext(`${labelSrc}\nresult = label(__el);`, ctx);
  return ctx.result;
}
function fakeEl(text) {
  return { getAttribute: () => null, innerText: text, value: undefined };
}

test('the CLOSEISH regex actually matches the real labels it needs to (Cancel, ✕, Close) and not an unrelated confirm label', () => {
  const CLOSEISH = /close|cancel|not now|stay|got it|dismiss|×|✕|back/i;
  for (const text of ['Cancel', 'Close', '✕', 'Not now', 'Got it', 'Dismiss', 'Back']) {
    assert.equal(CLOSEISH.test(runLabel(fakeEl(text))), true, `"${text}" must be recognized as a dismiss control`);
  }
  for (const text of ['Create', 'Save', 'Update book · keep CO draft', 'Send question']) {
    assert.equal(CLOSEISH.test(runLabel(fakeEl(text))), false, `"${text}" must NOT be mistaken for a dismiss control`);
  }
});
