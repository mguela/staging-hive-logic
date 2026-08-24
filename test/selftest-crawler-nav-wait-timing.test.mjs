import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Found 2026-08-22 investigating csx's "SAVE HOURS"/"SAVE NUMBERING"/"SAVE
// PROFILE"/"SAVE TERMS"/"SAVE AUTOMATIONS" all reading NO_OUTCOME in a fresh
// crawl despite working correctly when tested by hand. Live-confirmed via
// the Claude Browser tools: csx's `$('save-hours').addEventListener(...)`
// (and the other four save buttons) sit inside the SAME async block that
// renders the real settings fetch response -- polling the real page showed
// the settings badge (a proxy for "has the async init finished") stays at
// its placeholder value until somewhere between 800ms and 900ms after
// navigation. NAV_WAIT was 600ms: not a flaky, occasional race -- clicking
// at exactly 600ms deterministically hit a button with no listener attached
// yet, every time.
const src = readFileSync(new URL('../public/tools/selftest.js', import.meta.url), 'utf8');

test('NAV_WAIT gives real margin over the measured ~850-900ms floor for a view\'s async init to finish', () => {
  const match = src.match(/var SETTLE = \d+, CLICK_TIMEOUT = \d+, NAV_WAIT = (\d+),/);
  assert.ok(match, 'expected to find the NAV_WAIT constant declaration');
  const navWait = Number(match[1]);
  assert.ok(navWait >= 1000, `NAV_WAIT (${navWait}ms) must clear the measured ~900ms floor with real margin, not just barely exceed it`);
});

test('NAV_WAIT fires once per view (after showView), not once per click -- the fix is cheap at crawl scale', () => {
  // Regression guard against someone "fixing" a future timing issue by
  // moving NAV_WAIT into the per-click loop, which would turn a one-time
  // ~28s cost across a 47-view crawl into a per-click cost across ~450+
  // clicks.
  const navWaitIdx = src.indexOf('NAV_WAIT');
  const showViewCallIdx = src.indexOf('window.showView(code)');
  const tryClickDeclIdx = src.indexOf('async function tryClick(el, container, depth)');
  assert.ok(navWaitIdx > -1 && showViewCallIdx > -1 && tryClickDeclIdx > -1);
  const navWaitUsageSrc = src.slice(src.indexOf('setTimeout(r, NAV_WAIT)') - 150, src.indexOf('setTimeout(r, NAV_WAIT)') + 20);
  assert.match(navWaitUsageSrc, /showView\(code\)/, 'NAV_WAIT must be awaited right after the view switch, not inside the per-element click loop');
  const tryClickSrc = src.slice(tryClickDeclIdx, src.indexOf('\n  function tallyOf', tryClickDeclIdx));
  assert.doesNotMatch(tryClickSrc, /NAV_WAIT/, 'NAV_WAIT must not appear inside tryClick -- that would make it a per-click cost');
});
