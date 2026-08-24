import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSuggestions, isoWeekKey } from '../api/_lib/growth-suggester.js';

// The suggester is pure by design -- real facts in, ranked suggestions out,
// no I/O and no clock read beyond the `now` passed in. That is what makes the
// money-shaped decisions testable, which is the whole reason an LLM is not in
// this path. Every test below is therefore a plain function call.

const NOW = new Date('2026-08-24T12:00:00.000Z');

// A baseline where nothing is wrong: ads are live and spending, no unsold
// quotes, no dormant customers, every job asked for a review, no photos.
// Each test then perturbs exactly one thing, so a suggestion appearing can
// only have come from the fact that changed.
function healthyFacts(overrides = {}) {
  return {
    asOf: NOW.toISOString(),
    momentum: { available: true, divisions: [] },
    quotes: { available: true, openQuoteCount: 0, openQuoteValueCents: 0, openQuoteCountLast365: 0, openQuoteValueCentsLast365: 0 },
    dormant: { available: true, totalCustomersWithCompletedWork: 10, dormantCustomerCount: 0, dormantLifetimeValueCents: 0, avgLifetimeValueCents: 50000, dormantAfterDays: 365 },
    reviews: { available: true, completedLast180: 10, reviewRequestsSentAllTime: 10, completedLast180WithNoReviewAsk: 0 },
    ads: {
      connectedPlatforms: [{ platform: 'google_ads', state: 'launch_enabled' }],
      launchablePlatforms: ['google_ads'],
      hasAnyLaunchablePlatform: true,
      activeCampaignCount: 1,
      draftCampaignCount: 0,
      pendingReviewCampaignCount: 0,
      monthlyCapCents: 150000,
      autonomyLevel: 'auto_within_cap',
      monthToDateSpendCents: 150000,
      remainingCapCents: 0,
      daysRemainingInMonth: 8,
    },
    photos: { available: true, minPhotos: 4, totalPhotos: 0, jobsWithPhotosLast180: 0, jobsWithEnoughPhotosLast180: 0 },
    territory: { geocodedCustomerCount: 100, avgDistanceMiles: 6.2, maxDistanceMiles: 20, officeSet: true },
    ...overrides,
  };
}

function division(name, over = {}) {
  return {
    division: name,
    completedLast90: 0, completedPrior90: 0,
    revenueCentsLast90: 0, revenueCentsPrior90: 0,
    jobCountChangePct: null, revenueChangePct: null,
    avgJobValueCentsLast90: null,
    ...over,
  };
}

test('isoWeekKey: the same week produces the same key, so a cron retry updates instead of duplicating', () => {
  assert.equal(isoWeekKey(new Date('2026-08-24T00:00:00Z')), isoWeekKey(new Date('2026-08-28T23:00:00Z')));
  assert.notEqual(isoWeekKey(new Date('2026-08-24T00:00:00Z')), isoWeekKey(new Date('2026-08-31T00:00:00Z')));
});

test('a healthy business with nothing to fix produces no suggestions -- an empty list is a valid answer', () => {
  assert.deepEqual(buildSuggestions(healthyFacts(), NOW), []);
});

test('no ad platform connected: the first move is connecting one, and it names the unspent budget', () => {
  const facts = healthyFacts({
    ads: {
      ...healthyFacts().ads,
      connectedPlatforms: [], launchablePlatforms: [], hasAnyLaunchablePlatform: false,
      activeCampaignCount: 0, monthToDateSpendCents: 0, remainingCapCents: 150000,
    },
    momentum: { available: true, divisions: [division('HVAC', { completedLast90: 12, revenueCentsLast90: 4200000 })] },
  });
  const out = buildSuggestions(facts, NOW);
  const connect = out.find((s) => s.scan_key.startsWith('ad_campaign:connect_platforms'));
  assert.ok(connect, 'the connect suggestion must be produced');
  assert.match(connect.rationale, /\$1,500 a month/);
  assert.match(connect.rationale, /HVAC/);
  assert.equal(connect.proposed_action.type, 'connect_ad_platform');
});

test('no platform connected and no budget cap set: it says so rather than quoting a cap of $0', () => {
  const base = healthyFacts();
  const facts = healthyFacts({
    ads: { ...base.ads, hasAnyLaunchablePlatform: false, launchablePlatforms: [], monthlyCapCents: null, remainingCapCents: null },
  });
  const connect = buildSuggestions(facts, NOW).find((s) => s.scan_key.startsWith('ad_campaign:connect_platforms'));
  assert.match(connect.rationale, /no monthly budget cap is set/);
  assert.doesNotMatch(connect.rationale, /\$0/);
});

test('a live platform with real headroom produces a fully specified draft the budget governor would accept', () => {
  const base = healthyFacts();
  const facts = healthyFacts({
    ads: { ...base.ads, monthToDateSpendCents: 30000, remainingCapCents: 120000, daysRemainingInMonth: 10, activeCampaignCount: 1 },
    momentum: {
      available: true,
      divisions: [
        division('HVAC', { completedLast90: 12, revenueCentsLast90: 4200000, avgJobValueCentsLast90: 350000 }),
        division('Plumbing', { completedLast90: 20, revenueCentsLast90: 900000 }),
      ],
    },
  });
  const draft = buildSuggestions(facts, NOW).find((s) => s.proposed_action.type === 'ad_campaign_draft' && s.scan_key.includes('draft_'));
  assert.ok(draft, 'a draft suggestion must be produced');
  // Highest REVENUE wins, not highest job count -- Plumbing did more jobs.
  assert.equal(draft.proposed_action.division, 'HVAC');
  // The daily budget must fit the remaining cap across the remaining days,
  // or the governor would refuse the very campaign this suggested.
  assert.equal(draft.proposed_action.dailyBudgetCents, 12000);
  assert.ok(draft.proposed_action.dailyBudgetCents * 10 <= 120000);
});

test('no completed work in any division: no campaign is proposed, because there is no trade to advertise honestly', () => {
  const base = healthyFacts();
  const facts = healthyFacts({
    ads: { ...base.ads, remainingCapCents: 120000, monthToDateSpendCents: 30000 },
    momentum: { available: true, divisions: [division('HVAC'), division('Plumbing')] },
  });
  assert.equal(buildSuggestions(facts, NOW).filter((s) => s.scan_key.includes('draft_')).length, 0);
});

test('a division that fell off is surfaced with the real dollars lost', () => {
  const facts = healthyFacts({
    momentum: {
      available: true,
      divisions: [division('Electric', {
        completedLast90: 2, completedPrior90: 10,
        revenueCentsLast90: 500000, revenueCentsPrior90: 2500000,
        revenueChangePct: -80,
      })],
    },
  });
  const rec = buildSuggestions(facts, NOW).find((s) => s.scan_key.includes('recover_electric'));
  assert.ok(rec);
  assert.equal(rec.value_cents, 2000000);
  assert.match(rec.title, /down 80%/);
});

test('a division with a one-job history cannot register as a decline', () => {
  const facts = healthyFacts({
    momentum: {
      available: true,
      divisions: [division('Electric', { completedPrior90: 1, revenueCentsPrior90: 100000, revenueChangePct: -100 })],
    },
  });
  assert.equal(buildSuggestions(facts, NOW).filter((s) => s.scan_key.includes('recover_')).length, 0);
});

test('a division with completed work but no recorded revenue is not reported as a decline', () => {
  // Found by a dry run against real production data: Electric completed the
  // same 5 jobs in both windows, but those rows carry no total, so revenue
  // read $3,500 -> $0 and the rule announced "down 100%". Missing data is not
  // lost money, and saying it is would cost this feature its credibility.
  const facts = healthyFacts({
    momentum: {
      available: true,
      divisions: [division('Electric', {
        completedLast90: 5, completedPrior90: 5,
        revenueCentsLast90: 0, revenueCentsPrior90: 350000,
        revenueChangePct: -100,
      })],
    },
  });
  assert.deepEqual(buildSuggestions(facts, NOW).filter((s) => s.scan_key.includes('recover_')), []);
});

test('a division that genuinely stopped working IS still reported', () => {
  // The guard above must not silence a real collapse: no revenue AND no jobs.
  const facts = healthyFacts({
    momentum: {
      available: true,
      divisions: [division('Electric', {
        completedLast90: 0, completedPrior90: 5,
        revenueCentsLast90: 0, revenueCentsPrior90: 350000,
        revenueChangePct: -100,
      })],
    },
  });
  const rec = buildSuggestions(facts, NOW).find((s) => s.scan_key.includes('recover_electric'));
  assert.ok(rec, 'a division that actually stopped must still be surfaced');
  assert.equal(rec.value_cents, 350000);
});

test('unsold estimates and dormant customers are surfaced with their real totals', () => {
  const facts = healthyFacts({
    quotes: { available: true, openQuoteCount: 13, openQuoteValueCents: 4000000, openQuoteCountLast365: 12, openQuoteValueCentsLast365: 3800000 },
    dormant: { available: true, totalCustomersWithCompletedWork: 500, dormantCustomerCount: 210, dormantLifetimeValueCents: 9000000, avgLifetimeValueCents: 42000, dormantAfterDays: 365 },
  });
  const out = buildSuggestions(facts, NOW);
  const quotes = out.find((s) => s.kind === 'estimate_recovery');
  const dormant = out.find((s) => s.kind === 'reactivation');
  assert.equal(quotes.value_cents, 3800000);
  assert.match(quotes.title, /\$38,000/);
  assert.equal(dormant.value_cents, 9000000);
  assert.match(dormant.title, /210 customers/);
});

test('ranking is by real dollars at stake, so the biggest pile of money comes first', () => {
  const facts = healthyFacts({
    quotes: { available: true, openQuoteCount: 1, openQuoteValueCents: 60000, openQuoteCountLast365: 1, openQuoteValueCentsLast365: 60000 },
    dormant: { available: true, totalCustomersWithCompletedWork: 500, dormantCustomerCount: 210, dormantLifetimeValueCents: 9000000, avgLifetimeValueCents: 42000, dormantAfterDays: 365 },
    photos: { available: true, minPhotos: 4, totalPhotos: 41158, jobsWithPhotosLast180: 300, jobsWithEnoughPhotosLast180: 96 },
  });
  const out = buildSuggestions(facts, NOW);
  assert.equal(out[0].kind, 'reactivation', 'the $90,000 item must outrank the $600 one');
  assert.equal(out[0].priority, 1);
  // Reviews and reels carry no attributable dollar value, so they rank last
  // rather than being given an invented one to make them look urgent.
  assert.equal(out[out.length - 1].value_cents, 0);
});

test('a review backlog is surfaced even though it has no dollar value attached', () => {
  const facts = healthyFacts({
    reviews: { available: true, completedLast180: 120, reviewRequestsSentAllTime: 0, completedLast180WithNoReviewAsk: 120 },
  });
  const out = buildSuggestions(facts, NOW);
  const review = out.find((s) => s.kind === 'review_push');
  assert.ok(review);
  assert.equal(review.value_cents, 0);
  assert.match(review.rationale, /no review request has ever been sent/);
});

test('photo backlog becomes a reel suggestion capped at a sane batch size', () => {
  const facts = healthyFacts({
    photos: { available: true, minPhotos: 4, totalPhotos: 41158, jobsWithPhotosLast180: 300, jobsWithEnoughPhotosLast180: 96 },
  });
  const reels = buildSuggestions(facts, NOW).find((s) => s.kind === 'content_reel');
  assert.equal(reels.proposed_action.type, 'reel_batch');
  assert.equal(reels.proposed_action.count, 3);
});

test('an authorized but completely unspent budget is flagged on its own', () => {
  const base = healthyFacts();
  const facts = healthyFacts({
    ads: { ...base.ads, activeCampaignCount: 0, monthToDateSpendCents: 0, remainingCapCents: 150000 },
  });
  const idle = buildSuggestions(facts, NOW).find((s) => s.scan_key.includes('idle_budget'));
  assert.ok(idle);
  assert.match(idle.title, /\$1,500 of ad budget/);
});

test('the same facts always produce the same scan keys, which is what makes the weekly scan idempotent', () => {
  const facts = healthyFacts({
    quotes: { available: true, openQuoteCount: 5, openQuoteValueCents: 500000, openQuoteCountLast365: 5, openQuoteValueCentsLast365: 500000 },
  });
  const a = buildSuggestions(facts, NOW).map((s) => s.scan_key);
  const b = buildSuggestions(facts, new Date('2026-08-26T04:00:00.000Z')).map((s) => s.scan_key);
  assert.deepEqual(a, b);
});
