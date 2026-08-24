// api/_lib/growth-suggester.js
// Turns the real numbers from growth-facts.js into a ranked list of concrete
// next moves.
//
// Deliberately deterministic. An LLM is NOT in this path: every suggestion
// below is a rule over real data, so the same facts always produce the same
// recommendations and any one of them can be checked by hand against the
// evidence it carries. api/growth.js may afterwards ask Claude to rewrite the
// rationale in warmer language, but it can never add, drop, or re-order a
// suggestion -- the money-shaped decisions stay in code where they can be
// tested.
//
// Ranking is by real dollars at stake (valueCents), not by category. A
// $40,000 pile of unsold estimates outranks a $600 ad idea no matter which
// one the author of this file finds more interesting.

import { KNOWN_DIVISIONS } from './ad-copy-grounding.js';

// ISO-8601 week key (e.g. "2026-W34"). The scan runs weekly, so this is what
// makes a re-run -- or a cron retry ten minutes later -- update the same
// suggestion row instead of stacking a duplicate.
export function isoWeekKey(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Thursday of the current week determines the ISO year.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

function money(cents) {
  return '$' + Math.round((Number(cents) || 0) / 100).toLocaleString('en-US');
}

// Priority is derived from real dollars at stake so it cannot drift out of
// agreement with the ranking. 1 is act-on-this-first.
function priorityForValue(valueCents) {
  if (valueCents >= 5000000) return 1;   // $50k+
  if (valueCents >= 1500000) return 2;   // $15k+
  if (valueCents >= 300000) return 3;    // $3k+
  if (valueCents > 0) return 4;
  return 5;
}

// The division worth putting ad money behind: highest recent revenue among
// divisions that actually completed work in the last 90 days. Returns null
// when there is no completed work at all -- there is no honest way to pick a
// trade to advertise with no history behind it.
function bestAdDivision(momentum) {
  if (!momentum || !momentum.available) return null;
  const withWork = momentum.divisions.filter((d) => d.completedLast90 > 0 && d.revenueCentsLast90 > 0);
  if (!withWork.length) return null;
  return withWork.slice().sort((a, b) => b.revenueCentsLast90 - a.revenueCentsLast90)[0];
}

// A division that used to perform and has fallen off. Requires a real prior
// baseline (>= 3 jobs) so a division that did one job last spring cannot
// register as a "decline".
//
// The second condition is the one that matters, and it was added after a
// dry run against real production data reported "Electric is down 100%" for a
// division that had completed the SAME number of jobs in both windows. Its
// jobs simply carry no value on the row -- the work happened, the revenue is
// recorded elsewhere. Zero recorded revenue against real completed work is
// missing data, and reporting missing data as lost money is the single
// fastest way for this whole feature to lose the reader's trust.
function decliningDivision(momentum) {
  if (!momentum || !momentum.available) return null;
  const candidates = momentum.divisions.filter((d) => {
    if (d.completedPrior90 < 3) return false;
    if (d.revenueChangePct == null || d.revenueChangePct > -25) return false;
    // Work still coming in but nothing recorded against it: not a decline.
    if (d.revenueCentsLast90 === 0 && d.completedLast90 > 0) return false;
    return true;
  });
  if (!candidates.length) return null;
  return candidates.slice().sort((a, b) => a.revenueChangePct - b.revenueChangePct)[0];
}

// ---------------------------------------------------------------------
// The rules. Each returns a candidate object or null. A rule returns null
// whenever the honest answer is "there is nothing to say here" -- an empty
// growth list is a valid outcome and much better than a padded one.
// ---------------------------------------------------------------------

function ruleConnectAdPlatforms(facts) {
  const ads = facts.ads;
  if (ads.hasAnyLaunchablePlatform) return null;
  const best = bestAdDivision(facts.momentum);
  // Value at stake is the unspent monthly cap -- real budget that is
  // authorized and doing nothing. Null cap means nothing is authorized yet.
  const valueCents = ads.monthlyCapCents == null ? 0 : Math.max(ads.remainingCapCents, 0);
  return {
    kind: 'ad_campaign',
    discriminator: 'connect_platforms',
    title: 'Connect Google Ads and Meta so paid campaigns can actually run',
    valueCents,
    rationale: ads.monthlyCapCents == null
      ? 'No ad platform is connected and no monthly budget cap is set, so no paid campaign can be drafted or launched at all.'
      : 'You have an authorized ad budget of ' + money(ads.monthlyCapCents) + ' a month and ' +
        money(ads.remainingCapCents) + ' of it is unspent this month, but no ad platform is connected, so none of it can be spent.'
        + (best ? ' Your strongest trade right now is ' + best.division + ' (' + money(best.revenueCentsLast90) + ' completed in the last 90 days) -- that is where the first campaign should point.' : ''),
    evidence: {
      connectedPlatforms: ads.connectedPlatforms,
      monthlyCapCents: ads.monthlyCapCents,
      remainingCapCents: ads.remainingCapCents,
      strongestDivision: best ? best.division : null,
    },
    proposedAction: { type: 'connect_ad_platform', platforms: ['google_ads', 'meta'] },
  };
}

function ruleDraftCampaignForStrongestDivision(facts) {
  const ads = facts.ads;
  if (!ads.hasAnyLaunchablePlatform) return null;
  if (ads.remainingCapCents == null || ads.remainingCapCents <= 0) return null;
  const best = bestAdDivision(facts.momentum);
  if (!best) return null;

  // Spend the remaining cap evenly across the days left, so a proposal can
  // never be one the budget governor would turn around and refuse.
  const dailyBudgetCents = Math.floor(ads.remainingCapCents / Math.max(ads.daysRemainingInMonth, 1));
  if (dailyBudgetCents <= 0) return null;
  const platform = ads.launchablePlatforms.includes('google_ads') ? 'google_ads' : ads.launchablePlatforms[0];

  return {
    kind: 'ad_campaign',
    discriminator: 'draft_' + best.division.toLowerCase().replace(/[^a-z]+/g, '_'),
    title: 'Run a lead-gen campaign for ' + best.division,
    valueCents: ads.remainingCapCents,
    rationale: best.division + ' brought in ' + money(best.revenueCentsLast90) + ' across ' + best.completedLast90 +
      ' completed jobs in the last 90 days' +
      (best.avgJobValueCentsLast90 ? ' (about ' + money(best.avgJobValueCentsLast90) + ' a job)' : '') +
      '. There is ' + money(ads.remainingCapCents) + ' of authorized budget left this month and ' +
      ads.daysRemainingInMonth + ' days to use it, which is about ' + money(dailyBudgetCents) + ' a day.',
    evidence: {
      division: best.division,
      completedLast90: best.completedLast90,
      revenueCentsLast90: best.revenueCentsLast90,
      avgJobValueCentsLast90: best.avgJobValueCentsLast90,
      remainingCapCents: ads.remainingCapCents,
      daysRemainingInMonth: ads.daysRemainingInMonth,
    },
    proposedAction: {
      type: 'ad_campaign_draft',
      platform,
      objective: 'lead_gen',
      division: best.division,
      dailyBudgetCents,
    },
  };
}

function ruleRecoverDecliningDivision(facts) {
  const declining = decliningDivision(facts.momentum);
  if (!declining) return null;
  const lostCents = Math.max(declining.revenueCentsPrior90 - declining.revenueCentsLast90, 0);
  if (lostCents <= 0) return null;
  return {
    kind: 'ad_campaign',
    discriminator: 'recover_' + declining.division.toLowerCase().replace(/[^a-z]+/g, '_'),
    title: declining.division + ' is down ' + Math.abs(declining.revenueChangePct) + '% -- push it back up',
    valueCents: lostCents,
    rationale: declining.division + ' did ' + money(declining.revenueCentsPrior90) + ' across ' +
      declining.completedPrior90 + ' jobs in the previous 90 days, and ' + money(declining.revenueCentsLast90) +
      ' across ' + declining.completedLast90 + ' jobs in the last 90 -- a drop of ' + money(lostCents) + '.',
    evidence: {
      division: declining.division,
      completedLast90: declining.completedLast90,
      completedPrior90: declining.completedPrior90,
      revenueCentsLast90: declining.revenueCentsLast90,
      revenueCentsPrior90: declining.revenueCentsPrior90,
      revenueChangePct: declining.revenueChangePct,
    },
    proposedAction: { type: 'ad_campaign_draft', objective: 'lead_gen', division: declining.division },
  };
}

function ruleEstimateRecovery(facts) {
  const q = facts.quotes;
  if (!q || !q.available || !q.openQuoteCountLast365) return null;
  return {
    kind: 'estimate_recovery',
    discriminator: 'unsold_quotes',
    title: 'Follow up on ' + q.openQuoteCountLast365 + ' unsold estimates worth ' + money(q.openQuoteValueCentsLast365),
    valueCents: q.openQuoteValueCentsLast365,
    rationale: q.openQuoteCountLast365 + ' estimate' + (q.openQuoteCountLast365 === 1 ? '' : 's') +
      ' from the last year ' + (q.openQuoteCountLast365 === 1 ? 'is' : 'are') + ' still awaiting a response, totalling ' +
      money(q.openQuoteValueCentsLast365) + '. These people already asked for a price -- they are the warmest leads you have.',
    evidence: {
      openQuoteCountLast365: q.openQuoteCountLast365,
      openQuoteValueCentsLast365: q.openQuoteValueCentsLast365,
      openQuoteCountAllTime: q.openQuoteCount,
    },
    proposedAction: { type: 'email_campaign', campaignType: 'estimate_recovery' },
  };
}

function ruleReactivation(facts) {
  const d = facts.dormant;
  if (!d || !d.available || !d.dormantCustomerCount) return null;
  // What one reactivation campaign is plausibly worth is not knowable, so
  // the value at stake is stated as what these customers have ALREADY spent
  // -- a real, historical number, not a projection of future revenue.
  return {
    kind: 'reactivation',
    discriminator: 'dormant_customers',
    title: 'Win back ' + d.dormantCustomerCount + ' customers who have not booked in over a year',
    valueCents: d.dormantLifetimeValueCents,
    rationale: d.dormantCustomerCount + ' of your ' + d.totalCustomersWithCompletedWork +
      ' past customers have not had a completed job in more than ' + d.dormantAfterDays +
      ' days. They have spent ' + money(d.dormantLifetimeValueCents) + ' with you historically' +
      (d.avgLifetimeValueCents ? ', against a ' + money(d.avgLifetimeValueCents) + ' average customer lifetime value' : '') + '.',
    evidence: {
      dormantCustomerCount: d.dormantCustomerCount,
      totalCustomersWithCompletedWork: d.totalCustomersWithCompletedWork,
      dormantLifetimeValueCents: d.dormantLifetimeValueCents,
      avgLifetimeValueCents: d.avgLifetimeValueCents,
      dormantAfterDays: d.dormantAfterDays,
    },
    proposedAction: { type: 'email_campaign', campaignType: 'reactivation' },
  };
}

function ruleReviewPush(facts) {
  const r = facts.reviews;
  if (!r || !r.available || !r.completedLast180WithNoReviewAsk) return null;
  // Reviews have no directly attributable dollar value in this data, so the
  // value at stake is left at 0 rather than invented. It still appears in
  // the list; it just does not outrank things with real money behind them.
  return {
    kind: 'review_push',
    discriminator: 'review_backlog',
    title: 'Ask ' + r.completedLast180WithNoReviewAsk + ' recent customers for a review',
    valueCents: 0,
    rationale: r.completedLast180WithNoReviewAsk + ' of the ' + r.completedLast180 +
      ' jobs you completed in the last 180 days have never been asked for a review' +
      (r.reviewRequestsSentAllTime ? ' (' + r.reviewRequestsSentAllTime + ' asks have been sent all time)' : ' -- no review request has ever been sent') +
      '. Reviews are the cheapest growth lever a home-services company has.',
    evidence: {
      completedLast180: r.completedLast180,
      completedLast180WithNoReviewAsk: r.completedLast180WithNoReviewAsk,
      reviewRequestsSentAllTime: r.reviewRequestsSentAllTime,
    },
    proposedAction: { type: 'review_request_batch' },
  };
}

function ruleContentReels(facts) {
  const p = facts.photos;
  if (!p || !p.available || !p.jobsWithEnoughPhotosLast180) return null;
  return {
    kind: 'content_reel',
    discriminator: 'photo_backlog',
    title: 'Turn ' + p.jobsWithEnoughPhotosLast180 + ' photographed jobs into short-form videos',
    valueCents: 0,
    rationale: p.jobsWithEnoughPhotosLast180 + ' jobs from the last 180 days have ' + p.minPhotos +
      ' or more real photos on them -- enough to build a narrated before-and-after video from, at no media cost. ' +
      'You have ' + p.totalPhotos.toLocaleString('en-US') + ' job photos in total and none of them have been used for content.',
    evidence: {
      jobsWithEnoughPhotosLast180: p.jobsWithEnoughPhotosLast180,
      jobsWithPhotosLast180: p.jobsWithPhotosLast180,
      totalPhotos: p.totalPhotos,
      minPhotos: p.minPhotos,
    },
    proposedAction: { type: 'reel_batch', count: Math.min(p.jobsWithEnoughPhotosLast180, 3) },
  };
}

function ruleIdleBudget(facts) {
  const ads = facts.ads;
  if (!ads.hasAnyLaunchablePlatform) return null;      // covered by ruleConnectAdPlatforms
  if (ads.monthlyCapCents == null) return null;
  if (ads.monthToDateSpendCents > 0) return null;
  if (ads.activeCampaignCount > 0) return null;
  return {
    kind: 'ad_campaign',
    discriminator: 'idle_budget',
    title: money(ads.monthlyCapCents) + ' of ad budget is authorized and completely unspent this month',
    valueCents: ads.monthlyCapCents,
    rationale: 'Your monthly ad cap is ' + money(ads.monthlyCapCents) + ', nothing has been spent this month, and no campaign is currently active. ' +
      'There are ' + ads.daysRemainingInMonth + ' days left in the month -- unspent budget does not roll over.',
    evidence: {
      monthlyCapCents: ads.monthlyCapCents,
      monthToDateSpendCents: ads.monthToDateSpendCents,
      activeCampaignCount: ads.activeCampaignCount,
      daysRemainingInMonth: ads.daysRemainingInMonth,
    },
    proposedAction: { type: 'review_ad_plan' },
  };
}

const RULES = [
  ruleConnectAdPlatforms,
  ruleDraftCampaignForStrongestDivision,
  ruleRecoverDecliningDivision,
  ruleEstimateRecovery,
  ruleReactivation,
  ruleReviewPush,
  ruleContentReels,
  ruleIdleBudget,
];

// Produces the ranked suggestion list for one scan. Pure: same facts in,
// same suggestions out, no I/O, no clock reads beyond the `now` passed in.
export function buildSuggestions(facts, now = new Date()) {
  const week = isoWeekKey(now);
  const candidates = [];
  for (const rule of RULES) {
    const c = rule(facts);
    if (c) candidates.push(c);
  }
  candidates.sort((a, b) => b.valueCents - a.valueCents);
  return candidates.map((c) => ({
    kind: c.kind,
    title: c.title,
    rationale: c.rationale,
    evidence: c.evidence,
    proposed_action: c.proposedAction,
    priority: priorityForValue(c.valueCents),
    scan_key: c.kind + ':' + c.discriminator + ':' + week,
    value_cents: c.valueCents,
  }));
}

export { KNOWN_DIVISIONS };
