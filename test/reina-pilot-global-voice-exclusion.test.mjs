import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The global dictation helper (public/voice-input.js) attaches a browser
// SpeechRecognition to whichever field has focus. Reina's composer (#rnaIn)
// runs its OWN transcription, so the global helper must never attach a second
// microphone to it -- two recognizers racing the same utterance produce
// duplicated/interleaved text.
//
// This was previously asserted by requiring the opt-out check to appear in the
// source BEFORE "if (tag === 'TEXTAREA') return true;". That proxy broke when
// the file was deliberately refactored to split one decision into two:
// isTextField() decides whether a field gets ANY helper (a password field still
// needs the eye button), and voiceAllowed() separately decides whether the MIC
// is allowed. The ordering assertion then failed even though the opt-out was
// intact -- and, being a string search, it could not notice the thing that
// actually mattered: enforcement had thinned out to CSS visibility alone
// (the .hl-show class toggling pointer-events), so any path that reached
// startListening another way bypassed the opt-out completely.
//
// These assertions target the real enforcement point instead of line order.

const HELPER = readFileSync(new URL('../public/voice-input.js', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// The body of startListening, up to its closing brace at function indent.
function startListeningBody() {
  const at = HELPER.indexOf('function startListening');
  assert.ok(at >= 0, 'voice-input.js must define startListening');
  const rest = HELPER.slice(at);
  const end = rest.indexOf('\n  }');
  assert.ok(end > 0, 'could not delimit the startListening body');
  return rest.slice(0, end);
}

test('Reina\'s composer opts out in markup and the helper reads that attribute', () => {
  assert.match(INDEX, /<textarea\s+id="rnaIn"[^>]*data-hl-voice-input="off"[^>]*>/u);
  assert.ok(
    HELPER.includes("getAttribute('data-hl-voice-input') === 'off'"),
    'global helper must implement an explicit field opt-out',
  );
});

test('startListening refuses an opted-out field before it builds a recognizer', () => {
  const body = startListeningBody();
  const guard = body.search(/voiceAllowed\(\s*field\s*\)/);
  const construct = body.indexOf('new SR()');

  assert.ok(
    guard >= 0,
    'startListening must consult voiceAllowed(field) -- otherwise the opt-out '
    + 'is enforced only by the button being CSS-hidden, which any direct caller bypasses',
  );
  assert.ok(construct >= 0, 'startListening should construct the recognizer via new SR()');
  assert.ok(
    guard < construct,
    'the opt-out must be checked BEFORE the recognizer is constructed',
  );
});

test('the mic button still exists and defers to the same field-level gate', () => {
  // The button path may stay CSS-driven for presentation, but it must not be
  // the only thing standing between an opted-out field and a second mic.
  assert.ok(HELPER.includes('micBtn.onclick'), 'mic button handler should still exist');
  assert.ok(
    /function startListening\(field\)\s*\{[\s\S]*?voiceAllowed\(/.test(HELPER),
    'enforcement must live inside startListening, not only on the button',
  );
});
