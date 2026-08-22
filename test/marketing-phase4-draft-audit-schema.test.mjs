// test/marketing-phase4-draft-audit-schema.test.mjs
// Regression guard for Marketing Suite Phase 4 sub-slice 5: CampaignDraft
// (marketing_campaign_drafts) and AuditEvent (marketing_audit_events), added
// by sql/040_marketing_campaign_draft_audit_event.sql. This migration is
// deliberately NOT applied to production Supabase (per standing rule), so
// these are structural/source-text assertions against the real migration
// file plus real cross-file consistency checks against sql/013 (the
// existing bookkeeping audit-log precedent) and api/marketing.js (the real
// handleDraftPostPost function this table is meant to eventually back).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sqlPath = path.join(repoRoot, 'sql', '040_marketing_campaign_draft_audit_event.sql');
const bookkeepingAuditPath = path.join(repoRoot, 'sql', '013_bookkeeping_audit_log.sql');
const apiPath = path.join(repoRoot, 'api', 'marketing.js');

const sql = fs.readFileSync(sqlPath, 'utf8');
const bookkeepingAudit = fs.readFileSync(bookkeepingAuditPath, 'utf8');
const api = fs.readFileSync(apiPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('creates marketing_campaign_drafts and marketing_audit_events', () => {
  assert.match(sql, /create table if not exists marketing_campaign_drafts/);
  assert.match(sql, /create table if not exists marketing_audit_events/);
});

check('migration is additive only -- no drop/rename/column-drop statements', () => {
  assert.doesNotMatch(sql, /\bdrop table\b/i);
  assert.doesNotMatch(sql, /\bdrop column\b/i);
  assert.doesNotMatch(sql, /\brename\b/i);
  assert.doesNotMatch(sql, /\balter table\b.*\bmarketing_platform_connections\b/is);
});

check('both new tables enable RLS with a service-role policy', () => {
  assert.match(sql, /alter table marketing_campaign_drafts enable row level security;/);
  assert.match(sql, /alter table marketing_audit_events enable row level security;/);
  const policyCount = (sql.match(/for all using \(auth\.role\(\) = 'service_role'\)/g) || []).length;
  assert.ok(policyCount >= 2, `expected at least 2 service-role policies, found ${policyCount}`);
});

check('marketing_campaign_drafts is distinct from campaign_variants -- scoped to unpromoted AI drafts, not a duplicate of a campaign-scoped variant', () => {
  assert.match(sql, /A CampaignDraft has no campaign yet/);
  assert.match(sql, /promoted_campaign_id uuid references campaigns\(id\) on delete set null/);
  assert.doesNotMatch(sql, /create table if not exists campaign_variants/);
});

check('marketing_campaign_drafts models the real fields handleDraftPostPost already computes (division, job identity, real-analysis usage, photo count)', () => {
  // Confirm the real handler still computes exactly these facts, so the
  // migration's column choices are not speculative.
  assert.match(api, /async function handleDraftPostPost\(req, res\)/);
  assert.match(api, /const division = jobDivisionServer\(job\.title\);/);
  assert.match(api, /const usedRealAnalysis = analyzedDetails\.length > 0;/);
  assert.match(api, /photoCount: mediaRows\.length/);
  // And the migration's own columns for the same facts:
  assert.match(sql, /division text,/);
  assert.match(sql, /used_real_analysis boolean not null default false,/);
  assert.match(sql, /photo_count integer not null default 0 check \(photo_count >= 0\),/);
  assert.match(sql, /job_id text,/);
});

check('marketing_campaign_drafts status enum supports the draft -> discarded/promoted lifecycle, never fabricates a promoted campaign on insert', () => {
  assert.match(sql, /status text not null default 'draft' check \(status in \('draft','discarded','promoted'\)\)/);
});

check('marketing_audit_events is append-only at the database level, reusing sql/013\'s real REVOKE + trigger technique', () => {
  // Confirm sql/013's real mechanism still exists as the precedent being followed.
  assert.match(bookkeepingAudit, /revoke update, delete on bookkeeping_audit_log from anon, authenticated, service_role;/);
  assert.match(bookkeepingAudit, /before update or delete on bookkeeping_audit_log/);
  // And the new table reuses the same real mechanism, not just a comment claiming it does.
  assert.match(sql, /revoke update, delete on marketing_audit_events from anon, authenticated, service_role;/);
  assert.match(sql, /grant insert, select on marketing_audit_events to service_role;/);
  assert.match(sql, /before update or delete on marketing_audit_events/);
  assert.match(sql, /raise exception 'marketing_audit_events is append-only/);
});

check('marketing_audit_events deliberately does NOT copy the hash-chain columns from bookkeeping_audit_log -- documented divergence, not an oversight', () => {
  // sql/013's hash-chain-specific columns should exist there...
  assert.match(bookkeepingAudit, /previous_hash text,/);
  assert.match(bookkeepingAudit, /hash text not null,/);
  assert.match(bookkeepingAudit, /seq integer not null,/);
  // ...but marketing_audit_events should not have adopted them.
  const auditEventTableMatch = sql.match(/create table if not exists marketing_audit_events \([\s\S]*?\);/);
  assert.ok(auditEventTableMatch, 'could not isolate marketing_audit_events table definition');
  const tableBody = auditEventTableMatch[0];
  assert.doesNotMatch(tableBody, /previous_hash/);
  assert.doesNotMatch(tableBody, /\bhash\b/);
  assert.doesNotMatch(tableBody, /\bseq\b/);
  assert.match(sql, /solving a problem this domain doesn't have/);
});

check('marketing_audit_events category is constrained to real Marketing Suite domains, not a free-text field that could drift', () => {
  assert.match(sql, /category text not null check \(category in \(/);
  for (const cat of ['idea', 'campaign', 'approval', 'connection', 'budget', 'plan', 'review', 'opportunity']) {
    assert.match(sql, new RegExp(`'${cat}'`), `expected category '${cat}' in the CHECK constraint`);
  }
});

check('does not recreate campaigns, campaign_variants, marketing_platform_connections, or bookkeeping_audit_log', () => {
  assert.doesNotMatch(sql, /create table if not exists campaigns\b/);
  assert.doesNotMatch(sql, /create table if not exists campaign_variants\b/);
  assert.doesNotMatch(sql, /create table if not exists marketing_platform_connections\b/);
  assert.doesNotMatch(sql, /create table if not exists bookkeeping_audit_log\b/);
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
