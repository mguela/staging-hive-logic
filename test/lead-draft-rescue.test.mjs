// Chris, 2026-08-23, mid-way through filling in a lead:
//
//   "i inavertently clicked away from the screen and lost my work, that can't
//    happen. if I click somewere outside the popup for the lead form it cant
//    just close it. it needs to ask to save the form or confirm the work will
//    be lost... it needs a home to save the incomplete form too. and it needs
//    to be easily found when you want to return to it"
//
// The backdrop was literally
//   onclick="if(event.target===this)this.classList.remove('open')"
// One stray click on the grey and a phone call's worth of typing was gone,
// with no undo and nothing written anywhere. Escape and Cancel did the same.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// public/index.html is checked out CRLF on Windows (core.autocrlf) and LF in CI.
// Needles below span a line break, so reading the file raw makes this test mean
// two different things on the two platforms: it passed in CI and failed on
// Chris's machine asserting "the overlay Escape handler must exist" -- it does
// exist, and it does call nlTryClose(). Normalise on read so every needle in
// this file can be written with \n and match on both. Same trap as
// test/hiveconnect-email-triage.test.mjs, where the quiet version of it left an
// assertion running against an empty string.
const readSource = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8').replace(/\r\n/g, '\n');
const HTML = readSource('public', 'index.html');
const TRACK1 = readSource('api', 'track1.js');

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

// ---- every way out of the form goes through the gate ----------------------

test('the backdrop asks instead of discarding', () => {
  assert.match(HTML, /<div class="nlv" id="nlv" onclick="if\(event\.target===this\)nlTryClose\(\)">/);
  assert.ok(!/id="nlv" onclick="if\(event\.target===this\)this\.classList\.remove\('open'\)"/.test(HTML),
    'the silent close must be gone, not merely shadowed');
});

// There are four Escape handlers in the page; the one that matters is the
// overlay handler, identified by the overlays it closes rather than by being
// first in the file.
const ESC = (() => {
  // Anchored on the handler that closes the overlays, not on its first
  // statement -- that statement changed when the rail forms got the same
  // guard, and pinning it made this test fail for a reason unrelated to what
  // it checks.
  const i = HTML.indexOf("document.addEventListener('keydown',function(e){if(e.key==='Escape'){\n");
  assert.ok(i > -1, 'the overlay Escape handler must exist');
  return HTML.slice(i, i + 1200);
})();

test('Escape asks too', () => {
  assert.match(ESC, /nlTryClose\(\)/);
});

test('Cancel asks too', () => {
  assert.match(HTML, /<button class="btn-ghost" onclick="nlTryClose\(\)">Cancel<\/button>/);
});

test('Escape still closes every other overlay', () => {
  // A guard added in the wrong place here once disabled the whole rest of the
  // handler -- I wrapped the remainder in `if(false)`. None of those overlays
  // holds unrecoverable typing, so they must keep closing exactly as before.
  // 'icv' is deliberately not on this list any more: it was the hardcoded
  // "Sarah Jones" incoming-call mockup, removed on 2026-08-23 when the real
  // caller-ID prefill went in. Its Accept button typed a fictional client into
  // the real New Lead form.
  for (const id of ['ldv', 'dtv', 'pvv', 'cmv', 'jcv']) {
    assert.ok(ESC.includes("getElementById('" + id + "')"), id + ' must still close on Escape');
  }
});

// ---- what counts as work worth protecting ----------------------------------

function dirtySandbox(values) {
  const ctx = {
    document: {
      getElementById: (id) => (id in values ? { value: values[id] } : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    String, console,
  };
  vm.createContext(ctx);
  vm.runInContext(
    'var NL_TEXT_FIELDS = ' + JSON.stringify(Object.keys(values)) + ';\n' +
    extractFunction(HTML, 'function nlFormState() {') + '\n' +
    extractFunction(HTML, 'function nlIsDirty() {').replace(
      /var NL_TYPED_FIELDS = \[[^\]]*\];\s*/, ''),
    ctx
  );
  // Keep the real list, not a paraphrase of it.
  const listed = /var NL_TYPED_FIELDS = (\[[^\]]*\])/.exec(HTML);
  vm.runInContext('var NL_TYPED_FIELDS = ' + listed[1] + ';', ctx);
  return ctx;
}

const EMPTY = {
  'nl-search': '', 'nl-first': '', 'nl-last': '', 'nl-phone': '', 'nl-email': '',
  'nl-addr': '', 'nl-need': '', 'nl-clientid': '',
  'nl-source': 'Referral', 'nl-division': '', 'nl-visit-date': '', 'nl-visit-time': '10',
};

test('an untouched form closes without nagging him', () => {
  // Source, the visit time and the pre-selected urgency all carry defaults. A
  // confirm that fires when there is nothing to lose is one he learns to
  // dismiss without reading -- which is how he loses the real one.
  const ctx = dirtySandbox(EMPTY);
  assert.equal(ctx.nlIsDirty(), false);
});

test('one typed character is enough to protect', () => {
  for (const id of ['nl-first', 'nl-last', 'nl-phone', 'nl-email', 'nl-addr', 'nl-need', 'nl-search']) {
    const ctx = dirtySandbox(Object.assign({}, EMPTY, { [id]: 'x' }));
    assert.equal(ctx.nlIsDirty(), true, id + ' must count as work');
  }
});

test('a linked client counts, even with nothing typed', () => {
  const ctx = dirtySandbox(Object.assign({}, EMPTY, { 'nl-clientid': 'C42' }));
  assert.equal(ctx.nlIsDirty(), true);
});

test('whitespace is not work', () => {
  const ctx = dirtySandbox(Object.assign({}, EMPTY, { 'nl-need': '   ' }));
  assert.equal(ctx.nlIsDirty(), false);
});

// ---- the three answers -----------------------------------------------------

test('the confirm offers keep / save / discard, not OK and Cancel', () => {
  const fn = extractFunction(HTML, 'function nlTryClose() {');
  assert.match(fn, /Keep editing/);
  assert.match(fn, /Save as draft/);
  assert.match(fn, /Discard/);
  assert.match(fn, /kind: 'danger'/, 'discarding must not look like the safe default');
});

test('clicking the grey behind the CONFIRM cancels, it does not discard', () => {
  // Same gesture that caused the problem. It must not destroy anything twice.
  const fn = extractFunction(HTML, 'function hlConfirmSheet(opts) {');
  assert.match(fn, /back\.addEventListener\('click', function \(e\) \{ if \(e\.target === back\) close\(\); \}\)/);
});

test('a failed draft save keeps the form open', () => {
  // The typing is still the only copy. Closing anyway would lose exactly what
  // he pressed the button to protect.
  const fn = extractFunction(HTML, 'function nlSaveDraft() {');
  const okBranch = fn.slice(fn.indexOf('if (r && r.ok)'), fn.indexOf('// Never close'));
  assert.match(okBranch, /nlCloseNow\(\)/, 'a successful save closes');
  const after = fn.slice(fn.indexOf('// Never close'));
  assert.ok(!/nlCloseNow\(\)/.test(after), 'a failed save must NOT close');
  assert.match(after, /still here/, 'and must say the work survived');
});

// ---- the home --------------------------------------------------------------

test('drafts have a place on the Leads page, above the pipeline', () => {
  assert.match(HTML, /<div id="lgrid-drafts"/);
  const draftsAt = HTML.indexOf('id="lgrid-drafts"');
  const boardAt = HTML.indexOf('id="lgrid-headline-h1"');
  assert.ok(draftsAt < boardAt, 'an unfinished lead is the most urgent thing on that screen');
});

test('the strip hides itself when there is nothing unfinished', () => {
  const fn = extractFunction(HTML, 'function hlRenderLeadDrafts() {');
  assert.match(fn, /if \(!HL_LEAD_DRAFTS\.length\) \{ host\.style\.display = 'none'/);
});

test('a failed read does not claim there are no drafts', () => {
  // Rendering "none" on a network error is the same lie as losing them.
  const fn = extractFunction(HTML, 'function hlLoadLeadDrafts() {');
  const katch = fn.slice(fn.indexOf('.catch('));
  assert.ok(!/HL_LEAD_DRAFTS = \[\]/.test(katch), 'must not empty the list on failure');
});

test('the buttons on a draft are reachable from an inline onclick', () => {
  // This region sits inside a closure -- loadLeadsLive is global only because
  // it was explicitly exported. An inline onclick runs at page scope, so
  // Resume and Delete would have thrown "not defined" on the first press.
  // Caught in the browser, not by reading the code.
  for (const fn of ['hlLoadLeadDrafts', 'hlResumeLeadDraft', 'hlDeleteLeadDraft']) {
    assert.ok(HTML.includes('window.' + fn + ' = ' + fn + ';'), fn + ' must be exported');
  }
});

test('resuming a draft holds its id, so saving again updates it', () => {
  // Otherwise every resume-and-save leaves another copy, and the list he
  // opened to find one thing fills up with near-identical rows.
  const fn = extractFunction(HTML, 'function hlResumeLeadDraft(id) {');
  assert.match(fn, /NL_DRAFT_ID = d\.id/);
  assert.match(fn, /nlRestoreState\(d\.payload\)/);
});

test('finishing the lead clears the draft it came from', () => {
  const fn = extractFunction(HTML, 'function nlDiscardDraftAfterSave() {');
  assert.match(fn, /NL_DRAFT_ID = null/);
  assert.match(fn, /hlApiDelete\('form_drafts/);
});

test('deleting a draft asks first', () => {
  const fn = extractFunction(HTML, 'function hlDeleteLeadDraft(id) {');
  assert.match(fn, /hlConfirmSheet/);
  assert.match(fn, /gone for good/);
});

// ---- the server side -------------------------------------------------------

test('a draft is stored server-side against the user, not in the browser', () => {
  // The standing rule: a setting -- or here, saved work -- is a fact about HIM.
  // localStorage would strand it on whichever machine he was standing at.
  const fn = extractFunction(TRACK1, 'async function handleFormDrafts(req, res) {');
  assert.match(fn, /owner_id=eq\.\$\{owner\}/);
  assert.match(fn, /getRequestingProfile/);
  assert.match(fn, /Not signed in/);
});

test('another person\'s draft id is not enough to overwrite it', () => {
  const fn = extractFunction(TRACK1, 'async function handleFormDrafts(req, res) {');
  const patch = fn.slice(fn.indexOf('if (id) {'), fn.indexOf('const r = await supabaseRequest(\'form_drafts\''));
  assert.match(patch, /id=eq\.\$\{encodeURIComponent\(id\)\}&owner_id=eq\.\$\{owner\}/,
    'the owner must be in the filter, not just the id');
});

test('deleting is scoped to the owner too', () => {
  const fn = extractFunction(TRACK1, 'async function handleFormDrafts(req, res) {');
  const del = fn.slice(fn.indexOf("if (req.method === 'DELETE')"));
  assert.match(del, /owner_id=eq\.\$\{owner\}/);
});

test('a half-typed form is saved as-is, never validated away', () => {
  // Half a phone number and no name at all still has to survive -- that is
  // exactly the state he is in when the phone rings again.
  const fn = extractFunction(TRACK1, 'async function handleFormDrafts(req, res) {');
  assert.ok(!/firstName|lastName|required/i.test(fn.slice(fn.indexOf("if (req.method === 'POST')"), fn.indexOf("if (req.method === 'DELETE')"))),
    'no field-level validation on a draft');
  assert.match(fn, /too large to save/, 'only a size cap, which is about abuse not correctness');
});

test('a missing table reads as "no drafts", not as a broken Leads page', () => {
  const fn = extractFunction(TRACK1, 'async function handleFormDrafts(req, res) {');
  assert.match(fn, /relation .* does not exist/);
  assert.match(fn, /tableReady: false/);
});

test('the table exists in a migration, with row-level security on it', () => {
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  // The table was renamed to form_drafts when the guard was generalised; the
  // migration that CREATED it is still the one that put RLS on it.
  const sql = fs.readdirSync(dir)
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf-8'))
    .find((t) => /create table if not exists lead_drafts/i.test(t));
  assert.ok(sql, 'a table the app writes and no migration creates is a production 500');
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /auth\.uid\(\) = owner_id/, 'his drafts are nobody else\'s business');
});
