import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Found 2026-08-22: the Boardroom's "Send question" button reported
// NO_OUTCOME. It's type="submit" inside a <form> whose <textarea> is
// required and starts empty. Live-confirmed via the Claude Browser tools:
// clicking it fires the textarea's `invalid` event, and the browser's own
// constraint validation blocks the `submit` event from ever dispatching --
// no navigation, no fetch, no mutation the click itself causes (a live test
// observed 3 mutations after the click, but they turned out to be unrelated
// background UI activity, not the click). The exact same shape of bug as
// SKIPPED_DISABLED: a control correctly refusing to act by design, not a
// broken one.
const src = readFileSync(new URL('../public/tools/selftest.js', import.meta.url), 'utf8');

test('a submit button on a form with an unmet required field is skipped, not clicked and reported NO_OUTCOME', () => {
  assert.match(src, /if \(el\.type === 'submit' && el\.form && typeof el\.form\.checkValidity === 'function' && !el\.form\.checkValidity\(\)\) \{ results\.push\(\{ view: CUR, depth: depth, label: lab, kind: kind, verdict: 'SKIPPED_INVALID_FORM'/);
});

test('the invalid-form check runs before the click, not after (never actually clicks it)', () => {
  const idx = src.indexOf('SKIPPED_INVALID_FORM');
  const clickIdx = src.indexOf('el.click()');
  assert.ok(idx > -1 && clickIdx > -1 && idx < clickIdx);
});

test('the invalid-form check sits after the disabled-button check, the same shape of bug', () => {
  const disabledIdx = src.indexOf('SKIPPED_DISABLED');
  const invalidIdx = src.indexOf('SKIPPED_INVALID_FORM');
  const nextCheckIdx = src.indexOf("kind === 'tab' && el.matches");
  assert.ok(disabledIdx > -1 && invalidIdx > -1 && disabledIdx < invalidIdx,
    'expected the invalid-form check to come right after the disabled check');
  assert.ok(nextCheckIdx === -1 || invalidIdx < nextCheckIdx,
    'expected the invalid-form check before the next unrelated skip case (already-active tab)');
});

test('a submit button whose form is NOT currently invalid is unaffected (regression guard)', () => {
  // The condition must require !checkValidity() -- a bare `el.type ===
  // \'submit\'` check without it would wrongly skip every working submit
  // button, not just the ones currently blocked by a real browser
  // constraint.
  const line = src.split('\n').find((l) => l.includes('SKIPPED_INVALID_FORM'));
  assert.ok(line, 'expected a line defining SKIPPED_INVALID_FORM');
  assert.match(line, /!el\.form\.checkValidity\(\)/);
});
