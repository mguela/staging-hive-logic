// test/reina-inapp-voice-bridge.test.mjs
//
// Adversarial INTEGRATION tests for the in-app voice bridge. These wire the
// REAL voice-session controller (PR #56) and the REAL browser speech adapters
// (PR #61) together through the bridge, driving only injected browser fakes and
// an injected transport -- no real microphone, speakers, network, or brain.
//
// Coverage: normal spoken turn, typed<->voice continuity, interim suppression,
// duplicate final, stale generation, unclear transcript, emergency OFF during
// pending startup, emergency OFF during model response, interruption during
// playback, async cancellation ordering, speech-policy denial, auth expiry,
// stable retry identity, transport failure, late callbacks after disposal,
// unsafe spoken payload, and malformed dependency output.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInAppVoiceBridge } from '../public/reina-inapp-voice-bridge.js';

// ---------------------------------------------------------------------------
// Injected browser fakes (no real speech I/O)
// ---------------------------------------------------------------------------

class FakeRecognition {
  constructor(order) {
    this._order = order;
    this.lang = null;
    this.interimResults = null;
    this.continuous = null;
    this.started = false;
    this.stopped = false;
    this.aborted = false;
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
  }
  start() {
    this.started = true;
    if (this._order) this._order.push('rec-start');
    if (this.onstart) this.onstart({});
  }
  stop() {
    this.stopped = true;
  }
  abort() {
    this.aborted = true;
  }
  fireResult(ev) {
    if (this.onresult) this.onresult(ev);
  }
  fireError(code) {
    if (this.onerror) this.onerror({ error: code });
  }
  fireEnd() {
    if (this.onend) this.onend({});
  }
}
function finalResult(transcript) {
  return { resultIndex: 0, results: [{ isFinal: true, length: 1, 0: { transcript } }] };
}
function interimResult(transcript) {
  return { resultIndex: 0, results: [{ isFinal: false, length: 1, 0: { transcript } }] };
}
function emptyFinalResult() {
  return { resultIndex: 0, results: [{ isFinal: true, length: 1, 0: { transcript: '   ' } }] };
}

class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
  }
  fireEnd() {
    if (this.onend) this.onend({});
  }
}
class FakeSynthesis {
  constructor(order) {
    this._order = order;
    this.spoken = [];
    this.cancelled = 0;
  }
  speak(u) {
    this.spoken.push(u);
  }
  cancel() {
    this.cancelled++;
    if (this._order) this._order.push('cancel');
  }
}

// Drain microtasks + queued transport promises.
const flush = () => new Promise((r) => setTimeout(r, 0));

// Build a bridge over the real session + real adapters with injected fakes.
function makeBridge(o = {}) {
  const order = o.order || [];
  const recs = [];
  const utts = [];
  // Honor EXPLICIT presence (including an explicit `undefined`) so tests can
  // drive the "dependency missing" fail-closed paths, not just override them.
  const synthesis = 'synthesis' in o ? o.synthesis : new FakeSynthesis(order);
  const recognitionFactory =
    'recognitionFactory' in o
      ? o.recognitionFactory
      : () => {
          const r = new FakeRecognition(order);
          recs.push(r);
          return r;
        };
  const utteranceFactory =
    'utteranceFactory' in o
      ? o.utteranceFactory
      : (t) => {
          const u = new FakeUtterance(t);
          utts.push(u);
          return u;
        };

  const states = [];
  const replies = [];
  const interims = [];
  const confirms = [];
  const errors = [];
  const transportCalls = [];

  const submitTurn =
    o.submitTurn ||
    (async (payload) => {
      transportCalls.push(payload);
      return { reply: 'reina reply', speechSafe: o.speechSafe };
    });

  let idc = 0;
  const newId = o.newId || (() => 'turn-' + ++idc);

  const bridge = createInAppVoiceBridge({
    conversationId: o.conversationId || 'conv-server-42',
    newId,
    submitTurn,
    isSpeechAllowed: o.isSpeechAllowed,
    assessTranscript: o.assessTranscript,
    isEmergencyOff: o.isEmergencyOff,
    recognitionFactory,
    synthesis,
    utteranceFactory,
    onState: (s, d) => states.push({ s, d }),
    onReply: (r) => replies.push(r),
    onInterim: (i) => interims.push(i),
    onNeedsConfirmation: (c) => confirms.push(c),
    onError: (e) => errors.push(e),
  });

  return {
    bridge,
    recs,
    utts,
    synthesis,
    states,
    replies,
    interims,
    confirms,
    errors,
    transportCalls,
    order,
  };
}

const ACCEPT = () => ({ decision: 'accept' });

// ===========================================================================
// Normal + continuity
// ===========================================================================

test('normal spoken turn: interim shown, final enters the shared transport, reply delivered', async () => {
  const h = makeBridge({ assessTranscript: ACCEPT });
  assert.equal(await h.bridge.startListening(), true);
  assert.equal(h.bridge.getState(), 'listening');

  h.recs[0].fireResult(interimResult('book a'));
  h.recs[0].fireResult(finalResult('book a service call'));
  await flush();

  assert.equal(h.transportCalls.length, 1);
  assert.equal(h.transportCalls[0].text, 'book a service call');
  assert.equal(h.transportCalls[0].source, 'voice');
  assert.equal(h.transportCalls[0].conversationId, 'conv-server-42');
  assert.ok(h.interims.some((i) => i.text === 'book a'));
  assert.ok(h.replies.some((r) => r.reply === 'reina reply'));
});

test('typed-to-voice continuity: same conversationId + same transport for both', async () => {
  const h = makeBridge({ assessTranscript: ACCEPT });
  await h.bridge.submit('typed first');
  await flush();
  assert.equal(h.bridge.getState(), 'idle');

  await h.bridge.startListening();
  h.recs[0].fireResult(finalResult('spoken second'));
  await flush();

  assert.equal(h.transportCalls.length, 2);
  assert.equal(h.transportCalls[0].source, 'text');
  assert.equal(h.transportCalls[1].source, 'voice');
  assert.equal(h.transportCalls[0].conversationId, h.transportCalls[1].conversationId);
  assert.equal(h.transportCalls[1].conversationId, 'conv-server-42');
});

test('voice-to-typed continuity: spoken then typed both flow through one transport/conversation', async () => {
  const h = makeBridge({ assessTranscript: ACCEPT });
  await h.bridge.startListening();
  h.recs[0].fireResult(finalResult('spoken first'));
  await flush();
  assert.equal(h.bridge.getState(), 'idle');

  await h.bridge.submit('typed second');
  await flush();

  assert.equal(h.transportCalls.length, 2);
  assert.equal(h.transportCalls[0].source, 'voice');
  assert.equal(h.transportCalls[1].source, 'text');
  assert.equal(h.transportCalls[0].conversationId, h.transportCalls[1].conversationId);
});

// ===========================================================================
// Recognition-event correctness
// ===========================================================================

test('interim transcript suppression: interims display but never submit', async () => {
  const h = makeBridge({ assessTranscript: ACCEPT });
  await h.bridge.startListening();
  h.recs[0].fireResult(interimResult('draft one'));
  h.recs[0].fireResult(interimResult('draft two'));
  await flush();
  assert.equal(h.interims.length, 2);
  assert.equal(h.transportCalls.length, 0); // nothing submitted from interims
});

test('duplicate final: collapses to a single submitted turn', async () => {
  const h = makeBridge({ assessTranscript: ACCEPT });
  await h.bridge.startListening();
  h.recs[0].fireResult(finalResult('confirm please'));
  h.recs[0].fireResult(finalResult('confirm please')); // duplicate
  h.recs[0].fireResult(finalResult('confirm please')); // duplicate
  await flush();
  assert.equal(h.transportCalls.length, 1);
});

test('graceful Stop preserves the current final instead of aborting it', async () => {
  const h = makeBridge({ assessTranscript: ACCEPT });
  await h.bridge.startListening();
  h.bridge.stopListening();
  assert.equal(h.recs[0].stopped, true);
  assert.equal(h.recs[0].aborted, false);
  h.recs[0].fireResult(finalResult('send this finished recording'));
  await flush();
  assert.equal(h.transportCalls.length, 1);
  assert.equal(h.transportCalls[0].text, 'send this finished recording');
});

test('stale generation: a late final from a superseded recognizer never submits', async () => {
  const h = makeBridge({ assessTranscript: ACCEPT });
  await h.bridge.startListening(); // rec0
  await h.bridge.startListening(); // rapid restart -> rec1, rec0 retired
  assert.equal(h.recs.length, 2);
  assert.equal(h.recs[0].aborted, true);

  h.recs[0].fireResult(finalResult('stale words')); // detached recognizer -> nothing
  h.recs[1].fireResult(finalResult('fresh words'));
  await flush();

  assert.equal(h.transportCalls.length, 1);
  assert.equal(h.transportCalls[0].text, 'fresh words');
});

test('unclear transcript (empty final): asks for confirmation, never submits', async () => {
  const h = makeBridge({ assessTranscript: ACCEPT });
  await h.bridge.startListening();
  h.recs[0].fireResult(emptyFinalResult());
  await flush();
  assert.ok(h.confirms.some((c) => c.reason === 'unclear'));
  assert.equal(h.transportCalls.length, 0);
});

test('unclear transcript (policy says confirm): asks for confirmation, never submits', async () => {
  const h = makeBridge({ assessTranscript: () => ({ decision: 'confirm' }) });
  await h.bridge.startListening();
  h.recs[0].fireResult(finalResult('did you mean this'));
  await flush();
  assert.ok(h.confirms.some((c) => c.reason === 'confirm' && c.text === 'did you mean this'));
  assert.equal(h.transportCalls.length, 0);
});

// ===========================================================================
// Emergency OFF
// ===========================================================================

test('emergency OFF during pending recognition startup wins the race', async () => {
  const h = makeBridge({ assessTranscript: ACCEPT });
  const p = h.bridge.startListening();
  h.bridge.emergencyOff(); // OFF lands while start() is still pending
  const started = await p;

  assert.equal(started, false);
  assert.equal(h.bridge.getState(), 'off');
  // A now-active recognizer must have been stopped again; no transcript accepted.
  if (h.recs[0]) h.recs[0].fireResult(finalResult('too late'));
  await flush();
  assert.equal(h.transportCalls.length, 0);
});

test('emergency OFF during model response suppresses the pending reply', async () => {
  let resolveTransport;
  const h = makeBridge({
    assessTranscript: ACCEPT,
    submitTurn: () => new Promise((res) => (resolveTransport = res)),
  });
  await h.bridge.startListening();
  h.recs[0].fireResult(finalResult('do the thing'));
  await flush();
  assert.equal(h.bridge.getState(), 'thinking');

  h.bridge.emergencyOff();
  resolveTransport({ reply: 'late reply', speechSafe: 'late reply' });
  await flush();

  assert.equal(h.bridge.getState(), 'off');
  assert.equal(h.replies.length, 0); // pending response suppressed
  assert.equal(h.synthesis.spoken.length, 0); // nothing spoken
});

// ===========================================================================
// Playback / interruption
// ===========================================================================

test('interruption during playback cancels audio and restarts listening', async () => {
  const h = makeBridge({
    assessTranscript: ACCEPT,
    isSpeechAllowed: () => true,
    speechSafe: 'here is your answer',
  });
  await h.bridge.startListening();
  h.recs[0].fireResult(finalResult('answer me'));
  await flush();
  assert.equal(h.bridge.getState(), 'speaking');
  assert.equal(h.synthesis.spoken.length, 1);

  const listening = await h.bridge.interrupt();
  assert.ok(h.synthesis.cancelled >= 1);
  assert.equal(listening, true); // recognition restarted
  assert.equal(h.bridge.getState(), 'listening');
});

test('async cancellation ordering: playback is cancelled BEFORE recognition restarts', async () => {
  const order = [];
  const h = makeBridge({
    order,
    assessTranscript: ACCEPT,
    isSpeechAllowed: () => true,
    speechSafe: 'speaking now',
  });
  await h.bridge.startListening();
  h.recs[0].fireResult(finalResult('go'));
  await flush();
  assert.equal(h.bridge.getState(), 'speaking');

  order.length = 0; // observe only the interrupt sequence
  await h.bridge.interrupt();
  assert.deepEqual(order, ['cancel', 'rec-start']);
});

// ===========================================================================
// Policy, auth, retry, transport
// ===========================================================================

test('speech-policy denial: written reply delivered, nothing spoken', async () => {
  const h = makeBridge({
    assessTranscript: ACCEPT,
    isSpeechAllowed: () => false, // default is also false; explicit here
    speechSafe: 'do not say this aloud',
  });
  await h.bridge.startListening();
  h.recs[0].fireResult(finalResult('quiet answer'));
  await flush();
  assert.ok(h.replies.some((r) => r.reply === 'reina reply')); // written stays available
  assert.equal(h.synthesis.spoken.length, 0); // speech disabled by policy
});

test('speech policy must return primitive true: truthy non-true and throws both deny', async () => {
  for (const policy of [() => 1, () => 'yes', () => ({}), () => { throw new Error('x'); }]) {
    const h = makeBridge({ assessTranscript: ACCEPT, isSpeechAllowed: policy, speechSafe: 'x' });
    await h.bridge.startListening();
    h.recs[0].fireResult(finalResult('answer'));
    await flush();
    assert.equal(h.synthesis.spoken.length, 0);
  }
});

test('authentication expiry surfaces a recoverable auth error, submits nothing further', async () => {
  const h = makeBridge({
    assessTranscript: ACCEPT,
    submitTurn: async () => {
      const e = new Error('token expired');
      e.code = 'auth_expired';
      throw e;
    },
  });
  await h.bridge.startListening();
  h.recs[0].fireResult(finalResult('secure action'));
  await flush();
  const err = h.states.find((x) => x.s === 'error');
  assert.ok(err);
  assert.equal(err.d.reason, 'auth_expired');
  assert.equal(err.d.recoverable, 'reauth');
});

test('stable retry identity: retry reuses the same turnId + idempotencyKey', async () => {
  const calls = [];
  const h = makeBridge({
    assessTranscript: ACCEPT,
    submitTurn: async (p) => {
      calls.push(p);
      if (calls.length === 1) throw new Error('transient');
      return { reply: 'ok now' };
    },
  });
  await h.bridge.startListening();
  h.recs[0].fireResult(finalResult('retry me'));
  await flush();
  assert.equal(h.bridge.getState(), 'error');

  const r = h.bridge.retry();
  assert.equal(r.accepted, true);
  await flush();

  assert.equal(calls.length, 2);
  assert.equal(calls[0].turnId, calls[1].turnId);
  assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
});

test('storage/transport failure fails closed (both rejected and thrown transports)', async () => {
  // rejected transport
  const h1 = makeBridge({
    assessTranscript: ACCEPT,
    submitTurn: async () => {
      throw new Error('db down');
    },
  });
  await h1.bridge.startListening();
  h1.recs[0].fireResult(finalResult('write it'));
  await flush();
  assert.equal(h1.bridge.getState(), 'error');
  assert.equal(h1.replies.length, 0);

  // synchronously throwing transport
  const h2 = makeBridge({
    assessTranscript: ACCEPT,
    submitTurn: () => {
      throw new Error('sync boom');
    },
  });
  await h2.bridge.startListening();
  h2.recs[0].fireResult(finalResult('write it'));
  await flush();
  assert.equal(h2.bridge.getState(), 'error');
  assert.equal(h2.replies.length, 0);
});

// ===========================================================================
// Disposal, unsafe payload, malformed deps
// ===========================================================================

test('late callbacks after disposal never fire', async () => {
  let resolveTransport;
  const h = makeBridge({
    assessTranscript: ACCEPT,
    submitTurn: () => new Promise((res) => (resolveTransport = res)),
  });
  await h.bridge.startListening();
  h.recs[0].fireResult(finalResult('in flight'));
  await flush();
  assert.equal(h.bridge.getState(), 'thinking');

  const statesBefore = h.states.length;
  h.bridge.dispose();
  assert.equal(h.bridge.isDisposed(), true);

  // Late transport resolution + late recognition event must produce NOTHING.
  resolveTransport({ reply: 'too late', speechSafe: 'too late' });
  if (h.recs[0]) h.recs[0].fireResult(finalResult('also too late'));
  await flush();

  assert.equal(h.states.length, statesBefore); // no callbacks after dispose
  assert.equal(h.replies.length, 0);
  // New turns are blocked after dispose.
  assert.equal(await h.bridge.startListening(), false);
  assert.deepEqual(await h.bridge.submit('nope'), { accepted: false, reason: 'disposed' });
});

test('dispose stops recognition and cancels playback', async () => {
  const h = makeBridge({
    assessTranscript: ACCEPT,
    isSpeechAllowed: () => true,
    speechSafe: 'speaking',
  });
  await h.bridge.startListening();
  h.recs[0].fireResult(finalResult('go'));
  await flush();
  assert.equal(h.bridge.getState(), 'speaking');

  h.bridge.dispose();
  assert.ok(h.synthesis.cancelled >= 1); // playback cancelled
  assert.equal(h.recs[h.recs.length - 1].aborted, true); // recognition aborted
});

test('unsafe spoken payload is refused: no audio, written reply intact', async () => {
  const h = makeBridge({
    assessTranscript: ACCEPT,
    isSpeechAllowed: () => true,
    speechSafe: '<speak>hi<break/></speak>', // SSML/markup -> must be refused
  });
  await h.bridge.startListening();
  h.recs[0].fireResult(finalResult('speak it'));
  await flush();

  assert.equal(h.synthesis.spoken.length, 0); // playback adapter refused markup
  assert.ok(h.replies.some((r) => r.reply === 'reina reply')); // written reply still delivered
  assert.notEqual(h.bridge.getState(), 'speaking');
});

test('malformed dependency output: transport without a reply fails closed', async () => {
  const h = makeBridge({
    assessTranscript: ACCEPT,
    submitTurn: async () => 42, // not an object with a string reply
  });
  await h.bridge.startListening();
  h.recs[0].fireResult(finalResult('garbage in'));
  await flush();
  assert.equal(h.bridge.getState(), 'error');
  assert.equal(h.replies.length, 0);
});

test('malformed dependency output: an unusable recognizer fails closed on start', async () => {
  const h = makeBridge({
    recognitionFactory: () => ({}), // no start()/stop() -> adapter start() returns false
  });
  const started = await h.bridge.startListening();
  assert.equal(started, false);
  assert.equal(h.bridge.getState(), 'error'); // fail closed, not a false 'listening'
});

test('recognition unavailable (no factory) fails closed', async () => {
  const h = makeBridge({ recognitionFactory: undefined });
  const started = await h.bridge.startListening();
  assert.equal(started, false);
  assert.equal(h.bridge.getState(), 'error');
});

test('a throwing consumer callback never breaks the bridge', async () => {
  // onState throws on every transition; the turn must still complete.
  const transportCalls = [];
  const bridge = createInAppVoiceBridge({
    conversationId: 'conv-x',
    newId: (() => {
      let n = 0;
      return () => 'id-' + ++n;
    })(),
    submitTurn: async (p) => {
      transportCalls.push(p);
      return { reply: 'ok' };
    },
    assessTranscript: ACCEPT,
    recognitionFactory: (() => {
      const recs = [];
      const f = () => {
        const r = new FakeRecognition();
        recs.push(r);
        f.recs = recs;
        return r;
      };
      return f;
    })(),
    synthesis: new FakeSynthesis(),
    utteranceFactory: (t) => new FakeUtterance(t),
    onState: () => {
      throw new Error('callback boom');
    },
  });
  assert.equal(await bridge.startListening(), true);
  bridge.getState(); // still functional
  assert.equal(bridge.getState(), 'listening');
});

// ===========================================================================
// Bridge-level mute + guardrails
// ===========================================================================

test('mute mutes audio out and suppresses transcripts; unmute restores', async () => {
  const h = makeBridge({ assessTranscript: ACCEPT });
  await h.bridge.startListening();
  h.bridge.mute();
  assert.equal(h.bridge.isMuted(), true);

  h.recs[0].fireResult(finalResult('while muted'));
  await flush();
  assert.equal(h.transportCalls.length, 0); // muted transcripts suppressed

  h.bridge.unmute();
  assert.equal(h.bridge.isMuted(), false);
});

test('conversationId is server-issued and shared, never minted by the bridge', () => {
  const h = makeBridge();
  assert.equal(h.bridge.getConversationId(), 'conv-server-42');
});

// ===========================================================================
// Turn-stage failures reach the panel
// ===========================================================================

test('a spoken turn that fails after recording reports an error instead of going quiet', async () => {
  const h = makeBridge({
    assessTranscript: ACCEPT,
    submitTurn: async () => {
      throw new Error('db down');
    },
  });
  await h.bridge.startListening();
  h.recs[0].fireResult(finalResult('what is my ar'));
  await flush();
  assert.equal(h.bridge.getState(), 'error');
  assert.deepEqual(h.errors, [{ stage: 'turn', reason: 'turn_failed' }]);
});

test('authentication expiry reaches the panel as auth_expired so the host can re-authenticate', async () => {
  const h = makeBridge({
    assessTranscript: ACCEPT,
    submitTurn: async () => {
      const e = new Error('token expired');
      e.code = 'auth_expired';
      throw e;
    },
  });
  await h.bridge.startListening();
  h.recs[0].fireResult(finalResult('secure action'));
  await flush();
  assert.deepEqual(h.errors, [{ stage: 'turn', reason: 'auth_expired' }]);
});

test('a transport timeout and an empty reply are reported as themselves', async () => {
  const timedOut = makeBridge({
    assessTranscript: ACCEPT,
    submitTurn: async () => {
      const e = new Error('slow');
      e.code = 'timeout';
      throw e;
    },
  });
  await timedOut.bridge.startListening();
  timedOut.recs[0].fireResult(finalResult('anything'));
  await flush();
  assert.deepEqual(timedOut.errors, [{ stage: 'turn', reason: 'turn_timeout' }]);

  const empty = makeBridge({ assessTranscript: ACCEPT, submitTurn: async () => ({ reply: '   ' }) });
  await empty.bridge.startListening();
  empty.recs[0].fireResult(finalResult('anything'));
  await flush();
  assert.deepEqual(empty.errors, [{ stage: 'turn', reason: 'turn_empty_reply' }]);
});

test('a recognition failure is reported once, with its own normalized code', async () => {
  const h = makeBridge({ assessTranscript: ACCEPT });
  await h.bridge.startListening();
  h.recs[0].fireError('not-allowed');
  await flush();
  // The session ALSO enters an error state for the same failure; the microphone
  // code stays authoritative and is not duplicated by a generic turn failure.
  assert.deepEqual(h.errors, [{ stage: 'recognition', reason: 'permission_denied' }]);
});
