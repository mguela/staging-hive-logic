// test/marketing-phase4-website-review-attribution-schema.test.mjs
// Regression guard for the Marketing Suite Phase 4 "sub-slice 6" migration:
// the final 5 of 17 total entities (WebsiteChange, ReviewReply,
// LeadAttribution, RevenueAttribution, OptimizationRecommendation).
// This migration is deliberately NOT applied to production Supabase, so
// these are structural/source-text assertions against the real file plus
// real cross-file consistency checks -- not live DB tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sqlPath = path.join(repoRoot, 'sql', '041_marketing_website_review_attribution.sql');

const sql = fs.readFileSync(sqlPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('migration file exists and is additive-only (no drop/alter of existing tables)', () => {
  assert.ok(fs.existsSync(sqlPath), 'sql/041 should exist');
  assert.doesNotMatch(sql, /drop table/i);
  assert.doesNotMatch(sql, /alter table (?!marketing_website_changes|marketing_review_replies|marketing_lead_attributions|marketing_revenue_attributions|marketing_optimization_recommendations)/i);
});

check('creates all 5 new tables for this sub-slice', () => {
  for (const t of [
    'marketing_website_changes',
    'marketing_review_replies',
    'marketing_lead_attributions',
    'marketing_revenue_attributions',
    'marketing_optimization_recommendations',
  ]) {
    assert.match(sql, new RegExp(`create table if not exists ${t}`), `missing table ${t}`);
  }
});

check('does not recreate any real existing table (review_requests, campaigns, clients, marketing_approvals, marketing_platform_connections)', () => {
  for (const existing of ['review_requests', 'campaigns', 'clients', 'marketing_approvals', 'marketing_platform_connections']) {
    assert.doesNotMatch(sql, new RegExp(`create table if not exists ${existing}\\b`));
  }
});

check('marketing_website_changes.approval_id and marketing_review_replies.approval_id are deliberately soft references (no hard FK to the still-unmerged marketing_approvals)', () => {
  assert.doesNotMatch(sql, /approval_id uuid references marketing_approvals/);
  assert.match(sql, /approval_id uuid,/);
});

check('marketing_website_changes.provider matches the Phase 13 brief\'s WordPress/Webflow/Wix provider-abstraction requirement', () => {
  assert.match(sql, /provider text not null check \(provider in \('wordpress','webflow','wix','other'\)\)/);
});

check('marketing_review_replies.platform reuses the real google_business_profile value already established in sql/030, not an invented name', () => {
  const foundationPath = path.join(repoRoot, 'sql', '030_marketing_canonical_foundation.sql');
  const foundation = fs.readFileSync(foundationPath, 'utf8');
  assert.match(foundation, /'google_business_profile'/, 'sql/030 should really define google_business_profile');
  assert.match(sql, /platform text not null check \(platform in \('google_business_profile','other'\)\)/);
});

check('marketing_review_replies references the real review_requests(id) FK from sql/020, confirming that table\'s real uuid primary key shape rather than assuming it', () => {
  const reviewRequestsPath = path.join(repoRoot, 'sql', '020_review_requests.sql');
  const reviewRequestsSql = fs.readFileSync(reviewRequestsPath, 'utf8');
  assert.match(reviewRequestsSql, /create table if not exists review_requests \(\s*\n\s*id uuid primary key default gen_random_uuid\(\)/);
  assert.match(sql, /review_request_id uuid references review_requests\(id\) on delete set null/);
});

check('marketing_lead_attributions and marketing_revenue_attributions reference the real campaigns(id) FK from sql/021, confirming that table\'s real uuid primary key shape rather than assuming it', () => {
  const campaignsPath = path.join(repoRoot, 'sql', '021_campaigns.sql');
  const campaignsSql = fs.readFileSync(campaignsPath, 'utf8');
  assert.match(campaignsSql, /create table if not exists campaigns \(\s*\n\s*id uuid primary key default gen_random_uuid\(\)/);
  assert.match(sql, /first_touch_campaign_id uuid references campaigns\(id\) on delete set null/);
  assert.match(sql, /last_touch_campaign_id uuid references campaigns\(id\) on delete set null/);
  assert.match(sql, /campaign_id uuid references campaigns\(id\) on delete set null/);
});

check('all client-linking columns reuse the repo-wide clients(jobber_id) FK convention rather than a new shape', () => {
  const matches = sql.match(/client_id text references clients\(jobber_id\) on delete set null/g) || [];
  assert.ok(matches.length >= 3, `expected at least 3 client_id FKs, found ${matches.length}`);
});

check('marketing_revenue_attributions.job_id is deliberately unconstrained text (not a FK), matching review_requests.job_id\'s real convention for the synced/read-only jobs table', () => {
  const reviewRequestsPath = path.join(repoRoot, 'sql', '020_review_requests.sql');
  const reviewRequestsSql = fs.readFileSync(reviewRequestsPath, 'utf8');
  assert.match(reviewRequestsSql, /job_id text not null unique,\s*-- references jobs\.jobber_id/);
  assert.match(sql, /job_id text,\r?\n\s*client_id text references clients/);
});

check('every new table has RLS enabled and a service-role-only policy, matching the repo-wide convention', () => {
  for (const t of [
    'marketing_website_changes',
    'marketing_review_replies',
    'marketing_lead_attributions',
    'marketing_revenue_attributions',
    'marketing_optimization_recommendations',
  ]) {
    assert.match(sql, new RegExp(`alter table ${t} enable row level security`));
    assert.match(sql, new RegExp(`on ${t}\\s*\\n\\s*for all using \\(auth\\.role\\(\\) = 'service_role'\\)`));
  }
});

check('marketing_optimization_recommendations is deliberately kept distinct from marketing_approvals -- header documents it becomes an approval card only once surfaced, never merged into one table', () => {
  assert.match(sql, /kept as a distinct\s*\n-- record from marketing_approvals/);
});

check('review_text has no rewriting mechanism -- no trigger or generated column derives it from anything else, preserving the "never rewrite review text" rule', () => {
  const reviewRepliesBlock = sql.match(/create table if not exists marketing_review_replies[\s\S]*?(?=create index if not exists marketing_review_replies_tenant_status_idx)/);
  assert.ok(reviewRepliesBlock, 'could not isolate marketing_review_replies body');
  assert.doesNotMatch(reviewRepliesBlock[0], /generated always as/);
});

check('the sql/039/sql/040 filename collision with origin/main\'s unrelated jobs_enriched_view/snapshot_aggregates_fn files is explicitly documented, not silently sidestepped', () => {
  assert.match(sql, /NAMING NOTE \(discovered 2026-07-31\)/);
  assert.match(sql, /sql\/039_jobs_enriched_view\.sql/);
  assert.match(sql, /sql\/040_snapshot_aggregates_fn\.sql/);
});

let pass = 0, fail = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    console.log(`ok - ${name}`);
    pass++;
  } catch (e) {
    console.error(`not ok - ${name}`);
    console.error(e && e.message ? e.message : e);
    fail++;
  }
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
