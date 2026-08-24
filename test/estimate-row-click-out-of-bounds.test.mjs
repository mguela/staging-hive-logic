// test/estimate-row-click-out-of-bounds.test.mjs
// jomell, 2026-08-24: clicked Jovie Folloso's estimate row -- and every other
// estimate row, real or local, has apparently never worked since this repo's
// very first commit -- and nothing opened at all, no modal, no error visible
// to a user.
//
// Root cause: the estimates-list row has exactly 6 <td> cells (checkbox,
// client, estimate, created, status, total -- indices 0-5), but the
// delegated click handler read td[6].innerText, which is undefined.innerText
// -- an uncaught TypeError that silently aborted the entire handler before it
// ever reached hlModal(). It also read td[3] into a variable named "prop"
// (property address), a column that does not exist in this table at all.
//
// Confirmed via `git log -S` that this exact bug has existed since commit
// c30b4ff ("Initial commit"), so it predates every fix landed today.

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
  assert.ok(start > -1, 'the estimates-list delegated click handler must exist');
  return source.slice(start, source.indexOf('},true);', anchor) + 10);
}

test('the estimates-list row template renders exactly 6 <td> cells', () => {
  const fn = extractFunction(source, 'function efListTable(){');
  // Scoped to the per-row template inside rows.forEach() -- the "no results"
  // fallback row a few lines later has its own unrelated <td colspan="6">.
  const rowTemplate = fn.slice(fn.indexOf('rows.forEach('), fn.indexOf('if(!rows.length)'));
  const tdCount = (rowTemplate.match(/<td/g) || []).length;
  assert.equal(tdCount, 6,
    'if this ever changes, the click handler\'s td[] indices below must be updated to match');
});

function stripLineComments(code) {
  return code.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
}

test('the row-click handler never indexes past the last real <td> (no more td[6])', () => {
  const fn = stripLineComments(estimatesRowClickHandler());
  assert.doesNotMatch(fn, /td\[6\]/,
    'td[6] does not exist on a 6-cell row (valid indices are 0-5) -- reading .innerText off it throws, silently killing this whole handler before hlModal() ever runs');
});

test('the handler no longer reads a "property address" column that was removed from the table', () => {
  const fn = stripLineComments(estimatesRowClickHandler());
  assert.doesNotMatch(fn, /\bvar\s+prop\s*=/,
    'there is no property-address <td> in the current 6-column table for this to come from');
});

test('created/status/total are read from their real, correct cell indices', () => {
  const fn = estimatesRowClickHandler();
  assert.match(fn, /created\s*=\s*td\[3\]\.innerText\.trim\(\)/, 'td[3] is CREATED');
  assert.match(fn, /st\s*=\s*td\[4\]\.innerText\.trim\(\)/, 'td[4] is STATUS');
  assert.match(fn, /amt\s*=\s*td\[5\]\.innerText\.trim\(\)/, 'td[5] is TOTAL');
});
