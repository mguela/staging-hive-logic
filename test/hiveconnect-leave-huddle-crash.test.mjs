// test/hiveconnect-leave-huddle-crash.test.mjs
//
// Manual blocker (2026-08-19): "I received a call from my cousin Scott
// through HiveVideo, and when we tried to end the call, it didn't end. I
// tried to open the window again after a hard refresh, and it still
// wouldn't open."
//
// Root cause, confirmed live: leaveHuddle() calls hudPipWindow.close() when
// the call was popped out to a Document Picture-in-Picture window. That
// queues the PiP window's own `pagehide` -> restoreFromPip() ASYNCHRONOUSLY
// -- it does not move the #huddle-dock element back into the main document
// before the rest of leaveHuddle() runs. A few lines later,
// `$('huddle-dock').classList.add('hidden')` dereferenced null and threw
// uncaught, aborting the function.
//
// Reproduced directly in a live browser (no PiP API needed to trigger it --
// simulated by detaching #huddle-dock from the document, matching the exact
// state a click on Leave sees mid-PiP-restore): the LiveKit room DOES
// disconnect cleanly (its own `disconnect from room` / connected->
// disconnected log fires immediately before the crash point), but the crash
// stops everything after it -- the dock is never hidden, activeHuddle
// bookkeeping incomplete, hd-frame never cleared. The call had actually
// ended; the window just never got told to close.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/hiveconnect/app.js', import.meta.url), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > -1, `${signature} must exist`);
  let depth = 0, i = source.indexOf('{', start);
  do {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < source.length);
  assert.equal(depth, 0, 'braces must balance');
  return source.slice(start, i);
}

const fn = extractFunction(src, 'function leaveHuddle(silent)');

test('leaveHuddle no longer dereferences the dock unconditionally', () => {
  // The exact regression: a bare `dock.classList.add(...)` with no guard.
  assert.doesNotMatch(fn, /const dock = \$\('huddle-dock'\);\s*\n\s*dock\.classList\.add/);
  assert.match(fn, /const dock = \$\('huddle-dock'\);\s*\n\s*if \(dock\) \{/);
});

test('leaveHuddle no longer dereferences hd-frame unconditionally', () => {
  assert.doesNotMatch(fn, /\$\('hd-frame'\)\.innerHTML = '';/);
  assert.match(fn, /const frame = \$\('hd-frame'\);\s*\n\s*if \(frame\) frame\.innerHTML = '';/);
});

test('huddleChannel.untrack() is guarded, so a Supabase realtime hiccup cannot abort cleanup either', () => {
  assert.doesNotMatch(fn, /(?<!try \{ )if \(huddleChannel && huddleChannel\.untrack\) huddleChannel\.untrack\(\);/);
  assert.match(fn, /try \{ if \(huddleChannel && huddleChannel\.untrack\) huddleChannel\.untrack\(\); \} catch \(e\) \{\}/);
});

test('activeHuddle is still cleared and the room still disconnected regardless of dock findability', () => {
  // These must run BEFORE the (now-guarded) dock lookup, so the app's own
  // bookkeeping is never left inconsistent even if the dock is unreachable.
  const roomDisconnectIdx = fn.indexOf('if (r) r.disconnect();');
  const activeHuddleNullIdx = fn.indexOf('activeHuddle = null;');
  const dockLookupIdx = fn.indexOf("const dock = $('huddle-dock');");
  assert.ok(roomDisconnectIdx > -1 && activeHuddleNullIdx > -1 && dockLookupIdx > -1);
  assert.ok(roomDisconnectIdx < dockLookupIdx, 'the room must be disconnected before the (possibly-null) dock is touched');
  assert.ok(activeHuddleNullIdx < dockLookupIdx, 'activeHuddle must be cleared before the (possibly-null) dock is touched');
});

test('renderHuddleUI still runs at the end when not silent, regardless of dock findability', () => {
  const idx = fn.indexOf("const frame = $('hd-frame');");
  const renderIdx = fn.indexOf('if (!silent) renderHuddleUI();');
  assert.ok(idx > -1 && renderIdx > -1 && idx < renderIdx);
});
