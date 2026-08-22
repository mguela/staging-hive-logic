// test/marketing-phase4-media-schema.test.mjs
// Regression guard for Marketing Suite Phase 4 sub-slice 2
// (sql/037_marketing_media_generated_evidence.sql).
//
// Same rationale as test/marketing-phase4-schema.test.mjs (sub-slice 1):
// this migration is written but deliberately NOT applied to production
// Supabase, so there is no live DB to assert against. These are structural
// assertions against the real migration file's source text, plus real
// cross-file checks against sql/006_visual_intel.sql (the real `media`
// table this migration extends, not duplicates) and
// sql/030_marketing_canonical_foundation.sql (the real consent ledger this
// migration snapshots from).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sqlPath = path.join(repoRoot, 'sql', '037_marketing_media_generated_evidence.sql');
const mediaSqlPath = path.join(repoRoot, 'sql', '006_visual_intel.sql');
const consentSqlPath = path.join(repoRoot, 'sql', '030_marketing_canonical_foundation.sql');

const sql = fs.readFileSync(sqlPath, 'utf8');
const mediaSql = fs.readFileSync(mediaSqlPath, 'utf8');
const consentSql = fs.readFileSync(consentSqlPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('creates marketing_media_assets, marketing_generated_assets, marketing_source_evidence', () => {
  assert.match(sql, /create table if not exists marketing_media_assets\s*\(/);
  assert.match(sql, /create table if not exists marketing_generated_assets\s*\(/);
  assert.match(sql, /create table if not exists marketing_source_evidence\s*\(/);
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
  for (const table of ['marketing_media_assets', 'marketing_generated_assets', 'marketing_source_evidence']) {
    const enableRe = new RegExp(`alter table ${table} enable row level security`, 'i');
    assert.match(sql, enableRe, `${table} must enable RLS`);
    const policyRe = new RegExp(`create policy "service role full access ${table}"\\s*\\n\\s*on ${table}`, 'i');
    assert.match(sql, policyRe, `${table} must have a service-role policy`);
  }
});

check('marketing_media_assets extends the real media table by reference, does not duplicate its columns', () => {
  // must reference the real media table (confirmed schema in sql/006) by FK, cascade on delete
  assert.match(sql, /media_id uuid not null references media\(id\) on delete cascade/);
  // must NOT redeclare storage_path/gps_lat/gps_lng/captured_at -- those live on the real media row only
  for (const col of ['storage_path', 'gps_lat', 'gps_lng', 'captured_at', 'thumbnail_path']) {
    assert.doesNotMatch(sql, new RegExp(`^\\s*${col}\\s`, 'm'), `marketing_media_assets must not duplicate media.${col}`);
  }
  // sanity: the real media table this depends on actually has these columns (guards against the source file itself drifting)
  for (const col of ['storage_path', 'gps_lat', 'gps_lng', 'captured_at']) {
    assert.match(mediaSql, new RegExp(`${col}\\b`), `expected sql/006 media table to still define ${col}`);
  }
  assert.match(sql, /unique \(tenant_id, media_id\)/);
});

check('marketing_media_assets.permission_status models the real (unwired) media_marketing_use consent channel', () => {
  assert.match(sql, /permission_status text not null default 'unknown' check \(permission_status in \('unknown','granted','revoked','owner_override'\)\)/);
  // cross-check: marketing_consent_ledger really does define a media_marketing_use channel value
  assert.match(consentSql, /'media_marketing_use'/, 'expected sql/030 marketing_consent_ledger to define the media_marketing_use channel this snapshots from');
});

check('marketing_generated_assets links to MediaAsset and (optionally) CampaignVariant, tracks approval and publish state', () => {
  assert.match(sql, /media_asset_id uuid references marketing_media_assets\(id\) on delete set null/);
  assert.match(sql, /campaign_variant_id uuid references campaign_variants\(id\) on delete set null/);
  assert.match(sql, /approved_by text/);
  assert.match(sql, /approved_at timestamptz/);
  assert.match(sql, /publish_destinations jsonb/);
  assert.match(sql, /claims_used jsonb/);
});

check('marketing_source_evidence cascades with its generated asset, snapshots media_analysis rather than re-deriving it live', () => {
  assert.match(sql, /generated_asset_id uuid not null references marketing_generated_assets\(id\) on delete cascade/);
  assert.match(sql, /media_analysis_snapshot jsonb/);
  assert.match(sql, /claim_text text not null/);
  assert.match(sql, /verified boolean not null default true/);
});

check('does not recreate media, media_analysis, tags, media_tags, or marketing_consent_ledger', () => {
  for (const existing of [
    'create table if not exists media\\b',
    'create table if not exists media_analysis',
    'create table if not exists tags\\b',
    'create table if not exists media_tags',
    'create table if not exists marketing_consent_ledger',
    'create table if not exists campaign_variants',
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
