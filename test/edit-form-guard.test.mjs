// Chris, 2026-08-23: "do the rest of the forms."
//
// Two of the remaining overlays really save; the rest turned out to be
// in-memory mockups. The two real ones -- the lead detail card and a job's
// line items -- are EDIT forms, not new ones, and that changes the middle
// button. A new thing has nowhere to go yet, so the offer is a draft. An edit
// of a record that already exists has somewhere to go right now; parking a
// draft of it instead would leave the real record stale and two versions of
// the truth lying around.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

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

// ---- an edit offers Save, not a draft --------------------------------------

test('the guard offers Save changes when the record already exists', () => {
  const fn = extractFunction(HTML, 'function hlFormTryClose(formId, opts) {');
  assert.match(fn, /if \(o\.save && typeof o\.save\.fn === 'function'\)/);
  assert.match(fn, /Save changes/);
  // And the draft branch is the ELSE, so one form can never offer both and
  // leave him choosing between two kinds of saving.
  assert.match(fn, /\} else if \(o\.kind\) \{/);
});

test('choosing Save does NOT forget the form', () => {
  // If the save fails the form stays open with the edits in it, and the next
  // attempt to close has to warn again. Forgetting here makes that second
  // close silent, which is the whole bug.
  const fn = extractFunction(HTML, 'function hlFormTryClose(formId, opts) {');
  const branch = fn.slice(fn.indexOf('if (o.save &&'), fn.indexOf('} else if (o.kind)'));
  assert.ok(!/hlFormForget/.test(branch), 'must not forget the photo before the save has landed');
});

// ---- the lead card ---------------------------------------------------------

test('the lead card asks before dropping an edit', () => {
  assert.match(HTML, /<div class="nlv" id="rlv-lead-modal" onclick="if\(event\.target===this\)rlmTryClose\(\)">/);
  assert.match(HTML, /<button class="btn-ghost" onclick="rlmTryClose\(\)">Close<\/button>/);
  const fn = extractFunction(HTML, 'function rlmTryClose() {');
  assert.match(fn, /save: \{ label: 'Save changes', fn: function \(\) \{ saveRealLead\(\); \} \}/);
});

test('the card is photographed once it holds the lead, not while empty', () => {
  // Watching before it is filled in would call a freshly opened card dirty.
  const i = HTML.indexOf("document.getElementById('rlv-lead-modal').classList.add('open');");
  const after = HTML.slice(i, i + 600);
  assert.match(after, /hlFormWatch\('rlv-lead-modal'\)/);
});

// ---- the job line items ----------------------------------------------------

test('the line-items sheet asks, and saves rather than drafting', () => {
  const fn = extractFunction(HTML, 'function ajxTryClose() {');
  assert.match(fn, /save: \{ label: 'Save line items'/);
  assert.match(fn, /ajvSaveLines\(ajxCloseNow\)/, 'it must close only once the save has landed');
});

test('every existing caller of ajxClose now goes through the guard', () => {
  assert.match(HTML, /function ajxClose\(\) \{ ajxTryClose\(\); \}/);
  assert.match(HTML, /function ajxCloseNow\(\) \{/);
});

test('the sheet is photographed after its lines arrive, not while loading', () => {
  // The lines are fetched. Photographing at open time captures "Loading line
  // items..." and calls every sheet dirty the moment its rows appear.
  const fn = extractFunction(HTML, 'function ajxOpen(jobId) {');
  const render = fn.indexOf('ajvLinesRender();');
  const watch = fn.indexOf("hlFormWatch('ajv')");
  assert.ok(render > -1 && watch > render, 'the photo must come after the render');
  assert.match(fn, /hlFormForget\('ajv'\)/, 'a sheet that failed to load has nothing to lose');
});

test('a saved sheet stops counting as edited', () => {
  // Without re-photographing, a sheet he just saved still looks dirty and asks
  // again on the way out -- the cried-wolf failure in a new place.
  const fn = extractFunction(HTML, 'function ajvSaveLines(after) {');
  assert.match(fn, /hlFormWatch\('ajv'\)/);
  assert.match(fn, /if \(typeof after === 'function'\) after\(\)/);
  const okBranch = fn.slice(fn.indexOf('if (r && r.ok)'), fn.indexOf('} else {'));
  assert.ok(okBranch.includes('hlFormWatch'), 'only on success');
});

// ---- what was deliberately left alone --------------------------------------

test('the in-memory mockups are not guarded', () => {
  // rfqv, bidv and tkv have save buttons that build an object, push it into a
  // page-lifetime array and toast. Nothing reaches a server; a reload loses it
  // either way. Guarding one would promise a permanence the form does not have.
  // (ncmv looked like one of these until a wider look showed it really does
  // call create_client -- so it IS guarded. The rule is about whether a form
  // saves, and answering that took reading past the first screenful.)
  for (const id of ['rfqv', 'bidv', 'tkv']) {
    assert.ok(!new RegExp("hlFormWatch\\('" + id + "'\\)").test(HTML),
      id + ' stores nothing on a server and must not be guarded');
  }
});

test('the full New Client sheet sends the phone and address it demanded', () => {
  // It has required both since it was written, and sent neither: only name,
  // company and email reached the server. Two fields typed, validated, and
  // dropped -- and a client you cannot ring is half a client.
  const fn = extractFunction(HTML, 'function ncCreate(){');
  assert.match(fn, /if\(!fn\|\|!ln\|\|!ph\|\|!ad\)/, 'still requires them');
  const post = fn.slice(fn.indexOf("hlApiPost('create_client'"));
  assert.match(post, /phone: ph/, 'the phone it demanded must be sent');
  assert.match(post, /address: ad/, 'and the address');
  for (const f of ['source:', 'preferredContact:', 'propertyNotes:', 'secondContact:']) {
    assert.ok(post.includes(f), f + ' is collected but never sent');
  }
});

test('the full New Client sheet is guarded, because it really saves', () => {
  assert.match(HTML, /id="ncmv" onclick="if\(event\.target===this\)ncTryClose\(\)"/);
  const fn = extractFunction(HTML, 'function ncTryClose() {');
  assert.match(fn, /kind: 'client'/);
  assert.ok(HTML.includes('window.ncTryClose = ncTryClose;'), 'and reachable from the markup');
});
