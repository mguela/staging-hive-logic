// test/new-lead-required-fields.test.mjs
// jomell, 2026-08-26: "in creating a new lead in '+ new lead' they fields
// should have an asterisk or a label that says 'required' and then it
// cannot be saved if required field is not filled out."
//
// Before this, nlSaveLeadCore's only check was "a first or last name" --
// phone, email, service address, and "in their words" (which becomes the
// lead's title) could all be left blank and the lead would still save.
// nlValidateRequired() is the one gate shared by every save path: the
// plain Save button AND all five "Where does this go?" buttons funnel
// through nlSaveLeadCore, so a lead can't slip through incomplete on one
// path while being blocked on another.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// CRLF-normalised: see lead-form-destinations.test.mjs's own note -- a
// needle spanning a line break silently fails to match on a Windows
// checkout without ever failing the test.
const readSource = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8').replace(/\r\n/g, '\n');
const HTML = readSource('public', 'index.html');

function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  if (start === -1) throw new Error('not found: ' + decl);
  let depth = 1, i = start + decl.length;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

const NL_FORM = (() => {
  const start = HTML.indexOf('<div id="nl-tm-fields">');
  const end = HTML.indexOf('<div class="nl-foot">', start);
  assert.ok(start > -1 && end > start, 'the New Lead form should still be findable');
  return HTML.slice(Math.max(0, HTML.lastIndexOf('<div class="nlv" id="nlv"')), end);
})();

// ---- visible markers on the form -------------------------------------------

test('Service Address and In Their Words are marked with an asterisk', () => {
  assert.match(NL_FORM, /<label>SERVICE ADDRESS <span class="req">\*<\/span><\/label>/);
  assert.match(NL_FORM, /<label>IN THEIR WORDS <span class="req">\*<\/span><\/label>/);
});

test('the name and contact pairs get an "at least one required" hint instead of a per-field asterisk', () => {
  // Neither half of an either/or pair should carry its own asterisk -- that
  // would read as "both required," which is stricter than the actual rule.
  assert.doesNotMatch(NL_FORM, /<label>FIRST NAME <span class="req">/);
  assert.doesNotMatch(NL_FORM, /<label>LAST NAME <span class="req">/);
  assert.doesNotMatch(NL_FORM, /<label>PHONE <span class="req">/);
  assert.doesNotMatch(NL_FORM, /<label>EMAIL <span class="req">/);
  assert.match(NL_FORM, /nl-req-hint">\* First or last name required</);
  assert.match(NL_FORM, /nl-req-hint">\* Phone or email required</);
});

test('the required-field styling actually paints something -- a red border and a red asterisk, not a class that does nothing', () => {
  assert.match(HTML, /\.fld label \.req\{color:var\(--red\)/);
  assert.match(HTML, /\.fld input\.nl-invalid,\.fld select\.nl-invalid,\.fld textarea\.nl-invalid\{border-color:var\(--red\)/);
});

// ---- nlValidateRequired: the actual gate ------------------------------------

test('nlValidateRequired checks all four requirements, not just the name', () => {
  const fn = extractFunction(HTML, 'function nlValidateRequired(f) {');
  assert.match(fn, /!f\.firstName\.trim\(\) && !f\.lastName\.trim\(\)/);
  assert.match(fn, /!f\.phone\.trim\(\) && !f\.email\.trim\(\)/);
  assert.match(fn, /getElementById\('nl-addr'\)\.value \|\| ''\)\.trim\(\)/);
  assert.match(fn, /!f\.need\.trim\(\)/);
});

test('a missing requirement red-borders every field it names, not just the first one found', () => {
  const fn = extractFunction(HTML, 'function nlValidateRequired(f) {');
  const badFn = extractFunction(fn, 'function bad(ids, label) {');
  assert.match(badFn, /ids\.forEach\(function \(id\) \{/);
  assert.match(badFn, /e\.classList\.add\('nl-invalid'\)/);
});

test('the address check reads the raw input value directly, not the unit-joined serviceAddress -- a stray unit alone must not pass', () => {
  const fn = extractFunction(HTML, 'function nlValidateRequired(f) {');
  assert.doesNotMatch(fn, /!f\.serviceAddress\.trim\(\)/);
});

test('all four requirements must pass before the form is considered valid', () => {
  const fn = extractFunction(HTML, 'function nlValidateRequired(f) {');
  assert.match(fn, /if \(!missing\.length\) return true;/);
  assert.match(fn, /return false;/);
});

test('a validation failure focuses the first offending field so there is somewhere obvious to look', () => {
  const fn = extractFunction(HTML, 'function nlValidateRequired(f) {');
  assert.match(fn, /var el = document\.getElementById\(firstBadId\);/);
  assert.match(fn, /if \(el\) el\.focus\(\);/);
});

test('nlSaveLeadCore is gated by nlValidateRequired -- the old bare name-only check is gone', () => {
  const fn = extractFunction(HTML, 'function nlSaveLeadCore(extra) {');
  assert.match(fn, /if \(!nlValidateRequired\(f\)\) return Promise\.resolve\(null\);/);
  assert.doesNotMatch(fn, /Enter at least a first or last name/, 'the old inline-only check should be replaced, not duplicated alongside the new one');
});

// ---- clearing the red border as the user fixes a field ---------------------

test('typing into a previously-flagged field clears its red border immediately', () => {
  assert.match(NL_FORM, /id="nl-first" placeholder="First" oninput="nlDupeCheck\(\);nlClearReq\('nl-first'\)"/);
  assert.match(NL_FORM, /id="nl-last" placeholder="Last" oninput="nlDupeCheck\(\);nlClearReq\('nl-last'\)"/);
  assert.match(NL_FORM, /id="nl-phone".*oninput="nlDupeCheck\(\);nlClearReq\('nl-phone'\)"/);
  assert.match(NL_FORM, /id="nl-email".*oninput="nlDupeCheck\(\);nlClearReq\('nl-email'\)"/);
  assert.match(NL_FORM, /id="nl-addr".*oninput="nlClearReq\('nl-addr'\);nlAddrInput\(this\.value\)"/);
  assert.match(NL_FORM, /id="nl-need" placeholder="What did they ask for\?" oninput="nlClearReq\('nl-need'\)"/);
});

test('opening a fresh form clears any red borders left over from a previous failed attempt', () => {
  const fn = extractFunction(HTML, 'function nlResetForm() {');
  assert.match(fn, /el\.classList\.remove\('nl-invalid'\)/);
});
