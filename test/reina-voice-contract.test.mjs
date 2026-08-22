import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// THE VOICE CONTRACT.
//
// Reina's voice was broken for a month. Each thing asserted here is a defect
// that reached Chris, in his words, with the mechanism that caused it. This
// file exists so none of them can come back quietly:
//
//   "its not capturing my voice"      -- the app called the Electron desktop
//                                        bridge "native", so in a browser both
//                                        native factories were null and every
//                                        turn fell through to a record-and-
//                                        upload chain that never once produced
//                                        a transcript. Chrome's own recogniser
//                                        sat captured and unused.
//   "she didnt speak back tho"        -- the transcript goes to the submit a
//                                        TYPED message uses, which has never
//                                        had anything to do with speech.
//   "CLICK AND HOLD SHOULDN'T END     -- continuous was false, so Chrome ended
//    UNTIL YOU LET GO"                   recognition at the first pause and
//                                        sent half a sentence.
//   "THE OPTION TO SPEED UP HER       -- the pace control was still on screen
//    VOICE IS GONE"                      and still saved, but its fastest
//                                        setting was 1.06 -- six percent, which
//                                        is not a speed control.
//
// The recogniser is captured once when the host module loads, on purpose, so
// page code cannot swap it afterwards. A fake therefore has to be installed on
// the global BEFORE the module is evaluated, which is why every import in this
// file is dynamic and why the harness lives in test/helpers.

let started = [];

class FakeRecognition {
  constructor() {
    this.lang = '';
    this.continuous = false;
    this.interimResults = false;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.stopped = false;
    this.aborted = false;
    started.push(this);
  }
  start() { this.running = true; }
  stop() { this.stopped = true; }
  abort() { this.aborted = true; }

  // ---- what Chrome does to us -------------------------------------------
  say(transcript, isFinal = false) {
    const results = [{ 0: { transcript }, isFinal, length: 1 }];
    results.length = 1;
    if (typeof this.onresult === 'function') this.onresult({ resultIndex: 0, results });
  }
  // Chrome ends recognition on its own: at a pause, after silence, at its own
  // internal limits. This is the event that used to end the turn.
  endOnItsOwn() { if (typeof this.onend === 'function') this.onend({}); }
  fail(error) { if (typeof this.onerror === 'function') this.onerror({ error }); }
}

globalThis.SpeechRecognition = FakeRecognition;

const harness = await import('./helpers/reina-pilot-harness.mjs');
const { makeHarness, flush, VOICE_RATES } = harness;

// A POST is not necessarily a turn: the voice beacon posts diagnostics through
// the same client.
function turns(h) {
  return h.calls.filter((c) => c.method === 'POST' && c.url.includes('/api/reina-pilot'));
}

const SOURCE = fs.readFileSync(new URL('../public/reina-pilot-host.js', import.meta.url), 'utf8');

async function heldPanel(options = {}) {
  started = [];
  const h = makeHarness(options);
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const button = h.documentRef.byId.rnaVoice;
  button.dispatch('pointerdown', { isTrusted: true });
  assert.equal(started.length, 1, 'pressing the button starts the browser recogniser');
  return { h, button, label: h.documentRef.byId.rnaVoiceLabel };
}

// ---- the hold ----------------------------------------------------------------

test('the recogniser is told to keep listening through a pause', async () => {
  const { h } = await heldPanel();
  const recognizer = started[0];
  assert.equal(recognizer.continuous, true,
    'without this Chrome ends the turn at the first pause and sends half a sentence');
  assert.equal(recognizer.interimResults, true, 'words appear while they are being spoken');
  assert.match(h.documentRef.byId.rnaVoiceLabel.textContent, /talking/i);
});

test('a hold survives Chrome ending recognition, and nothing is sent', async () => {
  const { h, label } = await heldPanel();
  const first = started[0];
  first.say('what needs attention', true);
  const sent = turns(h).length;

  first.endOnItsOwn();
  await flush();

  assert.equal(started.length, 2, 'the recogniser is restarted while the button is still down');
  assert.equal(turns(h).length, sent,
    'and NOTHING is submitted -- the button has not been released');
  assert.match(label.textContent, /talking/i, 'still recording, as far as the person can see');
});

test('a final result does not end the turn on its own', async () => {
  // The exact regression: Chrome marks a phrase final after a pause. Submitting
  // there is what made holding "inconsistent" -- half a sentence, mid-thought.
  const { h, label } = await heldPanel();
  started[0].say('okay so', true);
  await flush();
  assert.equal(turns(h).length, 0, 'nothing sent yet');
  assert.match(label.textContent, /talking/i);
});

test('releasing sends everything said during the hold, once', async () => {
  const { h, button } = await heldPanel();
  const first = started[0];
  first.say('what needs ', true);
  first.endOnItsOwn();
  await flush();
  started[1].say('attention today', true);

  button.dispatch('pointerup', { isTrusted: true });
  assert.equal(started[1].stopped, true, 'releasing stops the recogniser');
  started[1].endOnItsOwn();
  await flush();

  const posts = turns(h);
  assert.equal(posts.length, 1, 'one turn, not one per phrase');
  assert.equal(JSON.parse(posts[0].body).utterance, 'what needs attention today',
    'every word, in order, across the restart');
});

test('interim words are shown, and are still sent if that is all there was', async () => {
  const { h, button } = await heldPanel();
  started[0].say('quick question', false);
  button.dispatch('pointerup', { isTrusted: true });
  started[0].endOnItsOwn();
  await flush();
  const posts = turns(h);
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].body).utterance, 'quick question');
});

test('a hold with nothing said sends nothing and hands the button back', async () => {
  const { h, button, label } = await heldPanel();
  button.dispatch('pointerup', { isTrusted: true });
  started[0].endOnItsOwn();
  await flush();
  assert.equal(turns(h).length, 0);
  assert.match(label.textContent, /hold/i, 'not stranded on TALKING');
});

test('silence while holding is not a failure', async () => {
  // Chrome reports 'no-speech' for someone who has not started talking yet.
  // Ending the turn there is exactly the impatience this control must not have.
  const { h, label } = await heldPanel();
  started[0].fail('no-speech');
  started[0].endOnItsOwn();
  await flush();
  assert.equal(started.length, 2, 'it keeps listening');
  assert.match(label.textContent, /talking/i);
  assert.equal(turns(h).length, 0);
});

test('a blocked microphone ends the hold and says which thing to fix', async () => {
  const { h, label } = await heldPanel();
  started[0].fail('not-allowed');
  started[0].endOnItsOwn();
  await flush();
  assert.equal(started.length, 1, 'nothing is gained by restarting a recogniser Chrome refuses');
  assert.match(label.textContent, /hold/i);
  assert.match(h.host.getViewElements().voiceError.textContent, /padlock/i,
    'the message names the padlock menu rather than saying something went wrong');
});

test('sliding off the button ends the hold like a release', async () => {
  const { h, button } = await heldPanel();
  started[0].say('send this', true);
  button.dispatch('pointerleave', { isTrusted: true });
  started[0].endOnItsOwn();
  await flush();
  assert.equal(turns(h).length, 1);
});

test('a recogniser that never reports the end does not swallow the turn', async () => {
  // stop() normally finalises the last words and fires 'end', which is what
  // delivers. If it does not -- and it sometimes does not -- the turn must not
  // be lost with the button stuck on TALKING.
  const timers = [];
  const { h, button, label } = await heldPanel({
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutFn: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
  });
  started[0].say('do not lose this', true);
  button.dispatch('pointerup', { isTrusted: true });
  assert.equal(started[0].stopped, true);
  assert.equal(turns(h).length, 0, 'nothing sent yet: the recogniser has not reported the end');

  const safety = timers.filter((t) => t.fn && t.ms === 1500).pop();
  assert.ok(safety, 'a bounded wait was armed rather than trusting the event');
  safety.fn();
  await flush();

  const posts = turns(h);
  assert.equal(posts.length, 1, 'the turn is delivered anyway');
  assert.equal(JSON.parse(posts[0].body).utterance, 'do not lose this');
  assert.doesNotMatch(label.textContent, /talking/i, 'and the button is not stuck');
});

test('the release is keyed on the hold, not on whichever recogniser is live', () => {
  // liveRecognizer is briefly null while restarting. Keying the release off it
  // sent the turn down the recorder path -- the chain that never worked.
  const end = SOURCE.slice(SOURCE.indexOf('function endHoldToTalk'), SOURCE.indexOf('function finishVoiceRecording'));
  assert.match(end, /if \(liveHolding\) \{ liveVoiceStop\(\); return; \}/);
});

// ---- the spoken reply --------------------------------------------------------

test('a turn asked for out loud is answered out loud', async () => {
  const { h, button } = await heldPanel();
  started[0].say('what needs attention', true);
  button.dispatch('pointerup', { isTrusted: true });
  started[0].endOnItsOwn();
  await flush();
  await flush();
  assert.match(h.documentRef.byId.rnaVoiceLabel.textContent, /hold|stop|wait/i);

  const start = SOURCE.slice(SOURCE.indexOf('function liveDeliver'), SOURCE.indexOf('function liveMakeRecognizer'));
  assert.match(start, /spokenReplyPending = true;/,
    'the delivered turn records that its answer is owed out loud');
  assert.ok(start.indexOf('spokenReplyPending = true;') < start.indexOf('submitTyped('),
    'before the turn is sent, not after the answer arrives');
});

test('playback is unlocked while the press is still trusted', () => {
  // Chrome permits delayed audio only through a player started during the
  // gesture. Unlock anywhere else and the reply is fetched, decoded, and then
  // refused at play() -- silence, with no error anyone can see.
  const hold = SOURCE.slice(SOURCE.indexOf('function beginHoldToTalk'), SOURCE.indexOf('function endHoldToTalk'));
  assert.match(hold, /unlockSpeechFromGesture\(\);/);
  assert.ok(hold.indexOf('unlockSpeechFromGesture();') < hold.indexOf('liveVoiceStart()'),
    'before anything asynchronous can happen');
  assert.match(hold, /stopSpeaking\(\);/, 'and pressing STOP actually stops her');
});

test('every way a turn can end hands the button back', () => {
  const rendered = SOURCE.slice(SOURCE.indexOf('function renderTypedView'), SOURCE.indexOf('function submitTyped'));
  assert.match(rendered, /finishSpokenTurn\(rendered\.answer\);/, 'the answer is what gets spoken');
  assert.equal((rendered.match(/abandonSpokenTurn\(\);/g) || []).length, 5,
    'answered, two malformed replies, an error, and an expired session');
});

test('Reina can speak even when the recognition chain fails to load', () => {
  // Playback needs a fetch, an Audio element and a token. It used to be built
  // halfway through installing the five-module recognition chain, so a chain
  // that failed to load also cost her the ability to speak.
  assert.match(SOURCE, /function ensureVoiceSynthesis\(\) \{/);
  const install = SOURCE.slice(SOURCE.indexOf('function installVoice'), SOURCE.indexOf('function renderTypedView'));
  assert.match(install, /var neuralSynthesis = ensureVoiceSynthesis\(\);/,
    'the voice host shares the one speaker rather than owning it');
});

test('the browser recogniser is preferred over the record-and-upload chain', () => {
  const chain = SOURCE.slice(SOURCE.indexOf('recognitionFactory:'), SOURCE.indexOf('windowRef: null'));
  assert.match(chain, /browserRecognitionFactory/,
    'the middle term whose absence is why a browser never transcribed anything');
  const hold = SOURCE.slice(SOURCE.indexOf('function beginHoldToTalk'), SOURCE.indexOf('function endHoldToTalk'));
  assert.ok(hold.indexOf('liveVoiceStart()') < hold.indexOf('enableVoiceFromGesture'),
    'and it is reached for strictly before the upload chain');
  assert.match(hold, /enableVoiceFromGesture/, 'which still exists for browsers without a recogniser');
});

// ---- the speaking pace -------------------------------------------------------
// One control, three files: the <option> values people choose from, the
// whitelist that restores the saved choice, and the range the player will
// actually honour. Any two of them disagreeing leaves a control on screen that
// silently does nothing -- which is what "the option to speed up her voice is
// gone" turned out to mean.

const INDEX = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const SPEECH = fs.readFileSync(new URL('../public/reina-neural-speech.js', import.meta.url), 'utf8');

function markupRates() {
  const select = /<select id="rnaVoiceRate">([\s\S]*?)<\/select>/.exec(INDEX);
  assert.ok(select, 'the speaking-pace control is still in the panel');
  return [...select[1].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
}

test('the pace choices on screen are exactly the ones the host accepts', () => {
  assert.deepEqual(markupRates(), [...VOICE_RATES]);
});

test('every pace on screen is one the player will actually honour', async () => {
  const { MIN_RATE, MAX_RATE } = (await import('../public/reina-neural-speech.js')).default;
  for (const value of markupRates()) {
    const rate = Number(value);
    assert.ok(rate >= MIN_RATE && rate <= MAX_RATE,
      `${value} is outside the player's range and would silently fall back to 0.96`);
  }
  assert.match(SPEECH, /rate >= MIN_RATE && rate <= MAX_RATE/,
    'the clamp reads the shared bounds rather than repeating numbers');
});

test('the fastest pace is actually fast', () => {
  // It was 1.06. Six percent is not a speed control, and a control that does
  // nothing perceptible is indistinguishable from one that is missing.
  const fastest = Math.max(...markupRates().map(Number));
  assert.ok(fastest >= 1.3, `fastest pace is ${fastest}, which nobody can hear as faster`);
  const slowest = Math.min(...markupRates().map(Number));
  assert.ok(slowest <= 0.9, `slowest pace is ${slowest}`);
});

test('the saved pace is restored from the same list it was chosen from', () => {
  assert.match(SOURCE, /storedSetting\(VOICE_RATE_STORAGE_KEY, '0\.96', VOICE_RATES\)/,
    'a whitelist written out by hand is how the saved choice silently stopped restoring');
  assert.match(SOURCE, /return VOICE_RATES\.indexOf\(value\) >= 0 \? Number\(value\) : 0\.96;/);
});

test('the settings panel still holds the pace control and the gear still opens it', () => {
  assert.match(INDEX, /<label class="rnaDeviceField" for="rnaVoiceRate">Speaking pace/);
  assert.match(INDEX, /id="rnaSettings"[^>]*aria-label="Voice settings"/);
  assert.match(SOURCE, /bindOwnedClick\(popupSettings, function \(\) \{/);
});
