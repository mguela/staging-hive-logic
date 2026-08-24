// scripts/growth-dry-run.mjs
// Runs the growth engine against the REAL production database and prints what
// Reina would recommend -- without writing a single row.
//
// This exists because the suggester being unit-tested is not the same as the
// suggester being right. Tests prove the rules behave as written against
// fixtures; only real data shows whether the rules say anything USEFUL about
// this actual company, and whether any number comes out looking wrong.
//
// STRICTLY READ-ONLY. It calls gatherGrowthFacts and buildSuggestions, which
// only ever issue GETs. It never touches handleGrowthScanGet, which is the
// function that writes.
//
// Usage: node --env-file=<file with real keys> scripts/growth-dry-run.mjs
//
// NOTE: .env.vercelpull on this setup does NOT work -- every Vercel env var is
// marked Sensitive, so the pulled file contains [SENSITIVE] placeholders
// rather than values. This needs a file with a real SUPABASE_URL and
// SUPABASE_SERVICE_KEY.

import { gatherGrowthFacts } from '../api/_lib/growth-facts.js';
import { buildSuggestions } from '../api/_lib/growth-suggester.js';

function money(cents) {
  return '$' + Math.round((Number(cents) || 0) / 100).toLocaleString('en-US');
}

// A read-only Supabase caller. Deliberately refuses anything that is not a
// GET, so this script cannot write even if a code path it calls tries to.
async function readOnlySupabase(pathAndQuery, options = {}) {
  if (options.method && options.method !== 'GET') {
    throw new Error('growth-dry-run is read-only; refused a ' + options.method + ' to ' + pathAndQuery);
  }
  const url = process.env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/' + pathAndQuery;
  const key = process.env.SUPABASE_SERVICE_KEY;
  return fetch(url, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('Run with --env-file=.env.vercelpull so SUPABASE_URL / SUPABASE_SERVICE_KEY are set.');
  }
  const now = new Date();
  console.log('reading real production data...\n');

  const facts = await gatherGrowthFacts('ghgrp', readOnlySupabase, now);

  console.log('--- WHAT THE ENGINE ACTUALLY READ ---');
  if (facts.momentum.available) {
    for (const d of facts.momentum.divisions) {
      if (!d.completedLast90 && !d.completedPrior90) continue;
      console.log(`  ${d.division.padEnd(15)} last 90d: ${String(d.completedLast90).padStart(3)} jobs / ${money(d.revenueCentsLast90).padStart(10)}` +
        `   prior 90d: ${String(d.completedPrior90).padStart(3)} jobs / ${money(d.revenueCentsPrior90).padStart(10)}` +
        (d.revenueChangePct == null ? '' : `   ${d.revenueChangePct > 0 ? '+' : ''}${d.revenueChangePct}%`));
    }
  }
  console.log(`  unsold estimates (1y): ${facts.quotes.openQuoteCountLast365} worth ${money(facts.quotes.openQuoteValueCentsLast365)}`);
  console.log(`  dormant customers:     ${facts.dormant.dormantCustomerCount} of ${facts.dormant.totalCustomersWithCompletedWork}, ${money(facts.dormant.dormantLifetimeValueCents)} historic spend`);
  console.log(`  review coverage:       ${facts.reviews.completedLast180WithNoReviewAsk} of ${facts.reviews.completedLast180} recent jobs never asked`);
  console.log(`  photo backlog:         ${facts.photos.jobsWithEnoughPhotosLast180} jobs with ${facts.photos.minPhotos}+ photos (${facts.photos.totalPhotos.toLocaleString('en-US')} photos total)`);
  console.log(`  ad posture:            cap ${facts.ads.monthlyCapCents == null ? 'none' : money(facts.ads.monthlyCapCents)}, spent ${money(facts.ads.monthToDateSpendCents)}, ` +
    `${facts.ads.launchablePlatforms.length ? 'launchable: ' + facts.ads.launchablePlatforms.join(', ') : 'no platform connected'}`);

  const suggestions = buildSuggestions(facts, now);
  console.log(`\n--- WHAT REINA WOULD SAY (${suggestions.length} item${suggestions.length === 1 ? '' : 's'}) ---`);
  if (!suggestions.length) {
    console.log('  Nothing. An empty list is a valid outcome -- it means no rule found anything worth raising.');
  }
  suggestions.forEach((s, i) => {
    console.log(`\n  ${i + 1}. [P${s.priority}] ${s.title}`);
    console.log(`     ${s.rationale}`);
    console.log(`     at stake: ${money(s.value_cents)}   action: ${s.proposed_action.type}   key: ${s.scan_key}`);
  });
  console.log('\nnothing was written.');
}

main().catch((e) => { console.error('\n' + e.message); process.exitCode = 1; });
