// test/estimate-approved-cancel.test.mjs
// jomell, 2026-08-25: "since im done testing out the feature in estimates, i
// should be able to delete the records. either in approved tab or converted
// tab i should be able to remove them."
//
// api/bookkeeping/estimates/cancel.js's own comment says cancellation is
// "Always reasoned and kept in history — never a silent delete", and staging
// shares the live production Supabase database with hivelogic-live, so this
// is deliberately NOT a hard delete. Chose (with jomell, via AskUserQuestion)
// the cancel/archive route: an approved estimate can be moved to Archived
// with a reason, matching the app's own audit-trail design. Converted
// estimates are out of scope -- cancelEstimate() itself doesn't accept
// 'converted' (it already became a real job by then).

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

test('an approved estimate gets a Cancel action, scoped to approved rows only', () => {
  const fn = estimatesRowClickHandler();
  assert.match(fn, /var cancelBtn\s*=\s*\(nativeRow&&nativeRow\.lifecycleStatus===\s*'approved'\)/,
    'must not offer cancelling a draft/sent/converted/archived row from here');
  assert.match(fn, /efOpenCancelEstimateModal\(nid,num\)/);
});

test('cancelling does not use window.prompt or window.confirm', () => {
  const fn = extractFunction(source, 'function efOpenCancelEstimateModal(nid,num){');
  assert.doesNotMatch(fn, /window\.prompt|window\.confirm/,
    'must use the app\'s own hlModal() form, not a native browser dialog');
  assert.match(fn, /hlModal\(/);
});

test('a reason is required before cancelling, so the record stays reasoned', () => {
  const fn = extractFunction(source, 'function efOpenCancelEstimateModal(nid,num){');
  assert.match(fn, /if\(!reason\)/);
});

test('cancelling calls the real cancel endpoint, not a hard delete', () => {
  const fn = extractFunction(source, 'function efOpenCancelEstimateModal(nid,num){');
  assert.match(fn, /hlEstApi\('cancel',\{id:nid,reason:reason\}\)/);
  assert.doesNotMatch(fn, /'delete'/, 'must never call a delete-style endpoint on a real, server-backed estimate');
});

test('a successful cancel refreshes the native list, so the row moves to Archived live', () => {
  const fn = extractFunction(source, 'function efOpenCancelEstimateModal(nid,num){');
  assert.match(fn, /loadNativeEstimatesLive\(\)/);
});

test('cancelled maps to the Archived tab, same as the other terminal states', () => {
  const fn = extractFunction(source, 'function nativeEstimateToRow(e){');
  assert.match(fn, /cancelled\s*:\s*'archived'/);
});
