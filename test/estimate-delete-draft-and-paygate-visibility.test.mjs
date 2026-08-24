// test/estimate-delete-draft-and-paygate-visibility.test.mjs
// jomell, 2026-08-24: two asks after testing the local-draft fixes:
// 1. "there should also be an option to delete the draft."
// 2. The save-blocked toast says "Add a deposit or a payment schedule...",
//    but the actual control was two small, unstyled text links at the
//    bottom of a long totals sidebar -- verified the markup itself was
//    correct (efPayBlock() genuinely returns working "Add deposit"/"Add
//    payment schedule" links), so this wasn't broken code, just something
//    the toast never pointed anyone toward.

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
  const start = source.lastIndexOf("document.addEventListener('click',function(e){", anchor);
  return source.slice(start, source.indexOf('},true);', anchor) + 10);
}

test('a "Delete draft" button exists and is offered only for local (unsynced) rows', () => {
  const fn = estimatesRowClickHandler();
  assert.match(fn, /var deleteBtn\s*=\s*isLocalRow/,
    'deleting a real, server-synced estimate is a materially different operation and stays out of scope');
  assert.match(fn, /Delete draft/);
});

test('deleting a draft asks for confirmation before removing anything', () => {
  const fn = estimatesRowClickHandler();
  assert.match(fn, /window\._hlEstDelete\s*=\s*function\(\)\{\s*if\s*\(!window\.confirm\(/,
    'an irreversible delete must confirm first, matching this codebase\'s existing window.confirm convention');
});

test('deleting a draft removes it from BOTH the durable store and the visible list', () => {
  const fn = estimatesRowClickHandler();
  assert.match(fn, /delete drafts\[rowKey\.slice\(6\)\]/, 'must remove the persisted hl_est_local_drafts entry');
  assert.match(fn, /efLocalDraftsSave\(drafts\)/, 'must actually persist the removal, not just mutate an in-memory copy');
  assert.match(fn, /ESTLIST\s*=\s*ESTLIST\.filter\(function\(e\)\{return e\.num\s*!==\s*rowKey\.slice\(6\);\}\)/,
    'must also drop the row from the currently-rendered list, not just storage');
});

test('the payment-schedule prompt is a visible call-to-action, not plain text links', () => {
  const fn = extractFunction(source, 'function efPayBlock(t){');
  assert.match(fn, /id="ef-paygate"/, 'needs an anchor the save-blocked gate can scroll to and highlight');
  assert.match(fn, /No deposit or payment schedule yet/);
});

test('a blocked save scrolls to and highlights the payment-schedule prompt', () => {
  const fn = extractFunction(source, 'function efRemoteCreate(silent){');
  assert.match(fn, /getElementById\('ef-paygate'\)/, 'must actually find the prompt element');
  assert.match(fn, /scrollIntoView/, 'must bring it into view -- it can be well below the fold');
  assert.match(fn, /classList\.add\('ef-flash'\)/, 'must draw the eye to it, not just silently scroll');
});

test('the flash highlight is temporary, not a permanent visual change', () => {
  const fn = extractFunction(source, 'function efRemoteCreate(silent){');
  assert.match(fn, /setTimeout\(function\(\)\{\s*gate\.classList\.remove\('ef-flash'\);\s*\},\s*1600\)/,
    'the highlight must remove itself -- otherwise every future glance at this estimate looks like an active warning');
});
