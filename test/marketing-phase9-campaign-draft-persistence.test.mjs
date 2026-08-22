// test/marketing-phase9-campaign-draft-persistence.test.mjs
// Regression guard for wiring handleDraftPostPost (api/marketing.js) to
// actually persist each generated caption into marketing_campaign_drafts
// (sql/040, Phase 4 sub-slice 5), plus a new resource=campaign_drafts GET
// endpoint to read them back. Before this slice, handleDraftPostPost was a
// pure, stateless AI caption generator -- every draft was lost the instant
// the HTTP response was sent (confirmed 2026-07-30). This file runs a real
// `node --check` syntax gate in addition to structural/behavioral
// assertions against the real source text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const apiPath = path.join(repoRoot, 'api', 'marketing.js');
const api = fs.readFileSync(apiPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('api/marketing.js is syntactically valid JS after the patch', () => {
  execFileSync(process.execPath, ['--check', apiPath], { stdio: 'pipe' });
});

check('handleCampaignDraftsGet is defined and dispatched for resource=campaign_drafts GET', () => {
  assert.match(api, /async function handleCampaignDraftsGet\(req, res\)/);
  assert.match(api, /if \(resource === 'campaign_drafts' && req\.method === 'GET'\)\s*\{\s*\n\s*return await handleCampaignDraftsGet\(req, res\);/);
});

check('the resource error-list string documents campaign_drafts (GET)', () => {
  assert.match(api, /campaign_activity \(GET\), campaign_drafts \(GET\)(?:, [a-z_]+ \((?:GET|POST|GET\/POST|PATCH)\))*, process_scheduled_sends \(GET\)/);
});

check('handleCampaignDraftsGet reads marketing_campaign_drafts via fetchAllRows and degrades honestly (never fabricates a list) when the table is not synced', () => {
  const fnMatch = api.match(/async function handleCampaignDraftsGet[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'could not isolate handleCampaignDraftsGet body');
  const body = fnMatch[0];
  assert.match(body, /fetchAllRows\('marketing_campaign_drafts', '\?select=\*&order=created_at\.desc'\)/);
  assert.match(body, /if \(e\.notSynced\) return res\.status\(200\)\.json\(\{ ok: true, drafts: \[\], notice:/);
  assert.match(body, /marketing_campaign_drafts table is not set up yet -- run sql\/040_marketing_campaign_draft_audit_event\.sql in Supabase\./);
});

check('handleDraftPostPost still generates and returns the real AI caption unchanged -- persistence is additive, not a replacement of the existing behavior', () => {
  assert.match(api, /async function handleDraftPostPost\(req, res\)/);
  // The exact prompt/facts-gathering logic from before this slice must
  // still be present verbatim -- this slice only ADDS persistence, it does
  // not touch caption generation itself.
  assert.match(api, /STRICT RULE: only use the facts given below\. Never invent specific materials/);
  assert.match(api, /const usedRealAnalysis = analyzedDetails\.length > 0;/);
});

check('handleDraftPostPost persists a real marketing_campaign_drafts row after generating the caption, using the real facts it already computed (not fabricated ones)', () => {
  const fnMatch = api.match(/async function handleDraftPostPost[\s\S]*?\nexport default async function handler/);
  assert.ok(fnMatch, 'could not isolate handleDraftPostPost body');
  const body = fnMatch[0];
  assert.match(body, /const insertRes = await supabaseRequest\('marketing_campaign_drafts', \{/);
  assert.match(body, /method: 'POST',/);
  assert.match(body, /job_id: jobId,/);
  assert.match(body, /draft_text: text,/);
  assert.match(body, /used_real_analysis: usedRealAnalysis,/);
  assert.match(body, /photo_count: mediaRows\.length,/);
  assert.match(body, /generated_by: 'ai',/);
});

check('the persistence path is best-effort -- a save failure (including a not-synced table) never blocks or corrupts the real caption response', () => {
  const fnMatch = api.match(/async function handleDraftPostPost[\s\S]*?\nexport default async function handler/);
  const body = fnMatch[0];
  assert.match(body, /let draftId = null;/);
  assert.match(body, /try \{\s*\n\s*const insertRes = await supabaseRequest/);
  assert.match(body, /\} catch \(e\) \{/);
  // The final response must always fire regardless of the persistence outcome.
  assert.match(body, /return res\.status\(200\)\.json\(\{\s*\n\s*ok: true,\s*\n\s*source: 'HiveLogic Marketing',\s*\n\s*draft: text,\s*\n\s*draftId,/);
});

check('handleDraftPostPost never fabricates a draftId -- it only comes from a real inserted row, defaulting to null', () => {
  const fnMatch = api.match(/async function handleDraftPostPost[\s\S]*?\nexport default async function handler/);
  const body = fnMatch[0];
  assert.match(body, /if \(insertRes\.ok\) \{\s*\n\s*const \[saved\] = await insertRes\.json\(\);\s*\n\s*if \(saved\) draftId = saved\.id;/);
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
