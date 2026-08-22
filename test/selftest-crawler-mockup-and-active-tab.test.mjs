import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Two more Dev To-Do NO_OUTCOME false positives found 2026-08-19 while
// investigating the csx/cpx/pbx batch.
const src = readFileSync(new URL('../public/tools/selftest.js', import.meta.url), 'utf8');

test('a tab that is already the selected one is skipped, not clicked and reported NO_OUTCOME', () => {
  // Live-confirmed: cpx's "30 days" day-range tab is the default-selected
  // tab (className="tab active"). Clicking it again is correctly a no-op --
  // it's already in the state the click would produce -- so it must not be
  // clicked and measured as if it might do something.
  assert.match(src, /if \(kind === 'tab' && el\.matches\('\.active,\.on,\.sel,\[aria-selected="true"\]'\)\) \{ results\.push\(\{ view: CUR, depth: depth, label: lab, kind: kind, verdict: 'SKIPPED_ALREADY_ACTIVE'/);
});

test('the already-active check only applies to tab kind, not any element carrying an .active-ish class', () => {
  const line = src.split('\n').find((l) => l.includes('SKIPPED_ALREADY_ACTIVE'));
  assert.ok(line, 'expected a line defining SKIPPED_ALREADY_ACTIVE');
  assert.match(line, /kind === 'tab' &&/);
});

test('the already-active check runs before the click, not after (never actually clicks it)', () => {
  const idx = src.indexOf('SKIPPED_ALREADY_ACTIVE');
  const clickIdx = src.indexOf('el.click()');
  assert.ok(idx > -1 && clickIdx > -1 && idx < clickIdx);
});

test('a view whose nav item is labeled a design mockup is skipped entirely, not click-tested', () => {
  // Live-confirmed: cpx and pbx are explicitly self-labeled
  // (title="Design mockup — lands in Reports/Finances once built"). Their
  // showDetail()-style reveals are a plain display:none->block toggle on a
  // static-position panel with no position/z-index signal and almost no
  // mutations -- there's no finished feature yet to verify, and building a
  // broader visibility-detection heuristic just to validate a screen that
  // will be replaced once the real feature ships isn't worth the false-
  // positive risk it would add elsewhere.
  assert.match(src, /var navEl = viewCode \? document\.getElementById\('nav-' \+ viewCode\) : null;/);
  assert.match(src, /if \(navEl && \/design mockup\/i\.test\(navEl\.getAttribute\('title'\) \|\| ''\)\) \{/);
  assert.match(src, /verdict: 'SKIPPED_MOCKUP'/);
});

test('the mockup check returns before any element is scanned or clicked', () => {
  const crawlCurrentSrc = src.slice(src.indexOf('async function crawlCurrent'));
  const mockupCheckIdx = crawlCurrentSrc.indexOf('SKIPPED_MOCKUP');
  const scanIdx = crawlCurrentSrc.indexOf('querySelectorAll');
  assert.ok(mockupCheckIdx > -1 && scanIdx > -1 && mockupCheckIdx < scanIdx);
});

test('the mockup check does not false-positive on a normal view\'s tooltip title', () => {
  // Regression guard: Company Setup's nav item has an unrelated title
  // ("🧬Company Setup") that must not match and cause a real, functional
  // view to be silently skipped.
  const regex = /design mockup/i;
  assert.equal(regex.test('🧬Company Setup'), false);
  assert.equal(regex.test('Design mockup — lands in Reports once built'), true);
  assert.equal(regex.test('Design mockup — lands in Finances once built'), true);
});
