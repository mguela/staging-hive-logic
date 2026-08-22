// Regression test for the Estimate Form's missing entry guard (master to-do,
// HiveLogic Live known bugs: "[MED] estform has no route entry/guard --
// renders a blank stub.").
//
// Root cause: showView('estform') only flips #view-estform's display from
// none to block, like every other view -- the form's actual content is
// populated by a SEPARATE efRender() call. Every existing call site
// remembers to pair them (e.g. "eChain();showView('estform');efRender();"
// and efResumeDraft()), but showView() itself had no guard, so any future
// or stray path that shows 'estform' without also calling efRender() (a
// deep link, a hash restore, a new nav entry) would leave whatever
// #view-estform's last-rendered -- or never-rendered, i.e. blank -- HTML
// happened to be on screen, since efRender() itself silently no-ops when
// there's no active draft (if(!EST)return;).
//
// Fix: showView() now has the same kind of per-view guard it already has
// for 'estimates'/'co'/'invx' -- if v==='estform' and a draft (EST) is
// active, it calls efRender() itself (so callers no longer need to
// remember to); if no draft is active, it redirects to the Estimates list
// instead of ever showing a blank container.
//
// Structural/string checks against the real public/index.html source (same
// approach as the other two fixes this session -- this is a huge static
// HTML+inline-JS file with no DOM harness wired up here).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');

test('showView() now guards estform: renders when a draft is active, redirects to the list otherwise', () => {
  assert.match(
    html,
    /if\(v==='estform'\)\{ if\(typeof EST!=='undefined'&&EST\)\{ if\(typeof efRender==='function'\)efRender\(\); \} else \{ showView\('estimates'\); return; \} \}/,
    'expected the estform entry guard to exist in showView(), right alongside the estimates/co/invx side-effect checks'
  );
});

test('the guard is positioned inside showView(), after the estimates-view side effect it sits next to', () => {
  const idx = html.indexOf("if(v==='estimates'&&typeof efListRender==='function'){efListRender();if(typeof loadEstimatesLive==='function')loadEstimatesLive();}");
  const guardIdx = html.indexOf("if(v==='estform'){ if(typeof EST!=='undefined'&&EST){");
  assert.ok(idx > -1, 'the estimates side-effect anchor line must still exist');
  assert.ok(guardIdx > idx, 'the estform guard must come after the estimates side-effect line (same showView() body)');
  assert.ok(guardIdx - idx < 200, 'the estform guard should sit immediately after it, not somewhere unrelated');
});

test('efRender() still silently no-ops with no active draft -- the guard relies on this, so this must not regress', () => {
  assert.match(html, /function efRender\(\)\{\s*\r?\n\s*if\(!EST\)return;/);
});

test('the existing call sites that already pair showView(\'estform\') with efRender() are untouched (guard is additive, not a replacement)', () => {
  assert.match(html, /eChain\(\);showView\('estform'\);efRender\(\);window\.scrollTo\(0,0\);/, 'the estimate-builder entry flow must be unchanged');
  assert.match(html, /function efResumeDraft\(\)\{var d=efDraft\(\);if\(!d\)return;EST=d;showView\('estform'\);efRender\(\);/, 'efResumeDraft() must be unchanged');
});

test('estimates (the redirect target) is a real, reachable view', () => {
  assert.match(html, /id="view-estimates"/, 'view-estimates must exist as the guard\'s fallback destination');
});
