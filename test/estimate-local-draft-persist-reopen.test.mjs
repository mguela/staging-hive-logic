// test/estimate-local-draft-persist-reopen.test.mjs
// jomell, 2026-08-24: Jovie Folloso's estimate #2483 showed up in the
// Estimates list tagged "local draft", but clicking it did nothing useful,
// and it vanished entirely after a page refresh.
//
// Root cause (confirmed pre-existing via git blame, not caused by the
// efSave() real-backend fix landed the same day): ESTLIST is a plain
// in-memory array reset to a hardcoded seed on every page load, and the
// delegated row-click handler tried to recover a client id by regex-matching
// an onclick attribute the <tr> never had, always falling through to
// estFormNew(null) -- a brand-new blank estimate, discarding the original.
//
// These tests pin the actual fix: local-only saves persist their full EST
// snapshot (not just the summary row) to localStorage, ESTLIST rehydrates
// from that store on load, and the row click reopens the real draft instead
// of building a blank one. Editing an already-real (synced) estimate is
// explicitly out of scope -- there is no update-in-place server route for
// any resource yet -- so that fallback path must stay untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start > -1, `${decl} must exist`);
  let depth = 0, i = src.indexOf('{', start);
  do {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < src.length);
  assert.equal(depth, 0, 'braces must balance');
  return src.slice(start, i);
}

test('a local-only save persists the full EST snapshot, not just the summary row', () => {
  const fn = extractFunction(source, 'function efSave(){');
  assert.match(fn, /efLocalDraftsLoad\(\)/, 'must read the persisted local-drafts store');
  assert.match(fn, /efLocalDraftsSave\(drafts\)/, 'must write it back');
  assert.match(fn, /drafts\[priorLocalKey\]\s*=\s*\{\s*est\s*:/,
    'the stored record must include the full EST object, not only a display summary');
});

test('a real save removes the stale local-draft entry instead of leaving an orphan', () => {
  const fn = extractFunction(source, 'function efSave(){');
  assert.match(fn, /delete drafts\[priorLocalKey\]/,
    'once an estimate becomes real, its old local shadow copy should not linger');
});

test('the local-draft key is captured BEFORE efRemoteCreate() can overwrite EST.num', () => {
  // efRemoteCreate() sets EST.num to the server's own estimate number on
  // success. Reading EST.num only inside the .then() callback would look up
  // (and fail to delete) the wrong key.
  const fn = extractFunction(source, 'function efSave(){');
  const priorIdx = fn.indexOf('priorLocalKey=efLocalDraftKey(EST.num)');
  const thenIdx = fn.indexOf('efRemoteCreate().then(');
  assert.ok(priorIdx > -1 && thenIdx > -1 && priorIdx < thenIdx,
    'priorLocalKey must be captured before the efRemoteCreate() call, not inside its callback');
});

test('ESTLIST rehydrates persisted local drafts back in after a refresh', () => {
  const declEnd = source.indexOf('];', source.indexOf('var ESTLIST=['));
  const afterEstlist = source.slice(declEnd, declEnd + 900);
  assert.match(afterEstlist, /efLocalDraftsLoad\(\)/,
    'something right after the ESTLIST array literal must reload persisted local drafts');
  assert.match(afterEstlist, /ESTLIST\.unshift\(drafts\[key\]\.summary\)/,
    'each persisted draft\'s pre-built summary must be pushed back into ESTLIST');
});

test('clicking a local-draft row reopens its real data instead of a blank estimate', () => {
  const anchor = source.indexOf('window._hlEstEdit=isLocalRow');
  assert.ok(anchor > -1, 'the local/real branch on _hlEstEdit must exist');
  const start = source.lastIndexOf("document.addEventListener('click',function(e){", anchor);
  assert.ok(start > -1, 'the estimates-list delegated click handler must exist');
  const fn = source.slice(start, source.indexOf('},true);', anchor) + 10);
  assert.match(fn, /isLocalRow\s*=\s*rowKey\.indexOf\('local:'\)===0/,
    'must distinguish a local row from a real (already-synced) one');
  assert.match(fn, /efOpenLocalDraft\(rowKey\.slice\(6\)\)/,
    'a local row\'s Edit action must reopen the persisted draft');
});

test('a real (already-synced) row is left on its original fallback, unchanged', () => {
  // Explicitly out of scope: there is no update-in-place server route yet.
  const anchor = source.indexOf('window._hlEstEdit=isLocalRow');
  const start = source.lastIndexOf("document.addEventListener('click',function(e){", anchor);
  const fn = source.slice(start, source.indexOf('},true);', anchor) + 10);
  assert.match(fn, /estFormNew\(cid\)/, 'the non-local branch must still fall back the old way');
  assert.match(fn, /estFormNew\(null\)/, 'including the final blank-estimate catch, same as before');
});

test('each row carries the exact key eqRows() already computed, not a re-derived one', () => {
  const fn = extractFunction(source, 'function efListTable(){');
  assert.match(fn, /data-key="'\+esc\(e\.key\)\+'"/,
    'the row must expose eqRows()\'s own local:/real: key so the click handler never has to re-derive it');
});

test('a local draft that somehow disappeared from storage fails honestly, not silently', () => {
  const fn = extractFunction(source, 'function efOpenLocalDraft(key){');
  assert.match(fn, /chirpToast\(/, 'a missing draft must say so rather than doing nothing');
  assert.match(fn, /if\s*\(!rec\|\|!rec\.est\)/, 'must guard against a missing or malformed record');
});
