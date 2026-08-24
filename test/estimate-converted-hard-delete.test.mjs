// test/estimate-converted-hard-delete.test.mjs
// jomell, 2026-08-25: "i want to delete the ones in the converted tab."
// Real hard delete (chosen via AskUserQuestion over a reversible archive,
// after being told converting created a real job row and staging shares the
// live production database). Frontend half of api/bookkeeping/estimates/
// delete.js -- covered separately in test/estimate-delete-converted.test.mjs.

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

function estimatesRowClickHandler() {
  const anchor = source.indexOf('window._hlEstEdit=isLocalRow');
  assert.ok(anchor > -1, 'the local/real branch on _hlEstEdit must exist');
  const start = source.lastIndexOf("document.addEventListener('click',function(e){", anchor);
  return source.slice(start, source.indexOf('},true);', anchor) + 10);
}

test('a converted estimate gets a hard-delete action, scoped to converted rows only', () => {
  const fn = estimatesRowClickHandler();
  assert.match(fn, /var hardDeleteBtn\s*=\s*\(nativeRow&&nativeRow\.lifecycleStatus===\s*'converted'\)/,
    'must not offer a hard delete on draft/sent/approved/archived rows');
  assert.match(fn, /efOpenHardDeleteEstimateModal\(nid,num\)/);
});

test('hard delete does not use window.prompt or window.confirm', () => {
  const fn = extractFunction(source, 'function efOpenHardDeleteEstimateModal(nid,num){');
  assert.doesNotMatch(fn, /window\.prompt|window\.confirm/,
    'must use the app\'s own hlModal() form, not a native browser dialog');
  assert.match(fn, /hlModal\(/);
});

test('deleting requires typing the estimate\'s own number to confirm', () => {
  const fn = extractFunction(source, 'function efOpenHardDeleteEstimateModal(nid,num){');
  assert.match(fn, /typed!==num/,
    'a generic "are you sure" confirm is too easy to click through on an irreversible action');
});

test('calls the real delete endpoint, and warns this cannot be undone', () => {
  const fn = extractFunction(source, 'function efOpenHardDeleteEstimateModal(nid,num){');
  assert.match(fn, /hlEstApi\('delete',\{id:nid\}\)/);
  assert.match(fn, /cannot be undone/);
});

test('a successful delete refreshes the native list, so the row disappears live', () => {
  const fn = extractFunction(source, 'function efOpenHardDeleteEstimateModal(nid,num){');
  assert.match(fn, /loadNativeEstimatesLive\(\)/);
});
