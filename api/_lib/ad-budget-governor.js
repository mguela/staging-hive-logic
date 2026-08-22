// api/_lib/ad-budget-governor.js
// Shared safety rail every paid-ad spend-creating call must go through
// before touching a real platform. Enforces ad_budget_caps against real
// ad_spend_ledger rows (sql/058). No fabricated numbers: if there is no
// budget cap row configured, the honest answer is 'not allowed', never a
// silent default.

import { supabaseRequest as defaultSupabaseRequest } from './jobber.js';

export function currentMonthBoundsUTC(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  const daysInMonth = Math.round((end - start) / 86400000);
  const daysElapsed = Math.floor((now - start) / 86400000) + 1;
  const daysRemaining = Math.max(daysInMonth - daysElapsed + 1, 1);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    daysInMonth,
    daysRemaining,
  };
}
export async function getBudgetCap(tenantId = 'ghgrp', supabaseRequest = defaultSupabaseRequest) {
  const res = await supabaseRequest(`ad_budget_caps?tenant_id=eq.${encodeURIComponent(tenantId)}&select=*`);
  if (!res.ok) throw new Error(`Failed to read ad_budget_caps: ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

export async function monthSpendCents(tenantId = 'ghgrp', supabaseRequest = defaultSupabaseRequest, now = new Date()) {
  const { startDate, endDate } = currentMonthBoundsUTC(now);
  const query = `ad_spend_ledger?tenant_id=eq.${encodeURIComponent(tenantId)}` +
    `&spend_date=gte.${startDate}&spend_date=lt.${endDate}&select=spend_cents`;
  const res = await supabaseRequest(query);
  if (!res.ok) throw new Error(`Failed to read ad_spend_ledger: ${await res.text()}`);
  const rows = await res.json();
  return rows.reduce((sum, row) => sum + Number(row.spend_cents || 0), 0);
}
// The single choke point every campaign-creating / budget-raising action
// must call BEFORE making a real platform API call that would spend money.
// Returns { allowed, reason, capCents, spentCents, remainingCents, autonomyLevel }.
// Never throws on 'no budget configured' or 'draft only' -- those are honest
// refusals, not exceptional errors.
export async function checkBudgetHeadroom(tenantId, proposedDailyBudgetCents, opts = {}) {
  const supabaseRequest = opts.supabaseRequest || defaultSupabaseRequest;
  const now = opts.now || new Date();

  const cap = await getBudgetCap(tenantId, supabaseRequest);
  if (!cap) {
    return { allowed: false, reason: 'no_budget_cap_configured' };
  }
  if (cap.autonomy_level === 'draft_only') {
    return {
      allowed: false,
      reason: 'draft_only_requires_manual_approval',
      capCents: cap.cap_cents,
      autonomyLevel: cap.autonomy_level,
    };
  }

  const { daysRemaining } = currentMonthBoundsUTC(now);
  const spentCents = await monthSpendCents(tenantId, supabaseRequest, now);
  const remainingCents = cap.cap_cents - spentCents;
  const projectedCents = proposedDailyBudgetCents * daysRemaining;

  if (projectedCents > remainingCents) {
    return {
      allowed: false,
      reason: 'would_exceed_monthly_cap',
      capCents: cap.cap_cents,
      spentCents,
      remainingCents,
      projectedCents,
      autonomyLevel: cap.autonomy_level,
    };
  }

  return {
    allowed: true,
    capCents: cap.cap_cents,
    spentCents,
    remainingCents,
    projectedCents,
    autonomyLevel: cap.autonomy_level,
  };
}
