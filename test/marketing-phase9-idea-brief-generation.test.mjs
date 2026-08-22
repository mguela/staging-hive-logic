// test/marketing-phase9-idea-brief-generation.test.mjs
// Regression guard for the Phase 9 "idea -> brief" slice: a new
// resource=ideas_process POST handler in api/marketing.js that turns a
// submitted owner idea into real, channel-constrained recommendations, plus
// the matching "Generate Brief" UI in public/marketing-command-center/index.html.
//
// Like the previous Phase 9 slice, this writes real application code, so on
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
  const tmpFile = path.join(repoRoot, '.tmp-cc-script-check-brief.js');
  fs.writeFileSync(tmpFile, scriptBody, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

check('handleIdeasProcessPost is defined and dispatched for resource=ideas_process POST', () => {
  assert.match(api, /async function handleIdeasProcessPost\(req, res\)/);
  assert.match(api, /if \(resource === 'ideas_process' && req\.method === 'POST'\)\s*\{\s*\n\s*return await handleIdeasProcessPost\(req, res\);/);
});

check('the resource error-list string documents ideas_process (POST)', () => {
  assert.match(api, /ideas \(GET\/POST\), ideas_process \(POST\), idea_attachments \(GET\/POST\)(?:, [a-z_]+ \((?:GET|POST|GET\/POST|PATCH)\))*, process_scheduled_sends \(GET\)/);
});

check('handleIdeasProcessPost requires ideaId and 404s when the idea is missing', () => {
  assert.match(api, /const ideaId = String\(b\.ideaId \|\| ''\)\.trim\(\);/);
  assert.match(api, /if \(!ideaId\) return res\.status\(400\)\.json\(\{ ok: false, error: 'ideaId is required\.' \}\);/);
  assert.match(api, /if \(!idea\) return res\.status\(404\)\.json\(\{ ok: false, error: 'Idea not found\.' \}\);/);
});

check('handleIdeasProcessPost honestly degrades (409 + persisted error status) when ANTHROPIC_API_KEY is not set, matching the handleDraftPostPost pattern', () => {
  const fnMatch = api.match(/async function handleIdeasProcessPost[\s\S]*?\nexport default async function handler/);
  assert.ok(fnMatch, 'could not isolate handleIdeasProcessPost body');
  const body = fnMatch[0];
  assert.match(body, /if \(!anthropicMkt\) \{/);
  assert.match(body, /ANTHROPIC_API_KEY is not set for this deployment -- cannot generate a brief yet\./);
  assert.match(body, /status(?::| =) 'error'/);
  assert.match(body, /return res\.status\(409\)\.json\(\{ ok: false, error: patch\.error_reason \}\);/);
});

check('handleIdeasProcessPost only ever recommends channels from channelsActuallyConnectedAndReady -- the prompt constrains the model, and the response is filtered again in code (never trusts the model)', () => {
  const fnMatch = api.match(/async function handleIdeasProcessPost[\s\S]*?\nexport default async function handler/);
  const body = fnMatch[0];
  assert.match(body, /const connections = await ccConnections\(\);/);
  assert.match(body, /const readyChannels = connections\.filter\(\(c\) => c\.ready\)/);
  assert.match(body, /Only recommend channels from \\"channelsActuallyConnectedAndReady\\"/);
  assert.match(body, /const readyLabels = new Set\(readyChannels\.map\(\(c\) => c\.label\)\);/);
  assert.match(body, /const safeRecommendedChannels = parsed\.recommendedChannels\.filter\(\(r\) => r && readyLabels\.has\(r\.channel\)\);/);
});

check('handleIdeasProcessPost never fabricates specifics -- the prompt explicitly requires gapFlags instead of invented details', () => {
  const fnMatch = api.match(/async function handleIdeasProcessPost[\s\S]*?\nexport default async function handler/);
  const body = fnMatch[0];
  assert.match(body, /Never invent specifics/);
  assert.match(body, /gapFlags instead of assumed/);
});

check('handleIdeasProcessPost honestly errors (502 + persisted error status) when the AI response cannot be parsed as valid JSON, rather than guessing', () => {
  const fnMatch = api.match(/async function handleIdeasProcessPost[\s\S]*?\nexport default async function handler/);
  const body = fnMatch[0];
  assert.match(body, /let parsed = null;/);
  assert.match(body, /catch \(e\) \{\s*\n\s*parsed = null;\s*\n\s*\}/);
  assert.match(body, /if \(!valid\) \{/);
  assert.match(body, /AI brief response could not be parsed -- try again\./);
  assert.match(body, /return res\.status\(502\)\.json\(\{ ok: false, error: patch\.error_reason \}\);/);
});

check('handleIdeasProcessPost derives status from whether any channel survived filtering (needs_input vs brief_ready), never hardcodes success', () => {
  const fnMatch = api.match(/async function handleIdeasProcessPost[\s\S]*?\nexport default async function handler/);
  const body = fnMatch[0];
  assert.match(body, /const status = safeRecommendedChannels\.length === 0 \? 'needs_input' : 'brief_ready';/);
});

check('handleIdeasProcessPost builds real facts (job/client/attachments) instead of fabricating context, and degrades attachmentCount to 0 if marketing_attachments is not synced', () => {
  const fnMatch = api.match(/async function handleIdeasProcessPost[\s\S]*?\nexport default async function handler/);
  const body = fnMatch[0];
  assert.match(body, /jobDivisionServer\(job\.title\)/);
  assert.match(body, /clientDisplayName\(client\)/);
  assert.match(body, /fetchAllRows\('marketing_attachments', `\?select=id&entity_type=eq\.OWNER_IDEA&entity_id=eq\.\$\{encodeURIComponent\(idea\.id\)\}`\)/);
  assert.match(body, /if \(!e\.notSynced\) throw e;/);
});

check('ccGenerateBrief() posts to resource=ideas_process and the renderIdeas() row template wires up a Generate/Retry Brief button', () => {
  assert.match(frontend, /function ccGenerateBrief\(ideaId\)\{/);
  assert.match(frontend, /api\('ideas_process', \{ method: 'POST', body: JSON\.stringify\(\{ ideaId: ideaId \}\) \}\)/);
  assert.match(frontend, /onclick="ccGenerateBrief\(\\'' \+ idea\.id \+ '\\'\)"/);
  assert.match(frontend, /idea\.status === 'error' \? 'Retry Brief' : 'Generate Brief'/);
});

check('renderIdeas() displays brief summary, recommended channels, and gap flags when present -- never renders a placeholder brief', () => {
  assert.match(frontend, /idea\.brief && idea\.brief\.summary/);
  assert.match(frontend, /idea\.brief\.recommendedChannels \|\| \[\]/);
  assert.match(frontend, /idea\.gapFlags && idea\.gapFlags\.length/);
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
