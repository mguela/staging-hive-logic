// test/schedule-cancel-appointment-real.test.mjs
// jomell, 2026-08-25: "i canceled the appointment for the 'decomissioning of
// existing air condition' but its not disappearing from the schedule."
//
// Same shape as the Apply Move bug fixed earlier the same day: cancelAppt()
// only ever set v.confirm='cancelled'/v.status='problem' on the local
// in-memory visit -- it never called the real cancel_appointment action, so
// the card stayed on the board (and the cancellation didn't survive a
// reload either). api/schedule/hl.js's GET query for hl_appointments
// already filters canceled=eq.false, so a real cancel + reload is what
// actually removes the card.

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

test('cancelling a real (native) appointment calls the real cancel_appointment action', () => {
  const fn = extractMethod(APP, "cancelAppt(vid){");
  assert.match(fn, /if\(v\.native && v\.apptId\)\{/);
  assert.match(fn, /hlPost\('cancel_appointment',\{id:v\.apptId\}\)/);
});

test('a successful cancel reloads the board, so the card actually disappears', () => {
  const fn = extractMethod(APP, "cancelAppt(vid){");
  assert.match(fn, /if\(r&&r\.ok\)\{[\s\S]{0,120}window\.hlReload\(\)/);
});

test('a failed cancel says so, rather than pretending it worked', () => {
  const fn = extractMethod(APP, "cancelAppt(vid){");
  assert.match(fn, /else toast\('⚠ Cancel failed: /);
});

test('a still-proposed visit with no real appointment yet keeps the old local-only path', () => {
  // Nothing exists on the server to cancel for a visit that was never
  // booked -- this must not try to hlPost an undefined id.
  const fn = extractMethod(APP, "cancelAppt(vid){");
  assert.match(fn, /\} else \{\s*v\.confirm='cancelled'; v\.status='problem'; render\(\);/);
});

test("the real cancel_appointment endpoint's GET side actually excludes canceled appointments", () => {
  // Confirms the fix is sufficient: reloading after a real cancel must not
  // bring the card right back.
  assert.match(HL, /hl_appointments\?canceled=eq\.false/);
});

test('cancel_appointment PATCHes canceled=true by id', () => {
  const fn = extractMethod(HL, "if (action === 'cancel_appointment') {");
  assert.match(fn, /canceled: true/);
  assert.match(fn, /id=eq\.\$\{enc\(body\.id\)\}/);
});
