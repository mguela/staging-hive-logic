// test/marketing-phase4-schema.test.mjs
// Regression guard for Marketing Suite Phase 4 sub-slice 1
// (sql/036_marketing_shared_workspace_plan_opportunity_variant.sql).
//
// This migration is written but deliberately NOT applied to production
// Supabase (standing rule) -- so there is no live DB to assert against.
// Instead this test does two things a live-DB test could not:
//   1. Structural assertions against the real migration file's source
//      text (tables/RLS/policies/foreign keys all present, additive only).
//   2. A real cross-file consistency check: the opportunity_key CHECK
//      constraint's value list must exactly match OPPORTUNITY_ELIGIBILITY's
//      real keys in api/marketing.js, so the migration's constraint can
//      never silently drift from the actual code constant it models.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sqlPath = path.join(repoRoot, 'sql', '036_marketing_shared_workspace_plan_opportunity_variant.sql');
const apiPath = path.join(repoRoot, 'api', 'marketing.js');

const sql = fs.readFileSync(sqlPath, 'utf8');
const apiSrc = fs.readFileSync(apiPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('creates marketing_plans, marketing_opportunities, campaign_variants', () => {
  assert.match(sql, /create table if not exists marketing_plans\s*\(/);
  assert.match(sql, /create table if not exists marketing_opportunities\s*\(/);
  assert.match(sql, /create table if not exists campaign_variants\s*\(/);
});

check('migration is additive only -- no drop/rename/column-drop statements', () => {
  assert.doesNotMatch(sql, /\bdrop\s+table\b/i);
  assert.doesNotMatch(sql, /\bdrop\s+column\b/i);
  assert.doesNotMatch(sql, /\brename\s+(table|column)\b/i);
  // every ALTER TABLE in this file must be the RLS-enable statement only
  const alterLines = sql.match(/^alter\s+table\s+.*$/gim) || [];
  assert.ok(alterLines.length > 0, 'expected at least one ALTER TABLE (RLS enable)');
  for (const line of alterLines) {
    assert.match(line, /enable row level security/i, `unexpected ALTER TABLE statement: ${line}`);
  }
});

check('every new table enables RLS with a service-role policy', () => {
  for (const table of ['marketing_plans', 'marketing_opportunities', 'campaign_variants']) {
    const enableRe = new RegExp(`alter table ${table} enable row level security`, 'i');
    assert.match(sql, enableRe, `${table} must enable RLS`);
    const policyRe = new RegExp(`create policy "service role full access ${table}"\\s*\\n\\s*on ${table}`, 'i');
    assert.match(sql, policyRe, `${table} must have a service-role policy`);
  }
});

check('marketing_plans: one active plan per tenant, supersede chain, forecast_state matches computeForecast states', () => {
  assert.match(sql, /create unique index if not exists marketing_plans_one_active_per_tenant\s*\n\s*on marketing_plans\(tenant_id\) where \(status = 'active'\)/);
  assert.match(sql, /superseded_by uuid references marketing_plans\(id\) on delete set null/);
  assert.match(sql, /forecast_state text check \(forecast_state is null or forecast_state in \('blocked_no_channel','blocked_assumptions','ready'\)\)/);
});

check('marketing_opportunities: foreign keys to marketing_plans and campaigns, no cascade-delete of history', () => {
  assert.match(sql, /plan_id uuid references marketing_plans\(id\) on delete set null/);
  assert.match(sql, /campaign_id uuid references campaigns\(id\) on delete set null/);
});

check('campaign_variants: cascades with its parent campaign, links optionally to an opportunity', () => {
  assert.match(sql, /campaign_id uuid not null references campaigns\(id\) on delete cascade/);
  assert.match(sql, /opportunity_id uuid references marketing_opportunities\(id\) on delete set null/);
});

check('opportunity_key CHECK list matches OPPORTUNITY_ELIGIBILITY keys in api/marketing.js exactly (no drift)', () => {
  const mapMatch = apiSrc.match(/const OPPORTUNITY_ELIGIBILITY = \{([\s\S]*?)\n\};/);
  assert.ok(mapMatch, 'OPPORTUNITY_ELIGIBILITY map must exist in api/marketing.js');
  const body = mapMatch[1];
  // top-level keys only: lines like `  key_name: {` or `  key_name: { ... },`
  const keyRe = /^\s{2}([a-z_]+):\s*\{/gm;
  const realKeys = new Set();
  let m;
  while ((m = keyRe.exec(body))) realKeys.add(m[1]);
  assert.ok(realKeys.size >= 5, 'sanity check: should find several real opportunity keys');

  const checkMatch = sql.match(/opportunity_key text not null check \(opportunity_key in \(([\s\S]*?)\)\)/);
  assert.ok(checkMatch, 'opportunity_key CHECK constraint must exist');
  const sqlKeys = new Set(
    checkMatch[1]
      .split(',')
      .map(s => s.trim().replace(/^'/, '').replace(/'$/, ''))
      .filter(Boolean)
  );

  assert.deepEqual(
    [...sqlKeys].sort(),
    [...realKeys].sort(),
    'migration opportunity_key values must exactly match the real OPPORTUNITY_ELIGIBILITY keys in api/marketing.js'
  );
});

check('does not recreate the 5 entities that already exist elsewhere', () => {
  for (const existing of ['create table if not exists campaigns', 'create table if not exists marketing_platform_connections', 'create table if not exists marketing_suppressions', 'create table if not exists review_requests', 'create table if not exists marketing_budget_settings']) {
    assert.doesNotMatch(sql, new RegExp(existing, 'i'));
  }
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
