// test/schedule-completed-checkbox.test.mjs
// jomell, 2026-08-25: "in schedule, when clicking on a schedule, there
// should be a checkbox named 'completed'."
//
// The existing ↻ status-cycle button never persisted anything (same class
// of bug as Apply Move / Cancel, fixed earlier the same day for those two --
// left untouched here since fixing it wasn't asked for). The new checkbox
// is real: it calls a new set_appointment_status action that PATCHes
// hl_appointments.status, then reloads on success -- same pattern every
// other real write in this file already uses.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(root, 'public', 'schedule-board', 'app.js'), 'utf-8');
const HL = fs.readFileSync(path.join(root, 'api', 'schedule', 'hl.js'), 'utf-8');

function extractMethod(src, decl) {
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

test('the appointment sheet has a checkbox literally labeled Completed', () => {
  const fn = extractMethod(APP, 'function openJobSheet(vid){');
  assert.match(fn, /<input type="checkbox" \$\{v\.status==='done'\?'checked':''\}/);
  assert.match(fn, /> Completed<\/label>/);
});

test('the checkbox starts checked exactly when the appointment is already done', () => {
  const fn = extractMethod(APP, 'function openJobSheet(vid){');
  assert.match(fn, /v\.status==='done'\?'checked':''/);
});

test('checking it calls the real set_appointment_status action for a native appointment', () => {
  const fn = extractMethod(APP, 'toggleCompleted(vid,checked){');
  assert.match(fn, /if\(v\.native && v\.apptId\)\{/);
  assert.match(fn, /hlPost\('set_appointment_status',\{id:v\.apptId,status:newStatus\}\)/);
});

test('checked maps to done, unchecked maps to scheduled', () => {
  const fn = extractMethod(APP, 'toggleCompleted(vid,checked){');
  assert.match(fn, /const newStatus=checked\?'done':'scheduled';/);
});

test('a successful update reloads the board', () => {
  const fn = extractMethod(APP, 'toggleCompleted(vid,checked){');
  assert.match(fn, /if\(r&&r\.ok\)\{[\s\S]{0,120}window\.hlReload\(\)/);
});

test('a still-proposed visit with no real appointment keeps the old local-only path', () => {
  const fn = extractMethod(APP, 'toggleCompleted(vid,checked){');
  assert.match(fn, /\} else \{\s*v\.status=newStatus; render\(\);/);
});

test('the backend action requires an id and a known status value', () => {
  const fn = extractMethod(HL, "if (action === 'set_appointment_status') {");
  assert.match(fn, /if \(!body\.id\) return res\.status\(400\)/);
  assert.match(fn, /APPT_STATUSES\.indexOf\(body\.status\) === -1/);
});

test('the backend action PATCHes hl_appointments.status by id', () => {
  const fn = extractMethod(HL, "if (action === 'set_appointment_status') {");
  assert.match(fn, /'PATCH', \{ status: body\.status/);
  assert.match(fn, /id=eq\.\$\{enc\(body\.id\)\}/);
});

test('the write-role guard covers the new action, same as every other mutation', () => {
  // SELF_ACTIONS is the only opt-out from canWrite() -- set_appointment_status
  // must not be added there.
  const selfActions = HL.slice(HL.indexOf('const SELF_ACTIONS'), HL.indexOf(']'));
  assert.ok(!/set_appointment_status/.test(selfActions));
});
