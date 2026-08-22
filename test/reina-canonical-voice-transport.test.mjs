// test/reina-canonical-voice-transport.test.mjs
//
// Integration tests for the canonical Voice transport adapter, wired through the
// REAL PR #81 Voice stack -- session + browser adapters + bridge + panel
// controller + host -- with an injected, contract-faithful serverTransport fake
// standing in for Claude 2's backend (Jobs -> knowledge -> classifier -> evidence
// composer). No real DOM, microphone, speakers, network, or business logic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanonicalVoiceTransport } from '../public/reina-canonical-voice-transport.js';
import { createReinaInAppVoiceHost } from '../public/reina-inapp-voice-host.js';
import { createInAppVoiceBridge } from '../public/reina-inapp-voice-bridge.js';

// ---------------------------------------------------------------------------
// Browser fakes
// ---------------------------------------------------------------------------
class FakeRecognition {
  constructor() {
    this.lang = null; this.interimResults = null; this.continuous = null;
    this.started = false; this.stopped = false; this.aborted = false;
    this.onstart = null; this.onresult = null; this.onerror = null; this.onend = null;
  }
  start() { this.started = true; if (this.onstart) this.onstart({}); }
  stop() { this.stopped = true; }
  abort() { this.aborted = true; }
  fireResult(ev) { if (this.onresult) this.onresult(ev); }
  fireError(code) { if (this.onerror) this.onerror({ error: code }); }
  fireEnd() { if (this.onend) this.onend({}); }
}
function finalResult(t) { return { resultIndex: 0, results: [{ isFinal: true, length: 1, 0: { transcript: t } }] }; }
function interimResult(t) { return { resultIndex: 0, results: [{ isFinal: false, length: 1, 0: { transcript: t } }] }; }

class FakeUtterance {
  constructor(text) { this.text = text; this.onstart = null; this.onend = null; this.onerror = null; }
}
class FakeSynthesis {
  constructor() { this.spoken = []; this.cancelled = 0; }
  speak(u) { this.spoken.push(u); }
  cancel() { this.cancelled++; }
}
class FakeEl {
  constructor() { this._t = ''; this.disabled = false; this._l = {}; this.innerHTMLWrites = 0; }
  get textContent() { return this._t; }
  set textContent(v) { this._t = String(v); }
  set innerHTML(_v) { this.innerHTMLWrites++; }
  get innerHTML() { return ''; }
  addEventListener(t, h) { (this._l[t] = this._l[t] || []).push(h); }
  removeEventListener(t, h) { const a = this._l[t] || []; const i = a.indexOf(h); if (i !== -1) a.splice(i, 1); }
  click() { (this._l.click || []).slice().forEach((h) => h({ type: 'click' })); }
}
function makeWindowRef(recs, utts, synthesis) {
  return {
    SpeechRecognition: function () { const r = new FakeRecognition(); recs.push(r); return r; },
    speechSynthesis: synthesis,
    SpeechSynthesisUtterance: function (t) { const u = new FakeUtterance(t); utts.push(u); return u; },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ACCEPT = () => ({ decision: 'accept' });

// A contract-faithful canonical envelope keyed off the canonical REQUEST the
// adapter sends (so IDs match by construction). `over` tweaks fields per test.
function goodEnvelope(request, over) {
  over = over || {};
  return {
    conversationId: 'conversationId' in over ? over.conversationId : request.conversationId,
    turnId: 'turnId' in over ? over.turnId : request.turnId,
    executed: 'executed' in over ? over.executed : false,
    nothingExecuted: 'nothingExecuted' in over ? over.nothingExecuted : true,
    state: 'state' in over ? over.state : 'synthetic',
    answer: {
      text: over.text != null ? over.text : 'Here is what I found.',
      speech: over.speech, // undefined -> adapter derives from text
    },
    evidence: 'evidence' in over ? over.evidence : [{ source: 'kb', ref: 'doc-1' }],
    freshness: 'freshness' in over ? over.freshness : { asOf: '2026-08-01', stale: false },
    missingInformation: 'missingInformation' in over ? over.missingInformation : [],
    conflicts: 'conflicts' in over ? over.conflicts : [],
    uncertainty: 'uncertainty' in over ? over.uncertainty : null,
    ...(over.envelopeOverride || {}),
  };
}

// ---- full host stack -------------------------------------------------------
function makeStack(o = {}) {
  const recs = [], utts = [];
  const synthesis = o.synthesis || new FakeSynthesis();
  const windowRef = makeWindowRef(recs, utts, synthesis);
  const els = { status: new FakeEl(), interim: new FakeEl(), reply: new FakeEl(), confirm: new FakeEl(), error: new FakeEl() };
  const controls = { start: new FakeEl(), stop: new FakeEl(), interrupt: new FakeEl(), mute: new FakeEl(), unmute: new FakeEl(), off: new FakeEl(), reset: new FakeEl(), confirm: new FakeEl(), dismiss: new FakeEl() };
  const serverCalls = [];
  const serverTransport = o.serverTransport || (async (req) => { serverCalls.push(req); return goodEnvelope(req, o.env); });
  const transport = createCanonicalVoiceTransport({ serverTransport, timeoutMs: o.timeoutMs });
  let idc = 0;
  const host = createReinaInAppVoiceHost({
    conversationId: o.conversationId || 'conv-canon-1',
    newId: o.newId || (() => 'turn-' + ++idc),
    submitTurn: transport.submitTurn,
    assessTranscript: o.assessTranscript,
    isSpeechAllowed: o.isSpeechAllowed,
    authorizeReset: o.authorizeReset,
    elements: els,
    controls,
    windowRef: 'windowRef' in o ? o.windowRef : windowRef,
    onControlEvent: () => {},
  });
  if (o.mount !== false) host.mount();
  return { host, transport, recs, utts, synthesis, els, controls, serverCalls };
}

// ---- direct bridge stack (for retry + auth-detail assertions) --------------
function makeBridgeStack(o = {}) {
  const recs = [], utts = [];
  const synthesis = new FakeSynthesis();
  const serverCalls = [];
  const serverTransport = o.serverTransport || (async (req) => { serverCalls.push(req); return goodEnvelope(req, o.env); });
  const transport = createCanonicalVoiceTransport({ serverTransport });
  const states = [], replies = [];
  let idc = 0;
  const bridge = createInAppVoiceBridge({
    conversationId: o.conversationId || 'conv-b-1',
    newId: o.newId || (() => 't-' + ++idc),
    submitTurn: transport.submitTurn,
    assessTranscript: o.assessTranscript,
    isSpeechAllowed: o.isSpeechAllowed,
    recognitionFactory: () => { const r = new FakeRecognition(); recs.push(r); return r; },
    synthesis,
    utteranceFactory: (t) => { const u = new FakeUtterance(t); utts.push(u); return u; },
    onState: (s, d) => states.push({ s, d }),
    onReply: (r) => replies.push(r),
    onInterim: () => {}, onNeedsConfirmation: () => {}, onError: () => {},
  });
  return { bridge, recs, utts, synthesis, serverCalls, states, replies };
}

// ===========================================================================
// Successful spoken turn + canonical request shape
// ===========================================================================

test('successful spoken turn: canonical request carries ONLY the 5 allowed fields', async () => {
  const h = makeStack({ assessTranscript: ACCEPT, isSpeechAllowed: () => true });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('what is my AR balance'));
  await flush();

  assert.equal(h.serverCalls.length, 1);
  const req = h.serverCalls[0];
  assert.deepEqual(Object.keys(req).sort(), ['conversationId', 'idempotencyKey', 'transport', 'turnId', 'utterance']);
  assert.equal(req.utterance, 'what is my AR balance');
  assert.equal(req.transport, 'voice');
  assert.equal(req.conversationId, 'conv-canon-1');
  // No client identity/role/company/capability/authorization/tools/evidence/etc.
  assert.equal('role' in req || 'company' in req || 'identity' in req || 'evidence' in req || 'tools' in req || 'authorization' in req, false);
  assert.equal(h.els.reply.textContent, 'Here is what I found.');
});

test('identical canonical response drives BOTH written and spoken (one call)', async () => {
  const h = makeStack({
    assessTranscript: ACCEPT,
    isSpeechAllowed: () => true,
    env: { text: 'WRITTEN ANSWER', speech: 'SPOKEN ANSWER' },
  });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('go'));
  await flush();
  assert.equal(h.serverCalls.length, 1); // one canonical response, not two model calls
  assert.equal(h.els.reply.textContent, 'WRITTEN ANSWER');
  assert.equal(h.synthesis.spoken.length, 1);
  assert.equal(h.synthesis.spoken[0].text, 'SPOKEN ANSWER'); // derived from same envelope
});

// ===========================================================================
// Continuity + shared identity/transport
// ===========================================================================

test('typed-to-spoken continuity: shared conversationId; transport tags typed then voice', async () => {
  const h = makeStack({ assessTranscript: ACCEPT });
  await h.host.submitTyped('typed one');
  await flush();
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('spoken two'));
  await flush();
  assert.equal(h.serverCalls.length, 2);
  assert.equal(h.serverCalls[0].transport, 'typed');
  assert.equal(h.serverCalls[1].transport, 'voice');
  assert.equal(h.serverCalls[0].conversationId, h.serverCalls[1].conversationId);
  assert.equal(h.serverCalls[0].conversationId, 'conv-canon-1');
});

test('spoken-to-typed continuity: same conversationId across both', async () => {
  const h = makeStack({ assessTranscript: ACCEPT });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('spoken first'));
  await flush();
  await h.host.submitTyped('typed second');
  await flush();
  assert.equal(h.serverCalls.length, 2);
  assert.equal(h.serverCalls[0].transport, 'voice');
  assert.equal(h.serverCalls[1].transport, 'typed');
  assert.equal(h.serverCalls[0].conversationId, h.serverCalls[1].conversationId);
});

test('matching IDs: canonical request turnId round-trips and the turn is accepted', async () => {
  const h = makeStack({ assessTranscript: ACCEPT });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('match me'));
  await flush();
  assert.ok(typeof h.serverCalls[0].turnId === 'string' && h.serverCalls[0].turnId.length > 0);
  assert.equal(h.els.reply.textContent, 'Here is what I found.'); // rendered -> IDs matched
});

// ===========================================================================
// Fail-closed validations
// ===========================================================================

test('mismatched turnId fails closed: no render, no speech, error state', async () => {
  const h = makeStack({
    assessTranscript: ACCEPT,
    isSpeechAllowed: () => true,
    serverTransport: async (req) => goodEnvelope(req, { turnId: 'WRONG-' + req.turnId }),
  });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('answer'));
  await flush();
  assert.equal(h.host.getState(), 'error');
  assert.equal(h.els.reply.textContent, '');
  assert.equal(h.synthesis.spoken.length, 0);
});

test('mismatched conversationId fails closed', async () => {
  const h = makeStack({
    assessTranscript: ACCEPT,
    serverTransport: async (req) => goodEnvelope(req, { conversationId: 'other-conv' }),
  });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('answer'));
  await flush();
  assert.equal(h.host.getState(), 'error');
  assert.equal(h.els.reply.textContent, '');
});

test('executed:true (or nothingExecuted!=true) is rejected; nothing spoken', async () => {
  for (const bad of [{ executed: true }, { nothingExecuted: false }, { envelopeOverride: { toolCalls: [{}] } }]) {
    const h = makeStack({
      assessTranscript: ACCEPT,
      isSpeechAllowed: () => true,
      serverTransport: async (req) => goodEnvelope(req, bad),
    });
    h.host.startListening();
    await flush();
    h.recs[0].fireResult(finalResult('do it'));
    await flush();
    assert.equal(h.host.getState(), 'error');
    assert.equal(h.synthesis.spoken.length, 0);
  }
});

test('unsafe HTML/script in written or speech is rejected (fail closed)', async () => {
  for (const bad of [{ text: '<script>alert(1)</script>' }, { text: 'ok', speech: '<b>hi</b>' }]) {
    const h = makeStack({
      assessTranscript: ACCEPT,
      isSpeechAllowed: () => true,
      serverTransport: async (req) => goodEnvelope(req, bad),
    });
    h.host.startListening();
    await flush();
    h.recs[0].fireResult(finalResult('go'));
    await flush();
    assert.equal(h.host.getState(), 'error');
    assert.equal(h.els.reply.textContent, ''); // never rendered
    assert.equal(h.synthesis.spoken.length, 0); // never spoken
  }
});

test('malformed envelope is rejected (missing answer / bad evidence / missing fields)', async () => {
  const bads = [
    async (req) => ({ conversationId: req.conversationId, turnId: req.turnId, executed: false, nothingExecuted: true, state: 'synthetic' }), // no answer
    async (req) => goodEnvelope(req, { evidence: 'not-an-array' }),
    async (req) => goodEnvelope(req, { evidence: ['bad-item'] }),
    async (req) => goodEnvelope(req, { state: 'verified' }), // not synthetic/unverified
    async (req) => goodEnvelope(req, { missingInformation: 'nope' }),
    async (req) => 42, // not an object at all
  ];
  for (const serverTransport of bads) {
    const h = makeStack({ assessTranscript: ACCEPT, serverTransport });
    h.host.startListening();
    await flush();
    h.recs[0].fireResult(finalResult('go'));
    await flush();
    assert.equal(h.host.getState(), 'error');
    assert.equal(h.els.reply.textContent, '');
  }
});

// ===========================================================================
// Duplicate / stale (PR #81 layers, preserved through the adapter)
// ===========================================================================

test('duplicate final transcript submits the canonical turn only once', async () => {
  const h = makeStack({ assessTranscript: ACCEPT });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('same words'));
  h.recs[0].fireResult(finalResult('same words'));
  await flush();
  assert.equal(h.serverCalls.length, 1);
});

test('stale generation: a superseded recognizer never reaches the transport', async () => {
  const h = makeStack({ assessTranscript: ACCEPT });
  h.host.startListening();
  await flush();
  h.host.stop();
  h.recs[0].fireEnd(); // the browser confirms the graceful stop
  await flush();
  h.host.startListening();
  await flush();
  assert.equal(h.recs.length, 2);
  h.recs[0].fireResult(finalResult('stale')); // detached
  h.recs[1].fireResult(finalResult('fresh'));
  await flush();
  assert.equal(h.serverCalls.length, 1);
  assert.equal(h.serverCalls[0].utterance, 'fresh');
});

test('interim transcripts never reach the transport', async () => {
  const h = makeStack({ assessTranscript: ACCEPT });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(interimResult('partial'));
  await flush();
  assert.equal(h.serverCalls.length, 0);
  assert.equal(h.els.interim.textContent, 'partial');
});

// ===========================================================================
// Retry (stable idempotency) + authorization expiry (bridge-level detail)
// ===========================================================================

test('retry reuses the SAME turnId + idempotencyKey through the canonical request', async () => {
  let n = 0;
  const b = makeBridgeStack({
    assessTranscript: ACCEPT,
    serverTransport: async (req) => {
      b.serverCalls.push(req);
      n += 1;
      if (n === 1) throw new Error('transient persistence error');
      return goodEnvelope(req);
    },
  });
  // makeBridgeStack pushes inside its default; here we replaced serverTransport,
  // so push manually above. Drive a turn:
  await b.bridge.startListening();
  await flush();
  b.recs[0].fireResult(finalResult('retry me'));
  await flush();
  assert.equal(b.bridge.getState(), 'error');

  b.bridge.retry();
  await flush();
  assert.equal(b.serverCalls.length, 2);
  assert.equal(b.serverCalls[0].turnId, b.serverCalls[1].turnId);
  assert.equal(b.serverCalls[0].idempotencyKey, b.serverCalls[1].idempotencyKey);
});

test('authorization expiry stops speech and requests reauthentication', async () => {
  const b = makeBridgeStack({
    assessTranscript: ACCEPT,
    isSpeechAllowed: () => true,
    serverTransport: async (req) => {
      b.serverCalls.push(req);
      const e = new Error('token expired');
      e.code = 'auth_expired';
      throw e;
    },
  });
  await b.bridge.startListening();
  await flush();
  b.recs[0].fireResult(finalResult('secure ask'));
  await flush();
  const err = b.states.find((x) => x.s === 'error');
  assert.ok(err);
  assert.equal(err.d.reason, 'auth_expired');
  assert.equal(err.d.recoverable, 'reauth');
  assert.equal(b.synthesis.spoken.length, 0); // never spoke a success after auth failure
});

test('in-band auth expiry (response.authExpired) also stops speech', async () => {
  const b = makeBridgeStack({
    assessTranscript: ACCEPT,
    isSpeechAllowed: () => true,
    serverTransport: async (req) => { b.serverCalls.push(req); return { authExpired: true }; },
  });
  await b.bridge.startListening();
  await flush();
  b.recs[0].fireResult(finalResult('secure ask'));
  await flush();
  const err = b.states.find((x) => x.s === 'error');
  assert.ok(err);
  assert.equal(err.d.reason, 'auth_expired');
  assert.equal(b.synthesis.spoken.length, 0);
});

// ===========================================================================
// Transport failures -> never speak a success
// ===========================================================================

test('persistence/network failure fails closed: error state, written empty, nothing spoken', async () => {
  const h = makeStack({
    assessTranscript: ACCEPT,
    isSpeechAllowed: () => true,
    serverTransport: async () => { throw new Error('persistence unavailable'); },
  });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('write it'));
  await flush();
  assert.equal(h.host.getState(), 'error');
  assert.equal(h.els.reply.textContent, '');
  assert.equal(h.synthesis.spoken.length, 0);
});

test('network/model timeout fails closed (adapter-level timeout)', async () => {
  const h = makeStack({
    assessTranscript: ACCEPT,
    isSpeechAllowed: () => true,
    timeoutMs: 20,
    serverTransport: () => new Promise(() => {}), // never resolves
  });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('slow one'));
  await wait(50);
  assert.equal(h.host.getState(), 'error');
  assert.equal(h.synthesis.spoken.length, 0);
});

// ===========================================================================
// Speech policy / mute / interruption / OFF / written survives
// ===========================================================================

test('speech disabled: written response preserved, nothing spoken', async () => {
  const h = makeStack({
    assessTranscript: ACCEPT,
    isSpeechAllowed: () => false,
    env: { text: 'read me only', speech: 'do not say' },
  });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('answer'));
  await flush();
  assert.equal(h.els.reply.textContent, 'read me only'); // written available
  assert.equal(h.synthesis.spoken.length, 0); // speech denied
});

test('written delivery survives a playback (speech) failure', async () => {
  const synthesis = new FakeSynthesis();
  synthesis.speak = () => { throw new Error('audio device gone'); };
  const h = makeStack({
    assessTranscript: ACCEPT,
    isSpeechAllowed: () => true,
    synthesis,
    env: { text: 'still readable', speech: 'attempted speech' },
  });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('answer'));
  await flush();
  assert.equal(h.els.reply.textContent, 'still readable'); // written survives
});

test('mute preserves the written answer without speaking (typed path)', async () => {
  const h = makeStack({ assessTranscript: ACCEPT, isSpeechAllowed: () => true, env: { text: 'muted read', speech: 'muted say' } });
  h.host.mute();
  await h.host.submitTyped('hi');
  await flush();
  assert.equal(h.els.reply.textContent, 'muted read');
  assert.equal(h.synthesis.spoken.length, 0);
});

test('interruption during playback cancels audio and restarts listening', async () => {
  const h = makeStack({ assessTranscript: ACCEPT, isSpeechAllowed: () => true, env: { text: 'answer', speech: 'answer aloud' } });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('go'));
  await flush();
  assert.equal(h.host.getState(), 'speaking');
  h.host.interrupt(); // fire-and-forget through the controller; drain its async chain
  await flush();
  assert.ok(h.synthesis.cancelled >= 1);
  assert.equal(h.host.getState(), 'listening');
});

test('emergency OFF during an in-flight turn suppresses the pending canonical response', async () => {
  let resolveServer;
  const h = makeStack({
    assessTranscript: ACCEPT,
    isSpeechAllowed: () => true,
    serverTransport: (req) => new Promise((res) => (resolveServer = () => res(goodEnvelope(req)))),
  });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('in flight'));
  await flush();
  assert.equal(h.host.getState(), 'thinking');

  h.host.emergencyOff();
  resolveServer(); // canonical response arrives AFTER OFF
  await flush();
  assert.equal(h.host.getState(), 'off');
  assert.equal(h.els.reply.textContent, '');
  assert.equal(h.synthesis.spoken.length, 0);
});

// ===========================================================================
// Missing browser APIs / nothing executed / no unhandled rejections
// ===========================================================================

test('missing browser speech APIs: Voice disabled, typed Reina still uses the canonical transport', async () => {
  const h = makeStack({ windowRef: undefined, assessTranscript: ACCEPT });
  assert.equal(h.host.isVoiceAvailable(), false);
  assert.equal(h.host.startListening(), false);
  assert.equal(h.recs.length, 0);
  const r = await h.host.submitTyped('typed works');
  await flush();
  assert.equal(r.accepted, true);
  assert.equal(h.serverCalls.length, 1);
  assert.equal(h.serverCalls[0].transport, 'typed');
});

test('nothing executed: request has no execution fields; accepted envelope is executed:false', async () => {
  const seen = [];
  const h = makeStack({
    assessTranscript: ACCEPT,
    serverTransport: async (req) => { seen.push(req); return goodEnvelope(req); },
  });
  h.host.startListening();
  await flush();
  h.recs[0].fireResult(finalResult('just answer'));
  await flush();
  const req = seen[0];
  assert.equal('execute' in req || 'executed' in req || 'actions' in req || 'toolCalls' in req, false);
  assert.equal(h.els.reply.textContent, 'Here is what I found.'); // rendered plain text; no action taken
});

test('failing turns never produce an unhandled promise rejection', async () => {
  const seen = [];
  process.on('unhandledRejection', (r) => seen.push(r));
  // Exercise several fail-closed paths back to back.
  const cases = [
    async () => { throw new Error('boom'); },
    async (req) => goodEnvelope(req, { executed: true }),
    async (req) => goodEnvelope(req, { turnId: 'nope' }),
    async () => 42,
  ];
  for (const serverTransport of cases) {
    const h = makeStack({ assessTranscript: ACCEPT, serverTransport });
    h.host.startListening();
    await flush();
    h.recs[0].fireResult(finalResult('go'));
    await flush();
  }
  const t = makeStack({ assessTranscript: ACCEPT, serverTransport: async () => { throw new Error('x'); } });
  await t.host.submitTyped('typed fail');
  await flush();
  await wait(10);
  process.removeAllListeners('unhandledRejection');
  assert.deepEqual(seen, []);
});
