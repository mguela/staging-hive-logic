// api/_lib/growth-facts.js
// The real-numbers layer under the growth engine (api/growth.js).
//
// One rule governs this whole file: every value returned here is READ from
// synced production data, never estimated, projected, or inferred. If a
// number cannot be computed honestly, the field is null and the caller says
// so out loud -- the same discipline api/_lib/ad-copy-grounding.js applies to
// ad copy. That matters more here than anywhere else in the marketing stack,
// because these numbers are what Reina hands to an LLM to justify spending
// real money.
//
// The division classifier and paging helper are imported from
// ad-copy-grounding.js rather than re-implemented, so a trade like "heat
// pump" can never land in HVAC for ad copy and Handyman for a growth
// suggestion about the same job.

import { supabaseRequest as defaultSupabaseRequest } from './jobber.js';
import { fetchAllRows, jobDivision, KNOWN_DIVISIONS, realServiceTerritoryFacts } from './ad-copy-grounding.js';
import { getBudgetCap, monthSpendCents, currentMonthBoundsUTC } from './ad-budget-governor.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// A job counts as "won revenue" only when Jobber says it completed. Anything
// else (upcoming, unscheduled, action_required) is work that has not happened
// and must never be summed into a growth number.
function completedInWindow(rows, startMs, endMs) {
  return rows.filter((r) => {
    if (!r.completed_at) return false;
    const t = new Date(r.completed_at).getTime();
    return Number.isFinite(t) && t >= startMs && t < endMs;
  });
}

function sumTotalCents(rows) {
  return rows.reduce((sum, r) => sum + Math.round(Number(r.total || 0) * 100), 0);
}

// Percent change between two windows, as a whole number. Returns null (not 0,
// and not Infinity) when the prior window is empty -- "we had none before" is
// not a percentage, and rendering it as one would be a fabricated trend.
function pctChange(current, prior) {
  if (!prior) return null;
  return Math.round(((current - prior) / prior) * 100);
}

// ---------------------------------------------------------------------
// Division momentum: for each trade, completed jobs + revenue in the last
// 90 days against the 90 days before that. This is the primary signal the
// growth engine uses to decide where ad money would do the most good.
// ---------------------------------------------------------------------
export async function divisionMomentum(supabaseRequest = defaultSupabaseRequest, now = new Date()) {
  let rows;
  try {
    rows = await fetchAllRows('jobs', '?select=title,total,completed_at&completed_at=not.is.null', supabaseRequest);
  } catch (e) {
    if (e.notSynced) return { available: false, divisions: [] };
    throw e;
  }
  const nowMs = now.getTime();
  const recentStart = nowMs - 90 * DAY_MS;
  const priorStart = nowMs - 180 * DAY_MS;

  const divisions = KNOWN_DIVISIONS.map((division) => {
    const mine = rows.filter((r) => jobDivision(r.title) === division);
    const recent = completedInWindow(mine, recentStart, nowMs);
    const prior = completedInWindow(mine, priorStart, recentStart);
    const recentRevenueCents = sumTotalCents(recent);
    const priorRevenueCents = sumTotalCents(prior);
    return {
      division,
      completedLast90: recent.length,
      completedPrior90: prior.length,
      revenueCentsLast90: recentRevenueCents,
      revenueCentsPrior90: priorRevenueCents,
      jobCountChangePct: pctChange(recent.length, prior.length),
      revenueChangePct: pctChange(recentRevenueCents, priorRevenueCents),
      avgJobValueCentsLast90: recent.length ? Math.round(recentRevenueCents / recent.length) : null,
    };
  });
  return { available: true, divisions };
}

// ---------------------------------------------------------------------
// Unsold quotes: real money already quoted that never converted. Only
// 'awaiting_response' and 'approved' count -- 'converted' became a job,
// 'archived' was closed out, and 'draft' was never sent to anyone.
// ---------------------------------------------------------------------
export async function unsoldQuoteFacts(supabaseRequest = defaultSupabaseRequest, now = new Date()) {
  let rows;
  try {
    rows = await fetchAllRows('quotes', '?select=quote_status,total,jobber_created_at,client_name', supabaseRequest);
  } catch (e) {
    if (e.notSynced) return { available: false };
    throw e;
  }
  const open = rows.filter((r) => r.quote_status === 'awaiting_response' || r.quote_status === 'approved');
  const cutoff = now.getTime() - 365 * DAY_MS;
  const openLastYear = open.filter((r) => {
    const t = r.jobber_created_at ? new Date(r.jobber_created_at).getTime() : NaN;
    return Number.isFinite(t) && t >= cutoff;
  });
  return {
    available: true,
    openQuoteCount: open.length,
    openQuoteValueCents: sumTotalCents(open),
    openQuoteCountLast365: openLastYear.length,
    openQuoteValueCentsLast365: sumTotalCents(openLastYear),
  };
}

// ---------------------------------------------------------------------
// Dormant customers: real past clients whose most recent completed job is
// older than `dormantAfterDays`. These are the cheapest revenue in the
// building -- they already chose this company once.
// ---------------------------------------------------------------------
export async function dormantCustomerFacts(supabaseRequest = defaultSupabaseRequest, now = new Date(), dormantAfterDays = 365) {
  let rows;
  try {
    rows = await fetchAllRows('jobs', '?select=client_id,completed_at,total&completed_at=not.is.null', supabaseRequest);
  } catch (e) {
    if (e.notSynced) return { available: false };
    throw e;
  }
  const lastJobByClient = new Map();
  const lifetimeByClient = new Map();
  for (const r of rows) {
    if (!r.client_id) continue;
    const t = new Date(r.completed_at).getTime();
    if (!Number.isFinite(t)) continue;
    const prev = lastJobByClient.get(r.client_id);
    if (prev == null || t > prev) lastJobByClient.set(r.client_id, t);
    lifetimeByClient.set(r.client_id, (lifetimeByClient.get(r.client_id) || 0) + Math.round(Number(r.total || 0) * 100));
  }
  const cutoff = now.getTime() - dormantAfterDays * DAY_MS;
  let dormantCount = 0;
  let dormantLifetimeCents = 0;
  for (const [clientId, lastMs] of lastJobByClient) {
    if (lastMs < cutoff) {
      dormantCount += 1;
      dormantLifetimeCents += lifetimeByClient.get(clientId) || 0;
    }
  }
  return {
    available: true,
    totalCustomersWithCompletedWork: lastJobByClient.size,
    dormantAfterDays,
    dormantCustomerCount: dormantCount,
    dormantLifetimeValueCents: dormantLifetimeCents,
    avgLifetimeValueCents: lastJobByClient.size
      ? Math.round([...lifetimeByClient.values()].reduce((s, v) => s + v, 0) / lastJobByClient.size)
      : null,
  };
}

// ---------------------------------------------------------------------
// Review coverage: completed jobs in the last 180 days that have never had
// a review request sent. Reviews are the highest-leverage free growth lever
// a home-services company has, so an untouched backlog is worth surfacing.
// ---------------------------------------------------------------------
export async function reviewCoverageFacts(supabaseRequest = defaultSupabaseRequest, now = new Date()) {
  let jobs;
  let requests;
  try {
    [jobs, requests] = await Promise.all([
      fetchAllRows('jobs', '?select=jobber_id,completed_at&completed_at=not.is.null', supabaseRequest),
      fetchAllRows('review_requests', '?select=job_id,status', supabaseRequest),
    ]);
  } catch (e) {
    if (e.notSynced) return { available: false };
    throw e;
  }
  const cutoff = now.getTime() - 180 * DAY_MS;
  const recent = jobs.filter((j) => {
    const t = new Date(j.completed_at).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  const askedJobIds = new Set(requests.filter((r) => r.status === 'sent').map((r) => String(r.job_id)));
  const neverAsked = recent.filter((j) => !askedJobIds.has(String(j.jobber_id)));
  return {
    available: true,
    completedLast180: recent.length,
    reviewRequestsSentAllTime: askedJobIds.size,
    completedLast180WithNoReviewAsk: neverAsked.length,
  };
}

// ---------------------------------------------------------------------
// Paid-ad posture: what is actually connected, what is actually running,
// and how much of the real monthly cap is still unspent. Read straight from
// the same tables the budget governor enforces against, so the growth
// engine can never propose a spend the governor would then refuse.
// ---------------------------------------------------------------------
export async function paidAdFacts(tenantId = 'ghgrp', supabaseRequest = defaultSupabaseRequest, now = new Date()) {
  const [connRes, campRes] = await Promise.all([
    supabaseRequest(`ad_platform_connections?tenant_id=eq.${encodeURIComponent(tenantId)}&select=platform,state`),
    supabaseRequest(`ad_campaigns?tenant_id=eq.${encodeURIComponent(tenantId)}&select=id,platform,status,daily_budget_cents`),
  ]);
  if (!connRes.ok) throw new Error('Failed to read ad_platform_connections: ' + (await connRes.text()));
  if (!campRes.ok) throw new Error('Failed to read ad_campaigns: ' + (await campRes.text()));
  const connections = await connRes.json();
  const campaigns = await campRes.json();

  const cap = await getBudgetCap(tenantId, supabaseRequest);
  const spentCents = await monthSpendCents(tenantId, supabaseRequest, now);
  const { daysRemaining } = currentMonthBoundsUTC(now);

  const launchable = connections.filter((c) => c.state === 'launch_enabled').map((c) => c.platform);
  return {
    connectedPlatforms: connections.map((c) => ({ platform: c.platform, state: c.state })),
    launchablePlatforms: launchable,
    hasAnyLaunchablePlatform: launchable.length > 0,
    activeCampaignCount: campaigns.filter((c) => c.status === 'active').length,
    draftCampaignCount: campaigns.filter((c) => c.status === 'draft').length,
    pendingReviewCampaignCount: campaigns.filter((c) => c.status === 'pending_review').length,
    monthlyCapCents: cap ? cap.cap_cents : null,
    autonomyLevel: cap ? cap.autonomy_level : null,
    monthToDateSpendCents: spentCents,
    remainingCapCents: cap ? cap.cap_cents - spentCents : null,
    daysRemainingInMonth: daysRemaining,
  };
}

// ---------------------------------------------------------------------
// Content raw material: how many recent completed jobs carry enough real
// photos to build a short-form video from. Used both to rank a
// content_reel suggestion and to tell the truth when the answer is "none".
// ---------------------------------------------------------------------
export async function photoContentFacts(supabaseRequest = defaultSupabaseRequest, now = new Date(), minPhotos = 4) {
  let media;
  try {
    media = await fetchAllRows('media', '?select=job_id,captured_at,media_type&job_id=not.is.null', supabaseRequest);
  } catch (e) {
    if (e.notSynced) return { available: false };
    throw e;
  }
  const cutoff = now.getTime() - 180 * DAY_MS;
  const countByJob = new Map();
  for (const m of media) {
    if (m.media_type && m.media_type !== 'photo' && m.media_type !== 'image') continue;
    const t = m.captured_at ? new Date(m.captured_at).getTime() : NaN;
    if (!Number.isFinite(t) || t < cutoff) continue;
    countByJob.set(m.job_id, (countByJob.get(m.job_id) || 0) + 1);
  }
  const eligible = [...countByJob.values()].filter((n) => n >= minPhotos);
  return {
    available: true,
    minPhotos,
    totalPhotos: media.length,
    jobsWithPhotosLast180: countByJob.size,
    jobsWithEnoughPhotosLast180: eligible.length,
  };
}

// One call the growth scan makes to assemble everything it is allowed to
// reason from. Gathered in parallel because each piece is an independent
// read; a failure in any one is allowed to propagate rather than be
// swallowed into a half-true picture.
export async function gatherGrowthFacts(tenantId = 'ghgrp', supabaseRequest = defaultSupabaseRequest, now = new Date()) {
  const [momentum, quotes, dormant, reviews, ads, photos, territory] = await Promise.all([
    divisionMomentum(supabaseRequest, now),
    unsoldQuoteFacts(supabaseRequest, now),
    dormantCustomerFacts(supabaseRequest, now),
    reviewCoverageFacts(supabaseRequest, now),
    paidAdFacts(tenantId, supabaseRequest, now),
    photoContentFacts(supabaseRequest, now),
    realServiceTerritoryFacts(supabaseRequest),
  ]);
  return {
    asOf: now.toISOString(),
    momentum,
    quotes,
    dormant,
    reviews,
    ads,
    photos,
    territory,
  };
}
