import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

import {
  SESSION, HASH, reviewFields, TextOnlyDocument, bootstrap, envelope, httpResponse,
  confirmedReview, deferred, makeVoiceModules, makeHarness, flush,
  HostModule, PilotClient, LoginBrief, TypedPanel, UiIntentRouter,
  createReinaInAppVoiceHost, createCanonicalVoiceTransport,
  createReinaPilotHost, installReinaPilotPage, resolveElements,
  createNativeRecognitionFactory, NATIVE_VOICE_MESSAGES, FIXED_ERRORS,
} from './helpers/reina-pilot-harness.mjs';

test('real client/login/typed modules bind the existing purple panel and render only text', async () => {
  const h = makeHarness();
  assert.equal(h.page.fab.style.display, 'none');
  assert.equal(h.page.panel.classList.contains('open'), false);
  assert.equal(h.page.input.disabled, true);
  const mounted = await h.host.mount();
  assert.equal(mounted.ok, true);
  assert.equal(mounted.sessionId, SESSION);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, 'GET');
  assert.equal(h.calls[0].headers.Authorization, 'Bearer verified-test-bearer');

  assert.equal(h.page.fab.style.display, 'flex');
  assert.equal(h.page.panel.classList.contains('open'), false);
  assert.equal(h.page.input.disabled, false);
  assert.equal(h.page.send.disabled, false);
  assert.equal(h.page.mode.textContent, 'reina · read only');
  assert.equal(h.page.feed.textContent, '', 'the compact popup starts with no briefing or status clutter');
  assert.match(h.host.getViewElements().greeting.textContent, /Hello, Chris\./,
    'verified briefing data remains available to the state machine without being displayed');
  assert.equal(h.host.getState().reviewAvailable, true);
  assert.equal(typeof h.page.fab.onclick, 'function');
  assert.equal(typeof h.page.close.onclick, 'function');
  assert.equal(typeof h.page.send.onclick, 'function');
  assert.equal(h.page.input.attributes['data-hl-voice-input'], 'off');

  const hostile = '<script>alert(1)</script> ![x](javascript:alert(2)) &lt;svg onload=alert(3)&gt;';
  assert.equal(h.host.submitTyped(hostile).accepted, true);
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(JSON.parse(h.calls[1].body).utterance, hostile);
  assert.match(h.page.feed.textContent, /<script>alert\(1\)<\/script>/);
  assert.match(h.page.feed.textContent, /This is a deterministic synthetic preview answer/);
  assert.doesNotMatch(h.page.feed.textContent, /Evidence:|Nothing was executed|READ-ONLY PREVIEW|Voice is off/);
  assert.equal(h.page.feed.scrollTop, 1000000, 'the latest exchange is kept visible');
  assert.ok(h.documentRef.created.every((node) => node.innerWrites === 0));
  assert.equal(h.host.getState().reviewAvailable, false, 'a new typed turn revokes the bootstrap review intent');
  assert.equal(h.host.getState().voiceEnabled, false);
  assert.equal(h.host.getState().executed, false);
});

test('all-unavailable canonical counts fail closed instead of becoming a zero-item greeting', async () => {
  const unavailable = bootstrap('Chris');
  unavailable.attention = {
    total: null,
    categories: [
      { key: 'jobs', label: 'Jobs', count: null, available: false, asOf: null, evidence: [] },
      { key: 'mail', label: 'Important email', count: null, available: false, asOf: null, evidence: [] },
    ],
    unavailableSources: ['Jobs', 'Important email'],
    asOf: null,
    reviewAvailable: true,
  };
  const h = makeHarness({ bootstrapBody: unavailable });
  const result = await h.host.mount();
  assert.deepEqual(result, { ok: false, reason: 'bootstrap_failed' });
  assert.equal(h.page.fab.style.display, 'flex');
  assert.equal(h.page.panel.classList.contains('open'), false);
  assert.equal(h.page.input.disabled, true);
  assert.doesNotMatch(h.page.feed.textContent, /nothing needs attention|no attention items/i);
  assert.equal(h.documentRef.byId.standup.style.display, 'none');
});

test('one trusted review click maps PR87 through PR88 exactly once', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  const reviewButton = h.host.getViewElements().reviewButton;
  reviewButton.dispatch('click', { isTrusted: false });
  await flush();
  assert.equal(h.state.navigationCalls, 0);
  reviewButton.dispatch('click', { isTrusted: true });
  await flush();
  assert.deepEqual(h.state.confirmationRequests, [{ action: 'confirm_review', intentId: reviewFields().review.intentId }]);
  assert.equal(h.state.navigationCalls, 1);
  assert.equal(h.documentRef.byId.standup.style.display, 'block');
  assert.equal(h.host.getState().reviewAvailable, false);
  assert.equal(h.host.getState().executed, false);
  reviewButton.dispatch('click', { isTrusted: true });
  await flush();
  assert.equal(h.state.navigationCalls, 1, 'the consumed server intent cannot navigate twice');
  assert.equal(h.state.confirmationRequests.length, 1);
});

test('silent server revocation at confirmation expires auth and never reaches the local router', async () => {
  const h = makeHarness({ confirmReview: async () => httpResponse(403, { error: 'authorization_expired' }) });
  assert.equal((await h.host.mount()).ok, true);

  h.host.getViewElements().reviewButton.dispatch('click', { isTrusted: true });
  await flush();

  assert.equal(h.state.confirmationRequests.length, 1);
  assert.equal(h.state.navigationCalls, 0);
  assert.equal(h.documentRef.byId.standup.style.display, 'none');
  assert.equal(h.host.getState().state, 'auth_expired');
  assert.equal(h.host.getState().executed, false);
  assert.equal(h.authExpiredCount(), 1);
});

test('two tabs race one server intent and only the atomic winner can navigate', async () => {
  let consumed = false;
  const outcomes = [];
  const confirmReview = async (request) => {
    if (consumed) {
      outcomes.push({ status: 409, intentId: request.intentId });
      return httpResponse(409, { error: 'confirmation_duplicate' });
    }
    consumed = true;
    const body = confirmedReview(request.intentId);
    outcomes.push({ status: 200, body });
    return httpResponse(200, body);
  };
  const first = makeHarness({ confirmReview });
  const second = makeHarness({ confirmReview });
  assert.equal((await first.host.mount()).ok, true);
  assert.equal((await second.host.mount()).ok, true);

  first.host.getViewElements().reviewButton.dispatch('click', { isTrusted: true });
  second.host.getViewElements().reviewButton.dispatch('click', { isTrusted: true });
  await flush();

  assert.equal(first.state.confirmationRequests.length + second.state.confirmationRequests.length, 2);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), [200, 409]);
  assert.equal(outcomes.find((outcome) => outcome.status === 200).body.executed, false);
  assert.equal(first.state.navigationCalls + second.state.navigationCalls, 1);
  assert.equal(first.host.getState().executed, false);
  assert.equal(second.host.getState().executed, false);
  assert.equal(first.calls.filter((call) => JSON.parse(call.body || '{}').utterance).length, 0);
  assert.equal(second.calls.filter((call) => JSON.parse(call.body || '{}').utterance).length, 0);
});

test('strict PR88 result mapper rejects malformed and mismatched confirmation results', async () => {
  for (const result of [
    { executed: true, intentId: 'rui.wrong', kind: 'navigate', destination: 'standup', source: 'button' },
    { executed: false, reason: 'navigation_failed' },
    true,
  ]) {
    const h = makeHarness();
    const host = createReinaPilotHost({
      documentRef: h.documentRef,
      elements: h.page,
      createClient: ({ onAuthExpired }) => PilotClient.createReinaPilotClient({
        fetchFn: async (_url, init) => {
          if (init.method === 'GET') return httpResponse(200, bootstrap());
          const request = JSON.parse(init.body);
          return request.action === 'confirm_review'
            ? httpResponse(200, confirmedReview(request.intentId))
            : httpResponse(503, {});
        },
        getAccessToken: async () => 'verified-test-bearer',
        hashFn: async () => HASH,
        validateBootstrap: LoginBrief.validateBootstrap,
        onAuthExpired,
      }),
      createLoginBrief: LoginBrief.createLoginBrief,
      createTypedPanel: TypedPanel.createTypedPanel,
      createIntentRouter: () => ({
        propose: () => ({ accepted: true }),
        confirm: () => Promise.resolve(result),
        revoke: () => ({ revoked: true }),
        dispose: () => ({ disposed: true }),
      }),
      loadVoiceModules: () => Promise.resolve(makeVoiceModules(h.state)),
      showView: () => {},
      go: () => { h.state.navigationCalls += 1; },
      newId: () => 'turn-fixed',
    });
    assert.equal((await host.mount()).ok, true);
    host.getViewElements().reviewButton.dispatch('click', { isTrusted: true });
    await flush();
    assert.equal(h.state.navigationCalls, 0);
    assert.equal(h.documentRef.byId.standup.style.display, 'none');
    host.dispose();
  }
});

test('auth/session replacement during confirmation revokes the pending navigation', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  const button = h.host.getViewElements().reviewButton;
  button.dispatch('click', { isTrusted: true });
  const reset = h.host.resetSession();
  await flush();
  assert.equal(h.state.navigationCalls, 0);
  assert.equal(h.documentRef.byId.standup.style.display, 'none');
  assert.equal((await reset).ok, true);
});

test('Voice requires a trusted enable gesture and confirms the same server intent once', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const view = h.host.getViewElements();
  assert.ok(h.state.voiceControl);
  assert.deepEqual(await h.state.voiceControl.final('yes', 'disabled-final'), { decision: 'reject' });
  assert.equal(h.state.navigationCalls, 0);
  view.voiceStart.dispatch('click', { isTrusted: false });
  assert.equal(h.state.voiceControl.starts, 0);
  assert.deepEqual(await h.state.voiceControl.final('yes', 'untrusted-final'), { decision: 'reject' });
  view.voiceStart.dispatch('click', { isTrusted: true });
  assert.equal(h.state.voiceControl.starts, 1);
  // A trusted "yes" is consumed by the governed review-confirmation seam;
  // it is deliberately not sent as a free-form conversational turn.
  assert.deepEqual(await h.state.voiceControl.final('Hey Reina, yes', 'trusted-final'), { decision: 'reject' });
  await flush();
  assert.equal(h.state.navigationCalls, 1);
  assert.equal((await h.state.voiceControl.final('yes', 'duplicate-final')).decision, 'reject');
  await flush();
  assert.equal(h.state.navigationCalls, 1);
});

test('hands-free Voice requires the wake phrase and submits only the words after Hey Reina', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const view = h.host.getViewElements();
  view.voiceStart.dispatch('click', { isTrusted: true });
  assert.equal(h.host.getState().handsFreeEnabled, true);
  assert.match(view.voiceStatus.textContent, /Say “Hey Reina”/);

  assert.deepEqual(await h.state.voiceControl.final('What needs attention?', 'no-wake'), { decision: 'reject' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.calls.filter((call) => call.method === 'POST' && !call.url.includes('reina-voice-diagnostic')).length, 0);
  assert.ok(h.state.voiceControl.starts >= 2, 'a non-wake transcript re-arms listening without submission');

  const result = await h.state.voiceControl.final('Hey Reina, what needs attention?', 'wake-question');
  assert.equal(result.decision, 'accept');
  const post = h.calls.find((call) => call.method === 'POST' && !call.url.includes('reina-voice-diagnostic'));
  assert.equal(JSON.parse(post.body).utterance, 'what needs attention?');
});

test('a bare Hey Reina becomes a normal greeting turn instead of silently timing out', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  h.host.getViewElements().voiceStart.dispatch('click', { isTrusted: true });
  const result = await h.state.voiceControl.final('Hey Reina', 'wake-only');
  assert.equal(result.decision, 'accept');
  const post = h.calls.find((call) => call.method === 'POST' && !call.url.includes('reina-voice-diagnostic'));
  assert.equal(JSON.parse(post.body).utterance, 'Hi Reina');
});

test('a prior browser microphone grant never starts listening without a fresh purple-tab gesture', async () => {
  const h = makeHarness({ canAutoStartVoice: async () => true });
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  assert.equal(h.host.getState().handsFreeEnabled, false);
  assert.equal(h.host.getState().voiceEnabled, false);
  assert.equal(h.documentRef.byId.rnaVoice.attributes['aria-pressed'], 'false');
  assert.equal(h.state.voiceControl.starts, 0);
  assert.match(h.host.getViewElements().voiceStatus.textContent, /Voice is off/);
});

test('a signed-in Reina briefing opens with a clean conversation surface', async () => {
  const h = makeHarness();
  h.documentRef.byId.rnaFeed.scrollTop = 900;
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  assert.equal(h.documentRef.byId.rnaFeed.scrollTop, 0);
  assert.equal(h.page.feed.textContent, '');
  assert.match(h.host.getViewElements().greeting.textContent, /Hello, Chris\./);
});

test('the purple Reina tab opens the Lab-style popup and accepts one direct spoken command', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const toggle = h.documentRef.byId.rnaVoice;
  assert.equal(toggle.disabled, false, 'the popup Voice control becomes available after Voice mounts');
  h.page.fab.dispatch('click', { isTrusted: true });
  assert.equal(h.page.panel.classList.contains('open'), true);
  assert.equal(h.host.getState().handsFreeEnabled, false);
  assert.equal(h.host.getState().voiceEnabled, true);
  assert.equal(toggle.attributes['aria-pressed'], 'true');
  assert.match(h.host.getViewElements().voiceStatus.textContent, /listening/i);

  const accepted = await h.state.voiceControl.final('What needs attention?', 'purple-direct-question');
  assert.equal(accepted.decision, 'accept');
  assert.equal(h.host.getState().voiceEnabled, true, 'Voice remains authorized while Reina prepares and speaks the reply');
  assert.equal(h.page.panel.classList.contains('open'), true);
  const post = h.calls.find((call) => call.method === 'POST' && !call.url.includes('reina-voice-diagnostic'));
  assert.equal(JSON.parse(post.body).utterance, 'What needs attention?');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.state.voiceControl.starts, 1, 'push-to-talk must not silently re-arm the microphone');
  h.state.voiceControl.options.render.status('idle');
  assert.equal(h.host.getState().voiceEnabled, false, 'push-to-talk returns to Off only after reply playback settles');
});

test('a visible header indicator lights up while Reina is actually listening, and only then', async () => {
  // Chris asked for a visible sign the mic is hot -- the underlying
  // listening/thinking/speaking state already existed (it drove
  // view.voiceStatus's text), it just never reached anything rendered on
  // screen. This is the first test asserting an on-screen (not just
  // detached-node) consequence of that state.
  //
  // render.status('listening') is driven directly (same pattern this file
  // already uses for 'idle' below) rather than via the fab click alone: the
  // click sets an OPTIMISTIC "I'm listening." string immediately (reina-pilot-
  // host.js's own restartDirectListeningFromGesture), independent of whether
  // the mic has actually opened yet. The indicator is deliberately wired to
  // the REAL state-machine signal instead, so it does not light up before the
  // microphone has genuinely started capturing -- the mock voice host used in
  // this test suite does not simulate that real signal on its own.
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const indicator = h.documentRef.byId.rnaVoice;
  assert.equal(indicator.classList.contains('listening'), false, 'must not be lit before voice ever starts');

  h.page.fab.dispatch('click', { isTrusted: true });
  assert.match(h.host.getViewElements().voiceStatus.textContent, /listening/i, 'sanity: the optimistic text is showing');
  assert.equal(indicator.classList.contains('listening'), false,
    'must NOT light up merely because the button was clicked -- only once the mic is actually confirmed open');

  h.state.voiceControl.options.render.status('listening');
  assert.equal(indicator.classList.contains('listening'), true, 'must light up once the real state machine reports listening');

  h.state.voiceControl.options.render.status('thinking');
  assert.equal(indicator.classList.contains('listening'), false, 'must turn off for any non-listening state, not just idle');

  h.state.voiceControl.options.render.status('listening');
  assert.equal(indicator.classList.contains('listening'), true);
  h.state.voiceControl.options.render.status('idle');
  assert.equal(indicator.classList.contains('listening'), false);
});

test('emergency voice-off force-clears the listening indicator even mid-listen', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  h.page.fab.dispatch('click', { isTrusted: true });
  h.state.voiceControl.options.render.status('listening');
  assert.equal(h.documentRef.byId.rnaVoice.classList.contains('listening'), true, 'sanity: lit before the emergency stop');

  h.host.getViewElements().voiceOff.dispatch('click', { isTrusted: true });
  assert.equal(h.documentRef.byId.rnaVoice.classList.contains('listening'), false,
    'emergency OFF must not leave the indicator stuck on regardless of whether render.status(\'idle\') ever fires');
});

test('a stale listening event arriving after Voice is toggled off does not relight the indicator', async () => {
  // Found live (2026-08-17, Chris): stopVoice() clears the indicator
  // synchronously via renderTopVoiceToggle(false), then calls
  // voiceHost.interrupt()/.stop() asynchronously. An already-in-flight
  // recognition attempt -- e.g. getUserMedia still resolving from just before
  // the toggle-off -- can still report 'listening' AFTER voice was switched
  // off, with nothing left to clear it a second time. The visible symptom was
  // worse than a cosmetic glitch: the indicator claimed a live session was
  // running while nothing was actually being recorded, so speaking did
  // nothing and looked exactly like "the mic isn't picking me up."
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const button = h.documentRef.byId.rnaVoice;

  button.dispatch('pointerdown', { isTrusted: true });
  assert.equal(h.host.getState().voiceEnabled, true, 'sanity: holding opens the microphone');
  h.state.voiceControl.options.render.status('listening');
  assert.equal(button.classList.contains('listening'), true, 'sanity: lit while genuinely recording');

  // Releasing ends the recording, and voice goes off with it.
  button.dispatch('pointerup', { isTrusted: true });
  h.host.getState().voiceEnabled === true && h.state.voiceControl.options.render.status('idle');
  const indicator = button;

  h.state.voiceControl.options.render.status('listening');
  assert.equal(indicator.classList.contains('listening'), false,
    'a stale listening event arriving after voice was turned off must not relight the indicator');
});

test('the purple Reina tab starts a second spoken turn without closing the popup', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  h.page.fab.dispatch('click', { isTrusted: true });
  assert.equal(h.state.voiceControl.starts, 1);
  assert.equal((await h.state.voiceControl.final('What needs attention?', 'first-direct-question')).decision, 'accept');

  const interruptsBefore = h.state.voiceControl.interrupts;
  h.page.fab.dispatch('click', { isTrusted: true });
  await flush();

  assert.equal(h.page.panel.classList.contains('open'), true);
  assert.equal(h.state.voiceControl.interrupts, interruptsBefore + 1);
  assert.equal(h.state.voiceControl.starts, 2);
  assert.equal(h.host.getState().voiceEnabled, true);
  assert.equal(h.host.getState().handsFreeEnabled, false);
  assert.match(h.host.getViewElements().voiceStatus.textContent, /listening/i);
});

test('Lab-style popup Settings and Stop Talking controls remain available inside Reina', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const settings = h.documentRef.byId.rnaSettings;
  const settingsPanel = h.documentRef.byId.rnaSettingsPanel;
  settings.dispatch('click', { isTrusted: true });
  assert.equal(settingsPanel.classList.contains('open'), true);
  assert.equal(settings.attributes['aria-expanded'], 'true');
  assert.ok(h.documentRef.byId.rnaAudioInput);
  assert.ok(h.documentRef.byId.rnaAudioOutput);
  assert.ok(h.documentRef.byId.rnaRefreshAudioDevices);
  assert.equal(typeof h.state.controlledRecognitionOptions.getAudioConstraints, 'function');
  settings.dispatch('click', { isTrusted: true });
  assert.equal(settingsPanel.classList.contains('open'), false);

  // Stopping Reina is no longer a separate button that read as though it
  // stopped the SPEAKER. The one voice control says "Stop Reina" only while
  // she is speaking, and then that is exactly what it does.
  h.page.fab.dispatch('click', { isTrusted: true });
  h.state.voiceControl.options.render.status('speaking');
  const voice = h.documentRef.byId.rnaVoice;
  assert.match(h.documentRef.byId.rnaVoiceLabel.textContent, /stop/i,
    'the face of the button must say what pressing it will do');
  assert.match(h.documentRef.byId.rnaVoiceHint.textContent, /stop her/i,
    'and the hint under it spells it out');
  const before = h.state.voiceControl.interrupts;
  voice.dispatch('pointerdown', { isTrusted: true });
  assert.equal(h.state.voiceControl.interrupts, before + 1,
    'pressing it while she is speaking stops her, rather than recording over her');
  assert.match(h.host.getViewElements().voiceStatus.textContent, /stopped speaking/i);
});

test('Reina closes the popup 20 seconds after her spoken response finishes and activity resets the timer', async () => {
  const timers = [];
  const h = makeHarness({
    setTimeoutFn(callback, milliseconds) {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timers.length;
    },
    clearTimeoutFn(id) {
      if (timers[id - 1]) timers[id - 1].cleared = true;
    },
  });
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  h.page.fab.dispatch('click', { isTrusted: true });
  assert.equal(h.page.panel.classList.contains('open'), true);
  assert.equal((await h.state.voiceControl.final('What needs attention?', 'auto-close-question')).decision, 'accept');
  h.state.voiceControl.options.render.status('idle');

  assert.equal(timers.length, 1);
  assert.equal(timers[0].milliseconds, 20000);
  h.page.panel.dispatch('pointerdown', { target: h.page.input });
  assert.equal(timers[0].cleared, true, 'continued interaction cancels the old countdown');
  assert.equal(timers.length, 2);
  assert.equal(timers[1].milliseconds, 20000);

  timers[1].callback();
  assert.equal(h.page.panel.classList.contains('open'), false);
  assert.equal(h.page.panel.attributes['aria-hidden'], 'true');
});

test('Settings closes when the user touches elsewhere or scrolls', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const settings = h.documentRef.byId.rnaSettings;
  const settingsPanel = h.documentRef.byId.rnaSettingsPanel;
  const outside = h.documentRef.createElement('div');

  settings.dispatch('click', { isTrusted: true });
  assert.equal(settingsPanel.classList.contains('open'), true);
  h.documentRef.dispatch('pointerdown', { target: outside });
  assert.equal(settingsPanel.classList.contains('open'), false);
  assert.equal(settings.attributes['aria-expanded'], 'false');

  settings.dispatch('click', { isTrusted: true });
  h.documentRef.dispatch('touchstart', { target: outside });
  assert.equal(settingsPanel.classList.contains('open'), false);

  settings.dispatch('click', { isTrusted: true });
  h.documentRef.dispatch('wheel', { target: outside });
  assert.equal(settingsPanel.classList.contains('open'), false);

  settings.dispatch('click', { isTrusted: true });
  h.page.feed.dispatch('scroll', { target: h.page.feed });
  assert.equal(settingsPanel.classList.contains('open'), false);
});

test('hands-free re-arms only for local no-speech and timeout failures', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  h.host.getViewElements().voiceStart.dispatch('click', { isTrusted: true });
  const beforeNoSpeech = h.state.voiceControl.starts;
  h.state.voiceControl.fail('no_speech');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(h.state.voiceControl.starts > beforeNoSpeech);

  const beforeNetwork = h.state.voiceControl.starts;
  h.state.voiceControl.fail('network');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(h.state.voiceControl.starts, beforeNetwork);
});

test('an actionable Voice failure leaves the purple panel open and typed chat usable', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  h.page.fab.dispatch('click');
  const view = h.host.getViewElements();
  view.voiceStart.dispatch('click', { isTrusted: true });
  assert.equal(h.host.getState().voiceEnabled, true);
  assert.equal(h.host.getState().state, 'ready');
  h.state.voiceControl.fail('network');
  assert.equal(h.host.getState().state, 'ready');
  assert.equal(h.page.panel.classList.contains('open'), true);
  assert.equal(h.page.fab.style.display, 'flex');
  assert.equal(h.page.input.disabled, false);
  assert.match(view.voiceError.textContent, /Chrome could not reach its speech service/);
  assert.equal(h.host.submitTyped('What jobs need attention?').accepted, true);
});

test('a failed one-shot Voice turn closes after 20 seconds instead of remaining stuck open', async () => {
  const timers = [];
  const h = makeHarness({
    setTimeoutFn(callback, milliseconds) {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timers.length;
    },
    clearTimeoutFn(id) {
      if (timers[id - 1]) timers[id - 1].cleared = true;
    },
  });
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  h.page.fab.dispatch('click', { isTrusted: true });
  assert.equal(h.host.getState().voiceEnabled, true);
  h.state.voiceControl.fail('network');

  assert.equal(h.page.panel.classList.contains('open'), true, 'the error remains visible during the grace period');
  assert.equal(h.host.getState().voiceEnabled, false);
  const closeTimer = timers.find((timer) => timer.milliseconds === 20000 && !timer.cleared);
  assert.ok(closeTimer, 'the failed turn schedules the same bounded close timer');
  closeTimer.callback();
  assert.equal(h.page.panel.classList.contains('open'), false);
  assert.equal(h.page.panel.attributes['aria-hidden'], 'true');
});

test('Voice surfaces unavailable and unknown internal errors instead of a generic fallback', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  const view = h.host.getViewElements();
  h.state.voiceControl.fail('unavailable');
  assert.match(view.voiceError.textContent, /Voice recording could not start in this browser/);
  h.state.voiceControl.fail('recognition_start_failed');
  assert.match(view.voiceError.textContent, /error_recognition_start_failed/);
  assert.equal(h.page.panel.classList.contains('open'), false);
  assert.equal(h.page.input.disabled, false);
});

test('Voice host never receives a browser speech fallback', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  assert.equal(h.state.voiceControl.options.windowRef, null);
  assert.equal(typeof h.state.voiceControl.options.recognitionFactory, 'function');
});

test('a compound verbal yes is a normal server turn and never navigation authority', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  h.host.getViewElements().voiceStart.dispatch('click', { isTrusted: true });
  const result = await h.state.voiceControl.final('Hey Reina, yes, and delete everything', 'hostile-final');
  assert.equal(result.decision, 'accept');
  assert.equal(h.state.navigationCalls, 0);
  assert.equal(h.host.getState().reviewAvailable, false);
  const post = h.calls.find((call) => call.method === 'POST' && !call.url.includes('reina-voice-diagnostic'));
  const request = JSON.parse(post.body);
  assert.equal(request.utterance, 'yes, and delete everything');
  assert.equal(request.conversationId, SESSION);
  assert.equal(request.transport, 'voice');
  assert.deepEqual(Object.keys(request).sort(), [
    'conversationId', 'idempotencyKey', 'transport', 'turnId', 'utterance',
  ]);
});

test('emergency OFF clears Voice consent and dominates later final transcripts', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const view = h.host.getViewElements();
  view.voiceStart.dispatch('click', { isTrusted: true });
  assert.equal(h.host.getState().voiceEnabled, true);
  view.voiceOff.dispatch('click', { isTrusted: false });
  assert.equal(h.state.voiceControl.offs, 1);
  assert.equal(h.host.getState().voiceEnabled, false);
  assert.deepEqual(await h.state.voiceControl.final('yes', 'after-off'), { decision: 'reject' });
  assert.equal(h.state.navigationCalls, 0);
  view.voiceStart.dispatch('click', { isTrusted: true });
  assert.equal(h.state.voiceControl.starts, 1, 'emergency OFF prevents microphone restart');
});

test('Stop Voice finishes the current recording without interrupting it', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const view = h.host.getViewElements();
  view.voiceStart.dispatch('click', { isTrusted: true });
  view.voiceStop.dispatch('click', { isTrusted: true });
  assert.equal(h.state.voiceControl.stops, 1);
  assert.equal(h.state.voiceControl.interrupts, 0);
  assert.match(view.voiceStatus.textContent, /Finishing recording/);
});

test('real Voice stack stays microphone-dormant for typed input until one trusted enable gesture', async () => {
  const recognizers = [];
  const recognitionFactory = () => {
    const recognizer = {
      starts: 0, stops: 0, aborts: 0,
      onstart: null, onresult: null, onerror: null, onend: null,
      start() { this.starts += 1; if (this.onstart) this.onstart({}); },
      stop() { this.stops += 1; },
      abort() { this.aborts += 1; },
    };
    recognizers.push(recognizer);
    return recognizer;
  };
  const h = makeHarness({
    loadVoiceModules: () => Promise.resolve({
      createVoiceHost: (options) => createReinaInAppVoiceHost({ ...options, recognitionFactory }),
      createVoiceTransport: createCanonicalVoiceTransport,
      createControlledRecognitionFactory: () => recognitionFactory,
    }),
  });
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  assert.equal(recognizers.length, 0, 'mount is dormant');

  assert.equal(h.host.submitTyped('What needs attention?').accepted, true);
  await flush();
  assert.equal(recognizers.length, 0, 'typed-before-enable must not call Voice interrupt/start');

  h.host.getViewElements().voiceStart.dispatch('click', { isTrusted: false });
  await flush();
  assert.equal(recognizers.length, 0, 'an untrusted event cannot mint Voice consent');
  h.host.getViewElements().voiceStart.dispatch('click', { isTrusted: true });
  await flush();
  assert.equal(recognizers.length, 1);
  assert.equal(recognizers[0].starts, 1, 'the explicit gesture starts recognition exactly once');
  assert.equal(h.host.getState().voiceEnabled, true, 'the asynchronous real Voice start enables the session');

  h.host.emergencyVoiceOff();
  assert.equal(h.host.getState().voiceEnabled, false);
  assert.equal(h.host.submitTyped('What is the synthetic status?').accepted, true);
  await flush();
  await flush();
  assert.equal(recognizers.length, 1, 'typed input after emergency OFF cannot restart Voice');
  const posts = h.calls
    .filter((call) => call.method === 'POST' && !call.url.includes('reina-voice-diagnostic'))
    .map((call) => JSON.parse(call.body));
  assert.equal(posts.length, 1, 'the first typed turn used the canonical route');
  assert.equal(posts.every((request) => request.conversationId === SESSION && request.transport === 'typed'), true);
});

test('Desktop native recognition adapts a safe transcript and retains a precise OS microphone failure', async () => {
  const issues = [];
  const native = {
    recognizeOnce: async () => ({ ok: true, transcript: 'What needs attention?' }),
    cancelRecognition: async () => ({ ok: true }),
  };
  const factory = createNativeRecognitionFactory(native, (code) => issues.push(code));
  assert.equal(typeof factory, 'function');
  const recognizer = factory();
  const events = [];
  recognizer.onstart = () => events.push('start');
  recognizer.onresult = (event) => events.push(event.results[0][0].transcript);
  recognizer.onend = () => events.push('end');
  recognizer.start();
  await flush();
  await flush();
  assert.deepEqual(events, ['start', 'What needs attention?', 'end']);
  assert.deepEqual(issues, []);

  const failures = [];
  const deniedFactory = createNativeRecognitionFactory({
    recognizeOnce: async () => ({ ok: false, code: 'os_microphone_denied' }),
    cancelRecognition: async () => ({ ok: true }),
  }, (code) => failures.push(code));
  const denied = deniedFactory();
  const errors = [];
  denied.onerror = (event) => errors.push(event.error);
  denied.start();
  await flush();
  await flush();
  assert.deepEqual(errors, ['not-allowed']);
  assert.deepEqual(failures, ['os_microphone_denied']);
  assert.match(NATIVE_VOICE_MESSAGES.os_microphone_denied, /Windows denied microphone access/i);
});

test('Desktop native wake recognition waits for Hey Reina and forwards one request through the shared Voice result shape', async () => {
  let wakeListener = null;
  let startCalls = 0;
  let stopCalls = 0;
  let woke = 0;
  const issues = [];
  const factory = HostModule.createNativeWakeRecognitionFactory({
    onWakeDetected: (listener) => {
      wakeListener = listener;
      return () => { wakeListener = null; };
    },
    startWakeWord: async () => {
      startCalls += 1;
      return { ok: true, transcript: 'What needs attention?' };
    },
    stopWakeWord: async () => { stopCalls += 1; return { ok: true }; },
  }, () => { woke += 1; }, (code) => issues.push(code));
  assert.equal(typeof factory, 'function');
  const recognizer = factory();
  const events = [];
  recognizer.onstart = () => events.push('start');
  recognizer.onresult = (event) => events.push(event.results[0][0].transcript);
  recognizer.onend = () => events.push('end');
  recognizer.start();
  assert.equal(typeof wakeListener, 'function');
  wakeListener();
  await flush();
  await flush();
  assert.equal(startCalls, 1);
  assert.equal(woke, 1);
  assert.deepEqual(events, ['start', 'Hey Reina What needs attention?', 'end']);
  assert.deepEqual(issues, []);
  recognizer.stop();
  await flush();
  assert.equal(stopCalls, 0, 'completed wake turns must not issue a stale cancellation');
});

test('owned panel and send handlers avoid the page dead-button path and submit once', async () => {
  const h = makeHarness();
  await h.host.mount();
  h.page.fab.dispatch('click');
  assert.equal(h.page.panel.classList.contains('open'), true);
  h.page.fab.dispatch('click');
  assert.equal(h.page.panel.classList.contains('open'), true, 'the Lab launcher opens and never acts as a hidden close toggle');
  h.documentRef.byId.rnaMin.dispatch('click');
  assert.equal(h.page.panel.classList.contains('open'), false);
  h.page.fab.dispatch('click');
  h.page.close.dispatch('click');
  assert.equal(h.page.panel.classList.contains('open'), false);
  h.page.fab.dispatch('click');
  h.page.input.value = 'What needs attention?';
  h.page.send.dispatch('click');
  await flush();
  assert.equal(h.calls.filter((call) => call.method === 'POST' && !call.url.includes('reina-voice-diagnostic')).length, 1);
});

test('503 failure exposes only same-turn Retry and never appends a second user message', async () => {
  const h = makeHarness();
  await h.host.mount();
  h.state.postStatus = 503;
  assert.equal(h.host.submitTyped('Retry this exact read-only turn').accepted, true);
  await flush();
  assert.equal(h.host.getState().state, 'turn_error');
  assert.equal(h.page.input.disabled, true);
  assert.equal(h.page.send.disabled, false);
  // 2026-08-13 bug fix: the button used to show the literal word "Retry",
  // which overflowed its fixed 40px circular box (built for a single glyph
  // like the idle "➤") and visually spilled past it. A matching short glyph
  // keeps the circle's size consistent in both states; the title carries the
  // "Retry" label instead.
  assert.equal(h.page.send.textContent, '↻');
  assert.equal(h.page.send.title, 'Retry');
  const first = JSON.parse(h.calls.filter((call) => call.method === 'POST' && !call.url.includes('reina-voice-diagnostic'))[0].body);

  h.state.postStatus = 200;
  h.page.send.dispatch('click');
  assert.equal(h.page.input.disabled, true);
  assert.equal(h.page.send.disabled, true);
  assert.equal(h.page.send.textContent, '↻');
  await flush();

  const posts = h.calls.filter((call) => call.method === 'POST' && !call.url.includes('reina-voice-diagnostic')).map((call) => JSON.parse(call.body));
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1], first);
  assert.equal(h.page.feed.textContent.split('You: ').length - 1, 1);
  assert.equal(h.page.send.textContent, 'Send');
  assert.equal(h.page.send.title, '', 'the "Retry" tooltip must clear once the turn recovers');
  assert.equal(h.page.input.disabled, false);
  assert.equal(h.page.send.disabled, false);
  assert.match(h.page.feed.textContent, /deterministic synthetic preview answer/);
});

test('primitive-only submit validation never invokes wrapper accessors', async () => {
  const h = makeHarness();
  await h.host.mount();
  let accessed = 0;
  const hostile = new Proxy({}, { get() { accessed += 1; throw new Error('SECRET_ACCESSOR'); } });
  assert.deepEqual(h.host.submitTyped(hostile), { accepted: false, reason: 'invalid_input' });
  assert.equal(accessed, 0);
  assert.doesNotMatch(h.page.feed.textContent, /SECRET_ACCESSOR/);
  assert.equal(h.host.getState().state, 'ready');
  assert.equal(h.page.input.disabled, false);
  assert.equal(h.page.send.disabled, false);
  assert.equal(h.page.send.textContent, 'Send');
});

test('authorization expiry clears principal content, keeps the purple button available, and emits a fixed error', async () => {
  const h = makeHarness();
  await h.host.mount();
  h.state.postStatus = 403;
  assert.equal(h.host.submitTyped('A private question that must be cleared').accepted, true);
  await flush();
  assert.equal(h.host.getState().state, 'auth_expired');
  assert.equal(h.page.fab.style.display, 'flex');
  assert.equal(h.page.panel.classList.contains('open'), false);
  assert.equal(h.page.input.disabled, true);
  assert.doesNotMatch(h.page.feed.textContent, /private question|SECRET_SERVER_MARKER|Chris/i);
  assert.match(h.page.feed.textContent, new RegExp(FIXED_ERRORS.auth_expired.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(h.authExpiredCount(), 1);
});

test('session reset clears the previous principal and performs a fresh server bootstrap', async () => {
  const h = makeHarness({ displayName: 'Chris' });
  await h.host.mount();
  assert.match(h.host.getViewElements().greeting.textContent, /Chris/);
  h.state.displayName = 'Jovie';
  assert.deepEqual(await h.host.resetSession(), { ok: true, sessionId: SESSION });
  assert.match(h.host.getViewElements().greeting.textContent, /Jovie/);
  assert.equal(h.page.feed.textContent, '');
  assert.equal(h.calls.filter((call) => call.method === 'GET').length, 2);
});

test('duplicate mount while loading shares one bootstrap and one terminal promise', async () => {
  const bootstrapGate = deferred();
  const h = makeHarness({ bootstrapGates: [bootstrapGate] });
  const first = h.host.mount();
  const second = h.host.mount();
  assert.equal(second, first);
  await flush();
  assert.equal(h.calls.filter((call) => call.method === 'GET').length, 1);
  assert.equal(h.host.getState().state, 'loading');

  bootstrapGate.resolve();
  assert.deepEqual(await first, { ok: true, sessionId: SESSION });
  assert.equal(h.host.getState().state, 'ready');
  assert.equal(h.page.feed.textContent, '');
  assert.match(h.host.getViewElements().greeting.textContent, /Hello, Chris\./);
});

test('reset during bootstrap settles the old mount as superseded and only the replacement may render', async () => {
  const oldGate = deferred();
  const replacementGate = deferred();
  const h = makeHarness({ bootstrapGates: [oldGate, replacementGate] });
  const oldMount = h.host.mount();
  await flush();
  h.state.displayName = 'Replacement';
  const replacementMount = h.host.resetSession();
  assert.deepEqual(await oldMount, { ok: false, reason: 'superseded' });
  await flush();
  assert.equal(h.calls.filter((call) => call.method === 'GET').length, 2);

  oldGate.resolve();
  await flush();
  assert.doesNotMatch(h.host.getViewElements().greeting.textContent, /Chris/);
  replacementGate.resolve();
  assert.deepEqual(await replacementMount, { ok: true, sessionId: SESSION });
  assert.match(h.host.getViewElements().greeting.textContent, /Replacement/);
  assert.equal(h.page.feed.textContent, '');
});

test('bootstrap failures keep the purple button available and reveal no provider error detail', async () => {
  const h = makeHarness();
  h.state.tokenError = 'SYNTHETIC_SECRET_TOKEN_MARKER';
  const result = await h.host.mount();
  assert.equal(result.ok, false);
  assert.equal(h.page.fab.style.display, 'flex');
  assert.equal(h.page.panel.classList.contains('open'), false);
  assert.equal(h.page.input.disabled, true);
  h.page.fab.dispatch('click', { isTrusted: true });
  assert.equal(h.page.panel.classList.contains('open'), true);
  h.page.close.dispatch('click', { isTrusted: true });
  assert.equal(h.page.panel.classList.contains('open'), false);
  assert.doesNotMatch(h.page.feed.textContent, /SYNTHETIC_SECRET_TOKEN_MARKER/);
  assert.equal(h.calls.length, 0);
});

test('dispose synchronously clears and disables the existing panel', async () => {
  const h = makeHarness();
  await h.host.mount();
  assert.deepEqual(h.host.dispose(), { disposed: true, executed: false });
  assert.equal(h.page.fab.onclick, null);
  assert.equal(h.page.close.onclick, null);
  assert.equal(h.page.send.onclick, null);
  assert.equal(h.page.fab.style.display, 'none');
  assert.equal(h.page.panel.classList.contains('open'), false);
  assert.equal(h.page.feed.textContent, '');
  assert.equal(h.page.input.disabled, true);
  assert.deepEqual(await h.host.mount(), { ok: false, reason: 'disposed' });
});

test('dispose during bootstrap settles the mount and stale completion cannot mutate the cleared panel', async () => {
  const bootstrapGate = deferred();
  const h = makeHarness({ bootstrapGates: [bootstrapGate] });
  const mounting = h.host.mount();
  await flush();
  assert.equal(h.calls.filter((call) => call.method === 'GET').length, 1);
  assert.deepEqual(h.host.dispose(), { disposed: true, executed: false });
  assert.deepEqual(await mounting, { ok: false, reason: 'disposed' });
  bootstrapGate.resolve();
  await flush();
  assert.equal(h.host.getState().state, 'disposed');
  assert.equal(h.page.fab.style.display, 'none');
  assert.equal(h.page.feed.textContent, '');
});

test('page installer owns auth lifecycle without reading a token or profile', async () => {
  const documentRef = new TextOnlyDocument();
  let authCallback;
  let unsubscribed = 0;
  const calls = [];
  const hosts = [];
  const authClient = {
    auth: {
      getSession() { return Promise.resolve({ data: { session: { access_token: 'token-one' } } }); },
      onAuthStateChange(callback) {
        authCallback = callback;
        return { data: { subscription: { unsubscribe() { unsubscribed += 1; } } } };
      },
    },
  };
  const createHost = () => {
    const host = {
      mount() { calls.push('mount'); return Promise.resolve({ ok: true }); },
      resetSession() { calls.push('reset'); return Promise.resolve({ ok: true }); },
      dispose() { calls.push('dispose'); return { disposed: true }; },
    };
    hosts.push(host);
    return host;
  };
  const installation = installReinaPilotPage({ documentRef, authClient, createHost });
  assert.equal(installation.installed, true);
  assert.equal(typeof authCallback, 'function');
  authCallback('INITIAL_SESSION', { user: { id: 'principal-one' } });
  await flush();
  assert.deepEqual(calls, ['mount']);
  authCallback('TOKEN_REFRESHED', { user: { id: 'principal-one' } });
  await flush();
  assert.deepEqual(calls, ['mount']);
  authCallback('USER_UPDATED', { user: { id: 'principal-one' } });
  await flush();
  assert.deepEqual(calls, ['mount']);
  authCallback('SIGNED_IN', { user: { id: 'principal-two' } });
  await flush();
  assert.equal(hosts.length, 2);
  assert.deepEqual(calls, ['mount', 'dispose', 'mount']);
  authCallback('SIGNED_OUT', null);
  assert.deepEqual(calls, ['mount', 'dispose', 'mount', 'dispose']);
  assert.equal(documentRef.byId.rnaFab.style.display, 'none');
  assert.equal(documentRef.byId.rnaPanel.classList.contains('open'), false);
  authCallback('SIGNED_IN', { user: { id: 'principal-three' } });
  await flush();
  assert.equal(hosts.length, 3);
  assert.deepEqual(calls, ['mount', 'dispose', 'mount', 'dispose', 'mount']);
  assert.deepEqual(installation.stop(), { stopped: true, executed: false });
  assert.equal(unsubscribed, 1);
  assert.equal(calls.at(-1), 'dispose');
});

test('auth signout during bootstrap disposes the host and deterministically settles its mount', async () => {
  const bootstrapGate = deferred();
  const h = makeHarness({ bootstrapGates: [bootstrapGate] });
  let authCallback;
  let mounting;
  const authClient = {
    auth: {
      getSession() { return Promise.resolve({ data: { session: { access_token: 'token-one' } } }); },
      onAuthStateChange(callback) {
        authCallback = callback;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  };
  const installedHost = {
    mount() { mounting = h.host.mount(); return mounting; },
    dispose() { return h.host.dispose(); },
  };
  const installation = installReinaPilotPage({
    documentRef: h.documentRef,
    authClient,
    createHost: () => installedHost,
  });
  authCallback('INITIAL_SESSION', { user: { id: 'principal-one' } });
  await flush();
  assert.equal(h.calls.filter((call) => call.method === 'GET').length, 1);
  authCallback('SIGNED_OUT', null);
  assert.deepEqual(await mounting, { ok: false, reason: 'disposed' });
  bootstrapGate.resolve();
  await flush();
  assert.equal(h.page.fab.style.display, 'none');
  assert.equal(h.page.feed.textContent, '');
  installation.stop();
});

test('same-principal token refresh during a pending POST preserves one canonical turn', async () => {
  const postGate = deferred();
  const h = makeHarness({ postGates: [postGate] });
  let authCallback;
  const authClient = {
    auth: {
      getSession() { return Promise.resolve({ data: { session: { access_token: 'token-one' } } }); },
      onAuthStateChange(callback) {
        authCallback = callback;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  };
  const installation = installReinaPilotPage({
    documentRef: h.documentRef,
    authClient,
    createHost: () => h.host,
  });
  const session = { user: { id: 'principal-one' } };
  authCallback('INITIAL_SESSION', session);
  await flush();
  assert.equal(h.host.getState().state, 'ready');
  assert.equal(h.host.submitTyped('Keep this exact turn during token refresh').accepted, true);
  await flush();
  assert.equal(h.calls.filter((call) => call.method === 'POST' && !call.url.includes('reina-voice-diagnostic')).length, 1);

  authCallback('TOKEN_REFRESHED', { user: { id: 'principal-one' } });
  await flush();
  assert.equal(h.calls.filter((call) => call.method === 'GET').length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'POST' && !call.url.includes('reina-voice-diagnostic')).length, 1);
  assert.equal(h.host.getState().state, 'submitting');

  postGate.resolve();
  await flush();
  assert.equal(h.host.getState().state, 'ready');
  assert.equal(h.calls.filter((call) => call.method === 'POST' && !call.url.includes('reina-voice-diagnostic')).length, 1);
  assert.equal(h.page.feed.textContent.split('You: ').length - 1, 1);
  assert.match(h.page.feed.textContent, /deterministic synthetic preview answer/);
  installation.stop();
});

test('refresh during bootstrap waits for the old GET 403 before one recovery GET', async () => {
  const oldBootstrap = deferred();
  const recoveryBootstrap = deferred();
  const h = makeHarness({ bootstrapGates: [oldBootstrap, recoveryBootstrap] });
  let authCallback;
  const installation = installReinaPilotPage({
    documentRef: h.documentRef,
    authClient: {
      auth: {
        getSession() { return Promise.resolve({ data: { session: { access_token: 'token-one' } } }); },
        onAuthStateChange(callback) {
          authCallback = callback;
          return { data: { subscription: { unsubscribe() {} } } };
        },
      },
    },
    createHost: () => h.host,
  });
  const session = { user: { id: 'principal-one' } };
  authCallback('INITIAL_SESSION', session);
  await flush();
  assert.equal(h.host.getState().state, 'loading');
  assert.equal(h.calls.filter((call) => call.method === 'GET').length, 1);

  authCallback('TOKEN_REFRESHED', session);
  await flush();
  assert.equal(h.calls.filter((call) => call.method === 'GET').length, 1);
  h.state.bootstrapStatus = 403;
  oldBootstrap.resolve();
  await flush();
  await flush();
  assert.equal(h.calls.filter((call) => call.method === 'GET').length, 2);
  assert.equal(h.host.getState().state, 'loading');

  h.state.bootstrapStatus = 200;
  recoveryBootstrap.resolve();
  await flush();
  assert.equal(h.calls.filter((call) => call.method === 'GET').length, 2);
  assert.equal(h.host.getState().state, 'ready');
  installation.stop();
});

test('refresh followed by the old pending POST 403 reboots without retrying the semantic turn', async () => {
  const postGate = deferred();
  const h = makeHarness({ postGates: [postGate] });
  let authCallback;
  const installation = installReinaPilotPage({
    documentRef: h.documentRef,
    authClient: {
      auth: {
        getSession() { return Promise.resolve({ data: { session: { access_token: 'token-one' } } }); },
        onAuthStateChange(callback) {
          authCallback = callback;
          return { data: { subscription: { unsubscribe() {} } } };
        },
      },
    },
    createHost: () => h.host,
  });
  const session = { user: { id: 'principal-one' } };
  authCallback('INITIAL_SESSION', session);
  await flush();
  h.state.postStatus = 403;
  assert.equal(h.host.submitTyped('One old-token turn only').accepted, true);
  await flush();
  assert.equal(h.calls.filter((call) => call.method === 'POST' && !call.url.includes('reina-voice-diagnostic')).length, 1);

  authCallback('TOKEN_REFRESHED', session);
  postGate.resolve();
  await flush();
  await flush();

  assert.equal(h.calls.filter((call) => call.method === 'POST' && !call.url.includes('reina-voice-diagnostic')).length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'GET').length, 2);
  assert.equal(h.host.getState().state, 'ready');
  assert.equal(h.page.input.disabled, false);
  assert.doesNotMatch(h.page.feed.textContent, /One old-token turn only/);
  installation.stop();
});

test('same-principal refresh recovers a terminal unavailable or expired bootstrap', async () => {
  for (const initialStatus of [503, 403]) {
    const h = makeHarness();
    h.state.bootstrapStatus = initialStatus;
    let authCallback;
    const installation = installReinaPilotPage({
      documentRef: h.documentRef,
      authClient: {
        auth: {
          getSession() { return Promise.resolve({ data: { session: { access_token: 'token-one' } } }); },
          onAuthStateChange(callback) {
            authCallback = callback;
            return { data: { subscription: { unsubscribe() {} } } };
          },
        },
      },
      createHost: () => h.host,
    });
    const principalSession = { user: { id: 'principal-one' } };
    authCallback('INITIAL_SESSION', principalSession);
    await flush();
    assert.ok(['unavailable', 'auth_expired'].includes(h.host.getState().state));
    assert.equal(h.calls.filter((call) => call.method === 'GET').length, 1);

    h.state.bootstrapStatus = 200;
    authCallback('TOKEN_REFRESHED', principalSession);
    await flush();
    assert.equal(h.host.getState().state, 'ready');
    assert.equal(h.calls.filter((call) => call.method === 'GET').length, 2);
    installation.stop();
  }
});

test('recognized auth events with missing, malformed, accessor, or Proxy principals fail closed', async () => {
  let getterCalls = 0;
  const accessorSession = {};
  Object.defineProperty(accessorSession, 'user', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('SECRET_SESSION_GETTER'); },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const hostileSessions = [
    {},
    { user: {} },
    { user: { id: 42 } },
    accessorSession,
    new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('SECRET_SESSION_PROXY'); } }),
    { user: revoked.proxy },
  ];

  for (const hostileSession of hostileSessions) {
    const documentRef = new TextOnlyDocument();
    let authCallback;
    let mounts = 0;
    let disposals = 0;
    const authClient = {
      auth: {
        getSession() { return Promise.resolve({ data: { session: { access_token: 'token-one' } } }); },
        onAuthStateChange(callback) {
          authCallback = callback;
          return { data: { subscription: { unsubscribe() {} } } };
        },
      },
    };
    const installation = installReinaPilotPage({
      documentRef,
      authClient,
      createHost: () => ({
        mount() { mounts += 1; return Promise.resolve({ ok: true }); },
        dispose() { disposals += 1; return { disposed: true }; },
      }),
    });
    authCallback('INITIAL_SESSION', { user: { id: 'principal-one' } });
    await flush();
    assert.equal(mounts, 1);
    authCallback('TOKEN_REFRESHED', hostileSession);
    assert.equal(disposals, 1);
    assert.equal(documentRef.byId.rnaFab.style.display, 'none');
    authCallback('SIGNED_IN', hostileSession);
    await flush();
    assert.equal(mounts, 1, 'a malformed principal must not activate a replacement host');
    installation.stop();
  }
  assert.equal(getterCalls, 0);
});

test('host pins legitimate module factories before later global reassignment', async () => {
  const source = fs.readFileSync(new URL('../public/reina-pilot-host.js', import.meta.url), 'utf8');
  const documentRef = new TextOnlyDocument();
  const calls = { legitimateClient: 0, forgedClient: 0, forgedLogin: 0, forgedTyped: 0 };
  const context = {
    ReinaPilotClient: {
      createReinaPilotClient() {
        calls.legitimateClient += 1;
        return {
          bootstrap: async () => ({ sessionId: SESSION, bootstrap: bootstrap('Trusted User') }),
          submitTurn: async () => { throw new Error('unused'); },
          confirmReviewIntent: async (intentId) => ({ ok: true, intentId, executed: false }),
        };
      },
    },
    ReinaLoginBrief: { createLoginBrief: LoginBrief.createLoginBrief },
    ReinaTypedPanel: { createTypedPanel: TypedPanel.createTypedPanel },
    ReinaUiIntentRouter: { createUiIntentRouter: UiIntentRouter.createUiIntentRouter },
    showView() {},
    go(destination) { documentRef.byId.standup.style.display = destination === 'standup' ? 'block' : 'none'; },
  };
  vm.runInNewContext(source, context, { filename: 'reina-pilot-host.js' });
  context.ReinaPilotClient = {
    createReinaPilotClient() {
      calls.forgedClient += 1;
      return {
        bootstrap: async () => ({ sessionId: SESSION, bootstrap: bootstrap('Forged User') }),
        submitTurn: async () => { throw new Error('unused'); },
        confirmReviewIntent: async (intentId) => ({ ok: true, intentId, executed: false }),
      };
    },
  };
  context.ReinaLoginBrief = { createLoginBrief() { calls.forgedLogin += 1; throw new Error('forged'); } };
  context.ReinaTypedPanel = { createTypedPanel() { calls.forgedTyped += 1; throw new Error('forged'); } };

  const host = context.ReinaPilotHost.createReinaPilotHost({
    documentRef,
    elements: context.ReinaPilotHost.resolveElements(documentRef),
    newId: () => 'turn-pinned',
  });
  const mounted = await host.mount();
  assert.equal(mounted.ok, true);
  assert.equal(mounted.sessionId, SESSION);
  assert.equal(calls.legitimateClient, 1);
  assert.equal(calls.forgedClient, 0);
  assert.equal(calls.forgedLogin, 0);
  assert.equal(calls.forgedTyped, 0);
  assert.match(host.getViewElements().greeting.textContent, /Trusted User/);
  assert.equal(documentRef.byId.rnaFeed.textContent, '');
});

test('actual client and host ignore late fetch and bootstrap-validator substitution', async () => {
  const loginSource = fs.readFileSync(new URL('../public/reina-login-brief-controller.js', import.meta.url), 'utf8');
  const clientSource = fs.readFileSync(new URL('../public/reina-pilot-client.js', import.meta.url), 'utf8');
  const typedSource = fs.readFileSync(new URL('../public/reina-typed-panel-controller.js', import.meta.url), 'utf8');
  const routerSource = fs.readFileSync(new URL('../public/reina-ui-intent-router.js', import.meta.url), 'utf8');
  const hostSource = fs.readFileSync(new URL('../public/reina-pilot-host.js', import.meta.url), 'utf8');
  const documentRef = new TextOnlyDocument();
  let trustedFetches = 0;
  let forgedFetches = 0;
  let forgedValidators = 0;
  const trustedBootstrap = bootstrap('Server Verified Chris');
  const context = {
    fetch: async (_url, init) => {
      trustedFetches += 1;
      assert.equal(init.headers.Authorization, 'Bearer verified-session-token');
      return { ok: true, status: 200, text: async () => JSON.stringify(trustedBootstrap) };
    },
    sb: {
      auth: {
        getSession: async () => ({ data: { session: { access_token: 'verified-session-token' } } }),
      },
    },
    setTimeout,
    clearTimeout,
    AbortController,
    showView() {},
    go(destination) { documentRef.byId.standup.style.display = destination === 'standup' ? 'block' : 'none'; },
  };
  vm.runInNewContext(loginSource, context, { filename: 'reina-login-brief-controller.js' });
  vm.runInNewContext(clientSource, context, { filename: 'reina-pilot-client.js' });
  vm.runInNewContext(typedSource, context, { filename: 'reina-typed-panel-controller.js' });
  vm.runInNewContext(routerSource, context, { filename: 'reina-ui-intent-router.js' });
  vm.runInNewContext(hostSource, context, { filename: 'reina-pilot-host.js' });
  const hostApi = context.ReinaPilotHost;

  context.fetch = async () => {
    forgedFetches += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify(bootstrap('FORGED NETWORK')) };
  };
  context.ReinaLoginBrief = {
    validateBootstrap(value) {
      forgedValidators += 1;
      value.user.displayName = 'FORGED LATE GLOBAL';
      return { ok: true };
    },
    createLoginBrief() { throw new Error('forged factory'); },
  };

  const host = hostApi.createReinaPilotHost({
    documentRef,
    elements: hostApi.resolveElements(documentRef),
    newId: () => 'turn-pinned-integration',
  });
  const mounted = await host.mount();
  assert.equal(mounted.ok, true);
  assert.equal(mounted.sessionId, SESSION);
  assert.equal(trustedFetches, 1);
  assert.equal(forgedFetches, 0);
  assert.equal(forgedValidators, 0);
  assert.match(host.getViewElements().greeting.textContent, /Server Verified Chris/);
  assert.equal(documentRef.byId.rnaFeed.textContent, '');
});

test('actual installer binds token reads to the installed principal across late sb replacement and refresh', async () => {
  const loginSource = fs.readFileSync(new URL('../public/reina-login-brief-controller.js', import.meta.url), 'utf8');
  const clientSource = fs.readFileSync(new URL('../public/reina-pilot-client.js', import.meta.url), 'utf8');
  const typedSource = fs.readFileSync(new URL('../public/reina-typed-panel-controller.js', import.meta.url), 'utf8');
  const routerSource = fs.readFileSync(new URL('../public/reina-ui-intent-router.js', import.meta.url), 'utf8');
  const hostSource = fs.readFileSync(new URL('../public/reina-pilot-host.js', import.meta.url), 'utf8');
  const documentRef = new TextOnlyDocument();
  let authCallback;
  let tokenReadsA = 0;
  let tokenReadsB = 0;
  let currentSession = { access_token: 'token-A', user: { id: 'principal-A' } };
  const seenAuthorization = [];
  const authClientA = {
    auth: {
      getSession() { tokenReadsA += 1; return Promise.resolve({ data: { session: currentSession } }); },
      onAuthStateChange(callback) {
        authCallback = callback;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  };
  const authClientB = {
    auth: {
      getSession() { tokenReadsB += 1; return Promise.resolve({ data: { session: { access_token: 'token-B', user: { id: 'principal-B' } } } }); },
      onAuthStateChange() { throw new Error('forged auth client must stay unused'); },
    },
  };
  const context = {
    fetch: async (_url, init) => {
      seenAuthorization.push(init.headers.Authorization);
      if (init.method === 'GET') return httpResponse(200, bootstrap('Genuine Principal A'));
      const request = JSON.parse(init.body);
      const env = envelope('Same-principal refreshed answer.');
      return httpResponse(200, {
        ok: true, enabled: true, stored: true,
        conversationId: request.conversationId, turnId: request.turnId,
        idempotencyKey: request.idempotencyKey, replayed: false,
        executed: false, nothingExecuted: true, businessActionAllowed: false,
        automationTaskAllowed: false, toolExecutionAllowed: false,
        synthetic: true, dataAccess: 'synthetic', reviewAvailable: false,
        envelope: env, plainText: PilotClient.renderPlainText(env), navigation: null,
      });
    },
    sb: authClientA,
    setTimeout,
    clearTimeout,
    AbortController,
    crypto: webcrypto,
    TextEncoder,
    showView() {},
    go(destination) { documentRef.byId.standup.style.display = destination === 'standup' ? 'block' : 'none'; },
  };
  vm.runInNewContext(loginSource, context, { filename: 'reina-login-brief-controller.js' });
  vm.runInNewContext(clientSource, context, { filename: 'reina-pilot-client.js' });
  vm.runInNewContext(typedSource, context, { filename: 'reina-typed-panel-controller.js' });
  vm.runInNewContext(routerSource, context, { filename: 'reina-ui-intent-router.js' });
  vm.runInNewContext(hostSource, context, { filename: 'reina-pilot-host.js' });

  const installation = context.ReinaPilotHost.installReinaPilotPage({ documentRef, authClient: authClientA });
  assert.equal(installation.installed, true);
  context.sb = authClientB;
  authCallback('INITIAL_SESSION', { user: { id: 'principal-A' } });
  await flush();
  await flush();
  assert.equal(installation.getHost().getState().state, 'ready');
  assert.equal(seenAuthorization[0], 'Bearer token-A');
  assert.match(installation.getHost().getViewElements().greeting.textContent, /Genuine Principal A/);
  assert.equal(documentRef.byId.rnaFeed.textContent, '');

  currentSession = { access_token: 'token-A-refreshed', user: { id: 'principal-A' } };
  authCallback('TOKEN_REFRESHED', { user: { id: 'principal-A' } });
  assert.equal(installation.getHost().submitTyped('Use the refreshed same-principal session').accepted, true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(seenAuthorization[1], 'Bearer token-A-refreshed');
  assert.equal(installation.getHost().getState().state, 'ready');

  const callsBeforeMismatch = seenAuthorization.length;
  currentSession = { access_token: 'token-B', user: { id: 'principal-B' } };
  assert.equal(installation.getHost().submitTyped('This must not cross principals').accepted, true);
  for (let attempt = 0; attempt < 20 && installation.getHost().getState().state === 'submitting'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(seenAuthorization.length, callsBeforeMismatch);
  assert.equal(installation.getHost().getState().state, 'auth_expired');
  assert.equal(tokenReadsA, 3);
  assert.equal(tokenReadsB, 0);
  installation.stop();
});

test('installed token source rejects a session missing its owner before any network call', async () => {
  const loginSource = fs.readFileSync(new URL('../public/reina-login-brief-controller.js', import.meta.url), 'utf8');
  const clientSource = fs.readFileSync(new URL('../public/reina-pilot-client.js', import.meta.url), 'utf8');
  const typedSource = fs.readFileSync(new URL('../public/reina-typed-panel-controller.js', import.meta.url), 'utf8');
  const routerSource = fs.readFileSync(new URL('../public/reina-ui-intent-router.js', import.meta.url), 'utf8');
  const hostSource = fs.readFileSync(new URL('../public/reina-pilot-host.js', import.meta.url), 'utf8');
  const documentRef = new TextOnlyDocument();
  let authCallback;
  let fetches = 0;
  const authClient = {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'ownerless-token' } } }),
      onAuthStateChange(callback) { authCallback = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    },
  };
  const context = {
    fetch: async () => { fetches += 1; throw new Error('network must not run'); },
    sb: authClient,
    setTimeout,
    clearTimeout,
    AbortController,
    showView() {},
    go(destination) { documentRef.byId.standup.style.display = destination === 'standup' ? 'block' : 'none'; },
  };
  vm.runInNewContext(loginSource, context);
  vm.runInNewContext(clientSource, context);
  vm.runInNewContext(typedSource, context);
  vm.runInNewContext(routerSource, context);
  vm.runInNewContext(hostSource, context);
  const installation = context.ReinaPilotHost.installReinaPilotPage({ documentRef, authClient });
  assert.equal(installation.installed, true);
  authCallback('INITIAL_SESSION', { user: { id: 'principal-A' } });
  await flush();
  await flush();
  assert.equal(fetches, 0);
  assert.equal(installation.getHost().getState().state, 'auth_expired');
  assert.equal(documentRef.byId.rnaFab.style.display, 'flex');
  assert.equal(documentRef.byId.rnaPanel.classList.contains('open'), false);
  installation.stop();
});

test('resolver requires every exact existing panel ID and source has no unsafe legacy call site', () => {
  const documentRef = new TextOnlyDocument();
  assert.ok(resolveElements(documentRef));
  delete documentRef.byId.rnaSend;
  assert.equal(resolveElements(documentRef), null);

  const source = fs.readFileSync(new URL('../public/reina-pilot-host.js', import.meta.url), 'utf8');
  for (const forbidden of [
    '/api/chat', 'marked.parse', 'inner' + 'HTML', 'insertAdjacent' + 'HTML',
    'getUserMedia',
    'location.assign', 'location.href', 'window.open',
  ]) assert.equal(source.includes(forbidden), false, `forbidden host call site: ${forbidden}`);
  assert.match(source, /ReinaPilotClient/);
  assert.match(source, /ReinaLoginBrief/);
  assert.match(source, /ReinaTypedPanel/);
  assert.match(source, /ReinaUiIntentRouter/);
  assert.match(source, /reina-inapp-voice-host\.js/);
  assert.match(source, /trustedGesture/);
  assert.match(source, /createElement/);
  assert.match(source, /textContent/);
  assert.match(source, /onAuthStateChange/);
});

test('clearing the Voice error surface renders nothing and is not treated as a failure', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  h.page.fab.dispatch('click', { isTrusted: true });
  const view = h.host.getViewElements();
  assert.equal(h.host.getState().voiceEnabled, true);

  h.state.voiceControl.clear();

  // The panel clears this surface every time it mounts or resets. Rendering
  // the generic failure text there put "Voice could not complete that turn"
  // in the feed of a conversation that had never run one -- and switched the
  // one-shot Voice turn off with it.
  assert.equal(view.voiceError.textContent, '');
  assert.equal(h.host.getState().voiceEnabled, true);
  assert.equal(h.page.panel.classList.contains('open'), true);
});

test('a spoken turn that fails after recording says what happened', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const view = h.host.getViewElements();

  h.state.voiceControl.fail('turn_failed');
  assert.match(view.voiceError.textContent, /could not answer that spoken turn/);
  h.state.voiceControl.fail('turn_timeout');
  assert.match(view.voiceError.textContent, /did not answer that spoken turn in time/);
  h.state.voiceControl.fail('turn_empty_reply');
  assert.match(view.voiceError.textContent, /returned no answer for that spoken turn/);
  assert.equal(h.page.input.disabled, false);
});

test('a spoken turn that fails on expired authentication expires the session', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  h.state.voiceControl.fail('auth_expired');
  // Expiry is not a voice problem: the panel hands the whole session to the
  // re-authentication path rather than leaving a voice error in the feed.
  assert.equal(h.host.getState().state, 'auth_expired');
  assert.equal(h.host.getViewElements().voiceError.textContent, '');
});

test('the real Voice stack mounts with a clean feed and names a failed spoken turn', async () => {
  const recognizers = [];
  const recognitionFactory = () => {
    const recognizer = {
      onstart: null, onresult: null, onerror: null, onend: null,
      start() { if (this.onstart) this.onstart({}); },
      stop() {},
      abort() {},
    };
    recognizers.push(recognizer);
    return recognizer;
  };
  const h = makeHarness({
    loadVoiceModules: () => Promise.resolve({
      createVoiceHost: (options) => createReinaInAppVoiceHost({ ...options, recognitionFactory }),
      createVoiceTransport: createCanonicalVoiceTransport,
      createControlledRecognitionFactory: () => recognitionFactory,
    }),
  });
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const view = h.host.getViewElements();
  // Mounting the panel clears its error surface. Nothing has failed yet, so
  // the conversation feed must not carry a Voice failure.
  assert.equal(view.voiceError.textContent, '');

  h.state.postStatus = 500; // the route stops answering
  view.voiceStart.dispatch('click', { isTrusted: true });
  await flush();
  await flush();
  assert.equal(recognizers.length, 1);
  assert.equal(h.host.getState().voiceEnabled, true);
  recognizers[0].onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: 'Hey Reina, what needs attention?' }, length: 1, isFinal: true }],
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.match(view.voiceError.textContent, /could not answer that spoken turn/);
  assert.equal(h.page.input.disabled, false, 'typed Reina stays usable');
});

test('a recording transcription could not read blames transcription, not the microphone', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const view = h.host.getViewElements();

  h.state.voiceControl.fail('transcription_no_speech');
  assert.match(view.voiceError.textContent, /I recorded you, but transcription returned no words/);
  assert.doesNotMatch(view.voiceError.textContent, /Enable Hands-free/);
});

test('a transcription that never answers says so instead of leaving an empty panel', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const view = h.host.getViewElements();
  h.state.voiceControl.fail('transcription_timeout');
  assert.match(view.voiceError.textContent, /transcription never answered/);
});

test('a microphone that records only noise points at the input, not at the speaker', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const view = h.host.getViewElements();
  h.state.voiceControl.fail('input_too_quiet');
  assert.match(view.voiceError.textContent, /recorded almost no sound/);
  assert.match(view.voiceError.textContent, /pick a different microphone/);
  // Never "try again" -- repeating the take cannot change the input level.
  assert.doesNotMatch(view.voiceError.textContent, /try again/i);
});

test('microphone capture is configured for dictation, and an alias device is a preference not a demand', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const constraintsFor = (value) => {
    h.documentRef.byId.rnaAudioInput.value = value;
    return h.state.controlledRecognitionOptions.getAudioConstraints().audio;
  };

  // The exact trio that ran from 2026-08-04 to 2026-08-16, the period voice
  // worked. Turning autoGainControl off (#325) dropped capture to the noise
  // floor the same day; this pins the known-good configuration so a theory
  // cannot quietly replace it again.
  const audio = constraintsFor('');
  assert.equal(audio.echoCancellation, true);
  assert.equal(audio.noiseSuppression, true);
  assert.equal(audio.autoGainControl, true);
  assert.equal('deviceId' in audio, false, 'no selection pins no device');

  // Every selection is demanded exactly, aliases included. Asking for one as a
  // preference let the browser open a different microphone entirely -- observed
  // live: "Default - Headset" selected, webcam microphone opened.
  assert.deepEqual(constraintsFor('default').deviceId, { exact: 'default' });
  assert.deepEqual(constraintsFor('communications').deviceId, { exact: 'communications' });
  assert.deepEqual(constraintsFor('486c95289f862067c2358c').deviceId, { exact: '486c95289f862067c2358c' });
});


test('voice refusing to start reports its cause, stripped to the enumerable part', async () => {
  const h = makeHarness({ loadVoiceModules: () => Promise.resolve({}) });
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  await flush();

  // A refusal to open the microphone was the last failure with no record
  // anywhere but a console. It now posts like every other voice failure.
  const reports = h.calls
    .filter((call) => call.method === 'POST' && call.url.includes('reina-voice-diagnostic'))
    .map((call) => JSON.parse(call.body));
  assert.ok(reports.length > 0, 'the refusal reached the diagnostic route');
  assert.equal(reports[0].stage, 'startup');
  assert.match(reports[0].code, /^[a-z0-9_-]+$/);

  // Reasons carry a free-form tail (voice_host_threw:<message>); only the code
  // may be stored, so a row can never hold an arbitrary string.
  assert.equal(reports.every((r) => !r.code.includes(':')), true);
  assert.equal(String(HostModule.lastVoiceBlock()).split(':')[0], reports[0].code);
});

// The device <select> is populated by refreshAudioDevices(), which runs when
// the Settings panel is opened and when its refresh button is pressed --
// nowhere else. The chosen device is persisted to localStorage, but the
// constraint builder read the DOM. So on any page load where Settings was not
// opened, the element had no value, no deviceId constraint was sent at all,
// and the browser opened its own default. Observed live, four times: a user
// with a headset selected had their webcam microphone opened, and every
// diagnostic row named the webcam.
test('a microphone saved in Settings is demanded even when Settings was never opened', async () => {
  const store = new Map([['hivelogic-reina-audio-input-v1', '486c95289f862067c2358c']]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
  };
  try {
    const h = makeHarness();
    assert.equal((await h.host.mount()).ok, true);
    await flush();

    // Exactly the real situation: the panel mounted, Settings was never opened,
    // so the <select> holds nothing.
    assert.equal(h.documentRef.byId.rnaAudioInput.value || '', '');

    const audio = h.state.controlledRecognitionOptions.getAudioConstraints().audio;
    assert.deepEqual(audio.deviceId, { exact: '486c95289f862067c2358c' },
      'the saved choice is the choice, rendered UI or not');
    // And the capture trio is untouched by the fallback.
    assert.equal(audio.echoCancellation, true);
    assert.equal(audio.noiseSuppression, true);
    assert.equal(audio.autoGainControl, true);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});

test('with nothing saved and nothing selected, no device is pinned', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  try {
    const h = makeHarness();
    assert.equal((await h.host.mount()).ok, true);
    await flush();
    const audio = h.state.controlledRecognitionOptions.getAudioConstraints().audio;
    assert.equal('deviceId' in audio, false,
      'the fallback must not invent a device when the user has never chosen one');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});

test('an explicit selection still wins over the saved value', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  globalThis.localStorage = { getItem: () => 'saved-device-id', setItem: () => {} };
  try {
    const h = makeHarness();
    assert.equal((await h.host.mount()).ok, true);
    await flush();
    h.documentRef.byId.rnaAudioInput.value = 'just-picked-in-the-ui';
    const audio = h.state.controlledRecognitionOptions.getAudioConstraints().audio;
    assert.deepEqual(audio.deviceId, { exact: 'just-picked-in-the-ui' },
      'the fallback is a fallback, not an override');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});

// For a month every voice attempt in a browser landed on the record-and-upload
// fallback, and not one of them produced a usable transcript: peaks from 1 to
// 128 across four microphones, every attempt answered by an empty string on an
// HTTP 200. The cause was not audio. "Native" in this file has always meant
// CAPTURED_NATIVE_RECOGNITION -- the Electron desktop bridge on
// window.hivelogicDesktop -- which does not exist in a browser, so both native
// factories resolved null on every load. Meanwhile the browser's own
// SpeechRecognition was read off the window at startup and used nowhere, while
// Chrome transcribed the same speaker on the same microphone with no upload at
// all.
test('a browser with speech recognition does not fall through to record-and-upload', () => {
  const source = fs.readFileSync(new URL('../public/reina-pilot-host.js', import.meta.url), 'utf8');
  assert.match(source, /createCapturedBrowserRecognitionFactory/,
    'the browser recognizer needs a factory of its own');
  const chain = source.slice(source.indexOf('recognitionFactory:'), source.indexOf('recognitionFactory:') + 320);
  assert.match(chain, /browserRecognitionFactory/,
    'and it must appear in the chain the voice host is handed');
  assert.ok(
    chain.indexOf('browserRecognitionFactory') < chain.indexOf('controlledRecognitionFactory'),
    'ahead of the recorder, or a browser still never reaches it',
  );
});

test('the captured browser recognizer is what the factory constructs', () => {
  const source = fs.readFileSync(new URL('../public/reina-pilot-host.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function createCapturedBrowserRecognitionFactory'));
  const end = body.indexOf('\n  }\n');
  const fn = body.slice(0, end);
  assert.match(fn, /CAPTURED_SPEECH_RECOGNITION/,
    'it must build from the captured constructor, not read the window again later');
  assert.match(fn, /if \(!CAPTURED_SPEECH_RECOGNITION\) return null;/,
    'and stay null where the browser has none, so the recorder still runs');
});

// Press and hold to talk, release to send -- the same walkie-talkie model as
// the Chirp button. It replaced a click-toggle whose label described a mode
// ("Voice On/Off") rather than an action, alongside a separate "Stop talking"
// button that stopped REINA and not the speaker. Holding removes the whole
// class of confusion: there is no mode to be in, because the microphone is
// open for exactly as long as a finger is down.
test('holding the button records, and releasing it sends', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const button = h.documentRef.byId.rnaVoice;
  const label = h.documentRef.byId.rnaVoiceLabel;
  assert.match(label.textContent, /hold/i, 'it says what to do before anything happens');
  assert.match(h.documentRef.byId.rnaVoiceHint.textContent, /release to send/i);

  button.dispatch('pointerdown', { isTrusted: true });
  assert.equal(h.host.getState().voiceEnabled, true, 'pressing opens the microphone');

  h.state.voiceControl.options.render.status('listening');
  assert.match(h.documentRef.byId.rnaVoiceHint.textContent, /release to send/i,
    'and then says how to finish');
  assert.match(label.textContent, /talking/i);
  assert.equal(button.classList.contains('listening'), true);

  const stops = h.state.voiceControl.stops;
  button.dispatch('pointerup', { isTrusted: true });
  assert.equal(h.state.voiceControl.stops, stops + 1, 'releasing ends the recording');
});

test('a recording does not keep running when the pointer slides off the button', async () => {
  // Chirp treats mouseleave as a release for the same reason: a recording left
  // running because a cursor moved is the worst of both worlds.
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const button = h.documentRef.byId.rnaVoice;
  button.dispatch('pointerdown', { isTrusted: true });
  const stops = h.state.voiceControl.stops;
  button.dispatch('pointerleave', { isTrusted: true });
  assert.equal(h.state.voiceControl.stops, stops + 1, 'leaving the button sends what was said');
});

test('releasing without having pressed does nothing', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const button = h.documentRef.byId.rnaVoice;
  const stops = h.state.voiceControl.stops;
  button.dispatch('pointerup', { isTrusted: true });
  button.dispatch('pointerleave', { isTrusted: true });
  assert.equal(h.state.voiceControl.stops, stops, 'a stray release must not end a turn nobody started');
});

test('the keyboard can hold to talk too', async () => {
  // Hold-to-talk is a pointer gesture; without this the control would be
  // reserved for people using a mouse.
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const button = h.documentRef.byId.rnaVoice;
  button.dispatch('keydown', { isTrusted: true, key: ' ' });
  assert.equal(h.host.getState().voiceEnabled, true, 'space holds');
  const stops = h.state.voiceControl.stops;
  button.dispatch('keyup', { isTrusted: true, key: ' ' });
  assert.equal(h.state.voiceControl.stops, stops + 1, 'and releasing it sends');
});

// ---- the spoken reply --------------------------------------------------------
// Chris, after the first turn that worked end to end: "tried it, works, she
// didnt speak back tho." The live path hands its transcript to the submit a
// TYPED message uses -- which is precisely why it works, and precisely why the
// answer came back in writing only: that submit has never had anything to do
// with speech. And because nothing released it, the button sat on WAIT reading
// "Reina is thinking..." underneath an answer she had already given.

test('a completed turn releases the button from WAIT', async () => {
  const h = makeHarness();
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const label = h.documentRef.byId.rnaVoiceLabel;
  h.documentRef.byId.rnaVoice.dispatch('pointerdown', { isTrusted: true });
  h.state.voiceControl.options.render.status('thinking');
  assert.match(label.textContent, /wait/i, 'sanity: the button waits while she works');

  assert.equal(h.host.submitTyped('What needs attention?').accepted, true);
  await flush();
  await flush();
  assert.match(label.textContent, /hold/i, 'an answered turn hands the button back');
  assert.match(h.documentRef.byId.rnaVoiceHint.textContent, /hold to talk/i);
});

test('a turn that fails releases the button too', async () => {
  // Stuck on WAIT is worse after a failure than after an answer: the button is
  // disabled in that phase, so the panel is not merely wrong, it is unusable.
  const h = makeHarness();
  h.state.postStatus = 500;
  assert.equal((await h.host.mount()).ok, true);
  await flush();
  const label = h.documentRef.byId.rnaVoiceLabel;
  h.documentRef.byId.rnaVoice.dispatch('pointerdown', { isTrusted: true });
  h.state.voiceControl.options.render.status('thinking');
  assert.match(label.textContent, /wait/i);

  assert.equal(h.host.submitTyped('What needs attention?').accepted, true);
  await flush();
  await flush();
  assert.match(label.textContent, /hold/i, 'the button is usable again');
  assert.equal(h.documentRef.byId.rnaVoice.disabled, false);
});

// The rest of the voice contract -- what the recogniser is told to do, when a
// turn ends, and what happens to the answer -- lives in
// test/reina-voice-contract.test.mjs, which installs a fake SpeechRecognition
// before the host module loads and drives a whole hold end to end.
