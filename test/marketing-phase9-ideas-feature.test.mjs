// test/marketing-phase9-ideas-feature.test.mjs
// Regression guard for the Phase 9 Ideas feature slice: a new
// `resource=ideas` GET/POST pair in api/marketing.js, and a new "Ideas" nav
// tab in public/marketing-command-center/index.html, backed by
// sql/039_marketing_owner_idea_attachment.sql (marketing_owner_ideas).
//
// This slice writes real application code (not just an unapplied
// migration), so on top of the usual structural/cross-file assertions this
// file also actually runs `node --check` against both changed files to
// confirm they are syntactically valid, not just regex-plausible.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const apiPath = path.join(repoRoot, 'api', 'marketing.js');
const frontendPath = path.join(repoRoot, 'public', 'marketing-command-center', 'index.html');
const sqlPath = path.join(repoRoot, 'sql', '039_marketing_owner_idea_attachment.sql');

const api = fs.readFileSync(apiPath, 'utf8');
const frontend = fs.readFileSync(frontendPath, 'utf8');
const sql = fs.readFileSync(sqlPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('api/marketing.js is syntactically valid JS after the patch', () => {
  execFileSync(process.execPath, ['--check', apiPath], { stdio: 'pipe' });
});

check('handleIdeasGet and handleIdeasPost are defined and dispatched for resource=ideas', () => {
  assert.match(api, /async function handleIdeasGet\(req, res\)/);
  assert.match(api, /async function handleIdeasPost\(req, res\)/);
  assert.match(api, /if \(resource === 'ideas' && req\.method === 'GET'\)\s*\{\s*\n\s*return await handleIdeasGet\(req, res\);/);
  assert.match(api, /if \(resource === 'ideas' && req\.method === 'POST'\)\s*\{\s*\n\s*return await handleIdeasPost\(req, res\);/);
});

check('the resource error-list string documents ideas (GET/POST)', () => {
  assert.match(api, /ideas \(GET\/POST\)/);
});

check('handleIdeasGet reads marketing_owner_ideas via fetchAllRows, not a hand-rolled query', () => {
  assert.match(api, /fetchAllRows\('marketing_owner_ideas', '\?select=\*&order=created_at\.desc'\)/);
});

check('handleIdeasPost validates inputMode against supportedModes -- Phase 9 upload-wiring slice (2026-07-31) intentionally relaxed the old text-only restriction now that idea_attachments (below) is a real upload path', () => {
  assert.match(api, /const supportedModes = \['text', 'voice_note', 'photo', 'video', 'document'\];/);
  assert.match(api, /if \(!supportedModes\.includes\(inputMode\)\) \{/);
  assert.doesNotMatch(api, /upload\/transcription pipeline that has not been built yet/);
});

check('handleIdeasPost validates rawText is required and degrades honestly if marketing_owner_ideas is not synced', () => {
  assert.match(api, /if \(inputMode === 'text' && !rawText\) return res\.status\(400\)\.json\(\{ ok: false, error: 'rawText is required\.' \}\);/);
  assert.match(api, /marketing_owner_ideas table is not set up yet -- run sql\/039_marketing_owner_idea_attachment\.sql in Supabase\./);
});

check('handleIdeasPost never fabricates a brief -- brief/gapFlags are only ever read back from the created row, never set on insert', () => {
  const postFnMatch = api.match(/async function handleIdeasPost[\s\S]*?\n\}/);
  assert.ok(postFnMatch, 'could not isolate handleIdeasPost body');
  const body = postFnMatch[0];
  // the insert `row` object must not set brief/gap_flags/campaign_id itself
  const rowLiteralMatch = body.match(/const row = \{[\s\S]*?\};/);
  assert.ok(rowLiteralMatch, 'could not find the insert row literal');
  assert.doesNotMatch(rowLiteralMatch[0], /brief:/);
  assert.doesNotMatch(rowLiteralMatch[0], /gap_flags:/);
  assert.doesNotMatch(rowLiteralMatch[0], /campaign_id:/);
});

check('api field names match the real marketing_owner_ideas columns from sql/039 (no drifted/typoed field names)', () => {
  for (const col of ['submitted_by', 'input_mode', 'raw_text', 'job_id', 'client_id', 'status', 'brief', 'gap_flags', 'campaign_id', 'error_reason', 'processed_at']) {
    assert.match(sql, new RegExp(`\\b${col}\\b`), `sql/039 should define column ${col}`);
    assert.match(api, new RegExp(`\\b${col}\\b`), `api/marketing.js should reference column ${col}`);
  }
});

check('public/marketing-command-center/index.html is syntactically valid (script block parses as JS)', () => {
  // Extract every <script>...</script> block and pick the one containing the
  // page's own IIFE (identified by screenFor(), which only lives in that
  // block) rather than anchoring on the exact closing-token whitespace,
  // which is fragile across CRLF/LF.
  const blocks = [...frontend.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const scriptBody = blocks.find(b => b.includes('function screenFor'));
  assert.ok(scriptBody, 'could not find the command center IIFE script block');
  const tmpFile = path.join(repoRoot, '.tmp-cc-script-check.js');
  fs.writeFileSync(tmpFile, scriptBody, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

check('NAV includes an Ideas tab and ICONS defines a matching idea icon', () => {
  assert.match(frontend, /\{key:'ideas', label:'Ideas', icon:'idea'\}/);
  assert.match(frontend, /idea:'<path d=/);
});

check('screenFor() routes "ideas" to renderIdeas(), and renderIdeas() fetches its own api(\'ideas\') data (matches renderResults\' own-fetch pattern, not folded into command_center)', () => {
  assert.match(frontend, /if \(route === 'ideas'\) return renderIdeas\(data\);/);
  assert.match(frontend, /function renderIdeas\(data\)\{\s*\n\s*return api\('ideas'\)\.then\(/);
});

check('renderIdeas degrades honestly when the table is not synced, and never renders a fabricated idea list', () => {
  assert.match(frontend, /not set up yet/i);
  assert.match(frontend, /No ideas submitted yet/);
});

check('ccSubmitIdea() still posts inputMode:"text" for the text box, and a separate real file-upload path now exists alongside it (Phase 9 upload-wiring slice, 2026-07-31)', () => {
  assert.match(frontend, /function ccSubmitIdea\(\)\{/);
  assert.match(frontend, /inputMode: 'text', rawText: text/);
  assert.match(frontend, /type=["']file["']/);
  assert.match(frontend, /function ccSubmitIdeaFile\(inputEl\)\{/);
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
