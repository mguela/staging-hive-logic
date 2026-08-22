// test/entitlements.test.mjs
// Phase 3 groundwork — plan tiers & feature entitlements. Pure logic, report-only.
// Verifies: unknown/founding plans fail OPEN (never disable a live customer),
// tier feature maps, seat caps, and the snapshot shape. Run:
//   node --test test/entitlements.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { planAllows, seatLimit, withinSeatLimit, entitlementsFor, tierFor } from '../api/_lib/entitlements.js';

test('founding company (plan=primary) is unlimited', () => {
  const c = { plan: 'primary' };
  assert.equal(planAllows(c, 'reina'), true);
  assert.equal(planAllows(c, 'fleet'), true);
  assert.equal(seatLimit(c), null);
  assert.equal(tierFor(c).internal, true);
});

test('unknown/blank plan fails OPEN — never silently disables a live customer', () => {
  assert.equal(planAllows({ plan: 'legacy-weird' }, 'payroll'), true);
  assert.equal(planAllows({ plan: '' }, 'payroll'), true);
  assert.equal(planAllows({}, 'payroll'), true);
  assert.equal(seatLimit({ plan: 'legacy-weird' }), null);
});

test('starter includes core, excludes fleet/payroll/reina', () => {
  const c = { plan: 'starter' };
  assert.equal(planAllows(c, 'cost_model'), true);
  assert.equal(planAllows(c, 'invoicing'), true);
  assert.equal(planAllows(c, 'fleet'), false);
  assert.equal(planAllows(c, 'payroll'), false);
  assert.equal(planAllows(c, 'reina'), false);
});

test('pro adds fleet/payroll/marketing but not reina', () => {
  const c = { plan: 'pro' };
  assert.equal(planAllows(c, 'fleet'), true);
  assert.equal(planAllows(c, 'payroll'), true);
  assert.equal(planAllows(c, 'marketing'), true);
  assert.equal(planAllows(c, 'reina'), false);
});

test('elite and trial include everything', () => {
  for (const plan of ['elite', 'trial']) {
    const c = { plan };
    assert.equal(planAllows(c, 'reina'), true);
    assert.equal(planAllows(c, 'cost_model'), true);
  }
});

test('seat limits: plan default, purchased override, unlimited', () => {
  assert.equal(seatLimit({ plan: 'starter' }), 5);
  assert.equal(seatLimit({ plan: 'pro' }), 25);
  assert.equal(seatLimit({ plan: 'starter', seats: 12 }), 12);  // purchased override wins
  assert.equal(seatLimit({ plan: 'elite' }), null);              // unlimited
});

test('withinSeatLimit respects the cap and unlimited', () => {
  assert.equal(withinSeatLimit({ plan: 'starter' }, 5), true);
  assert.equal(withinSeatLimit({ plan: 'starter' }, 6), false);
  assert.equal(withinSeatLimit({ plan: 'elite' }, 9999), true);
  assert.equal(withinSeatLimit({ plan: 'primary' }, 9999), true);
});

test('entitlementsFor snapshot shape is report-only and complete', () => {
  const e = entitlementsFor({ plan: 'pro', plan_status: 'trialing', trial_ends_at: '2026-09-01T00:00:00Z' });
  assert.equal(e.plan, 'pro');
  assert.equal(e.plan_label, 'Pro');
  assert.equal(e.plan_status, 'trialing');
  assert.equal(e.trialing, true);
  assert.equal(e.trial_ends_at, '2026-09-01T00:00:00Z');
  assert.equal(e.enforced, false, 'entitlements must be report-only until enforcement is flipped on');
  assert.equal(e.features.fleet, true);
  assert.equal(e.features.reina, false);
  assert.equal(e.seats, 25);
});
