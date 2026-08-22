import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  currentMonthBoundsUTC,
  getBudgetCap,
  monthSpendCents,
  checkBudgetHeadroom,
} from '../api/_lib/ad-budget-governor.js';

// Real code under test, imported directly -- no vm sandbox needed since this
// is a small, purpose-built module (not extracted from a giant handler file).
// The only I/O boundary, supabaseRequest, is swapped via a plain injected
// parameter -- this avoids node:test's mock.module, which is broken in this
// environment (see jobs-view-shape/snapshot-rpc-shape/webhook-cleanup).

function fakeSupabase(responses) {
  let call = 0;
  return async (path) => {
    const entry = responses[call];
    call += 1;
    if (!entry) throw new Error('fakeSupabase: no response queued for call ' + call + ' (path: ' + path + ')');
    return {
      ok: entry.ok !== false,
      json: async () => entry.rows,
      text: async () => JSON.stringify(entry.rows),
    };
  };
}
test('currentMonthBoundsUTC: computes real days remaining in a 28-day February', () => {
  const { startDate, endDate, daysInMonth, daysRemaining } = currentMonthBoundsUTC(new Date('2026-02-15T12:00:00.000Z'));
  assert.equal(startDate, '2026-02-01');
  assert.equal(endDate, '2026-03-01');
  assert.equal(daysInMonth, 28);
  assert.equal(daysRemaining, 14);
});

test('getBudgetCap: returns the real row when one exists', async () => {
  const supa = fakeSupabase([{ rows: [{ tenant_id: 'ghgrp', cap_cents: 150000, autonomy_level: 'auto_within_cap' }] }]);
  const cap = await getBudgetCap('ghgrp', supa);
  assert.equal(cap.cap_cents, 150000);
});

test('getBudgetCap: honestly returns null when no cap row exists yet -- never a fabricated default', async () => {
  const supa = fakeSupabase([{ rows: [] }]);
  const cap = await getBudgetCap('ghgrp', supa);
  assert.equal(cap, null);
});

test('monthSpendCents: sums real ledger rows for the month, not an estimate', async () => {
  const supa = fakeSupabase([{ rows: [{ spend_cents: 10000 }, { spend_cents: 25000 }] }]);
  const spent = await monthSpendCents('ghgrp', supa, new Date('2026-02-15T12:00:00.000Z'));
  assert.equal(spent, 35000);
});

test('monthSpendCents: zero real rows means honestly zero spent, not undefined', async () => {
  const supa = fakeSupabase([{ rows: [] }]);
  const spent = await monthSpendCents('ghgrp', supa, new Date('2026-02-15T12:00:00.000Z'));
  assert.equal(spent, 0);
});
test('checkBudgetHeadroom: refuses honestly when no cap row exists yet', async () => {
  const supa = fakeSupabase([{ rows: [] }]);
  const result = await checkBudgetHeadroom('ghgrp', 5000, { supabaseRequest: supa });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'no_budget_cap_configured');
});

test('checkBudgetHeadroom: refuses when autonomy is draft_only, regardless of remaining budget', async () => {
  const supa = fakeSupabase([{ rows: [{ cap_cents: 150000, autonomy_level: 'draft_only' }] }]);
  const result = await checkBudgetHeadroom('ghgrp', 100, { supabaseRequest: supa });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'draft_only_requires_manual_approval');
});

test('checkBudgetHeadroom: allows a real proposed daily budget that fits inside the real cap', async () => {
  const supa = fakeSupabase([
    { rows: [{ cap_cents: 150000, autonomy_level: 'auto_within_cap' }] },
    { rows: [{ spend_cents: 20000 }] },
  ]);
  const result = await checkBudgetHeadroom('ghgrp', 1000, {
    supabaseRequest: supa,
    now: new Date('2026-02-15T12:00:00.000Z'),
  });
  assert.equal(result.allowed, true);
  assert.equal(result.spentCents, 20000);
  assert.equal(result.remainingCents, 130000);
  assert.equal(result.projectedCents, 14000);
});

test('checkBudgetHeadroom: refuses the exact historical risk -- a daily budget that would blow through the real cap this month', async () => {
  const supa = fakeSupabase([
    { rows: [{ cap_cents: 150000, autonomy_level: 'auto_within_cap' }] },
    { rows: [{ spend_cents: 140000 }] },
  ]);
  const result = await checkBudgetHeadroom('ghgrp', 5000, {
    supabaseRequest: supa,
    now: new Date('2026-02-15T12:00:00.000Z'),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'would_exceed_monthly_cap');
  assert.equal(result.remainingCents, 10000);
  assert.equal(result.projectedCents, 70000);
});
