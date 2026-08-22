import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CARD_RATE_BPS, DISCOUNT_PAYMENT_METHODS, isDiscountMethod,
  normalizeCardRateBps, cardPricing, creditedAmount
} from '../src/card-pricing.js';

test('program default is 400 bps (4.00%) and the discount methods are cash/check/ach', () => {
  assert.equal(DEFAULT_CARD_RATE_BPS, 400);
  assert.deepEqual([...DISCOUNT_PAYMENT_METHODS], ['cash', 'check', 'ach']);
  assert.equal(isDiscountMethod('Check'), true);
  assert.equal(isDiscountMethod(' ACH '), true);
  assert.equal(isDiscountMethod('credit'), false);
  assert.equal(isDiscountMethod('debit'), false);
  assert.equal(isDiscountMethod(undefined), false);
});

test('normalizeCardRateBps: null/undefined -> default, explicit 0 stays 0, out-of-range throws', () => {
  assert.equal(normalizeCardRateBps(null), 400);
  assert.equal(normalizeCardRateBps(undefined), 400);
  assert.equal(normalizeCardRateBps(''), 400);
  assert.equal(normalizeCardRateBps(0), 0);
  assert.equal(normalizeCardRateBps(250), 250);
  assert.throws(() => normalizeCardRateBps(-1), /between 0 and 1000/);
  assert.throws(() => normalizeCardRateBps(1500), /between 0 and 1000/);
  assert.throws(() => normalizeCardRateBps('abc'), /between 0 and 1000/);
});

test('cardPricing: fee computed once at the bottom — Chris\'s handyman example', () => {
  // 4 hrs @ $225 = $900 labor + $300 materials (cost 150, 100% markup) = $1,200 base
  const p = cardPricing(1200, 400);
  assert.deepEqual(p, { cashPrice: 1200, cardFee: 48, cardPrice: 1248, cardRateBps: 400 });
});

test('cardPricing rounding and edge cases', () => {
  assert.deepEqual(cardPricing(0, 400), { cashPrice: 0, cardFee: 0, cardPrice: 0, cardRateBps: 400 });
  assert.deepEqual(cardPricing(0.13, 400), { cashPrice: 0.13, cardFee: 0.01, cardPrice: 0.14, cardRateBps: 400 });
  assert.deepEqual(cardPricing(9240, 0), { cashPrice: 9240, cardFee: 0, cardPrice: 9240, cardRateBps: 0 });
});

test('creditedAmount: discount methods credit at the record\'s own card/cash ratio; card methods at face value', () => {
  const totals = { cashPrice: 1200, cardPrice: 1248 };
  assert.equal(creditedAmount(1200, 'check', totals), 1248, 'a check for the full cash price settles the full posted total');
  assert.equal(creditedAmount(600, 'cash', totals), 624, 'partial cash payments credit proportionally');
  assert.equal(creditedAmount(1248, 'credit', totals), 1248, 'card pays face value — no discount');
  assert.equal(creditedAmount(500, undefined, totals), 500);
  assert.equal(creditedAmount(100, 'check', { cashPrice: 0, cardPrice: 0 }), 100, 'degenerate zero-total records credit at face value');
  assert.equal(creditedAmount(100, 'check', { cashPrice: 500, cardPrice: 500 }), 100, 'card pricing off (equal prices) -> no gross-up');
});
