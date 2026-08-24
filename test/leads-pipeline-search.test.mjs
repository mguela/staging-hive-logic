// Chris, 2026-08-23: "add a search to the Leads pipeline."
//
// There was already a search, but only over the New column, and it matched only
// l.name. A lead sitting in Quoted or Won was unfindable, and so was one you
// remembered by its job title ("deck rebuild") rather than the customer's name.
//
// The trap this feature keeps walking into is where the input lives. The old
// New-column box was rendered INSIDE #lgrid-board, whose innerHTML is replaced
// on every keystroke -- an earlier version of it destroyed itself mid-type and
// silently stopped filtering. The fix is structural, not a workaround: the
// input is static markup OUTSIDE the board, so re-rendering can never eat it.
// That is what the first test here pins.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Normalised: this file is CRLF on Windows and LF in CI, and the needles below
// span line breaks. See test/lead-draft-rescue.test.mjs for what that costs.
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8').replace(/\r\n/g, '\n');

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

// ---- where the input lives -------------------------------------------------

test('the search input is outside the board, so re-rendering cannot destroy it', () => {
  const boardAt = HTML.indexOf('<div class="board" id="lgrid-board">');
  const inputAt = HTML.indexOf('id="lgrid-search"');
  assert.ok(inputAt > -1, 'the pipeline search input must exist');
  assert.ok(boardAt > -1, 'the board must exist');
  assert.ok(inputAt < boardAt, 'the input must be declared BEFORE the board element, not inside it');

  // and the board's own render must not emit an input of its own again
  const render = extractFunction(HTML, 'function renderRealLeadsBoard(leads) {');
  assert.ok(!/<input/.test(render), 'renderRealLeadsBoard must not render an input into the board');
});

test('the old New-column-only search is gone, not merely shadowed', () => {
  for (const dead of ['lgrid-new-search', 'lgrid-new-cards', 'LEADS_NEW_ROWS', 'leadsNewFilteredCardsHtml']) {
    assert.ok(!new RegExp(dead).test(HTML), dead + ' must be gone');
  }
});

test('the Clear button is wired in JS, never by inline onclick', () => {
  // Caught in the browser, not in review: every leads function lives inside the
  // big "HL Reina Phase 1 wiring" IIFE, so none of them is global. An inline
  // onclick="leadsClearSearch()" parses fine, ships fine, and throws
  // ReferenceError the first time anyone clicks it.
  const markup = HTML.slice(HTML.indexOf('id="lgrid-search-clear"') - 400, HTML.indexOf('id="lgrid-search-clear"') + 400);
  assert.ok(!/onclick=/.test(markup), 'the Clear button must not use an inline onclick');
  const wire = extractFunction(HTML, 'function wireLeadsSearch() {');
  assert.match(wire, /lgrid-search-clear/);
  assert.match(wire, /addEventListener\('click', leadsClearSearch\)/);
  assert.match(wire, /clr\._hlWired/, 'and must not stack a handler per render');
});

test('typing re-renders the board rather than patching one column', () => {
  const wire = extractFunction(HTML, 'function wireLeadsSearch() {');
  assert.match(wire, /inp\._hlWired/, 'wiring must be idempotent -- render calls it every time');
  assert.match(wire, /renderRealLeadsBoard\(REAL_LEADS\)/);
  assert.match(wire, /e\.key === 'Escape'/, 'Escape clears, like every other overlay in the app');
});

// ---- what actually matches -------------------------------------------------

function matcher() {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(HTML, 'function leadsMatchesSearch(l, q) {'), ctx);
  return (lead, q) => ctx.leadsMatchesSearch(lead, String(q).toLowerCase());
}

const LEAD = {
  title: 'Deck rebuild', name: 'Priya Raman', need: 'rotten joists',
  leadSource: 'Referral', division: 'Carpentry', lostReason: null,
};

test('an empty search matches everything, so the board is never hidden by default', () => {
  assert.equal(matcher()(LEAD, ''), true);
  assert.equal(matcher()({}, ''), true);
});

test('every field the card actually shows is searchable', () => {
  const m = matcher();
  // The point of the change: the old one searched name and nothing else.
  for (const q of ['deck', 'priya', 'joists', 'referral', 'carpentry']) {
    assert.equal(m(LEAD, q), true, q + ' must match');
  }
});

test('a lost reason is searchable too, since the card prints it', () => {
  assert.equal(matcher()({ ...LEAD, lostReason: 'Too expensive' }, 'expensive'), true);
});

test('search is case-insensitive and matches mid-word', () => {
  const m = matcher();
  assert.equal(m(LEAD, 'RAMAN'.toLowerCase()), true);
  assert.equal(m(LEAD, 'aman'), true, 'substring, not prefix -- he types what he remembers');
});

test('a miss is a miss', () => {
  assert.equal(matcher()(LEAD, 'plumbing'), false);
});

test('missing fields never throw -- a half-filled lead is normal here', () => {
  const m = matcher();
  assert.equal(m({}, 'anything'), false);
  assert.equal(m({ title: null, name: undefined, need: '' }, 'x'), false);
  assert.equal(m({ estimatedValue: 0 }, 'x'), false, 'a falsy non-string field must not be read as text');
});

// ---- what the columns say while filtered -----------------------------------

test('a filtered column says "3 of 41", so a thin column reads as the filter working', () => {
  const render = extractFunction(HTML, 'function renderRealLeadsBoard(leads) {');
  assert.match(render, /rows\.length \+ ' of ' \+ all\.length/);
  assert.match(render, /No matches here/, 'and an empty filtered column must not claim the stage is empty');
  // The un-filtered wording has to survive: an empty Requests column means
  // Jobber sent nothing, which is a different fact from "no matches".
  assert.match(render, /No new requests from Jobber/);
});

test('the column total counts only what is on screen', () => {
  const render = extractFunction(HTML, 'function renderRealLeadsBoard(leads) {');
  const valueLine = render.slice(render.indexOf('var value ='), render.indexOf('var cls ='));
  assert.match(valueLine, /rows\.reduce/, 'value must sum the filtered rows, not all of them');
  assert.ok(!/all\.reduce/.test(valueLine), 'a total counting hidden cards cannot be reconciled with the column');
});

test('the summary line reports across every stage, and says so when nothing matches', () => {
  const render = extractFunction(HTML, 'function renderRealLeadsBoard(leads) {');
  assert.match(render, /totalShown \+ ' of ' \+ totalAll \+ ' leads match/);
  assert.match(render, /Nothing matches/);
  assert.match(render, /lgrid-search-clear/, 'and a Clear button appears only while filtering');
});
