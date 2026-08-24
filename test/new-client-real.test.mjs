// Chris, 2026-08-23: "build New Client for real."
//
// The form had asked twelve questions since it was drawn, and its Save button
// called saveForm() -- a toast reading "Client created - deduped across brands,
// property file opened", then a close, storing absolutely nothing. Its footer
// said "Autosaving draft" as well. Both were untrue.
//
// A form that lies about saving is worse than no form at all: he types a client
// in, is told it worked, and finds nothing there later. This wires it to
// create_client -- which already existed, and is what the Schedule board's
// quick-add uses -- and adds the seven columns the rest of the form needed, so
// nothing he types is quietly thrown away.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
const TRACK1 = fs.readFileSync(path.join(__dirname, '..', 'api', 'track1.js'), 'utf-8');

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

const FORM = HTML.slice(HTML.indexOf('<div class="fm" id="fm-client">'),
                        HTML.indexOf('<div class="fm" id="fm-invoice">'));

test('the Save button saves, instead of showing a toast about it', () => {
  assert.match(FORM, /onclick="ncliSave\(\)"/);
  assert.ok(!/saveForm\(/.test(FORM), 'saveForm is the mockup path and must be gone from here');
});

test('the footer no longer claims to be autosaving', () => {
  assert.ok(!/Autosaving draft/.test(FORM), 'nothing autosaves; saying so was the second lie');
});

test('every rail form footer tells the truth about whether it saves', () => {
  // Leaving "Autosaving draft" on a mockup is how somebody types a payment in
  // and believes it landed. Checked per form, against what its Save button
  // actually calls -- not against the page text, which includes the comment
  // explaining all this.
  const forms = [...HTML.matchAll(/<div class="fm" id="(fm-[a-z]+)">/g)];
  assert.ok(forms.length >= 6);
  for (const m of forms) {
    const seg = HTML.slice(m.index, m.index + 9000);
    const save = /class="fm-save" onclick="([^"]+)"/.exec(seg);
    const foot = /class="draft"[^>]*>(.*?)<\/span>/.exec(seg);
    assert.ok(save && foot, m[1] + ' has no save button or no footer');
    const isMockup = /^saveForm\(/.test(save[1]);
    assert.ok(!/Autosaving/i.test(foot[1]), m[1] + ' claims to autosave, and nothing does');
    if (isMockup) {
      assert.match(foot[1], /nothing is saved/i,
        m[1] + ' stores nothing but its footer does not say so: ' + foot[1]);
    } else {
      assert.ok(!/nothing is saved/i.test(foot[1]),
        m[1] + ' really saves but its footer says it does not');
    }
  }
});

test('every field the form asks about has an id, so none of it can be dropped', () => {
  // A field with no id cannot be read on save and cannot be restored from a
  // draft. Twelve of these had none, which is why the form could never work.
  const inputs = (FORM.match(/<(input|select)\b/g) || []).length;
  const withIds = (FORM.match(/<(input|select)[^>]*\bid="ncli-/g) || []).length;
  assert.equal(withIds, inputs, inputs - withIds + ' field(s) still have no id');
});

test('everything he types is sent -- all thirteen fields', () => {
  const fn = extractFunction(HTML, 'function ncliSave() {');
  for (const f of ['ncli-first', 'ncli-last', 'ncli-company', 'ncli-phone', 'ncli-email',
                   'ncli-addr', 'ncli-type', 'ncli-contact', 'ncli-brand', 'ncli-source',
                   'ncli-membership', 'ncli-second', 'ncli-notes']) {
    assert.ok(fn.includes(f), f + ' is asked for but never sent');
  }
});

test('a client with no name at all is refused, not silently created', () => {
  const fn = extractFunction(HTML, 'function ncliSave() {');
  assert.match(fn, /if \(!first && !last && !company\)/);
  const guard = fn.indexOf('if (!first && !last && !company)');
  const post = fn.indexOf("hlApiPost('create_client'");
  assert.ok(guard < post, 'it must refuse before posting');
});

test('a failed save keeps the form open and the typing in it', () => {
  // The behaviour this form used to have BY ACCIDENT -- close and lose it --
  // is the thing being fixed. It must not come back as error handling.
  const fn = extractFunction(HTML, 'function ncliSave() {');
  const fail = fn.slice(fn.indexOf('if (!(r && r.ok))'), fn.indexOf('hlFormForget'));
  assert.ok(!/closeForms\(\)/.test(fail), 'a failed save must not close the form');
  assert.match(fail, /still here/);
});

test('the address failing does not get reported as a clean save', () => {
  // The address is a separate write and is allowed to fail on its own. Saying
  // "added" when the address vanished is how a crew turns up at no address.
  const fn = extractFunction(HTML, 'function ncliSave() {');
  assert.match(fn, /r\.locationSaved/);
  assert.match(fn, /the address did not save/);
});

test('the client book is refreshed, so the new client is findable at once', () => {
  const fn = extractFunction(HTML, 'function ncliSave() {');
  assert.match(fn, /REAL_LOADED = false/, 'the cached book is stale the moment a client is added');
  assert.match(fn, /loadClientsLive\(\)/);
});

test('now that it really saves, it is guarded like the rest', () => {
  const cfg = HTML.slice(HTML.indexOf('var FORM_DRAFT_KINDS'), HTML.indexOf('function ncliSave'));
  assert.match(cfg, /'fm-client': \{/);
  assert.match(cfg, /kind: 'client'/);
});

// ---- the server end --------------------------------------------------------

test('the API stores the seven fields the form asks beyond name and address', () => {
  const fn = extractFunction(TRACK1, 'async function handleCreateClient(req, res) {');
  for (const col of ['client_type', 'preferred_contact', 'source', 'brand',
                     'membership', 'second_contact', 'property_notes']) {
    assert.ok(fn.includes(col), col + ' is collected by the form but never stored');
  }
});

test('blank answers are stored as null, not empty string', () => {
  // "Not asked" and "answered blank" must read the same downstream, or every
  // consumer has to test for both.
  const fn = extractFunction(TRACK1, 'async function handleCreateClient(req, res) {');
  assert.match(fn, /client_type: String\(b\.clientType \|\| ''\)\.trim\(\) \|\| null/);
});

test('the quick-add path that only has a name still works', () => {
  // The Schedule board creates a client mid-booking with a name and nothing
  // else. A required field added here would break a dispatcher's flow.
  const fn = extractFunction(TRACK1, 'async function handleCreateClient(req, res) {');
  const required = fn.slice(0, fn.indexOf('const row = {'));
  assert.match(required, /if \(!first && !last && !company\)/);
  for (const f of ['clientType', 'preferredContact', 'membership', 'brand']) {
    assert.ok(!new RegExp('!' + f).test(required), f + ' must not be required');
  }
});

test('the columns exist in a migration, all nullable', () => {
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  const sql = fs.readdirSync(dir)
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf-8'))
    .find((t) => /alter table clients add column if not exists property_notes/i.test(t));
  assert.ok(sql, 'columns the app writes with no migration are a production 500');
  for (const col of ['client_type', 'preferred_contact', 'source', 'brand',
                     'membership', 'second_contact', 'property_notes']) {
    assert.ok(new RegExp('add column if not exists ' + col + ' text;').test(sql), col + ' missing');
    assert.ok(!new RegExp(col + ' text not null').test(sql), col + ' must be nullable');
  }
});
