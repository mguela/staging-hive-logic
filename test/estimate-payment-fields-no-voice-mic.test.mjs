import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// jomell, 2026-08-27: the floating voice-input mic was covering the
// deposit/schedule percentage fields, blocking the digits while typing --
// the global dictation helper (public/voice-input.js) floats a mic button
// over whichever text/number field has focus. On the estimate builder's
// Deposit % field and each Payment Schedule row's % field, both narrow
// number inputs, the mic sat on top of the digits being typed. Neither
// field is something anyone dictates by voice anyway -- opt both out via
// the same data-hl-voice-input="off" attribute Reina's own composer uses
// (see reina-pilot-global-voice-exclusion.test.mjs for how the helper
// enforces it).

const INDEX = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('the Deposit % field opts out of the floating voice-input mic', () => {
  assert.match(
    INDEX,
    /Deposit <input type="number" data-hl-voice-input="off" style="width:46px" value="'\+EST\.depPct\+'"/,
  );
});

test('each Payment Schedule row\'s % field opts out of the floating voice-input mic', () => {
  assert.match(
    INDEX,
    /<input class="pp" type="number" data-hl-voice-input="off" value="'\+r\.pct\+'"/,
  );
});
