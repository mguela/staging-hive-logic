// test/estimate-resave-no-duplicate.test.mjs
// jomell, 2026-08-24: reopened Jovie Folloso's local draft (#2483), edited
// it, and saving again produced a SECOND row for the same estimate instead
// of replacing the first -- and the new row's client name showed as the
// literal em-dash entity "&#8212;" instead of "jovie folloso".
//
// Two separate bugs, both in the same save path:
// 1. efSaveListUpdate() always unshifted a fresh summary onto ESTLIST with
//    no de-dup, so re-saving the same estimate number just piled a new row
//    on top of the old one.
// 2. efSaveSummary() recomputes the client name from CLIENTDB every single
//    save. If CLIENTDB hasn't finished loading this client yet at that exact
//    moment (plausible right after efOpenLocalDraft() synchronously reopens
//    the builder), the lookup silently falls back to the "-" placeholder,
//    overwriting a name that was already known to be correct from the first
//    save.

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

test('efSaveListUpdate() removes any existing row for the same estimate before adding the new one', () => {
  const fn = extractFunction(source, 'function efSaveListUpdate(summary){');
  assert.match(fn, /ESTLIST\s*=\s*ESTLIST\.filter\(function\(e\)\{return e\.num\s*!==\s*summary\.num;\}\)/,
    'without this, re-saving the same estimate leaves the old row sitting alongside the new one');
  const filterIdx = fn.search(/ESTLIST\s*=\s*ESTLIST\.filter/);
  const unshiftIdx = fn.search(/ESTLIST\.unshift\(summary\)/);
  assert.ok(filterIdx > -1 && unshiftIdx > -1 && filterIdx < unshiftIdx,
    'the old row must be removed BEFORE the new one is added, not after');
});

test('every efSaveListUpdate() call site passes a pre-built summary, not a boolean', () => {
  // The function used to take isReal directly and build its own summary
  // internally -- every call site must have been updated to match, or some
  // path would still duplicate rows.
  const calls = source.match(/efSaveListUpdate\([^)]*\)/g) || [];
  assert.ok(calls.length >= 3, 'expected at least the real/re-real/local call sites in efSave()');
  calls.forEach((call) => {
    assert.doesNotMatch(call, /efSaveListUpdate\((true|false)\)/,
      `${call} still passes a bare boolean instead of a summary object`);
  });
});

test('a stale-CLIENTDB re-save keeps the client name it already knew, instead of blanking it', () => {
  const fn = extractFunction(source, 'function efSave(){');
  assert.match(fn, /summary\.client\s*===\s*'&#8212;'/,
    'must detect when the fresh CLIENTDB lookup came back empty');
  assert.match(fn, /prior\.summary\.client\s*!==\s*'&#8212;'/,
    'must only fall back to the prior name when that prior name was itself real');
  assert.match(fn, /summary\.client\s*=\s*prior\.summary\.client/,
    'must actually overwrite the blanked-out name with the last known-good one');
});

test('the recovered client name is captured from THIS draft\'s own prior save, not a different one', () => {
  const fn = extractFunction(source, 'function efSave(){');
  // drafts[priorLocalKey] -- keyed by this exact estimate, not any other.
  assert.match(fn, /var prior\s*=\s*drafts\[priorLocalKey\]/,
    'the fallback must be scoped to this same estimate\'s own local-draft record');
});
