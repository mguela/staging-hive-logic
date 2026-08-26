// test/schedule-apply-move-native.test.mjs
// jomell, 2026-08-25: "i just booked a schedule and it reflected in the
// schedule or calendar, and when i clicked on that schedule, a window
// popped up, when i click on 'apply move' nothing happens."
//
// Root cause: Apply Move in openJobSheet() unconditionally called
// openImpact()->commitMove(), which is a local-only lab preview (its own
// body text literally says "Lab preview... No real write") -- so the
// appointment appeared to move, then reverted on the next reload with no
// visible error. The exact same appointment CAN already be moved for real
// via drag-and-drop (wireDay()'s drop handler), which correctly calls
// hlMoveNative() -> a real hlPost('move_appointment', ...) for a native
// appointment. Apply Move now takes the same branch.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(root, 'public', 'schedule-board', 'app.js'), 'utf-8');

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

test('Apply Move calls hlMoveNative for a real native appointment, same as drag-and-drop', () => {
  const fn = extractFunction(APP, 'function openJobSheet(vid){');
  assert.match(fn, /if\(v\.native\)hlMoveNative\(v,nt,clamped\)/,
    'a native appointment must go through the real move_appointment write, not the local-only lab preview');
});

test('Apply Move only falls back to the local preview for a non-native visit', () => {
  const fn = extractFunction(APP, 'function openJobSheet(vid){');
  assert.match(fn, /else openImpact\(vid,nt,clamped\)/);
});

test('the drop handler and Apply Move branch on the exact same flag', () => {
  // wireDay()'s existing drop handler is the reference implementation --
  // if these ever drift onto different flags (v.native vs. v.source vs.
  // !v.locked) the two paths for moving the same appointment could disagree.
  const dropHandler = APP.slice(APP.indexOf('lane.addEventListener(\'drop\''), APP.indexOf('lane.addEventListener(\'drop\'') + 400);
  assert.match(dropHandler, /dv\.native/);
  const jobSheet = extractFunction(APP, 'function openJobSheet(vid){');
  assert.match(jobSheet, /v\.native/);
});

test('a real move still routes through the guarded impact/request flow when the role cannot edit', () => {
  const fn = extractFunction(APP, 'function openJobSheet(vid){');
  assert.match(fn, /openChangeRequest\(vid,nt,clampHr\(ns,dur\)\)/,
    'a non-dispatch role must still only be able to request a change, not move it directly');
});
