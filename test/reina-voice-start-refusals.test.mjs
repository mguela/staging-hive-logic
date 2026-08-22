import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoicePanelController } from '../public/reina-voice-panel-controller.js';
import VS from '../public/reina-voice-session.js';

const { createVoiceSession } = VS;

// Every guard between the microphone button and getUserMedia used to be a bare
// `return false`. The microphone did not open, the panel said nothing, the
// console said nothing, and no diagnostic row was written -- so a refused start
// and a start that hung produced the identical report: "I pressed it and
// nothing happened." These tests exist so that sentence can never again be the
// only evidence available.

function mountedController(overrides = {}) {
  const events = [];
  const controller = createVoicePanelController({
    elements: { status: {}, error: {}, interim: {}, confirm: {} },
    render: { text: () => {} },
    controls: {},
    labels: {},
    createBridge: () => ({
      startListening: () => true,
      stopListening: () => {},
      interrupt: () => {},
      mute: () => {},
      unmute: () => {},
      submit: () => {},
      retry: () => {},
      emergencyOff: () => {},
      dispose: () => {},
    }),
    onControlEvent: (event) => events.push(event),
    ...overrides,
  });
  controller.mount?.();
  return { controller, events };
}

function blocks(events) {
  return events.filter((e) => e && e.type === 'blocked').map((e) => e.detail && e.detail.reason);
}

test('a duplicate click on the microphone names the guard that refused it', () => {
  const { controller, events } = mountedController();
  assert.equal(controller.startListening(), true, 'sanity: the first start is accepted');
  // The second click lands while the first is still pending. Previously silent.
  assert.equal(controller.startListening(), false);
  assert.deepEqual(blocks(events), ['start_already_pending']);
});

test('a start refused because the panel never returned to idle names the state', () => {
  // The refusal that can strand the panel: a state that is neither idle nor
  // error leaves the button inert, and before this it said nothing at all.
  let callbacks = null;
  const events = [];
  const controller = createVoicePanelController({
    elements: { status: {}, error: {}, interim: {}, confirm: {} },
    render: { text: () => {} },
    createBridge: (cb) => { callbacks = cb; return { startListening: () => true, dispose: () => {} }; },
    onControlEvent: (event) => events.push(event),
  });
  controller.mount();
  assert.ok(callbacks && typeof callbacks.onState === 'function', 'sanity: the bridge got its callbacks');

  callbacks.onState('thinking', null);
  events.length = 0;
  assert.equal(controller.startListening(), false, 'a press while thinking is refused');
  assert.deepEqual(blocks(events), ['state_thinking'],
    'the reported reason names the state that refused, not a generic failure');

  // And once the panel does return to idle, the button works again.
  callbacks.onState('idle', null);
  events.length = 0;
  assert.equal(controller.startListening(), true);
  assert.deepEqual(blocks(events), []);
});

test('a start refused after dispose is reported, not swallowed', () => {
  const { controller, events } = mountedController();
  controller.dispose();
  events.length = 0;
  assert.equal(controller.startListening(), false);
  assert.deepEqual(blocks(events), ['disposed']);
});

test('a start refused before mount is reported', () => {
  const events = [];
  const controller = createVoicePanelController({
    elements: {},
    render: { text: () => {} },
    createBridge: () => ({ startListening: () => true, dispose: () => {} }),
    onControlEvent: (event) => events.push(event),
  });
  assert.equal(controller.startListening(), false);
  assert.deepEqual(blocks(events), ['not_mounted']);
});

// ---- session-level refusals --------------------------------------------------

function session(overrides = {}) {
  const reasons = [];
  const instance = createVoiceSession({
    conversationId: 'conv-1',
    newId: () => 'id-' + reasons.length,
    recognizer: { start: () => true, stop: () => {}, mute: () => {} },
    synthesizer: { speak: () => Promise.resolve(), cancel: () => {} },
    submitTurn: () => Promise.resolve({ ok: true, reply: 'hi' }),
    isEmergencyOff: () => false,
    onBlock: (reason) => reasons.push(reason),
    ...overrides,
  });
  return { instance, reasons };
}

test('the session reports a start refused by the emergency latch', async () => {
  const { instance, reasons } = session({ isEmergencyOff: () => true });
  assert.equal(await instance.startListening(), false);
  assert.deepEqual(reasons, ['emergency_off']);
});

test('a recognition error dropped for a missing generation is reported', () => {
  // A dropped recognition error never reaches fail(), so the session never
  // enters 'error' and the panel never returns to a startable state. Silently.
  const { instance, reasons } = session();
  const result = instance.handleRecognitionError({ kind: 'network' });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'missing_generation');
  assert.deepEqual(reasons, ['recognition_missing_generation']);
});

test('a recognition error dropped as stale is reported', async () => {
  const { instance, reasons } = session();
  await instance.startListening();
  reasons.length = 0;
  const result = instance.handleRecognitionError({ kind: 'network', generation: -99 });
  assert.equal(result.reason, 'stale_generation');
  assert.deepEqual(reasons, ['recognition_stale_generation']);
});

test('a session with no reporter still refuses cleanly', async () => {
  // The reporter is optional and wrapped: a session must keep working whether
  // or not anything is listening to its refusals.
  const instance = createVoiceSession({
    conversationId: 'conv-1',
    newId: () => 'id',
    isEmergencyOff: () => true,
    submitTurn: () => Promise.resolve({ ok: true }),
  });
  assert.equal(await instance.startListening(), false);
});

test('a throwing reporter never breaks a refusal', async () => {
  const { instance } = session({
    isEmergencyOff: () => true,
    onBlock: () => { throw new Error('reporter exploded'); },
  });
  assert.equal(await instance.startListening(), false);
});

// ---- the stranded panel ------------------------------------------------------
// Measured, not theorised: a press was refused with `panel_state_listening` at
// 2026-08-18 23:56:57, and the panel header showed LISTENING at the time. The
// session had been left in 'listening' by an earlier recognition that ended
// with neither a transcript nor an error -- a closed panel, a cancel, or a
// recorder that simply stopped. Nothing moved it on, so the start guard
// refused every later press and the microphone button was dead until reload.

test('a recognition that ends with no transcript and no error returns the session to idle', async () => {
  const states = [];
  const { instance } = session({ onState: (state) => states.push(state) });
  assert.equal(await instance.startListening(), true);
  assert.equal(states.at(-1), 'listening');

  const result = instance.handleRecognitionEnd({ generation: instance.getGeneration() });
  assert.equal(result.handled, true);
  assert.equal(states.at(-1), 'idle', 'the panel can be started again');
});

test('an end that follows a delivered transcript does not undo the turn', async () => {
  // A result has already moved the session to 'thinking' by the time 'end'
  // arrives. Forcing idle there would cancel a turn that is mid-flight.
  const states = [];
  const { instance } = session({
    onState: (state) => states.push(state),
    assessTranscript: () => ({ decision: 'accept' }),
  });
  await instance.startListening();
  await instance.handleTranscript('what needs attention',
    { eventId: 'e1', final: true, generation: instance.getGeneration() });
  const moved = states.at(-1);
  assert.notEqual(moved, 'listening', 'sanity: a transcript moves the session on');

  const result = instance.handleRecognitionEnd({ generation: instance.getGeneration() });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'not_listening');
  assert.equal(states.at(-1), moved, 'the in-flight turn is untouched');
});

test('a stale or unidentified end is ignored', async () => {
  const { instance } = session();
  await instance.startListening();
  assert.equal(instance.handleRecognitionEnd({}).reason, 'missing_generation');
  assert.equal(instance.handleRecognitionEnd({ generation: -99 }).reason, 'stale_generation');
});

test('after an unresolved end, the panel accepts a start again', async () => {
  // The whole point, end to end: the guard that reported panel_state_listening
  // must stop firing once the session is no longer stranded.
  let callbacks = null;
  const events = [];
  const controller = createVoicePanelController({
    elements: { status: {}, error: {}, interim: {}, confirm: {} },
    render: { text: () => {} },
    createBridge: (cb) => { callbacks = cb; return { startListening: () => true, dispose: () => {} }; },
    onControlEvent: (event) => events.push(event),
  });
  controller.mount();

  callbacks.onState('listening', null);
  events.length = 0;
  assert.equal(controller.startListening(), false);
  assert.deepEqual(blocks(events), ['state_listening'], 'the exact code seen in production');

  // The session reports the recognition ended and returns to idle.
  callbacks.onState('idle', null);
  events.length = 0;
  assert.equal(controller.startListening(), true, 'the button works again');
  assert.deepEqual(blocks(events), []);
});
