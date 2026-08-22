// test/command-center-right-column-consistency.test.mjs
//
// Chris, 2026-08-17: "Watching, TEAM TO-DO, NOTIFICATIONS all have different
// looks to them."
//
// He said it twice, and the first fix missed. That attempt (#353) matched the
// three cards' TYPOGRAPHY -- title weight, muted detail line, status pip --
// which was a real difference but not the one anyone can see from across the
// room. The visible one lived in a rule nobody had looked at:
//
//     #watching-panel{background:#eef1f6}
//     #watching-panel .w{background:#fff;border:…;border-radius:10px;…}
//
// Watching was a grey tray holding white row-cards; Team To-Do and
// Notifications were flat lists with a hairline between rows. Same card type,
// same column, two completely different treatments -- and the typography fix
// changed nothing anyone would notice next to it.
//
// These tests pin the three cards to ONE set of rules, so the next styling
// change cannot quietly apply to one of them and not the others.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// The three cards that sit together in the Command Center's right column, and
// the row class each one renders.
const PANELS = [
  { id: 'watching-panel', row: '.w' },
  { id: 'team-todo-panel', row: '.w' },
  { id: 'cc-notifications-panel', row: '.lv' },
];

function ruleFor(selectorFragment) {
  // Returns the whole CSS rule (selector list + body) containing the fragment.
  const at = html.indexOf(selectorFragment);
  if (at === -1) return null;
  const start = html.lastIndexOf('\n', at) + 1;
  const end = html.indexOf('}', at);
  return html.slice(start, end + 1);
}

test('all three cards get their tray background from one rule', () => {
  const rule = ruleFor('#watching-panel,#team-todo-panel,#cc-notifications-panel{background:');
  assert.ok(rule, 'the three panels must share one background rule — separate rules are how they drifted apart');
  for (const p of PANELS) {
    assert.ok(rule.includes('#' + p.id), `${p.id} must be in the shared tray rule`);
  }
});

test('all three cards get their row chrome from one rule', () => {
  const rule = ruleFor('#watching-panel .w,#team-todo-panel .w,#cc-notifications-panel .lv{background:#fff');
  assert.ok(rule, 'row background/border/radius must come from a single shared rule');
  for (const decl of ['border:1px solid var(--line)', 'border-radius:10px', 'padding:11px 13px', 'margin-bottom:8px']) {
    assert.ok(rule.includes(decl), `the shared row rule must carry ${decl}`);
  }
  for (const p of PANELS) {
    assert.ok(rule.includes(`#${p.id} ${p.row}`), `${p.id} ${p.row} must be in the shared row rule`);
  }
});

test('the last row in each card drops its trailing margin, in one rule', () => {
  const rule = ruleFor('#watching-panel .w:last-child,');
  assert.ok(rule, 'the :last-child margin reset must be shared too');
  for (const p of PANELS) {
    assert.ok(rule.includes(`#${p.id} ${p.row}:last-child`), `${p.id} needs its last row's margin reset like the others`);
  }
});

test('no card carries private row chrome of its own', () => {
  // A rule that gives ONE panel a background/border/radius its siblings do not
  // get is exactly how this happened. Every rule that styles one of these rows
  // must name all three -- a selector list ending in one panel is fine (that is
  // just where it sits in the list); a rule mentioning ONE of them is not.
  const ruleRe = /([^{}]*#(?:watching-panel|team-todo-panel|cc-notifications-panel)[^{}]*)\{([^}]*)\}/g;
  // A panel's rows are reached either by the scoped selector (#panel .w) or by
  // the bare class (.w / .lv), which sweeps up every such row in the app. Both
  // count as covered -- what must never happen is a rule reaching some of these
  // three rows and not the others.
  const covers = (selectorList, p) => {
    const parts = selectorList.split(',').map((s) => s.trim());
    return parts.some((s) => s === `#${p.id} ${p.row}` || s === p.row);
  };
  for (const [, selectorList, body] of html.matchAll(ruleRe)) {
    if (!/(background|border-radius|box-shadow)/.test(body)) continue;
    if (!PANELS.some((p) => covers(selectorList, p))) continue; // styles the tray, not the rows
    const missing = PANELS.filter((p) => !covers(selectorList, p));
    assert.deepEqual(missing, [],
      `this rule styles some of the three cards' rows but not ${missing.map((p) => p.id).join(', ')}:\n  ${selectorList.trim().slice(0, 200)}`);
  }
});

test('the three row types share the raised-shadow list', () => {
  const rule = ruleFor('.fin .f,#watching-panel .w,#team-todo-panel .w,.lv,');
  assert.ok(rule, 'the shared shadow rule must name all three row types');
  assert.ok(rule.includes('box-shadow'), 'sanity: this is the shadow rule');
});

// ---- header actions ----------------------------------------------------------
// Chris, 2026-08-17: the action buttons "should all be blue if there is a link
// behind them and they all should be in the same location on the top of each
// box". They had drifted because `.rcol h3 a` -- the rule that used to style
// them -- went dead when the GridStack rewrite removed .rcol from the markup,
// leaving each header to whatever inline style it carried.

test('the three header actions are blue, and blue comes from one rule', () => {
  const rule = ruleFor('#watching-panel h3 a,#team-todo-panel h3 a,#cc-notifications-panel h3 a{');
  assert.ok(rule, 'the three header links must share one rule');
  assert.match(rule, /color:#2f5d8a/, "header actions must use the app's link blue, so a link looks like a link");
  assert.match(rule, /cursor:pointer/, 'they must also read as clickable');
});

test('the three headers are laid out by one rule, not by inline styles', () => {
  const rule = ruleFor('#watching-panel h3,#team-todo-panel h3,#cc-notifications-panel h3{');
  assert.ok(rule, 'the three headers must share one layout rule');
  assert.match(rule, /justify-content:flex-start/, 'same position on every card');

  // The inline justify-content values are what made them differ.
  for (const id of ['watching-panel', 'team-todo-panel', 'cc-notifications-panel']) {
    const at = html.indexOf(`id="${id}"`);
    const header = html.slice(at, html.indexOf('</h3>', at));
    assert.ok(!/<h3 style="justify-content/.test(header),
      `#${id}'s header still carries an inline justify-content, which is how the three drifted apart`);
  }
});

test('no dead .rcol rule is left styling these headers', () => {
  assert.ok(!/\.rcol h3 a\{/.test(html),
    '.rcol was removed from the markup by the GridStack rewrite -- a rule keyed to it silently styles nothing');
});

test("Team To-Do's action comes first, with the timestamp after it", () => {
  const at = html.indexOf('id="team-todo-panel"');
  const header = html.slice(at, html.indexOf('</h3>', at));
  const action = header.indexOf('teamTodoNewTask()');
  const stamp = header.indexOf('id="todo-updated"');
  assert.ok(action !== -1 && stamp !== -1, 'sanity: the header has both');
  assert.ok(action < stamp,
    'the ＋ TASK action must precede "updated just now" so it sits where the other two cards put theirs');
});

test('scoping is by panel id, so rows elsewhere in the app are untouched', () => {
  // .w and .lv are used on other pages (jobs, reports, portals). The unifying
  // rules must never reach them.
  const trayRule = ruleFor('#watching-panel,#team-todo-panel,#cc-notifications-panel{background:');
  const rowRule = ruleFor('#watching-panel .w,#team-todo-panel .w,#cc-notifications-panel .lv{background:#fff');
  for (const rule of [trayRule, rowRule]) {
    const selectors = rule.slice(0, rule.indexOf('{')).split(',').map((s) => s.trim());
    for (const sel of selectors) {
      assert.ok(sel.startsWith('#'), `"${sel}" is unscoped — it would restyle .w/.lv rows on other pages`);
    }
  }
});
