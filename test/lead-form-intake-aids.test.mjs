// Four things Chris asked for while working through the New Lead form on
// 2026-08-23, all of them about the same problem: the form let him type past
// things HiveLogic already knew.
//
//   "while creating a new client in New leads, it should still be searching the
//    existing client list to ensure you do not create a duplicate client folder."
//   "as you are entering a new address for the new client, it should be offering
//    a selectable list of addresses that relate to the charachters being typed"
//   "its not really offering confirmation that the address typed into the text
//    box is recognized and confirmed"
//   "in the dollar value in approximate cost, you should be able to see in in a
//    Dllar value with comas etc."
//   "You should also be able to select the type of home, Condo, coop,
//    apartment, multifamily, townhouse etc."
//
// The duplicate one is not a tidiness problem. A second client folder starts
// with no jobs, no balance, no addresses and no history, so whoever picks the
// lead up is working blind on a customer of ten years.

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

// Run a function straight out of the page source, so these test the real code
// rather than a copy of it that can drift.
function liveFn(decl) {
  const src = extractFunction(HTML, decl);
  return new Function('return (' + src + ')')();
}

// ---- duplicate clients ------------------------------------------------------

test('every identity field re-checks for a duplicate, not just the name', () => {
  // Pressing "+ New client" used to stop all checking dead. Phone and email are
  // the strongest signals and were not being used at all.
  for (const id of ['nl-first', 'nl-last', 'nl-phone', 'nl-email']) {
    const i = HTML.indexOf('id="' + id + '"');
    assert.ok(i > -1, id + ' should exist');
    // Bounded to THIS element -- a fixed-width window ran past the closing
    // bracket and matched the next field's handler, so the check passed with
    // the phone field unwired. Same trap as reading a grep window instead of
    // the statement.
    const tag = HTML.slice(i, HTML.indexOf('>', i));
    // 2026-08-26: oninput also clears this field's required-validation
    // red-border now (nlClearReq) -- nlDupeCheck() just has to still be
    // one of the calls, not the whole attribute value.
    assert.match(tag, /oninput="[^"]*nlDupeCheck\(\)[^"]*"/, id + ' should re-run the check, got: ' + tag);
  }
});

test('a match on the phone number outranks a match on the name', () => {
  // Nobody shares a mobile by accident. Two people share a surname constantly.
  const fn = extractFunction(HTML, 'function nlDupeMatches() {');
  assert.ok(fn.indexOf('the same phone number') < fn.indexOf('the same name'),
    'phone is checked first so it is the reason shown');
  assert.ok(fn.indexOf('the same email address') < fn.indexOf('the same name'));
});

test('a phone matches on its last ten digits', () => {
  // One record has +19145550111 and the other has (914) 555-0111. They are the
  // same number and a string compare says otherwise.
  const nlLast10 = liveFn('function nlLast10(v) {');
  assert.strictEqual(nlLast10('+19145550111'), '9145550111');
  assert.strictEqual(nlLast10('(914) 555-0111'), '9145550111');
  assert.strictEqual(nlLast10('914.555.0111'), '9145550111');
  assert.strictEqual(nlLast10('555-0111'), '', 'too short to be an identity');
  assert.strictEqual(nlLast10(''), '');
});

test('a half-typed name does not fire the warning', () => {
  // It has to survive being useful on the third day. Matching on a fragment
  // would light up on every keystroke and get ignored.
  const fn = extractFunction(HTML, 'function nlDupeMatches() {');
  assert.match(fn, /if \(first && last\)/, 'both halves must be present');
  assert.match(fn, /words\.indexOf\(first\) > -1 && words\.indexOf\(last\) > -1/,
    'and both must appear as whole words in the client\'s own name');
});

test('"Smith" alone is not a duplicate', () => {
  const nlNameWords = liveFn('function nlNameWords(v) {');
  assert.deepEqual(nlNameWords('Lori A. Kendall'), ['lori', 'a', 'kendall']);
  // Whole-word matching is what stops "Ann" matching "Joanne".
  assert.ok(!nlNameWords('Joanne Baxter').includes('ann'));
});

test('an already-linked client cannot duplicate itself', () => {
  const fn = extractFunction(HTML, 'function nlDupeMatches() {');
  assert.match(fn, /if \(linked && linked\.value\) return \[\];/);
});

test('"we do not know yet" is a different answer from "no duplicates"', () => {
  // The client book loads asynchronously. Saying nothing while it is missing
  // would quietly imply the coast is clear.
  const fn = extractFunction(HTML, 'function nlDupeMatches() {');
  assert.match(fn, /REAL_LOADED\) return null;/);
  const check = extractFunction(HTML, 'function nlDupeCheck() {');
  assert.match(check, /hits === null/, 'and the strip stays silent rather than saying "no duplicates"');
});

test('the warning never blocks the save', () => {
  // Two real people do share a name, and a form that refuses to proceed is a
  // form he cannot use.
  const check = extractFunction(HTML, 'function nlDupeCheck() {');
  assert.match(check, /nothing here stops you/);
  const core = extractFunction(HTML, 'function nlSaveLeadCore(extra) {');
  assert.ok(!/nlDupe/.test(core), 'the save does not consult it at all');
});

test('picking the existing client links the lead to them', () => {
  const fn = extractFunction(HTML, 'function nlDupeUse(id) {');
  assert.match(fn, /nlClientPick\(id\)/);
  assert.match(fn, /nlBackToSearch\(\)/, 'and the form stops pretending to create one');
});

// ---- address suggestions ----------------------------------------------------

test('the address box offers what HiveLogic already knows, first', () => {
  // 6,409 of 8,690 clients have one, they are already in the browser, and an
  // address we hold usually means a client we hold.
  const fn = extractFunction(HTML, 'function nlKnownAddresses(q) {');
  assert.match(fn, /REAL_CLIENTS/);
  assert.match(fn, /c\.isArchived\) return;|if \(!c\.address \|\| c\.isArchived\) continue;/);
  const render = extractFunction(HTML, 'function nlAddrRender(known, suggestions) {');
  assert.ok(render.indexOf('ALREADY ON FILE') < render.indexOf('OTHER ADDRESSES'),
    'on-file addresses come first because they are worth more');
});

test('the on-file list says whose address it is', () => {
  const render = extractFunction(HTML, 'function nlAddrRender(known, suggestions) {');
  assert.match(render, /clientName/);
  assert.match(render, /links the lead to them/);
});

test('the outside lookup is debounced hard enough to respect the geocoder', () => {
  // Nominatim's usage policy is one request a second. Firing per keystroke
  // would get the IP blocked and take the service-area geocoding with it --
  // a feature nobody was touching.
  const fn = extractFunction(HTML, 'function nlAddrInput(v) {');
  assert.match(fn, /}, 700\);/, 'one lookup per address typed, not thirty');
  assert.match(fn, /NL_ADDR_CACHE/, 'and backspacing costs nothing');
  assert.match(fn, /raw\.trim\(\)\.length < 6/, 'a two-letter fragment is not a lookup worth making');
});

test('a stale lookup cannot overwrite a newer one', () => {
  const fn = extractFunction(HTML, 'function nlAddrInput(v) {');
  assert.match(fn, /seq !== NL_ADDR_SEQ\) return;/);
  assert.strictEqual((fn.match(/seq !== NL_ADDR_SEQ\) return;/g) || []).length, 2,
    'both the success and the failure path must check');
});

test('the server end refuses a query too short to be an address', () => {
  const fn = extractFunction(TRACK1, 'async function handleAddressSuggest(req, res) {');
  assert.match(fn, /q\.length < 6/);
  assert.match(fn, /checkRateLimit/, 'and caps how fast one user can ask');
  assert.match(fn, /countrycodes=us/);
  assert.match(fn, /User-Agent/, "Nominatim's policy requires an identifying one");
});

test('a geocoder outage is a missing convenience, never a failure', () => {
  // The box still takes anything typed into it.
  const fn = extractFunction(TRACK1, 'async function handleAddressSuggest(req, res) {');
  // The property, not a count of return statements: NO path may answer with an
  // error status, because a red address box for a geocoder outage would have
  // him retyping a correct address until he gave up.
  const statuses = [...fn.matchAll(/res\.status\((\d+)\)/g)].map((m) => m[1]);
  assert.ok(statuses.length >= 4, 'expected several exits, found ' + statuses.length);
  assert.deepEqual([...new Set(statuses)], ['200'], 'every exit is a 200, got ' + statuses.join(','));
  assert.match(fn, /reason: 'unreachable'/);
  assert.match(fn, /reason: 'throttled'/);
});

// ---- "is this address recognised?" ------------------------------------------

test('the box always says where it stands', () => {
  // Chris: "its not really offering confirmation that the address typed into
  // the text box is recognized and confirmed."
  assert.match(HTML, /id="nl-addr-state"/);
  const settle = extractFunction(HTML, 'function nlAddrSettle(raw, known, suggestions) {');
  assert.match(settle, /✓ Address confirmed/);
  assert.match(settle, /Not recognised/);
  const input = extractFunction(HTML, 'function nlAddrInput(v) {');
  assert.match(input, /Checking this address…/, 'including while it is still working it out');
});

test('an address on file reads differently from one merely confirmed', () => {
  // "This is Lori Kendall's address" is a stronger and more useful fact than
  // "OpenStreetMap has heard of this street".
  const settle = extractFunction(HTML, 'function nlAddrSettle(raw, known, suggestions) {');
  assert.match(settle, /if \(onFile\) return;/);
  const input = extractFunction(HTML, 'function nlAddrInput(v) {');
  assert.match(input, /✓ On file/);
});

test('a failed lookup does not call the address wrong', () => {
  // Those are different things, and one of them has him retyping a correct
  // address until he gives up.
  const fn = extractFunction(HTML, 'function nlAddrInput(v) {');
  assert.match(fn, /Could not check this address just now/);
  assert.match(fn, /it will still save/);
});

// ---- money ------------------------------------------------------------------

test('approximate cost shows as money', () => {
  const fmt = liveFn('function nlMoneyInput(el) {');
  const box = (v) => { const el = { value: v, setSelectionRange() {} }; fmt(el); return el.value; };
  assert.strictEqual(box('850'), '$850');
  assert.strictEqual(box('1234'), '$1,234');
  assert.strictEqual(box('1234567'), '$1,234,567');
  assert.strictEqual(box('0850'), '$850', 'a leading zero is a typo, not a value');
});

test('the money box refuses what is not a number', () => {
  const fmt = liveFn('function nlMoneyInput(el) {');
  const box = (v) => { const el = { value: v, setSelectionRange() {} }; fmt(el); return el.value; };
  assert.strictEqual(box('abc'), '');
  assert.strictEqual(box('.'), '');
  assert.strictEqual(box('12.34.56'), '$12.34', 'one decimal point only');
  assert.strictEqual(box('1250.5'), '$1,250.5', 'and cents stay as typed mid-thought');
});

test('the formatted value round-trips back to a number', () => {
  // "$1,250" reaching the API as a string lands as null -- a lead he priced,
  // saved as unpriced.
  const val = liveFn('function nlMoneyValue(v) {');
  assert.strictEqual(val('$1,250'), 1250);
  assert.strictEqual(val('$1,234,567.89'), 1234567.89);
  assert.strictEqual(val(''), 0);
  assert.strictEqual(val(null), 0);
  const read = extractFunction(HTML, 'function nlReadForm() {');
  assert.match(read, /nlMoneyValue\(v\('nl-approx'\)\)/);
});

// ---- property type ----------------------------------------------------------

test('the property kind is offered, and it is the list he asked for', () => {
  assert.match(HTML, /id="nl-propkind"/);
  const kinds = HTML.slice(HTML.indexOf('var NL_PROP_KINDS = {'), HTML.indexOf('function nlFillPropKinds'));
  for (const want of ['condo', 'co_op', 'apartment', 'townhouse', 'multi_family_2_4', 'single_family']) {
    assert.ok(kinds.includes("'" + want + "'"), want + ' should be offered');
  }
});

test('the list follows the residential/commercial split', () => {
  const pick = extractFunction(HTML, 'function nlPickType(el) {');
  assert.match(pick, /nlFillPropKinds\(/);
  const fill = extractFunction(HTML, 'function nlFillPropKinds(which, keep) {');
  // Switching sides must not leave a commercial kind on a residential lead.
  assert.match(fill, /list\.some\(function \(o\) \{ return o\[0\] === want; \}\) \? want : ''/);
});

test('the choice is stored as a stable key, not the label', () => {
  // Renaming what the office calls something must not orphan a year of leads.
  const kinds = HTML.slice(HTML.indexOf('var NL_PROP_KINDS = {'), HTML.indexOf('function nlFillPropKinds'));
  assert.match(kinds, /\['condo', 'Condo'\]/);
});

test('it is actually saved, which the old picker never was', () => {
  // The Residential/Commercial segment has posted `propertyType` since the form
  // was built and api/track1.js had nowhere to put it, so every choice anyone
  // ever made was dropped on the floor.
  const read = extractFunction(HTML, 'function nlReadForm() {');
  assert.match(read, /propertyType: v\('nl-propkind'\) \|\| v\('nl-proptype'\)/,
    'the finer kind, falling back to the split so this is never emptier than before');
  assert.match(TRACK1, /property_type: String\(b\.propertyType \|\| ''\)\.trim\(\)\.slice\(0, 60\) \|\| null/);
  assert.match(TRACK1, /if \(b\.propertyType !== undefined\) patch\.property_type/,
    'editing a lead must not silently wipe it');
  assert.match(TRACK1, /propertyType: p\.property_type \|\| null/, 'and it has to come back out');
});

test('the migration is additive and replay-safe', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260823220000_lead_property_type.sql'), 'utf-8');
  assert.match(sql, /add column if not exists property_type text/);
  assert.ok(!/drop |delete |truncate /i.test(sql));
});

test('a new lead starts with all of this cleared', () => {
  // A property kind, a duplicate warning or an address state carried over from
  // the last lead is a wrong answer nobody typed.
  const fn = extractFunction(HTML, 'function nlResetForm() {');
  assert.match(fn, /nlFillPropKinds\('residential', ''\)/);
  assert.match(fn, /nl-dupe/);
  assert.match(fn, /nlAddrClose\(\)/);
  assert.match(fn, /nlAddrState\('', ''\)/);
});

test('the property kind is part of the draft', () => {
  const line = HTML.match(/var NL_TEXT_FIELDS = \[[^\]]*\]/)[0];
  assert.ok(line.includes('nl-propkind'), 'or a rescued draft loses it');
});

// ---- apartment / suite / unit ----------------------------------------------

test('there is somewhere to put an apartment number', () => {
  // Chris: "no place for a apartment number or suite etc. on the address on
  // the lead form". He was typing it into the street box, which is also the
  // one thing that stops the address matching anything: neither the on-file
  // list nor OpenStreetMap has heard of a street called "Apt 2b".
  assert.match(HTML, /id="nl-unit"/);
  const i = HTML.indexOf('id="nl-unit"');
  const tag = HTML.slice(i, HTML.indexOf('>', i));
  assert.ok(!/oninput="nlAddrInput/.test(tag), 'the unit must not feed the address lookup');
});

test('the unit goes after the street, not on the end of the line', () => {
  // "14 Maple Ave, Greenwich, CT, Apt 2B" is what the tech gets handed
  // otherwise, and it reads as a fourth address line.
  const join = liveFn('function nlJoinAddress(addr, unit) {');
  assert.strictEqual(join('14 Maple Ave, Greenwich, CT 06830', '2B'), '14 Maple Ave Apt 2B, Greenwich, CT 06830');
  assert.strictEqual(join('14 Maple Ave, Greenwich, CT', 'Apt 2B'), '14 Maple Ave Apt 2B, Greenwich, CT');
  assert.strictEqual(join('14 Maple Ave', 'Suite 300'), '14 Maple Ave Suite 300');
});

test('a bare unit number gets a label', () => {
  // "14 Maple Ave 2B" reads as a house number. "Apt 2B" does not.
  const join = liveFn('function nlJoinAddress(addr, unit) {');
  assert.match(join('14 Maple Ave, Greenwich', '2B'), /Apt 2B/);
  assert.match(join('14 Maple Ave, Greenwich', '4'), /Apt 4/);
  // Anything already labelled is left exactly as typed.
  assert.strictEqual(join('14 Maple Ave, Greenwich', 'Suite 300'), '14 Maple Ave Suite 300, Greenwich');
  assert.strictEqual(join('14 Maple Ave, Greenwich', 'Rear cottage'), '14 Maple Ave Rear cottage, Greenwich');
});

test('an empty unit changes nothing', () => {
  const join = liveFn('function nlJoinAddress(addr, unit) {');
  assert.strictEqual(join('14 Maple Ave, Greenwich', ''), '14 Maple Ave, Greenwich');
  assert.strictEqual(join('14 Maple Ave, Greenwich', '   '), '14 Maple Ave, Greenwich');
  assert.strictEqual(join('', ''), '');
});

test('the joined address is what gets saved', () => {
  const read = extractFunction(HTML, 'function nlReadForm() {');
  assert.match(read, /serviceAddress: nlJoinAddress\(v\('nl-addr'\), v\('nl-unit'\)\)/);
});

test('the unit is cleared and kept in the draft like every other field', () => {
  const reset = extractFunction(HTML, 'function nlResetForm() {');
  assert.match(reset, /'nl-unit'/, 'or the last lead\'s apartment number rides along to the next one');
  const line = HTML.match(/var NL_TEXT_FIELDS = \[[^\]]*\]/)[0];
  assert.ok(line.includes('nl-unit'), 'or a rescued draft loses it');
});

test('the website form asks for it too, and joins it the same way', () => {
  const FORM = fs.readFileSync(path.join(__dirname, '..', 'public', 'web-lead-form.html'), 'utf-8');
  const API = fs.readFileSync(path.join(__dirname, '..', 'api', 'web-lead.js'), 'utf-8');
  assert.match(FORM, /name="unit"/);
  assert.match(FORM, /autocomplete="address-line2"/);
  assert.match(FORM, /unit: form\.unit\.value/);
  assert.match(API, /joinAddress\(noTags\(b\.address, CAPS\.address\), noTags\(b\.unit, CAPS\.unit\)\)/);
  assert.match(API, /unit: 30/, 'and it is capped like everything else a stranger can send');
});

// ---- what the job form inherits from the lead ------------------------------

test('division and estimated value carry over to the job', () => {
  // Chris: "Why does't divison and estimated value carry over to the job from
  // the leads form?" They were collected, saved on the lead, and then not
  // handed on -- so he retyped both into the job form thirty seconds after
  // typing them into the lead form.
  const core = extractFunction(HTML, 'function nlSaveLeadCore(extra) {');
  assert.match(core, /division: f\.division, estimatedValue: f\.estimatedValue/);

  const job = extractFunction(HTML, 'function nlGoJob() {');
  assert.match(job, /hlSetSelectWhenReady\('njob-div', res\.division\)/);
  assert.match(job, /njob-total/);
});

test('the pipeline card route carries them too', () => {
  // Both routes reach the same job form and both were dropping these.
  const fn = extractFunction(HTML, 'function rlmStartJob() {');
  assert.match(fn, /hlSetSelectWhenReady\('njob-div', l\.division\)/);
  assert.match(fn, /njob-total/);
});

test('a division set before its options load is not silently dropped', () => {
  // The division list is fetched once and cached, so the FIRST time a form
  // opens the options are still in flight. Setting .value then does nothing at
  // all, and the field reads "none" -- indistinguishable from the lead never
  // having had a division.
  const fn = extractFunction(HTML, 'function hlSetSelectWhenReady(selId, value) {');
  assert.match(fn, /setTimeout\(attempt, 150\)/);
  assert.match(fn, /tries\+\+ < 20/, 'and it gives up rather than spinning forever');
  assert.match(fn, /sel\.options\[i\]\.value === want/, 'it waits for the OPTION, not just the element');
});

test('the job form reads its money box through the parser', () => {
  // The box shows "$1,250" now that the value flows in from the lead.
  // parseFloat("$1,250") is NaN, so the estimated value would have saved as
  // null -- a job priced at nothing.
  assert.match(HTML, /total: nlMoneyValue\(document\.getElementById\('njob-total'\)\.value\) \|\| null/);
  const i = HTML.indexOf('id="njob-total"');
  const tag = HTML.slice(i, HTML.indexOf('>', i));
  assert.match(tag, /oninput="nlMoneyInput\(this\)"/, 'and formats as money like the lead form');
  assert.ok(!/type="number"/.test(tag), 'a number field cannot show a comma');
});

test('the time-and-materials checkbox says what it does', () => {
  // Chris: "Idk whath the check box is for thats labled time and materials
  // job". It was four words with no explanation, and it reveals a rate card
  // picker -- so what it actually decides is whether the client pays for hours
  // or pays the quoted figure.
  assert.ok(!HTML.includes('>TIME &amp; MATERIALS JOB</label>'), 'the bare label is gone');
  assert.match(HTML, /HOW IS THIS BILLED\?/);
  assert.match(HTML, /Bill by the hour \(time &amp; materials\)/);
  assert.match(HTML, /Leave this off for a fixed price/);
  assert.match(HTML, /WHICH RATE CARD\?/);
});
