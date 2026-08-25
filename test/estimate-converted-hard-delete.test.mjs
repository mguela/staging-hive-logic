// test/estimate-converted-hard-delete.test.mjs
// jomell, 2026-08-25: "i want to delete the ones in the converted tab," then
// "i just want to have the ability/button to delete these" (any status, and
// also the real Jobber-synced quotes mixed into the same list). Real hard
// delete (chosen via AskUserQuestion over a reversible archive, after being
// told converting created a real job row, staging shares the live
// production database, and the wider list includes real Jobber quote
// history). Frontend half of api/bookkeeping/estimates/delete.js and
// api/jobber/delete-quote.js -- covered separately in
// test/estimate-delete-converted.test.mjs and test/jobber-delete-quote.test.mjs.

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

test('every native estimate gets a hard-delete action, regardless of status', () => {
  const fn = estimatesRowClickHandler();
  assert.match(fn, /var hardDeleteBtn\s*=\s*nativeRow\s*\?/,
    'a native row of any status must be deletable, not just converted ones');
  assert.match(fn, /efOpenHardDeleteEstimateModal\(nid,num,nativeRow\.lifecycleStatus===\s*'converted'\)/);
});

test('the button and modal only mention a job when the estimate is actually converted', () => {
  const fn = estimatesRowClickHandler();
  assert.match(fn, /nativeRow\.lifecycleStatus===\s*'converted'\?' &amp; job':''/,
    'a draft/sent/approved estimate never had a job -- the copy must not claim one existed');
});

test('a Jobber-synced quote row also gets a delete action', () => {
  const fn = estimatesRowClickHandler();
  assert.match(fn, /var isRealRow\s*=\s*rowKey\.indexOf\('real:'\)===0/);
  assert.match(fn, /efOpenHardDeleteQuoteModal\(realId,num\)/);
});

test('hard delete does not use window.prompt or window.confirm', () => {
  const est = extractFunction(source, 'function efOpenHardDeleteEstimateModal(nid,num,hasJob){');
  assert.doesNotMatch(est, /window\.prompt|window\.confirm/,
    'must use the app\'s own hlModal() form, not a native browser dialog');
  assert.match(est, /hlModal\(/);
  const quote = extractFunction(source, 'function efOpenHardDeleteQuoteModal(qid,num){');
  assert.doesNotMatch(quote, /window\.prompt|window\.confirm/);
  assert.match(quote, /hlModal\(/);
});

test('deleting requires typing the number to confirm, for both estimates and quotes', () => {
  const est = extractFunction(source, 'function efOpenHardDeleteEstimateModal(nid,num,hasJob){');
  assert.match(est, /typed!==num/,
    'a generic "are you sure" confirm is too easy to click through on an irreversible action');
  const quote = extractFunction(source, 'function efOpenHardDeleteQuoteModal(qid,num){');
  assert.match(quote, /typed!==num/);
});

test('estimate delete calls the real delete endpoint, and warns this cannot be undone', () => {
  const fn = extractFunction(source, 'function efOpenHardDeleteEstimateModal(nid,num,hasJob){');
  assert.match(fn, /hlEstApi\('delete',\{id:nid\}\)/);
  assert.match(fn, /cannot be undone/);
});

test('a successful estimate delete refreshes the native list, so the row disappears live', () => {
  const fn = extractFunction(source, 'function efOpenHardDeleteEstimateModal(nid,num,hasJob){');
  assert.match(fn, /loadNativeEstimatesLive\(\)/);
});

test('quote delete calls the quote endpoint and is honest about the daily resync', () => {
  // 2026-08-25: the quotes table is a one-way, read-only Jobber mirror
  // (upserted daily, never deleted) -- a quote still open in Jobber will
  // reappear within ~24h, and the modal must say so rather than let it look
  // like a silent bug later.
  const fn = extractFunction(source, 'function efOpenHardDeleteQuoteModal(qid,num){');
  assert.match(fn, /\/api\/jobber\/delete-quote/);
  assert.match(fn, /daily sync/);
  assert.match(fn, /cannot be undone/);
});

test('a successful quote delete refreshes the Jobber-synced list, so the row disappears live', () => {
  const fn = extractFunction(source, 'function efOpenHardDeleteQuoteModal(qid,num){');
  assert.match(fn, /loadQuotesLive\(\)/);
});
