// test/marketing-phase4-approval-schema.test.mjs
// Regression guard for Marketing Suite Phase 4 sub-slice 3
// (sql/038_marketing_approval_annotation_publication.sql).
//
// Same rationale as the sub-slice 1/2 schema tests: this migration is
// written but deliberately NOT applied to production Supabase, so there is
// no live DB to assert against. These are structural assertions against the
// real migration file's source text, plus real cross-file checks against
// sql/006_visual_intel.sql (the real `annotations`/`media_entity_links`
// tables this migration deliberately does NOT duplicate) and
// sql/035_automation_agents.sql (the real approval precedent this
// migration explicitly diverges from, for a documented reason).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sqlPath = path.join(repoRoot, 'sql', '038_marketing_approval_annotation_publication.sql');
const visualIntelSqlPath = path.join(repoRoot, 'sql', '006_visual_intel.sql');
const automationSqlPath = path.join(repoRoot, 'sql', '035_automation_agents.sql');

const sql = fs.readFileSync(sqlPath, 'utf8');
const visualIntelSql = fs.readFileSync(visualIntelSqlPath, 'utf8');
const automationSql = fs.readFileSync(automationSqlPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('creates marketing_approvals, marketing_annotations, marketing_publications', () => {
  assert.match(sql, /create table if not exists marketing_approvals\s*\(/);
  assert.match(sql, /create table if not exists marketing_annotations\s*\(/);
  assert.match(sql, /create table if not exists marketing_publications\s*\(/);
});

check('migration is additive only -- no drop/rename/column-drop statements', () => {
  assert.doesNotMatch(sql, /\bdrop\s+table\b/i);
  assert.doesNotMatch(sql, /\bdrop\s+column\b/i);
  assert.doesNotMatch(sql, /\brename\s+(table|column)\b/i);
  const alterLines = sql.match(/^alter\s+table\s+.*$/gim) || [];
  assert.ok(alterLines.length > 0, 'expected at least one ALTER TABLE (RLS enable)');
  for (const line of alterLines) {
    assert.match(line, /enable row level security/i, `unexpected ALTER TABLE statement: ${line}`);
  }
});

check('every new table enables RLS with a service-role policy', () => {
  for (const table of ['marketing_approvals', 'marketing_annotations', 'marketing_publications']) {
    const enableRe = new RegExp(`alter table ${table} enable row level security`, 'i');
    assert.match(sql, enableRe, `${table} must enable RLS`);
    const policyRe = new RegExp(`create policy "service role full access ${table}"\\s*\\n\\s*on ${table}`, 'i');
    assert.match(sql, policyRe, `${table} must have a service-role policy`);
  }
});

check('marketing_approvals covers exactly the 7 Ready-for-You card types and full card context fields', () => {
  const expectedTypes = [
    'CAMPAIGN_SPEND', 'GENERATED_VIDEO', 'WEBSITE_PROMOTION', 'REVIEW_REPLY',
    'CLAIM_CORRECTION', 'ACCOUNT_REPAIR', 'BUDGET_ADJUSTMENT',
  ];
  for (const t of expectedTypes) {
    assert.match(sql, new RegExp(`'${t}'`), `expected approvable_type to include ${t}`);
  }
  for (const field of ['rationale text', 'preview_text text', 'amount_cents integer', 'max_amount_cents integer', 'target_description text', 'estimate jsonb', 'confidence numeric', 'risks jsonb']) {
    assert.match(sql, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `marketing_approvals missing field: ${field}`);
  }
  assert.match(sql, /status text not null default 'pending' check \(status in \(\s*'pending','approved','rejected','edited','regenerating','needs_input','expired'/);
});

check('marketing_approvals is a single mutable-status row, not the automation_task_approvals append-only decision-log pattern', () => {
  // sanity: confirm the real precedent it diverges from actually exists and looks the way we documented
  assert.match(automationSql, /create table if not exists automation_task_approvals/);
  assert.match(automationSql, /decision text not null check \(decision in \('approved','rejected'\)\)/);
  // our table must NOT reuse that narrow decision-only shape -- it needs its own status column
  assert.match(sql, /status text not null default 'pending' check \(status in \(/);
  assert.doesNotMatch(sql, /decision text not null check \(decision in \('approved','rejected'\)\)/);
});

check('marketing_annotations does not duplicate sql/006 annotations -- scoped to generated assets, not raw media', () => {
  assert.match(sql, /generated_asset_id uuid not null references marketing_generated_assets\(id\) on delete cascade/);
  // must not declare a media_id column on this table (that's sql/006's annotations' job)
  assert.doesNotMatch(sql, /marketing_annotations[\s\S]*?media_id uuid not null references media/);
  assert.match(sql, /superseded_by uuid references marketing_annotations\(id\) on delete set null/);
  // cross-check the real sql/006 annotations table still exists with its own superseded_by, confirming no collision/duplication
  assert.match(visualIntelSql, /create table if not exists annotations\s*\(/);
  assert.match(visualIntelSql, /superseded_by uuid references annotations \(id\)/);
});

check('marketing_annotations covers Phase 12\'s 4 annotation kinds plus plain-language correction and targeted regeneration link', () => {
  for (const t of ['VIDEO_MARK', 'REGION_CLICK', 'TEXT_HIGHLIGHT', 'CORRECTION']) {
    assert.match(sql, new RegExp(`'${t}'`), `expected annotation_type to include ${t}`);
  }
  assert.match(sql, /correction_text text/);
  assert.match(sql, /regenerated_asset_id uuid references marketing_generated_assets\(id\) on delete set null/);
});

check('marketing_publications is genuinely new (no prior publish/rollback table exists) and reuses the real website_cms channel key', () => {
  assert.match(sql, /destination_type text not null check \(destination_type in \(/);
  assert.match(sql, /'website_cms'/);
  assert.match(sql, /published_at timestamptz/);
  assert.match(sql, /expires_at timestamptz/);
  assert.match(sql, /rolled_back_at timestamptz/);
  assert.match(sql, /rollback_reason text/);
  assert.match(sql, /approval_id uuid references marketing_approvals\(id\) on delete set null/);
});

check('does not recreate annotations, media_entity_links, automation_task_approvals, marketing_generated_assets, or campaigns', () => {
  for (const existing of [
    'create table if not exists annotations\\b',
    'create table if not exists media_entity_links',
    'create table if not exists automation_task_approvals',
    'create table if not exists marketing_generated_assets',
    'create table if not exists campaigns\\b',
  ]) {
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
