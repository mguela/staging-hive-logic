// test/reina-inapp-voice-host.test.mjs
//
// Integration tests for the explicit in-app Voice HOST factory. These assemble
// the REAL full stack -- recognition adapter + playback adapter + Voice bridge +
// panel controller (PR #72 / PR #75) -- through the host, driving only injected
// browser fakes and an injected transport. No real DOM, microphone, or speakers.
//
// Coverage: dormant construction, explicit mount, typed<->Voice continuity,
// shared conversationId/transport, interim/duplicate/stale transcripts, speech
// denial, written-reply fallback, emergency-OFF races, disposal races,
// unavailable browser APIs, unsafe text, throwing callbacks, and no global DOM
// queries.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReinaInAppVoiceHost } from '../public/reina-inapp-voice-host.js';

// ---------------------------------------------------------------------------
// Injected fakes
// ---------------------------------------------------------------------------

class FakeRecognition {
  constructor() {
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
  constructor() {
    this.spoken = [];
    this.cancelled = 0;
  }
  speak(u) {
    this.spoken.push(u);
  }
  cancel() {
    this.cancelled++;
  }
}

// Text-only element: tracks textContent + records any innerHTML attempt.
class FakeEl {
  constructor() {
    this._t = '';
    this.disabled = false;
    this._l = {};
    this.innerHTMLWrites = 0;
  }
  get textContent() {
    return this._t;
  }
  set textContent(v) {
    this._t = String(v);
  }
  set innerHTML(_v) {
    this.innerHTMLWrites++;
  }
  get innerHTML() {
    return '';
  }
  addEventListener(t, h) {
    (this._l[t] = this._l[t] || []).push(h);
  }
  removeEventListener(t, h) {
    const a = this._l[t] || [];
    const i = a.indexOf(h);
    if (i !== -1) a.splice(i, 1);
  }
  click() {
    (this._l.click || []).slice().forEach((h) => h({ type: 'click' }));
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const ACCEPT = () => ({ decision: 'accept' });

function makeWindowRef(recs, utts, synthesis) {
  return {
    SpeechRecognition: function () {
      const r = new FakeRecognition();
      recs.push(r);
      return r; // constructor returns the fake -> `new SR()` yields it
    },
    speechSynthesis: synthesis,
    SpeechSynthesisUtterance: function (t) {
      const u = new FakeUtterance(t);
      utts.push(u);
      return u;
    },
  };
}

function makeHost(o = {}) {
  const recs = [];
  const utts = [];
  const synthesis = new FakeSynthesis();
  const windowRef = makeWindowRef(recs, utts, synthesis);
  const els = {
    status: new FakeEl(),
    interim: new FakeEl(),
    reply: new FakeEl(),
    confirm: new FakeEl(),
    error: new FakeEl(),
  };
  const controls = {
    start: new FakeEl(),
    stop: new FakeEl(),
    interrupt: new FakeEl(),
    mute: new FakeEl(),
    unmute: new FakeEl(),
    off: new FakeEl(),
    reset: new FakeEl(),
    confirm: new FakeEl(),
    dismiss: new FakeEl(),
  };
  const transportCalls = [];
  const events = [];
  const submitTurn =
    o.submitTurn ||
    (async (p) => {
      transportCalls.push(p);
      return { reply: o.reply || 'reina reply', speechSafe: o.speechSafe };
    });
  let idc = 0;
  const newId = o.newId || (() => 'turn-' + ++idc);

  const host = createReinaInAppVoiceHost({
    conversationId: o.conversationId || 'conv-server-9',
    newId,
    submitTurn,
    assessTranscript: o.assessTranscript,
    isSpeechAllowed: o.isSpeechAllowed,
    isEmergencyOff: o.isEmergencyOff,
    authorizeReset: o.authorizeReset,
    elements: o.render ? undefined : els,
    render: o.render,
    controls,
    windowRef: 'windowRef' in o ? o.windowRef : windowRef,
    recognitionFactory: o.recognitionFactory,
    requestMicrophone: o.requestMicrophone,
    synthesis: o.synthesis,
    utteranceFactory: o.utteranceFactory,
    onControlEvent: (e) => events.push(e),
  });

  if (o.mount !== false) host.mount();
  return { host, recs, utts, synthesis, els, controls, transportCalls, events };
}

// ===========================================================================
// Dormancy + explicit mount
// ===========================================================================

test('construction is dormant: no bridge activity, no mic, no transport, no mount', () => {
  const h = makeHost({ mount: false });
  assert.equal(h.host.isMounted(), false);
  assert.equal(h.recs.length, 0); // no recognition instance created
  assert.equal(h.transportCalls.length, 0);
  assert.equal(h.synthesis.spoken.length, 0);
});

test('explicit mount connects the stack but never starts the microphone', () => {
  const h = makeHost();
  assert.equal(h.host.isMounted(), true);
  assert.equal(h.host.getState(), 'idle');
  assert.equal(h.recs.length, 0); // mount does NOT open the mic
});

test('microphone starts only from an explicit start seam', async () => {
  const h = makeHost({ assessTranscript: ACCEPT });
  assert.equal(h.recs.length, 0);
  h.host.startListening();
  await flush();
  assert.equal(h.recs.length, 1);
  assert.equal(h.host.getState(), 'listening');
});

test('Chromium microphone preflight runs only after an explicit start and releases its probe track', async () => {
  let requests = 0;
  let stopped = 0;
  const h = makeHost({
    assessTranscript: ACCEPT,
    requestMicrophone: async () => {
      requests += 1;
      return { getTracks: () => [{ stop() { stopped += 1; } }] };
    },
  });
  assert.equal(requests, 0);
  assert.equal(h.recs.length, 0);
  assert.equal(h.host.startListening(), true);
  await flush();
  await flush();
  assert.equal(requests, 1);
  assert.equal(stopped, 1);
  assert.equal(h.recs.length, 1);
  assert.equal(h.host.getState(), 'listening');
});

// ===========================================================================
// Typed <-> Voice continuity + shared identity/transport
// ===========================================================================

test('typed-to-voice continuity: one conversationId + one transport for both', async () => {
  const h = makeHost({ assessTranscript: ACCEPT });
  await h.host.submitTyped('typed first');
  await flush();
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('spoken second'));
  await flush();

  assert.equal(h.transportCalls.length, 2);
  assert.equal(h.transportCalls[0].source, 'text');
  assert.equal(h.transportCalls[1].source, 'voice');
  assert.equal(h.transportCalls[0].conversationId, 'conv-server-9');
  assert.equal(h.transportCalls[1].conversationId, 'conv-server-9');
});

test('voice-to-typed continuity: shared conversationId + transport in reverse', async () => {
  const h = makeHost({ assessTranscript: ACCEPT });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('spoken first'));
  await flush();
  await h.host.submitTyped('typed second');
  await flush();

  assert.equal(h.transportCalls.length, 2);
  assert.equal(h.transportCalls[0].source, 'voice');
  assert.equal(h.transportCalls[1].source, 'text');
  assert.equal(h.transportCalls[0].conversationId, h.transportCalls[1].conversationId);
  assert.equal(h.host.getConversationId(), 'conv-server-9');
});

test('every turn shares the exact conversationId and transport', async () => {
  const h = makeHost({ assessTranscript: ACCEPT });
  await h.host.submitTyped('a');
  await flush();
  await h.host.submitTyped('b');
  await flush();
  assert.equal(h.transportCalls.length, 2);
  assert.ok(h.transportCalls.every((c) => c.conversationId === 'conv-server-9'));
});

// ===========================================================================
// Transcript handling: interim / duplicate / stale
// ===========================================================================

test('interim transcripts display but never submit', async () => {
  const h = makeHost({ assessTranscript: ACCEPT });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(interimResult('partial words'));
  await flush();
  assert.equal(h.els.interim.textContent, 'partial words');
  assert.equal(h.transportCalls.length, 0);
});

test('duplicate final collapses to a single submitted turn', async () => {
  const h = makeHost({ assessTranscript: ACCEPT });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('same thing'));
  h.recs[0].fireResult(finalResult('same thing'));
  await flush();
  assert.equal(h.transportCalls.length, 1);
});

test('stale final from a superseded recognizer never submits', async () => {
  const h = makeHost({ assessTranscript: ACCEPT });
  h.host.startListening();
  await flush();
  h.host.stop(); // requests a graceful stop
  h.recs[0].fireEnd(); // the browser closes and detaches rec0
  await flush();
  h.host.startListening();
  await flush();
  assert.equal(h.recs.length, 2);
  h.recs[0].fireResult(finalResult('stale')); // detached -> nothing
  h.recs[1].fireResult(finalResult('fresh'));
  await flush();
  assert.equal(h.transportCalls.length, 1);
  assert.equal(h.transportCalls[0].text, 'fresh');
});

// ===========================================================================
// Speech denial / written reply fallback / unsafe text
// ===========================================================================

test('speech denial: written reply delivered, nothing spoken', async () => {
  const h = makeHost({ assessTranscript: ACCEPT, isSpeechAllowed: () => false, speechSafe: 'quiet' });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('answer me'));
  await flush();
  assert.equal(h.els.reply.textContent, 'reina reply'); // written stays available
  assert.equal(h.synthesis.spoken.length, 0); // policy denied speech
});

test('written reply survives mute (typed path)', async () => {
  const h = makeHost({ assessTranscript: ACCEPT, isSpeechAllowed: () => true, speechSafe: 'hello' });
  h.host.mute();
  await h.host.submitTyped('hi there');
  await flush();
  assert.equal(h.els.reply.textContent, 'reina reply');
});

test('unsafe HTML/SSML stays inert plain text; markup speechSafe is refused', async () => {
  const h = makeHost({
    assessTranscript: ACCEPT,
    isSpeechAllowed: () => true,
    reply: '<img src=x onerror=alert(1)>',
    speechSafe: '<speak>hi<break/></speak>',
  });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('go'));
  await flush();
  assert.equal(h.els.reply.textContent, '<img src=x onerror=alert(1)>'); // inert text
  assert.equal(h.els.reply.innerHTMLWrites, 0);
  assert.equal(h.synthesis.spoken.length, 0); // SSML/markup refused by playback
});

// ===========================================================================
// Emergency OFF + disposal races
// ===========================================================================

test('emergency OFF race: immediate OFF, late final suppressed, typed blocked', async () => {
  const h = makeHost({ assessTranscript: ACCEPT });
  h.host.startListening();
  await flush();
  h.host.emergencyOff();
  h.recs[0].fireResult(finalResult('too late')); // must be suppressed
  await flush();
  assert.equal(h.host.getState(), 'off');
  assert.equal(h.transportCalls.length, 0);
  assert.equal(h.els.reply.textContent, '');
  const typed = await h.host.submitTyped('nope');
  assert.equal(typed.accepted, false);
  assert.equal(typed.reason, 'off');
});

test('reset only through injected host authorization (primitive true)', async () => {
  // No authorization -> denied.
  const h1 = makeHost();
  h1.host.emergencyOff();
  assert.equal(await h1.host.reset(), false);
  assert.equal(h1.host.isOff(), true);

  // Authorization returns non-true -> denied.
  const h2 = makeHost({ authorizeReset: () => 1 });
  h2.host.emergencyOff();
  assert.equal(await h2.host.reset(), false);

  // Authorization throws -> denied (fail closed).
  const h3 = makeHost({ authorizeReset: () => { throw new Error('x'); } });
  h3.host.emergencyOff();
  assert.equal(await h3.host.reset(), false);

  // Async authorization returns true -> reset succeeds, back to idle, no mic.
  const h4 = makeHost({ authorizeReset: async () => true });
  h4.host.emergencyOff();
  assert.equal(await h4.host.reset(), true);
  assert.equal(h4.host.isOff(), false);
  assert.equal(h4.host.getState(), 'idle');
  assert.equal(h4.recs.length, 0); // reset never opens the mic
});

test('disposal is idempotent and suppresses late callbacks across layers', async () => {
  let resolveTransport;
  const h = makeHost({
    assessTranscript: ACCEPT,
    submitTurn: () => new Promise((res) => (resolveTransport = res)),
  });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('in flight'));
  await flush();
  assert.equal(h.host.getState(), 'thinking');

  h.host.dispose();
  h.host.dispose(); // idempotent
  assert.equal(h.host.isDisposed(), true);

  resolveTransport({ reply: 'too late', speechSafe: 'too late' });
  h.recs[0].fireResult(finalResult('also late'));
  await flush();
  assert.equal(h.els.reply.textContent, ''); // no late reply rendered
  const typed = await h.host.submitTyped('after dispose');
  assert.equal(typed.reason, 'disposed');
});

// ===========================================================================
// Unavailable browser APIs
// ===========================================================================

test('missing speech APIs disable Voice gracefully; typed conversation still works', async () => {
  const h = makeHost({ windowRef: undefined, assessTranscript: ACCEPT });
  assert.equal(h.host.isVoiceAvailable(), false);
  assert.equal(h.host.isMounted(), true);
  // startListening is a graceful no-op (no throw, no mic).
  assert.equal(h.host.startListening(), false);
  assert.equal(h.recs.length, 0);
  // Typed conversation remains fully usable.
  const r = await h.host.submitTyped('typed still works');
  await flush();
  assert.equal(r.accepted, true);
  assert.equal(h.transportCalls.length, 1);
  assert.equal(h.transportCalls[0].source, 'text');
});

// ===========================================================================
// Throwing / malformed dependencies fail closed
// ===========================================================================

test('throwing policies fail closed (no crash, no auto-submit, no speech)', async () => {
  const h = makeHost({
    assessTranscript: () => { throw new Error('assess boom'); }, // -> confirm, not submitted
    isSpeechAllowed: () => { throw new Error('policy boom'); }, // -> deny speech
    speechSafe: 'x',
  });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('unclear-ish'));
  await flush();
  assert.equal(h.transportCalls.length, 0); // throwing assess -> not auto-submitted
  assert.equal(h.synthesis.spoken.length, 0); // throwing speech policy -> no audio
});

test('throwing render sink never breaks the host', async () => {
  const boom = () => { throw new Error('render boom'); };
  const h = makeHost({
    assessTranscript: ACCEPT,
    render: { status: boom, interim: boom, reply: boom, confirm: boom, error: boom },
  });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('go'));
  await flush();
  // The turn flowed all the way through the transport despite every render sink
  // throwing, and the host never crashed.
  assert.equal(h.transportCalls.length, 1);
  assert.ok(['idle', 'thinking', 'speaking', 'error'].includes(h.host.getState()));
});

test('missing required identity/transport fails closed at construction', () => {
  assert.throws(() => createReinaInAppVoiceHost({ newId: () => 'x', submitTurn: async () => ({}) }));
  assert.throws(() => createReinaInAppVoiceHost({ conversationId: 'c', submitTurn: async () => ({}) }));
  assert.throws(() => createReinaInAppVoiceHost({ conversationId: 'c', newId: () => 'x' }));
});

test('a rejecting transport never yields an unhandled rejection', async () => {
  const h = makeHost({
    assessTranscript: ACCEPT,
    submitTurn: async () => { throw new Error('transport down'); },
  });
  const r = await h.host.submitTyped('will fail');
  await flush();
  // The turn is ACCEPTED for dispatch and resolves cleanly (no thrown/unhandled
  // rejection); the transport failure surfaces as an error STATE, not a reject.
  assert.equal(typeof r, 'object');
  assert.equal(h.host.getState(), 'error');
});

// ===========================================================================
// No global DOM queries
// ===========================================================================

test('no global DOM queries: full flow runs with no window/document present', async () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.window, 'undefined');
  const h = makeHost({ assessTranscript: ACCEPT });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('works without a DOM'));
  await flush();
  // The entire recognition->bridge->transport flow ran with no global DOM.
  assert.equal(h.transportCalls.length, 1);
  assert.equal(h.transportCalls[0].source, 'voice');
});
