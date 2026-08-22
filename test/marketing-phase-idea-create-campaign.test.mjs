// test/marketing-phase-idea-create-campaign.test.mjs
// Regression guard for Task #101: closes the idea -> brief -> campaign gap.
// Before this, handleIdeasProcessPost got an idea to brief_ready/needs_input
// and stopped there -- nothing ever turned a ready brief into a real
// campaign, and renderIdeas() rendered zero action once an idea left
// submitted/error. This adds a resource=idea_create_campaign POST handler
// in api/marketing.js that reuses handleCampaignsPost in-process (the same
// pattern runLifecycleAutosend() already uses), plus a "Create Campaign"
// button in public/marketing-command-center/index.html.
//
// Like the Phase 9 idea-brief test, this writes real application code, so on
// top of structural/cross-file assertions this file actually runs
// `node --check` against both changed files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const apiPath = path.join(repoRoot, 'api', 'marketing.js');
const frontendPath = path.join(repoRoot, 'public', 'marketing-command-center', 'index.html');

const api = fs.readFileSync(apiPath, 'utf8');
const frontend = fs.readFileSync(frontendPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('api/marketing.js is syntactically valid JS after the patch', () => {
  execFileSync(process.execPath, ['--check', apiPath], { stdio: 'pipe' });
});

check('public/marketing-command-center/index.html is syntactically valid (script block parses as JS)', () => {
  const blocks = [...frontend.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const scriptBody = blocks.find(b => b.includes('function screenFor'));
  assert.ok(scriptBody, 'could not find the command center IIFE script block');
  const tmpFile = path.join(repoRoot, '.tmp-cc-script-check-idea-campaign.js');
  fs.writeFileSync(tmpFile, scriptBody, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

check('handleIdeaCreateCampaignPost is defined and dispatched for resource=idea_create_campaign POST', () => {
  assert.match(api, /async function handleIdeaCreateCampaignPost\(req, res\)/);
  assert.match(api, /if \(resource === 'idea_create_campaign' && req\.method === 'POST'\)\s*\{\s*\n\s*return await handleIdeaCreateCampaignPost\(req, res\);/);
});

check('the resource error-list string documents idea_create_campaign (POST)', () => {
  assert.match(api, /idea_attachments \(GET\/POST\), idea_create_campaign \(POST\), attribution \(GET\),/);
});

check('handleIdeaCreateCampaignPost declares its channel map, and requires ideaId, 404s when missing, and 409s when already converted', () => {
  assert.match(api, /const IDEA_CHANNEL_TO_CAMPAIGN_CHANNEL = \{ Email: 'email', 'Text Messages': 'sms' \};/);
  const fnMatch = api.match(/async function handleIdeaCreateCampaignPost[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(fnMatch, 'could not isolate handleIdeaCreateCampaignPost body');
  const body = fnMatch[0];
  assert.match(body, /const ideaId = String\(b\.ideaId \|\| ''\)\.trim\(\);/);
  assert.match(body, /if \(!ideaId\) return res\.status\(400\)\.json\(\{ ok: false, error: 'ideaId is required\.' \}\);/);
  assert.match(body, /if \(!idea\) return res\.status\(404\)\.json\(\{ ok: false, error: 'Idea not found\.' \}\);/);
  assert.match(body, /if \(idea\.campaign_id\) return res\.status\(409\)\.json\(\{ ok: false, error: 'This idea already has a campaign\.', campaignId: idea\.campaign_id \}\);/);
});

check('handleIdeaCreateCampaignPost only proceeds from a ready brief, and only for automatable (Email/Text Messages) channels -- never fabricates a campaign channel that has no real publish path', () => {
  const fnMatch = api.match(/async function handleIdeaCreateCampaignPost[\s\S]*?\r?\n\}\r?\n/);
  const body = fnMatch[0];
  assert.match(body, /if \(idea\.status !== 'brief_ready'\) \{/);
  assert.match(body, /const automatable = recommendedChannels\.filter\(\(c\) => c && IDEA_CHANNEL_TO_CAMPAIGN_CHANNEL\[c\.channel\]\);/);
  assert.match(body, /Reina can't auto-create a campaign for this idea yet/);
});

check('handleIdeaCreateCampaignPost never fabricates an audience -- recipients only when the idea has a real linked client', () => {
  const fnMatch = api.match(/async function handleIdeaCreateCampaignPost[\s\S]*?\r?\n\}\r?\n/);
  const body = fnMatch[0];
  assert.match(body, /const recipients = idea\.client_id\s*\n\s*\? \[\{ clientId: idea\.client_id, targetRecordId: idea\.job_id \|\| null, targetRecordType: idea\.job_id \? 'job' : null \}\]\s*\n\s*: \[\];/);
});

check('handleIdeaCreateCampaignPost reuses handleCampaignsPost in-process (same pattern as runLifecycleAutosend) instead of duplicating validation/eligibility/dedup logic, and uses type: custom to guarantee a fresh campaign', () => {
  const fnMatch = api.match(/async function handleIdeaCreateCampaignPost[\s\S]*?\r?\n\}\r?\n/);
  const body = fnMatch[0];
  assert.match(body, /const createRes = \{ status\(code\) \{ createCaptured\.statusCode = code; return this; \}, json\(body\) \{ createCaptured\.body = body; return this; \} \};/);
  assert.match(body, /type: 'custom',/);
  assert.match(body, /await handleCampaignsPost\(createReq, createRes\);/);
});

check('handleIdeaCreateCampaignPost surfaces handleCampaignsPost\'s honest failure (e.g. no-recipients-yet) rather than fabricating success, and links campaign_id back onto the idea on success', () => {
  const fnMatch = api.match(/async function handleIdeaCreateCampaignPost[\s\S]*?\r?\n\}\r?\n/);
  const body = fnMatch[0];
  assert.match(body, /if \(!createCaptured\.body \|\| !createCaptured\.body\.ok\) \{/);
  assert.match(body, /body: JSON\.stringify\(\{ campaign_id: campaign\.id, updated_at: new Date\(\)\.toISOString\(\) \}\),/);
});

check('ccCreateCampaignFromIdea() posts to resource=idea_create_campaign and renderIdeas() wires a Create Campaign button for brief_ready ideas without a campaign yet', () => {
  assert.match(frontend, /function ccCreateCampaignFromIdea\(ideaId\)\{/);
  assert.match(frontend, /api\('idea_create_campaign', \{ method: 'POST', body: JSON\.stringify\(\{ ideaId: ideaId \}\) \}\)/);
  assert.match(frontend, /onclick="ccCreateCampaignFromIdea\(\\'' \+ idea\.id \+ '\\'\)"/);
});

check('renderIdeas() shows "Campaign created" instead of a duplicate Create Campaign button once idea.campaignId is set', () => {
  assert.match(frontend, /idea\.status === 'brief_ready'/);
  assert.match(frontend, /idea\.campaignId/);
  assert.match(frontend, /Campaign created<\/div>/);
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
