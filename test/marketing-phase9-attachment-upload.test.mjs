// test/marketing-phase9-attachment-upload.test.mjs
// Regression guard for the Phase 9 "upload-wiring" slice: real photo/video/
// voice/document attachments for owner ideas, backed by a new
// resource=idea_attachments GET/POST pair in api/marketing.js, a new
// uploadDataUrl() Supabase Storage helper, a relaxed handleIdeasPost that no
// longer hard-rejects non-text inputMode, handleIdeasGet's new
// attachmentCount, and matching file-picker UI in
// public/marketing-command-center/index.html.
//
// This slice writes real application code, so on top of the usual
// structural/cross-file assertions this file also actually runs
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
const sharedFilesPath = path.join(repoRoot, 'api', '_lib', 'hivedoc-files.js');

const api = fs.readFileSync(apiPath, 'utf8');
const frontend = fs.readFileSync(frontendPath, 'utf8');
const sharedFiles = fs.readFileSync(sharedFilesPath, 'utf8');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('api/marketing.js is syntactically valid JS after the patch', () => {
  execFileSync(process.execPath, ['--check', apiPath], { stdio: 'pipe' });
});

check('public/marketing-command-center/index.html is syntactically valid (script block parses as JS)', () => {
  const blocks = [...frontend.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const scriptBody = blocks.find(b => b.includes('function screenFor'));
  assert.ok(scriptBody, 'could not find the command center IIFE script block');
  const tmpFile = path.join(repoRoot, '.tmp-cc-script-check-upload2.js');
  fs.writeFileSync(tmpFile, scriptBody, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

check('handleIdeasGet computes attachmentCount via one batch query, not N+1', () => {
  const fnMatch = api.match(/async function handleIdeasGet\(req, res\)[\s\S]*?(?=\nasync function handleIdeasPost)/);
  assert.ok(fnMatch, 'could not isolate handleIdeasGet body');
  const body = fnMatch[0];
  assert.match(body, /let attachmentCounts = new Map\(\);/);
  assert.match(body, /fetchAllRows\('marketing_attachments', '\?select=entity_id&entity_type=eq\.OWNER_IDEA'\)/);
  assert.match(body, /attachmentCount: attachmentCounts\.get\(i\.id\) \|\| 0,/);
  assert.match(body, /if \(!e\.notSynced\) throw e;/);
});

check('handleIdeasPost no longer hard-rejects non-text inputMode -- rawText is required only for inputMode==="text"', () => {
  assert.doesNotMatch(api, /Only text ideas can be submitted right now/);
  assert.match(api, /if \(inputMode === 'text' && !rawText\) return res\.status\(400\)\.json\(\{ ok: false, error: 'rawText is required\.' \}\);/);
});

check('uploadDataUrl still does data-URL-to-Supabase-Storage the established way (same regex, same service-key POST, same x-upsert convention)', () => {
  assert.match(api, /async function uploadDataUrl\(bucket, path, dataUrl\)/);
  assert.match(api, /const match = \/\^data:\(\[\^;\]\+\);base64,\(\.\+\)\$\/\.exec\(dataUrl \|\| ''\);/);
  assert.match(api, /apikey: process\.env\.SUPABASE_SERVICE_KEY,/);
  assert.match(api, /'x-upsert': 'true',/);
  // This used to assert that api/subportal.js defined the precedent. It no
  // longer does: on 2026-08-22 subportal's copy was deleted and its uploads
  // moved to api/_lib/hivedoc-files.js, because the buckets it named
  // (`sub-documents`, `sub-invoices`) have never existed on production. So
  // this points at where the precedent actually lives now.
  //
  // api/marketing.js is the last hand-rolled uploader. It is NOT broken --
  // `marketing-attachments` is a real bucket -- but it has no size cap, no
  // content-type allowlist and no path sanitising, all of which the shared
  // module does. Folding it in is a follow-up, deliberately not done here.
  assert.match(sharedFiles, /export async function storeFiledDocument/);
  assert.match(sharedFiles, /'x-upsert': 'true'/);
});

check('handleIdeaAttachmentsGet and handleIdeaAttachmentsPost are defined and dispatched for resource=idea_attachments', () => {
  assert.match(api, /async function handleIdeaAttachmentsGet\(req, res\)/);
  assert.match(api, /async function handleIdeaAttachmentsPost\(req, res\)/);
  assert.match(api, /if \(resource === 'idea_attachments' && req\.method === 'GET'\)\s*\{\s*\n\s*return await handleIdeaAttachmentsGet\(req, res\);/);
  assert.match(api, /if \(resource === 'idea_attachments' && req\.method === 'POST'\)\s*\{\s*\n\s*return await handleIdeaAttachmentsPost\(req, res\);/);
});

check('the resource error-list string documents idea_attachments (GET/POST)', () => {
  assert.match(api, /idea_attachments \(GET\/POST\)(?:, [a-z_]+ \((?:GET|POST|GET\/POST|PATCH)\))*, process_scheduled_sends \(GET\)/);
});

check('handleIdeaAttachmentsPost validates ideaId, attachmentType, and fileDataUrl before doing any work', () => {
  const fnMatch = api.match(/async function handleIdeaAttachmentsPost\(req, res\)[\s\S]*?(?=\n\/\/ ----- Ideas brief generation)/);
  assert.ok(fnMatch, 'could not isolate handleIdeaAttachmentsPost body');
  const body = fnMatch[0];
  assert.match(body, /if \(!ideaId\) return res\.status\(400\)\.json\(\{ ok: false, error: 'ideaId is required\.' \}\);/);
  assert.match(body, /const supportedTypes = \['photo', 'video', 'audio', 'document'\];/);
  assert.match(body, /if \(!supportedTypes\.includes\(attachmentType\)\) \{/);
  assert.match(body, /if \(!fileDataUrl \|\| typeof fileDataUrl !== 'string'\) \{/);
});

check('handleIdeaAttachmentsPost confirms the idea actually exists (404s for a phantom id) before accepting an upload for it', () => {
  const fnMatch = api.match(/async function handleIdeaAttachmentsPost\(req, res\)[\s\S]*?(?=\n\/\/ ----- Ideas brief generation)/);
  const body = fnMatch[0];
  assert.match(body, /const ideaRes = await supabaseRequest\(`marketing_owner_ideas\?select=id&id=eq\.\$\{encodeURIComponent\(ideaId\)\}`\);/);
  assert.match(body, /if \(!idea\) return res\.status\(404\)\.json\(\{ ok: false, error: 'Idea not found\.' \}\);/);
});

check('handleIdeaAttachmentsPost never trusts client-supplied mime/size -- both come from the real uploaded buffer', () => {
  const fnMatch = api.match(/async function handleIdeaAttachmentsPost\(req, res\)[\s\S]*?(?=\n\/\/ ----- Ideas brief generation)/);
  const body = fnMatch[0];
  assert.doesNotMatch(body, /mime_type: b\.mimeType/);
  assert.doesNotMatch(body, /size_bytes: b\.sizeBytes/);
  assert.match(body, /mime_type: uploaded\.contentType,/);
  assert.match(body, /size_bytes: uploaded\.sizeBytes,/);
});

check('handleIdeaAttachmentsPost never fabricates transcript or media_id on insert -- both are honest gaps (no transcription pipeline, no media-reuse picker)', () => {
  const fnMatch = api.match(/async function handleIdeaAttachmentsPost\(req, res\)[\s\S]*?(?=\n\/\/ ----- Ideas brief generation)/);
  const body = fnMatch[0];
  const rowLiteralMatch = body.match(/const row = \{[\s\S]*?\};/);
  assert.ok(rowLiteralMatch, 'could not find the insert row literal');
  assert.doesNotMatch(rowLiteralMatch[0], /transcript:/);
  assert.doesNotMatch(rowLiteralMatch[0], /media_id:/);
});

check('handleIdeaAttachmentsGet degrades honestly (empty list + notice) when marketing_attachments is not synced, never fabricates a list', () => {
  const fnMatch = api.match(/async function handleIdeaAttachmentsGet\(req, res\)[\s\S]*?(?=\n\/\/ resource=idea_attachments POST)/);
  assert.ok(fnMatch, 'could not isolate handleIdeaAttachmentsGet body');
  const body = fnMatch[0];
  assert.match(body, /attachments: \[\], notice: 'marketing_attachments table is not set up yet/);
});

check('renderIdeas() shows the real attachmentCount per idea and a per-idea "+ Add file" control', () => {
  assert.match(frontend, /var attLine = idea\.attachmentCount \? \(' · ' \+ idea\.attachmentCount \+ \(idea\.attachmentCount === 1 \? ' attachment' : ' attachments'\)\) : '';/);
  assert.match(frontend, /var addFileHtml = '<label class="cc-btn cc-btn-secondary"[\s\S]*?\+ Add file<input type="file"[\s\S]*?onchange="ccAttachFileToIdea\(/);
});

check('a new "attach a file as a new idea" card exists with a Choose File input wired to ccSubmitIdeaFile', () => {
  assert.match(frontend, /Or attach a photo, video, voice note, or document/);
  assert.match(frontend, /id="cc-idea-file-input" style="display:none" onchange="ccSubmitIdeaFile\(this\)"/);
});

check('readFileAsDataUrl, attachmentKindForFile, CC_MAX_ATTACHMENT_BYTES, ccSubmitIdeaFile, and ccAttachFileToIdea are all defined', () => {
  assert.match(frontend, /function readFileAsDataUrl\(file\)\{/);
  assert.match(frontend, /function attachmentKindForFile\(file\)\{/);
  assert.match(frontend, /var CC_MAX_ATTACHMENT_BYTES = 4 \* 1024 \* 1024;/);
  assert.match(frontend, /function ccSubmitIdeaFile\(inputEl\)\{/);
  assert.match(frontend, /function ccAttachFileToIdea\(ideaId, inputEl\)\{/);
});

check('attachmentKindForFile maps audio/* to "audio" for attachmentType, but ccSubmitIdeaFile maps that to "voice_note" for inputMode (the two vocabularies differ and must not be conflated)', () => {
  const fnMatch = frontend.match(/function attachmentKindForFile\(file\)\{[\s\S]*?\n  \}/);
  assert.ok(fnMatch, 'could not isolate attachmentKindForFile body');
  assert.match(fnMatch[0], /if \(t\.indexOf\('audio\/'\) === 0\) return 'audio';/);

  const submitFnMatch = frontend.match(/function ccSubmitIdeaFile\(inputEl\)\{[\s\S]*?\n  \}/);
  assert.ok(submitFnMatch, 'could not isolate ccSubmitIdeaFile body');
  const body = submitFnMatch[0];
  assert.match(body, /var ideaInputMode = attachmentType === 'audio' \? 'voice_note' : attachmentType;/);
  assert.match(body, /inputMode: ideaInputMode, rawText: caption \|\| undefined/);
  // and it must NOT pass the raw attachmentType straight through as inputMode
  assert.doesNotMatch(body, /inputMode: attachmentType,/);
});

check('both file-upload paths client-side guard against oversized files using CC_MAX_ATTACHMENT_BYTES before ever reading the file', () => {
  const submitFnMatch = frontend.match(/function ccSubmitIdeaFile\(inputEl\)\{[\s\S]*?\n  \}/);
  assert.match(submitFnMatch[0], /if \(file\.size > CC_MAX_ATTACHMENT_BYTES\) \{/);
  const attachFnMatch = frontend.match(/function ccAttachFileToIdea\(ideaId, inputEl\)\{[\s\S]*?\n  \}/);
  assert.match(attachFnMatch[0], /if \(file\.size > CC_MAX_ATTACHMENT_BYTES\) \{/);
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
