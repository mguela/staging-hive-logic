// test/estimate-remote-create-disabled-response.test.mjs
// jomell, 2026-08-25: submitting a real estimate returned "Network error
// saving estimate: Cannot read properties of undefined (reading 'id')".
//
// The actual server response was a valid, documented shape --
// {ok:true, enabled:false} -- returned by api/bookkeeping/estimates/create.js
// whenever BOOKKEEPING_ENABLED isn't exactly "true" on that deployment. The
// frontend's success branch read d.estimate.id unconditionally the moment
// d.ok was true, without checking d.estimate existed first, so a legitimate
// "this feature isn't enabled" response crashed with a message that named
// the wrong problem (a JS type error) instead of the real one (a disabled
// backend flag).

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

function stripLineComments(code) {
  return code.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
}

test('efRemoteCreate() checks for the enabled:false response before touching d.estimate', () => {
  const fn = stripLineComments(extractFunction(source, 'function efRemoteCreate(silent){'));
  const enabledCheckIdx = fn.search(/d\.enabled\s*===\s*false/);
  const idAccessIdx = fn.search(/d\.estimate\.id/);
  assert.ok(enabledCheckIdx > -1, 'must explicitly detect the disabled-backend response shape');
  assert.ok(idAccessIdx > -1, 'must still handle the real success case');
  assert.ok(enabledCheckIdx < idAccessIdx,
    'the enabled:false check must run BEFORE reading .id off d.estimate, or it never prevents the crash');
});

test('the real success branch requires d.estimate to actually exist, not just d.ok', () => {
  const fn = extractFunction(source, 'function efRemoteCreate(silent){');
  assert.match(fn, /if\s*\(\s*d\s*&&\s*d\.ok\s*&&\s*d\.estimate\s*\)/,
    'd.ok alone does not guarantee d.estimate exists -- the enabled:false response proves that');
});

test('a disabled backend gets an honest, specific message instead of a JS error', () => {
  const fn = extractFunction(source, 'function efRemoteCreate(silent){');
  assert.match(fn, /chirpToast\('⚠ The real Estimates backend isn\\?'t enabled/,
    'must name the actual cause (BOOKKEEPING_ENABLED) rather than surfacing "Cannot read properties of undefined"');
});
