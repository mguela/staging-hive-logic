// Turning a day's clock entries into an hours figure.
//
// This is the number a customer is charged on, so the tests care most about
// what must NEVER be billed and what must never be silently dropped.

import test from 'node:test';
import assert from 'node:assert';
import { summarizeBillable, billingWarnings, roundHours } from '../api/_lib/tm-billable.js';

const at = (h, m = 0) => new Date(Date.UTC(2026, 7, 18, h, m)).toISOString();
const e = (kind, from, to, over = {}) => ({
  id: kind + from, kind, tech_name: 'Marco',
  started_at: at(from), ended_at: to == null ? null : at(to), ...over,
});

test('travel, supplies and onsite are billable', () => {
  const s = summarizeBillable([e('travel', 8, 9), e('supplies', 9, 10), e('onsite', 10, 14)]);
  assert.equal(s.hours, 6);
});

test('lunch and breaks are never billed', () => {
  const s = summarizeBillable([e('onsite', 8, 12), e('lunch', 12, 13), e('break', 14, 14, 15)]);
  assert.equal(s.hours, 4, 'billing a customer for lunch is not a policy option');
  assert.ok(s.excludedHours > 0);
});

test('an entry still running is reported, not counted as zero', () => {
  // Someone is still on the clock. Quietly dropping it produces an invoice
  // that is short, with nothing on screen to say why.
  const s = summarizeBillable([e('onsite', 8, 12), e('onsite', 13, null)]);
  assert.equal(s.hours, 4);
  assert.equal(s.openEntries.length, 1);
  assert.match(billingWarnings(s).join(' '), /still running/i);
});

test('no time recorded says so plainly', () => {
  const s = summarizeBillable([]);
  assert.equal(s.hours, 0);
  assert.match(billingWarnings(s).join(' '), /no time was recorded/i);
});

test('a day of nothing but lunch is called out', () => {
  const s = summarizeBillable([e('lunch', 12, 13)]);
  assert.equal(s.hours, 0);
  assert.match(billingWarnings(s).join(' '), /lunch or break/i);
});

test('hours round to the NEAREST quarter, not up', () => {
  // Rounding up always favours the house. A customer who checks the arithmetic
  // should find it fair.
  assert.equal(roundHours(2.1), 2);
  assert.equal(roundHours(2.13), 2.25);
  assert.equal(roundHours(2.01), 2);
  assert.equal(roundHours(0), 0);
  assert.equal(roundHours(-5), 0);
});

test('real work never rounds away to a zero invoice', () => {
  // Six minutes is not nothing. Rounding it to 0 is the same silent-drop
  // failure this module exists to remove.
  assert.equal(roundHours(0.1), 0.25);
  assert.ok(roundHours(0.01) > 0);
});

test('the breakdown shows where the hours came from', () => {
  // A total nobody can decompose is a total nobody can check.
  const s = summarizeBillable([e('travel', 8, 9), e('onsite', 9, 12)]);
  assert.deepEqual(Object.keys(s.byKind).sort(), ['onsite', 'travel']);
  assert.equal(s.byKind.travel, 1);
  assert.equal(s.byKind.onsite, 3);
});

test('an unknown kind is neither billed nor hidden', () => {
  const s = summarizeBillable([e('onsite', 8, 10), e('training', 10, 12)]);
  assert.equal(s.hours, 2, 'an unrecognised kind must not silently reach the bill');
  assert.equal(s.byKind.training, 2, 'but it must still be visible');
});

test('a backwards or zero-length entry cannot subtract time', () => {
  const s = summarizeBillable([e('onsite', 12, 8), e('onsite', 9, 11)]);
  assert.equal(s.hours, 2);
});

test('a malformed entry is skipped rather than throwing', () => {
  const s = summarizeBillable([{ kind: 'onsite' }, { kind: 'onsite', started_at: 'nonsense', ended_at: 'nonsense' }, e('onsite', 9, 10)]);
  assert.equal(s.hours, 1);
});
