// Chris, 2026-08-23, once the New Lead rescue landed: "we need this for all
// forms throughout HiveLogic. How do we apply this?"
//
// One guard, not a copy per form. The New Lead version decided "did he type
// something?" from a hand-written list of field ids, which rots the first time
// somebody adds a field and forgets the list -- and rots SILENTLY, into exactly
// the data loss the guard exists to prevent. This one knows nothing about any
// particular form: it photographs every field on open and compares on the way
// out, so defaults, pre-selected options and pre-filled dates are all in the
// photo and an untouched form is never dirty.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Read normalised: public/index.html is CRLF on a Windows checkout and LF in
// CI, and the rail-form Escape needle below spans a line break, so reading raw
// made this test pass in CI and fail on Chris's machine claiming the handler
// did not exist. It does. See the same note in test/lead-draft-rescue.test.mjs.
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

// A form is just a bag of fields; the guard never sees the markup.
function field(o) {
  return Object.assign({ id: '', type: 'text', value: '', checked: false, isContentEditable: false,
    hasAttribute: () => false, innerText: '' }, o);
}
function sandbox(fields) {
  const root = { querySelectorAll: () => fields };
  const ctx = {
    document: { getElementById: (id) => (id === 'f' ? root : null) },
    JSON, Object, Array, String, console,
  };
  vm.createContext(ctx);
  vm.runInContext(
    extractFunction(HTML, 'function hlFormFields(root) {') + '\n' +
    extractFunction(HTML, 'function hlFormSnapshot(root) {') + '\n' +
    extractFunction(HTML, 'function hlFormWatch(formId) {') + '\n' +
    extractFunction(HTML, 'function hlFormIsDirty(formId) {') + '\n' +
    extractFunction(HTML, 'function hlFormForget(formId) {') + '\n' +
    extractFunction(HTML, 'function hlFormCapture(formId) {') + '\n' +
    'var HL_FORM_SNAPSHOTS = {};', ctx);
  // The var declaration is hoisted; re-run so the object exists before use.
  vm.runInContext('HL_FORM_SNAPSHOTS = {};', ctx);
  return ctx;
}

// ---- the photograph --------------------------------------------------------

test('a form full of DEFAULTS is not dirty', () => {
  // This is the whole reason for snapshotting instead of listing fields. The
  // New Lead form has a defaulted source, division, visit time and a
  // pre-selected urgency; a guard that counted those would fire on an
  // untouched form, and a confirm that cries wolf is one he stops reading.
  const fields = [
    field({ id: 'a', value: 'Referral' }),
    field({ id: 'b', value: '10' }),
    field({ id: 'c', type: 'checkbox', checked: true }),
  ];
  const ctx = sandbox(fields);
  ctx.hlFormWatch('f');
  assert.equal(ctx.hlFormIsDirty('f'), false);
});

test('one character anywhere makes it dirty', () => {
  const fields = [field({ id: 'a', value: '' }), field({ id: 'b', value: 'Referral' })];
  const ctx = sandbox(fields);
  ctx.hlFormWatch('f');
  fields[0].value = 'x';
  assert.equal(ctx.hlFormIsDirty('f'), true);
});

test('a field added tomorrow is protected without anyone remembering it', () => {
  // The failure the hand-written list was always going to have.
  const fields = [field({ id: 'a' })];
  const ctx = sandbox(fields);
  ctx.hlFormWatch('f');
  fields.push(field({ id: 'brand-new-field', value: 'typed into it' }));
  assert.equal(ctx.hlFormIsDirty('f'), true);
});

test('ticking a box counts, and so does a dropdown', () => {
  const fields = [field({ id: 'a', type: 'checkbox', checked: false }), field({ id: 'b', value: 'one' })];
  const ctx = sandbox(fields);
  ctx.hlFormWatch('f');
  fields[0].checked = true;
  assert.equal(ctx.hlFormIsDirty('f'), true);
  fields[0].checked = false;
  assert.equal(ctx.hlFormIsDirty('f'), false, 'and putting it back is not dirty either');
  fields[1].value = 'two';
  assert.equal(ctx.hlFormIsDirty('f'), true);
});

test('typing into a rich-text box counts', () => {
  const fields = [field({ id: 'a', isContentEditable: true, innerText: '' })];
  const ctx = sandbox(fields);
  ctx.hlFormWatch('f');
  fields[0].innerText = 'a note';
  assert.equal(ctx.hlFormIsDirty('f'), true);
});

test('a form nobody opted in for is never dirty', () => {
  // The guard has to be additive. A screen no one has looked at yet must
  // behave exactly as it did before this existed.
  const ctx = sandbox([field({ id: 'a', value: 'typed' })]);
  assert.equal(ctx.hlFormIsDirty('f'), false, 'never watched, never nagged');
});

test('closing forgets the photo, so reopening starts clean', () => {
  const fields = [field({ id: 'a' })];
  const ctx = sandbox(fields);
  ctx.hlFormWatch('f');
  fields[0].value = 'typed';
  assert.equal(ctx.hlFormIsDirty('f'), true);
  ctx.hlFormForget('f');
  assert.equal(ctx.hlFormIsDirty('f'), false);
});

test('a hidden field is not work he would mourn', () => {
  const fields = [field({ id: 'a', type: 'hidden', value: '' })];
  const ctx = sandbox(fields);
  ctx.hlFormWatch('f');
  fields[0].value = 'a token the page set';
  assert.equal(ctx.hlFormIsDirty('f'), false);
});

// ---- what gets saved -------------------------------------------------------

test('capture keys by id, and skips what it could never put back', () => {
  const ctx = sandbox([
    field({ id: 'title', value: 'Deck rebuild' }),
    field({ id: '', value: 'no id, cannot be restored' }),
    field({ id: 'tm', type: 'checkbox', checked: true }),
  ]);
  const snap = ctx.hlFormCapture('f');
  assert.deepEqual(snap, { fields: { title: 'Deck rebuild', tm: true } });
});

// ---- which forms are guarded ----------------------------------------------

test('New Job and New Invoice are guarded -- the two that really save', () => {
  const cfg = HTML.slice(HTML.indexOf('var FORM_DRAFT_KINDS'), HTML.indexOf('function ncliSave'));
  assert.match(cfg, /'fm-job':/);
  assert.match(cfg, /'fm-invoice':/);
  assert.match(cfg, /kind: 'job'/);
  assert.match(cfg, /kind: 'invoice'/);
});

test('the mockup forms are deliberately NOT guarded', () => {
  // fm-payment, fm-estimate and the old fm-lead all call saveForm(), which
  // shows a toast and closes. They store nothing. Offering to save a draft of
  // a form that was never going to save anything is a worse lie than losing
  // it. (fm-client was on this list until it was wired to create_client --
  // the rule is about whether a form saves, not about which form it is.)
  const cfg = HTML.slice(HTML.indexOf('var FORM_DRAFT_KINDS'), HTML.indexOf('function ncliSave'));
  for (const id of ['fm-payment', 'fm-estimate']) {
    assert.ok(!new RegExp("'" + id + "':").test(cfg), id + ' is a mockup and must not be guarded');
  }
  assert.match(cfg, /mockups that store nothing/, 'and the reason must be written down');
});

test('every guarded form really has a save path', () => {
  // The guard promising to keep work for a form that discards it would be the
  // same lie from the other direction.
  const cfg = HTML.slice(HTML.indexOf('var FORM_DRAFT_KINDS'), HTML.indexOf('function ncliSave'));
  const guarded = [...cfg.matchAll(/'(fm-[a-z]+)':/g)].map((m) => m[1]);
  assert.ok(guarded.length >= 2);
  for (const id of guarded) {
    const at = HTML.indexOf('id="' + id + '"');
    const body = HTML.slice(at, at + 6000);
    const save = /class="fm-save" onclick="([^"]+)"/.exec(body);
    assert.ok(save, id + ' has no save button');
    assert.ok(!/^saveForm\(/.test(save[1]),
      id + ' is guarded but its save is a toast: ' + save[1]);
  }
});

// ---- the exits -------------------------------------------------------------

test('all three ways out of a rail form go through the guard', () => {
  assert.match(HTML, /<div class="dwv" id="dwv" onclick="if\(event\.target===this\)hlCloseFormsGuarded\(\)">/);
  assert.match(HTML, /<b>New Job<\/b><span class="x" onclick="hlCloseFormsGuarded\(\)">/);
  // Four handlers in the page answer Escape; the rail-form one is identified
  // by what it does, not by where it sits.
  const at = HTML.indexOf("document.addEventListener('keydown',function(e){if(e.key==='Escape'){\n");
  assert.ok(at > -1, 'the rail-form Escape handler must exist');
  assert.match(HTML.slice(at, at + 600), /hlCloseFormsGuarded\(\)/);
});

test('with no rail form open it is exactly closeForms()', () => {
  const fn = extractFunction(HTML, 'function hlCloseFormsGuarded() {');
  assert.match(fn, /if \(!id \|\| !cfg\) \{ closeForms\(\); return; \}/);
});

test('the photo is taken AFTER the form is reset', () => {
  // Watching before njobReset would photograph the previous job's values and
  // call the fresh form dirty the instant it opened.
  const fn = extractFunction(HTML, 'function openForm(k){');
  const reset = fn.indexOf('njobReset');
  const watch = fn.indexOf('hlFormWatch');
  assert.ok(reset > -1 && watch > reset, 'hlFormWatch must come after the reset');
});

test('a failed draft save keeps the form open', () => {
  const fn = extractFunction(HTML, 'function hlFormSaveDraft(formId, opts) {');
  const after = fn.slice(fn.indexOf('// Never close'));
  assert.ok(!/o\.close\(\)/.test(after), 'a failed save must not close');
  assert.match(after, /still here/);
});

test('a form with no draft kind gets keep-or-discard, not a save it cannot do', () => {
  const fn = extractFunction(HTML, 'function hlFormTryClose(formId, opts) {');
  assert.match(fn, /if \(o\.kind\) \{/, 'Save as draft is offered only when there is somewhere to save it');
});

// ---- storage ---------------------------------------------------------------

test('one table for every kind of draft, filtered per screen', () => {
  const fn = extractFunction(TRACK1, 'async function handleFormDrafts(req, res) {');
  assert.match(fn, /kind=eq\.\$\{encodeURIComponent\(kind\)\}/);
  assert.match(fn, /const kindFilter = kind \? /);
  assert.match(fn, /owner_id=eq\.\$\{owner\}/, 'still owner-scoped');
});

test('the old resource name still answers', () => {
  // A page cached in someone's browser from before the rename would otherwise
  // start failing on a form they already had open.
  assert.match(TRACK1, /resource === 'form_drafts' \|\| resource === 'lead_drafts'/);
});

test('the rename is a migration, and it keeps the row-level security', () => {
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  const sql = fs.readdirSync(dir)
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf-8'))
    .find((t) => /alter table if exists lead_drafts rename to form_drafts/i.test(t));
  assert.ok(sql, 'the rename must be recorded, not just done by hand');
  assert.match(sql, /add column if not exists kind text not null default 'lead'/i,
    'existing rows are lead drafts by definition');
  assert.match(sql, /alter policy lead_drafts_own_select on form_drafts rename/i,
    'the policies must come with it');
});
