// test/estimate-save-real-backend.test.mjs
// jomell, 2026-08-24: saved a real estimate (client "Jovie") and got
// "EST-2483 saved locally -- Jobber Quotes sync isn't wired in this
// deployment yet, so this isn't saved to a real backend." The team's
// direction is to ditch Jobber write-back entirely, not build it -- the
// estimate builder's "Save & send to client" menu item already had a real,
// durable backend (efRemoteCreate -> /api/bookkeeping/estimates/create,
// Supabase-backed) sitting right next to the plain "Save estimate" button,
// which was the one path nobody had wired to it.
//
// These tests pin the wire, not the estimate builder's other behaviour:
// Save now calls the same real path Send already used, and does not create a
// duplicate remote record if the estimate is already real (there is no
// update-in-place route yet, per efRemoteCreate's own header comment).

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

test('the old "saved locally, Jobber Quotes sync isn\'t wired" toast is gone from efSave()', () => {
  const fn = extractFunction(source, 'function efSave(){');
  assert.doesNotMatch(fn, /Jobber Quotes sync isn.t wired/,
    'Save must stop admitting to a Jobber sync that was never the actual plan');
  assert.doesNotMatch(fn, /saved locally/,
    'the fake-save wording should not linger inside efSave itself');
});

test('efSave() calls the same real backend efSendReal() already uses, not a new one', () => {
  const fn = extractFunction(source, 'function efSave(){');
  assert.match(fn, /efRemoteCreate\(\)/, 'must call the existing real-create path');
  assert.doesNotMatch(fn, /quoteCreate|jobberGraphQL/i,
    'this must not attempt a Jobber write -- that was explicitly rejected in favor of the native store');
});

test('efSave() does not create a duplicate remote record for an already-real estimate', () => {
  // Mirrors efSendReal()'s own guard: `if(!EST.remoteId){ efRemoteCreate(...) } else { ... }`.
  // There is no update-in-place route yet, so calling create() twice for the
  // same estimate would produce two separate records on the server.
  const fn = extractFunction(source, 'function efSave(){');
  assert.match(fn, /if\s*\(\s*EST\.remoteId\s*\)/,
    'must check for an existing remote record before attempting to create one');
  const guardedBranch = fn.slice(0, fn.search(/efRemoteCreate\(\)/));
  assert.match(guardedBranch, /return;/,
    'the already-real branch must return before reaching efRemoteCreate()');
});

test('a blocked or failed real save still keeps the local draft, so work is never lost', () => {
  // efRemoteCreate() resolves null (not a rejection) when it's blocked (no
  // payment schedule) or the server/network call fails, and it already
  // toasts the specific reason itself. efSave() must still record the
  // estimate locally either way, exactly as the original always-local
  // behaviour did, so someone hitting the payment-schedule gate does not
  // lose the estimate they were drafting.
  const fn = extractFunction(source, 'function efSave(){');
  assert.match(fn, /efSaveListUpdate\(/, 'must update the local list regardless of outcome');
  const listUpdateFn = extractFunction(source, 'function efSaveListUpdate(isReal){');
  assert.match(listUpdateFn, /ESTLIST\.unshift/, 'must still push the local list entry');
  // The local/real flag itself now lives in the shared efSaveSummary() helper
  // (also reused when persisting a full local-draft snapshot -- see
  // estimate-local-draft-persist-reopen.test.mjs), not inlined here anymore.
  const summaryFn = extractFunction(source, 'function efSaveSummary(isReal){');
  assert.match(summaryFn, /local\s*:\s*!isReal/,
    'the local flag must reflect whether this actually became a real record');
});

test('efSave() does not stack a second, vaguer error message on top of efRemoteCreate\'s own honest one', () => {
  const fn = extractFunction(source, 'function efSave(){');
  // efRemoteCreate() already calls chirpToast() itself on every failure path
  // (missing schedule, server error, network error). efSave() should only
  // add its own toast for the SUCCESS case.
  const successToastCount = (fn.match(/chirpToast\(/g) || []).length;
  assert.equal(successToastCount, 2,
    'expected exactly one success toast plus the already-real-record toast, no generic failure toast');
});
