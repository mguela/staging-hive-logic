// test/active-jobs-close-job.test.mjs
// jomell, 2026-08-25: "in active jobs, when clicking on a job, there
// should be an option to 'close job' (meaning its done) make it bold or
// even change the font color."
//
// Deliberately writes ONLY jobs.hl_closed_at, never job_status or
// completed_at -- both are in the Jobber sync's full-row upsert payload
// every run, so writing "closed" there directly for a real Jobber-synced
// job would get silently wiped on the next sync. hl_closed_at is a new
// HiveLogic-owned column (20260825160000_jobs_hl_closed.sql) the sync
// never touches -- same discipline as clients.phone.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf-8');
const TRACK1 = fs.readFileSync(path.join(root, 'api', 'track1.js'), 'utf-8');

function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  if (start === -1) throw new Error('not found: ' + decl);
  let depth = 1, i = start + decl.length;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

// ---- backend ------------------------------------------------------------

test('the resource dispatch routes set_job_closed to the real handler', () => {
  assert.match(TRACK1, /resource === 'set_job_closed'/);
  assert.match(TRACK1, /handleSetJobClosed\(req, res\)/);
});

test('the handler requires a signed-in HiveLogic user and a job id', () => {
  const fn = extractFunction(TRACK1, 'async function handleSetJobClosed(req, res) {');
  assert.match(fn, /getRequestingProfile\(req\)/);
  assert.match(fn, /if \(!id\) return res\.status\(400\)/);
});

test('the handler writes ONLY jobs.hl_closed_at, never job_status or completed_at', () => {
  const fn = extractFunction(TRACK1, 'async function handleSetJobClosed(req, res) {');
  assert.match(fn, /body: JSON\.stringify\(\{ hl_closed_at: closed \? new Date\(\)\.toISOString\(\) : null \}\)/);
  assert.doesNotMatch(fn, /job_status/, 'must never touch the Jobber-owned status column');
  assert.doesNotMatch(fn, /completed_at/, 'must never touch the Jobber-owned completed_at column');
});

test('the handler PATCHes the existing row by jobber_id, and is a real toggle', () => {
  const fn = extractFunction(TRACK1, 'async function handleSetJobClosed(req, res) {');
  assert.match(fn, /jobs\?jobber_id=eq\.\$\{encodeURIComponent\(id\)\}/);
  assert.match(fn, /method: 'PATCH'/);
  assert.match(fn, /const closed = !!b\.closed;/, 'closed:false must clear it, not just be ignored');
});

test('an unknown job id is reported as not found', () => {
  const fn = extractFunction(TRACK1, 'async function handleSetJobClosed(req, res) {');
  assert.match(fn, /if \(!rows\.length\) return res\.status\(404\)/);
});

test('the route stays POST-only', () => {
  const fn = extractFunction(TRACK1, 'async function handleSetJobClosed(req, res) {');
  assert.match(fn, /if \(req\.method !== 'POST'\) return res\.status\(405\)/);
});

// ---- frontend -------------------------------------------------------------

test('a closed job renders bold and in a different color in the Active Jobs list', () => {
  const fn = extractFunction(HTML, 'function ajxRender() {');
  assert.match(fn, /j\.closedAt \? 'ajx-closed' : ''/);
  assert.match(fn, /✓ Closed/);
});

test('the CSS actually bolds and recolors the closed row, not just a class with no rule', () => {
  const i = HTML.indexOf('.ajx-tbl tr.ajx-closed td{');
  assert.ok(i > -1, 'the ajx-closed rule must exist');
  const rule = HTML.slice(i, HTML.indexOf('}', i) + 1);
  assert.match(rule, /font-weight:800/);
  assert.match(rule, /color:#1B7A50/);
});

test('the job detail modal has a Close/Reopen toggle button, wired to ajvToggleClosed', () => {
  const shell = HTML.slice(HTML.indexOf('class="ajv-foot"'), HTML.indexOf('class="ajv-foot"') + 600);
  assert.match(shell, /id="ajv-close-toggle"/);
  assert.match(shell, /onclick="ajvToggleClosed\(\)"/);
});

test('opening a job sets the button label from its actual closed state', () => {
  const fn = extractFunction(HTML, 'function ajxOpen(jobId) {');
  assert.match(fn, /closeBtn\.textContent = j\.closedAt \? 'Reopen job' : 'Close job'/);
});

test('the modal status line shows the same bold/colored treatment as the list row', () => {
  const fn = extractFunction(HTML, 'function ajxOpen(jobId) {');
  assert.match(fn, /color:#1B7A50;font-weight:900/);
});

test('ajvToggleClosed posts the real action with the opposite of the current state', () => {
  const fn = extractFunction(HTML, 'function ajvToggleClosed() {');
  assert.match(fn, /var closing = !j\.closedAt;/);
  assert.match(fn, /hlApiPost\('set_job_closed', \{ id: j\.id, closed: closing \}\)/);
});

test('a failed toggle reports the real error and re-enables the button, rather than silently doing nothing', () => {
  const fn = extractFunction(HTML, 'function ajvToggleClosed() {');
  assert.match(fn, /if \(!r \|\| !r\.ok\)/);
  assert.match(fn, /btn\.disabled = false/);
});

test('a successful toggle refreshes both the modal and the list', () => {
  const fn = extractFunction(HTML, 'function ajvToggleClosed() {');
  assert.match(fn, /ajxOpen\(j\.id\);/);
  assert.match(fn, /ajxRender\(\);/);
});
