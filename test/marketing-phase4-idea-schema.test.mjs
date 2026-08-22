// test/marketing-phase4-idea-schema.test.mjs
// Regression guard for Marketing Suite Phase 4 sub-slice 4
// (sql/039_marketing_owner_idea_attachment.sql).
//
// Same rationale as the sub-slice 1/2/3 schema tests: this migration is
// written but deliberately NOT applied to production Supabase, so there is
// no live DB to assert against. These are structural assertions against the
// real migration file's source text, plus real cross-file checks against
// sql/006_visual_intel.sql (the real media_entity_links polymorphic pattern
// this migration's Attachment table follows) and sql/021_campaigns.sql /
// sql/006 (the real clients(jobber_id) / media(id) FK shapes this migration
// reuses for its optional links).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sqlPath = path.join(repoRoot, 'sql', '039_marketing_owner_idea_attachment.sql');
const visualIntelSqlPath = path.join(repoRoot, 'sql', '006_visual_intel.sql');
const campaignsSqlPath = path.join(repoRoot, 'sql', '021_campaigns.sql');

const sql = fs.readFileSync(sqlPath, 'utf8');
const visualIntelSql = fs.readFileSync(visualIntelSqlPath, 'utf8');
const campaignsSql = fs.readFileSync(campaignsSqlPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('creates marketing_owner_ideas and marketing_attachments', () => {
  assert.match(sql, /create table if not exists marketing_owner_ideas\s*\(/);
  assert.match(sql, /create table if not exists marketing_attachments\s*\(/);
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
  for (const table of ['marketing_owner_ideas', 'marketing_attachments']) {
    const enableRe = new RegExp(`alter table ${table} enable row level security`, 'i');
    assert.match(sql, enableRe, `${table} must enable RLS`);
    const policyRe = new RegExp(`create policy "service role full access ${table}"\\s*\\n\\s*on ${table}`, 'i');
    assert.match(sql, policyRe, `${table} must have a service-role policy`);
  }
});

check('marketing_owner_ideas covers all 5 input modes and honest not-yet-processed fields', () => {
  for (const mode of ['text', 'voice_note', 'photo', 'video', 'document']) {
    assert.match(sql, new RegExp(`'${mode}'`), `expected input_mode to include ${mode}`);
  }
  assert.match(sql, /brief jsonb/);
  assert.match(sql, /gap_flags jsonb/);
  assert.match(sql, /status text not null default 'submitted' check \(status in \(\s*'submitted','processing','brief_ready','needs_input','dismissed','error'/);
});

check('marketing_owner_ideas reuses the real clients(jobber_id) and campaigns(id) FK shapes, not invented ones', () => {
  assert.match(sql, /client_id text references clients\(jobber_id\) on delete set null/);
  assert.match(sql, /campaign_id uuid references campaigns\(id\) on delete set null/);
  // sanity: confirm campaigns.id is really a uuid primary key (sql/021) and
  // that the real repo-wide convention for a client link is exactly this
  // clients(jobber_id) shape (also used by campaign_recipients in the same file)
  assert.match(campaignsSql, /create table if not exists campaigns \(\s*\n\s*id uuid primary key default gen_random_uuid\(\)/);
  assert.match(campaignsSql, /client_id text references clients\(jobber_id\) on delete set null/);
  // job_id must stay unconstrained text, matching the repo-wide pattern (jobs is synced/read-only)
  assert.match(sql, /job_id text,/);
  assert.doesNotMatch(sql, /job_id text not null references jobs/);
});

check('marketing_attachments follows media_entity_links\' exact polymorphic CHECK-constrained shape', () => {
  assert.match(sql, /entity_type text not null check \(entity_type in \('OWNER_IDEA'\)\)/);
  assert.match(sql, /entity_id uuid not null/);
  // cross-check the real precedent this follows still exists with the same entity_type/entity_id CHECK-constrained shape
  assert.match(visualIntelSql, /entity_type text not null check \(entity_type in \(/);
  assert.match(visualIntelSql, /entity_id text not null/);
});

check('marketing_attachments covers all 4 attachment types, links optionally to a real media row, and admits no transcription pipeline exists yet', () => {
  for (const t of ['photo', 'video', 'audio', 'document']) {
    assert.match(sql, new RegExp(`'${t}'`), `expected attachment_type to include ${t}`);
  }
  assert.match(sql, /media_id uuid references media\(id\) on delete set null/);
  assert.match(sql, /transcript text/);
  // must NOT claim a transcription pipeline is wired up anywhere in this migration
  assert.doesNotMatch(sql, /transcri(be|ption)_(status|provider|model)/i);
});

check('does not recreate media, media_entity_links, clients, campaigns, or marketing_generated_assets', () => {
  for (const existing of [
    'create table if not exists media\\b',
    'create table if not exists media_entity_links',
    'create table if not exists clients\\b',
    'create table if not exists campaigns\\b',
    'create table if not exists marketing_generated_assets',
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
