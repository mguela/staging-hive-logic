// Behavioural tests for the leads card/column rendering.
//
// The board's script block only runs once the app is signed in, so it cannot be
// exercised in a signed-out browser. Rather than assert on source patterns and
// call that verification, this lifts the real function bodies out of
// public/index.html and runs them, so the assertions are about output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf8');

function fnSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} not found`);
  // walk braces to the matching close, ignoring those inside strings
  let i = html.indexOf('{', start), depth = 0, q = null;
  for (; i < html.length; i++) {
    const c = html[i], prev = html[i - 1];
    if (q) { if (c === q && prev !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return html.slice(start, i + 1); }
  }
  throw new Error(`could not close ${name}`);
}

// Real sources, with the page's own escaper stubbed to something equivalent.
const sandbox = new Function(`
  const hlEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  ${fnSource('leadAgeLabel')}
  ${fnSource('leadCardKey')}
  ${fnSource('realLeadCardHtml')}
  return { leadAgeLabel, leadCardKey, realLeadCardHtml };
`)();

const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
const card = (o) => sandbox.realLeadCardHtml(Object.assign(
  { id: 'x1', clientId: 'c1', name: 'Bob Vance', title: null, stage: 'request', createdAt: day(2) }, o
));

test('a card leads with the job title and names the customer beneath', () => {
  const h = card({ title: 'Leaking chimney' });
  assert.match(h, /<b>Leaking chimney<\/b>/);
  assert.match(h, /class="lead-who">Bob Vance</);
});

test('a card with no job title falls back to the customer name', () => {
  // Some Jobber requests genuinely have no title.
  assert.match(card({ title: null }), /<b>Bob Vance<\/b>/);
});

test('an overdue request is flagged on the card', () => {
  assert.match(card({ requestId: 'r1', requestOverdue: true }), /<span class="od">OVERDUE<\/span>/);
});

test('a card that is not overdue carries no flag', () => {
  assert.doesNotMatch(card({ requestId: 'r1', requestOverdue: false }), /class="od"/);
});

test('age shows only for cards that came from a request', () => {
  assert.match(card({ requestId: 'r1', createdAt: day(21) }), /class="age">21 days old</);
  // a hand-entered lead has no request date to age against
  assert.doesNotMatch(card({ requestId: null, createdAt: day(21) }), /class="age"/);
});

test('age reads naturally at the boundaries', () => {
  assert.equal(sandbox.leadAgeLabel(day(0)), 'today');
  assert.equal(sandbox.leadAgeLabel(day(1)), '1 day old');
  assert.equal(sandbox.leadAgeLabel(day(9)), '9 days old');
  assert.equal(sandbox.leadAgeLabel(null), '');
  // a clock-skewed future date must not render "-1 days old"
  assert.equal(sandbox.leadAgeLabel(new Date(Date.now() + 86400000).toISOString()), '');
});

test('a card is keyed by its opportunity, falling back to the client', () => {
  assert.equal(sandbox.leadCardKey({ id: 'abc', clientId: 'c1' }), 'abc');
  assert.equal(sandbox.leadCardKey({ id: null, clientId: 'c1' }), 'c:c1');
});

test('two opportunities for one client produce two distinct cards', () => {
  const a = card({ id: 'a', title: 'Bathroom refit' });
  const b = card({ id: 'b', title: 'Railing and painting' });
  assert.notEqual(a, b);
  assert.match(a, /data-lead-key="a"/);
  assert.match(b, /data-lead-key="b"/);
  // both still point at the same customer
  assert.match(a, /data-client-id="c1"/);
  assert.match(b, /data-client-id="c1"/);
});

test('a hostile title cannot inject markup into the board', () => {
  const h = card({ title: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /&lt;img/);
});

test('the inbox sorts overdue first, then longest waiting', () => {
  // the comparator as written in renderRealLeadsBoard
  const src = html.slice(html.indexOf('byStage.request.sort'), html.indexOf('byStage.request.sort') + 400);
  const cmp = new Function('a', 'b', src.slice(src.indexOf('{', src.indexOf('function')) + 1, src.indexOf('});')).trim());
  const rows = [
    { name: 'recent',  createdAt: day(1),  requestOverdue: false },
    { name: 'oldest',  createdAt: day(30), requestOverdue: false },
    { name: 'overdue', createdAt: day(2),  requestOverdue: true },
  ];
  assert.deepEqual(rows.sort(cmp).map((r) => r.name), ['overdue', 'oldest', 'recent']);
});

// --- 2026-08-18: seen on the live board -------------------------------------
// An untitled Jobber request falls back to the customer's name for its title,
// and the card then printed that name again on its own line: "Tom Anderson /
// Tom Anderson". 36 of the 60 live cards did this. A request whose title equals
// its need repeated a third time ("sky hook repair / Alan Johnson / sky hook
// repair").

test('an untitled request shows the customer name once, not twice', () => {
  const h = card({ title: null, name: 'Tom Anderson', requestId: 'r1' });
  assert.equal((h.match(/Tom Anderson/g) || []).length, 1);
  assert.doesNotMatch(h, /class="lead-who"/);
});

test('a titled request still names the customer beneath', () => {
  const h = card({ title: 'Leaking chimney', name: 'Bob Vance' });
  assert.match(h, /<b>Leaking chimney<\/b>/);
  assert.match(h, /class="lead-who">Bob Vance</);
});

test('a need identical to the title is not repeated', () => {
  const h = card({ title: 'sky hook repair', need: 'sky hook repair', name: 'Alan Johnson' });
  assert.equal((h.match(/sky hook repair/g) || []).length, 1);
});

test('a need that adds information is still shown', () => {
  const h = card({ title: 'Deck rebuild', need: 'Rotten boards on the south side', name: 'Cara Diaz' });
  assert.match(h, /class="need">Rotten boards on the south side</);
});

test('a card with nothing but a name still renders that name', () => {
  const h = card({ title: null, name: 'Solo Client', need: null, requestId: null });
  assert.match(h, /<b>Solo Client<\/b>/);
  assert.equal((h.match(/Solo Client/g) || []).length, 1);
});
