// test/reina-voice-session.test.mjs
// Adversarial regression tests for the hardened voice session controller:
// async start-failure handling; exact-generation transcripts AND recognition
// errors; physical stop that must SUCCEED (awaited, fail-closed) before dispatch;
// bounded nonempty primitive eventId on every final transcript; validated/unique
// ids + conversation-namespaced idempotency keys; interrupt that never falsely
// claims listening; separate reply callback; preserved speech/emergency/auth/
// retry guarantees. Pure — no DOM, network, or speech APIs.
//
//   node --test test/reina-voice-session.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import VS from '../public/reina-voice-session.js';

const { createVoiceSession } = VS;

function deferredTransport() {
  const calls = []; const pending = [];
  const submitTurn = (arg) => new Promise((resolve, reject) => { calls.push(arg); pending.push({ resolve, reject }); });
  return { submitTurn, calls, resolveLast: (v) => pending[pending.length - 1].resolve(v), resolveAt: (i, v) => pending[i].resolve(v), rejectLast: (e) => pending[pending.length - 1].reject(e), pendingCount: () => pending.length };
}
function controllablePlayback() {
  const p = []; const spoke = []; let cancelled = 0;
  const synthesizer = { speak: (t) => new Promise((res, rej) => { spoke.push(t); p.push({ res, rej }); }), cancel: () => { cancelled++; if (p.length) p[p.length - 1].rej(new Error('cancelled')); } };
  return { synthesizer, spoke, completeLast: () => p[p.length - 1].res(), failLast: () => p[p.length - 1].rej(new Error('tts')), cancelledCount: () => cancelled };
}
function mocks(over = {}) {
  const rec = Object.assign({ started: 0, stopped: 0, muted: null, start() { this.started++; }, stop() { this.stopped++; }, mute(m) { this.muted = m; } }, over.rec || {});
  const play = controllablePlayback();
  const t = deferredTransport();
  const states = []; const replies = []; let n = 0;
  const s = createVoiceSession(Object.assign({
    conversationId: 'conv-1', newId: over.newId || (() => 'k-' + (++n)),
    recognizer: rec, synthesizer: play.synthesizer, submitTurn: t.submitTurn,
    assessTranscript: over.assess || (() => ({ decision: 'accept' })),
    isSpeechAllowed: over.speech || (() => false),
    isEmergencyOff: over.off || (() => false),
    onState: (st, d) => states.push([st, d]), onReply: (r) => replies.push(r),
  }, over.deps || {}));
  return { s, rec, play, t, states, replies };
}
const tick = () => new Promise((r) => setImmediate(r));

// ── construction contract ────────────────────────────────────────────────────
test('requires conversationId and newId', () => {
  assert.throws(() => createVoiceSession({ newId: () => 'x' }), /conversationId is required/);
  assert.throws(() => createVoiceSession({ conversationId: 'c' }), /newId\(\) is required/);
});

// ── 1) startListening handles sync throw + rejected start promise ────────────
test('startListening() returns false for a synchronous start throw (no false listening)', async () => {
  const { s } = mocks({ rec: { start() { throw new Error('permission'); } } });
  assert.equal(await s.startListening(), false);
  assert.notEqual(s.getState(), 'listening');
  assert.equal(s.getState(), 'error');
});
test('startListening() returns false for a REJECTED start promise; no unhandled rejection', async () => {
  const { s } = mocks({ rec: { start() { return Promise.reject(new Error('mic busy')); } } });
  assert.equal(await s.startListening(), false);
  assert.notEqual(s.getState(), 'listening');
});
test('startListening() resolves to listening on success (sync or async start)', async () => {
  const a = mocks(); assert.equal(await a.s.startListening(), true); assert.equal(a.s.getState(), 'listening');
  const b = mocks({ rec: { start() { return Promise.resolve(); } } }); assert.equal(await b.s.startListening(), true); assert.equal(b.s.getState(), 'listening');
});

// ── stop-before-dispatch: awaited + fail-closed ──────────────────────────────
test('submit dispatches NOTHING and enters a typed error if recognizer.stop() throws synchronously', async () => {
  const { s, t } = mocks({ rec: { start() {}, stop() { throw new Error('stop boom'); }, mute() {} } });
  const r = await s.submit('go', 'text');
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'recognition_stop_failed');
  assert.equal(s.getState(), 'error');
  assert.equal(t.calls.length, 0, 'transport never invoked');
});
test('submit dispatches NOTHING and enters a typed error if recognizer.stop() REJECTS', async () => {
  const { s, t } = mocks({ rec: { start() {}, stop() { return Promise.reject(new Error('stop reject')); }, mute() {} } });
  const r = await s.submit('go', 'text');
  assert.equal(r.reason, 'recognition_stop_failed');
  assert.equal(s.getState(), 'error');
  assert.equal(t.calls.length, 0);
});
test('a successful physical stop is AWAITED before the transport is invoked', async () => {
  let stoppedAt = -1, submittedAt = -1, clock = 0;
  const rec = { started: 0, stopped: 0, start() { this.started++; }, stop() { this.stopped++; stoppedAt = ++clock; return Promise.resolve(); }, mute() {} };
  const t = deferredTransport();
  const s = createVoiceSession({ conversationId: 'c', newId: (() => { let i = 0; return () => 'id' + (++i); })(), recognizer: rec, submitTurn: (a) => { submittedAt = ++clock; return t.submitTurn(a); }, assessTranscript: () => ({ decision: 'accept' }) });
  await s.submit('hi', 'text');
  assert.ok(stoppedAt > 0 && submittedAt > 0, 'both ran');
  assert.ok(stoppedAt < submittedAt, 'physical stop completes before transport');
});

// ── 2) exact-generation transcripts ──────────────────────────────────────────
test('a transcript MISSING the generation is denied', async () => {
  const { s, t } = mocks();
  await s.startListening();
  assert.equal(s.handleTranscript('x', { final: true, eventId: 'e' }).reason, 'missing_generation');
  assert.equal(t.calls.length, 0);
});
test('a transcript with a STALE generation is denied; exact generation is accepted', async () => {
  const { s, t } = mocks();
  await s.startListening();
  const gen = s.getGeneration();
  assert.equal(s.handleTranscript('x', { final: true, eventId: 'e0', generation: gen - 1 }).reason, 'stale_generation');
  await s.handleTranscript('hello', { final: true, eventId: 'e1', generation: gen });
  assert.equal(t.calls.length, 1);
});

test('a trusted assessment may remove an app-owned wake phrase but cannot replace the transcript with malformed data', async () => {
  const wake = mocks({ assess: () => ({ decision: 'accept', text: 'What needs attention?' }) });
  await wake.s.startListening();
  await wake.s.handleTranscript('Hey Reina, what needs attention?', {
    final: true, eventId: 'wake-1', generation: wake.s.getGeneration(),
  });
  assert.equal(wake.t.calls[0].text, 'What needs attention?');

  const malformed = mocks({ assess: () => ({ decision: 'accept', text: { forged: true } }) });
  await malformed.s.startListening();
  await malformed.s.handleTranscript('original words', {
    final: true, eventId: 'wake-2', generation: malformed.s.getGeneration(),
  });
  assert.equal(malformed.t.calls[0].text, 'original words');
});
test('a final transcript arriving during a graceful Stop is accepted once', async () => {
  const { s, t } = mocks();
  await s.startListening(); const gen = s.getGeneration();
  s.stopListening();
  await s.handleTranscript('finish this clip', { final: true, eventId: 'e', generation: gen });
  assert.equal(t.calls.length, 1);
});

// ── 3) every final transcript needs a bounded nonempty primitive eventId ─────
test('a final transcript with NO / non-primitive / oversized eventId is denied', async () => {
  for (const bad of [undefined, null, '', '   ', {}, [], true, false, { id: 1 }, 'x'.repeat(201)]) {
    const { s, t } = mocks();
    await s.startListening();
    const r = s.handleTranscript('hi', { final: true, eventId: bad, generation: s.getGeneration() });
    assert.equal(r.reason, 'invalid_event_id', `eventId=${JSON.stringify(bad)} must deny`);
    assert.equal(t.calls.length, 0);
  }
});
test('a final transcript WITH a valid primitive eventId (string or finite number) is accepted and de-duped', async () => {
  const a = mocks(); await a.s.startListening();
  await a.s.handleTranscript('hi', { final: true, eventId: 12345, generation: a.s.getGeneration() });
  assert.equal(a.t.calls.length, 1, 'finite-number eventId accepted');

  // same event id re-delivered while still listening is a duplicate (deduped)
  const b = mocks({ assess: () => ({ decision: 'confirm' }) }); // stays listening
  await b.s.startListening();
  const g = b.s.getGeneration();
  assert.equal(b.s.handleTranscript('hi', { final: true, eventId: 'evt-1', generation: g }).reason, 'confirmation_required');
  assert.equal(b.s.handleTranscript('hi', { final: true, eventId: 'evt-1', generation: g }).reason, 'duplicate_final');
});

// ── stop recognition before dispatching an accepted turn ─────────────────────
test('an accepted voice turn STOPS recognition before dispatch; typed turn stops too', async () => {
  const { s, rec, t } = mocks();
  await s.startListening();
  await s.handleTranscript('go', { final: true, eventId: 'e', generation: s.getGeneration() });
  assert.ok(rec.stopped >= 1, 'recognizer stopped before dispatch');
  assert.equal(s.getState(), 'thinking');
  assert.equal(t.calls.length, 1);
  const before = rec.stopped;
  await s.submit('typed', 'text');
  assert.ok(rec.stopped > before, 'typed turn also stops recognition');
});

// ── id validation + namespaced idempotency keys ──────────────────────────────
test('invalid generated id (empty/oversized/non-string) is rejected before submit', async () => {
  for (const bad of ['', '   ', 'x'.repeat(201), 123, null]) {
    const { s, t } = mocks({ newId: () => bad });
    assert.equal((await s.submit('hi', 'text')).reason, 'invalid_turn_id');
    assert.equal(t.calls.length, 0);
  }
});
test('reused ids are rejected (unique within session)', async () => {
  const { s, t } = mocks({ newId: () => 'same-id' });
  assert.equal((await s.submit('a', 'text')).accepted, true);
  const r2 = await s.submit('b', 'text');
  assert.equal(r2.accepted, false);
  assert.equal(r2.reason, 'invalid_turn_id');
  assert.equal(t.calls.length, 1);
});
test('idempotency key is namespaced by conversationId and stable across retries', async () => {
  const { s, t } = mocks({ newId: (() => { let n = 0; return () => 'id' + (++n); })() });
  await s.submit('a', 'text');
  const key = t.calls[0].idempotencyKey;
  assert.match(key, /^rvk1\|6:conv-1\|3:id1$/, 'length-prefixed encoding of conversationId + turnId');
  t.rejectLast(new Error('net')); await tick();
  s.retry();
  assert.equal(t.calls[1].idempotencyKey, key, 'retry reuses the same namespaced key');
});

// ── interrupt never falsely claims listening ─────────────────────────────────
test('interrupt() restarts recognition -> listening; if start fails -> not listening', async () => {
  const ok = mocks({ speech: () => true });
  await ok.s.submit('q', 'text'); ok.t.resolveLast({ reply: 'r', speechSafe: 'say' }); await tick();
  assert.equal(ok.s.getState(), 'speaking');
  assert.equal(await ok.s.interrupt(), true);
  assert.equal(ok.s.getState(), 'listening');
  assert.equal(ok.play.cancelledCount() >= 1, true);

  const bad = mocks({ rec: { start() { throw new Error('no mic'); }, stop() {}, mute() {} } });
  assert.equal(await bad.s.interrupt(), false);
  assert.notEqual(bad.s.getState(), 'listening');
});

// ── generation-scoped recognition-error handler ──────────────────────────────
test('recognition errors of each kind transition to a typed error while active', async () => {
  for (const kind of ['permission_denied', 'no_speech', 'network', 'aborted']) {
    const { s } = mocks();
    await s.startListening();
    const r = s.handleRecognitionError({ kind, generation: s.getGeneration() });
    assert.equal(r.handled, true);
    assert.equal(s.getState(), 'error');
  }
});
test('a recognition error with a MISSING generation is denied (ignored)', async () => {
  const { s } = mocks();
  await s.startListening();
  const r = s.handleRecognitionError({ kind: 'network' });
  assert.equal(r.handled, false);
  assert.equal(r.reason, 'missing_generation');
  assert.equal(s.getState(), 'listening');
});
test('a stale-generation recognition error is ignored', async () => {
  const { s } = mocks();
  await s.startListening();
  const r = s.handleRecognitionError({ kind: 'network', generation: s.getGeneration() - 5 });
  assert.equal(r.handled, false);
  assert.equal(r.reason, 'stale_generation');
  assert.equal(s.getState(), 'listening');
});

// ── reply is a SEPARATE callback, not a state ────────────────────────────────
test('reply is delivered via onReply; state never becomes a pseudo "replied"', async () => {
  const { s, t, states, replies } = mocks({ speech: () => false });
  await s.submit('hi', 'text');
  t.resolveLast({ reply: 'full answer', speechSafe: 'safe' }); await tick();
  assert.deepEqual(replies.map((r) => r.reply), ['full answer']);
  assert.ok(!states.some(([st]) => st === 'replied'), 'no undocumented replied state');
  assert.equal(s.getState(), 'idle');
});

// ── preserved guarantees ─────────────────────────────────────────────────────
test('speech OFF by default; only speechSafe is ever spoken; stays speaking until playback settles', async () => {
  const off = mocks({ speech: () => false });
  await off.s.submit('q', 'text'); off.t.resolveLast({ reply: 'FULL SENSITIVE', speechSafe: 'safe' }); await tick();
  assert.equal(off.play.spoke.length, 0);
  assert.equal(off.s.getState(), 'idle');

  const on = mocks({ speech: () => true });
  await on.s.submit('q', 'text'); on.t.resolveLast({ reply: 'FULL SENSITIVE 1234', speechSafe: 'short safe' }); await tick();
  assert.equal(on.s.getState(), 'speaking');
  assert.deepEqual(on.play.spoke, ['short safe']);
  assert.ok(!on.play.spoke.join(' ').includes('SENSITIVE'));
  on.play.completeLast(); await tick();
  assert.equal(on.s.getState(), 'idle');
});
test('whitespace-only reply and speech failure are handled honestly', async () => {
  const ws = mocks({ speech: () => true });
  await ws.s.submit('q', 'text'); ws.t.resolveLast({ reply: '   ', speechSafe: 'x' }); await tick();
  assert.equal(ws.s.getState(), 'error');
  const sf = mocks({ speech: () => true });
  await sf.s.submit('q', 'text'); sf.t.resolveLast({ reply: 'r', speechSafe: 'say' }); await tick();
  sf.play.failLast(); await tick();
  assert.equal(sf.s.getState(), 'idle');
  assert.ok(sf.states.some(([st, d]) => st === 'idle' && d && d.speechError === true));
});
test('auth expiry -> error, no auto-retry; retry reuses stable identity', async () => {
  const { s, t } = mocks({ newId: (() => { let n = 0; return () => 'id' + (++n); })() });
  await s.submit('q', 'text');
  const e = new Error('exp'); e.code = 'auth_expired';
  t.rejectLast(e); await tick();
  assert.equal(s.getState(), 'error');
  assert.equal(t.calls.length, 1);
  s.retry(); assert.equal(t.calls[1].idempotencyKey, t.calls[0].idempotencyKey);
});
test('emergency off stops mic, cancels speech, blocks turns; mid-flight suppressed', async () => {
  let off = false;
  const m = mocks({ off: () => off, speech: () => true });
  await m.s.startListening(); m.s.emergencyOff();
  assert.equal(m.s.getState(), 'off');
  assert.ok(m.rec.stopped >= 1);
  assert.equal(await m.s.startListening(), false);
  assert.equal((await m.s.submit('x', 'text')).reason, 'off');
  const m2 = mocks({ off: () => off, speech: () => true });
  off = false; await m2.s.submit('q', 'text'); off = true; m2.t.resolveLast({ reply: 'r', speechSafe: 's' }); await tick();
  assert.equal(m2.play.spoke.length, 0);
});
test('a superseded (stale) response is suppressed', async () => {
  const { s, t, replies } = mocks({ newId: (() => { let n = 0; return () => 'id' + (++n); })() });
  await s.submit('first', 'text'); await s.submit('second', 'text');
  assert.equal(t.pendingCount(), 2);
  t.resolveAt(0, { reply: 'STALE' }); t.resolveAt(1, { reply: 'final' }); await tick();
  assert.deepEqual(replies.map((r) => r.reply), ['final']);
});

// ═══ REMAINING FIVE CORRECTIONS ══════════════════════════════════════════════

// ── (1) speech-policy evaluation: sync OR async, exactly-true only ───────────
test('async isSpeechAllowed resolving true permits speech; resolving false denies', async () => {
  const yes = mocks({ speech: () => Promise.resolve(true) });
  await yes.s.submit('q', 'text'); yes.t.resolveLast({ reply: 'r', speechSafe: 'say' }); await tick();
  assert.equal(yes.s.getState(), 'speaking');
  assert.deepEqual(yes.play.spoke, ['say']);

  const no = mocks({ speech: () => Promise.resolve(false) });
  await no.s.submit('q', 'text'); no.t.resolveLast({ reply: 'r', speechSafe: 'say' }); await tick();
  assert.equal(no.play.spoke.length, 0);
  assert.equal(no.s.getState(), 'idle');
});
test('malformed speech-policy results (non-true primitives/objects) deny speech', async () => {
  for (const v of ['true', 1, {}, [], 'yes', null, undefined, NaN, Promise.resolve('true'), Promise.resolve(1)]) {
    const m = mocks({ speech: () => v });
    await m.s.submit('q', 'text'); m.t.resolveLast({ reply: 'r', speechSafe: 'say' }); await tick();
    assert.equal(m.play.spoke.length, 0, `speech must be denied for ${JSON.stringify(v === undefined ? 'undefined' : v)}`);
    assert.equal(m.s.getState(), 'idle');
  }
});
test('a throwing OR rejecting speech policy denies speech with no unhandled rejection', async () => {
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  try {
    const thrower = mocks({ speech: () => { throw new Error('policy boom'); } });
    await thrower.s.submit('q', 'text'); thrower.t.resolveLast({ reply: 'r', speechSafe: 'say' }); await tick();
    assert.equal(thrower.play.spoke.length, 0);
    assert.equal(thrower.s.getState(), 'idle');

    const rejecter = mocks({ speech: () => Promise.reject(new Error('policy reject')) });
    await rejecter.s.submit('q', 'text'); rejecter.t.resolveLast({ reply: 'r', speechSafe: 'say' }); await tick();
    assert.equal(rejecter.play.spoke.length, 0);
    assert.equal(rejecter.s.getState(), 'idle');
    await tick();
  } finally { process.removeListener('unhandledRejection', onRej); }
  assert.deepEqual(rejections, [], 'no unhandled rejection leaked from speech policy');
});

// ── (2) emergency-OFF microphone race ────────────────────────────────────────
test('emergency OFF during a pending start() leaves recognition inactive and the session OFF', async () => {
  let releaseStart; let started = 0, stopped = 0;
  const rec = {
    start() { started++; return new Promise((res) => { releaseStart = res; }); },
    stop() { stopped++; },
    mute() {},
  };
  const t = deferredTransport();
  const s = createVoiceSession({ conversationId: 'conv-1', newId: (() => { let n = 0; return () => 'id' + (++n); })(), recognizer: rec, submitTurn: t.submitTurn, assessTranscript: () => ({ decision: 'accept' }) });
  const startingP = s.startListening();      // start() is dispatched a microtask later
  await tick();                              // let recognizer.start() actually be invoked
  assert.equal(started, 1, 'start() is pending');
  s.emergencyOff();                          // OFF arrives mid-start
  assert.equal(s.getState(), 'off');
  releaseStart();                            // start() now resolves successfully
  assert.equal(await startingP, false, 'a late successful start does not claim listening');
  assert.equal(s.getState(), 'off', 'session remains OFF');
  assert.ok(stopped >= 2, 'recognizer stopped again after the late start settled');
  // accepts no transcript or turn while OFF
  assert.equal(s.handleTranscript('hi', { final: true, eventId: 'e', generation: s.getGeneration() }).reason, 'off');
  assert.equal((await s.submit('x', 'text')).reason, 'off');
  assert.equal(t.calls.length, 0);
});

// ── (3) collision-free idempotency identity ──────────────────────────────────
test('idempotency keys cannot collide across the conversation/turn boundary', async () => {
  async function keyFor(conversationId, forcedTurnId) {
    const t = deferredTransport();
    const s = createVoiceSession({ conversationId, newId: () => forcedTurnId, recognizer: { start() {}, stop() {}, mute() {} }, submitTurn: t.submitTurn });
    await s.submit('hi', 'text');
    return t.calls[0].idempotencyKey;
  }
  const k1 = await keyFor('a::turn:b', 'c');   // (conv "a::turn:b", turn "c")
  const k2 = await keyFor('a', 'b::turn:c');   // (conv "a", turn "b::turn:c")
  assert.notEqual(k1, k2, 'crafted delimiters must not produce the same key');
});
test('idempotency identity is stable across retries (unchanged encoding)', async () => {
  const { s, t } = mocks({ newId: (() => { let n = 0; return () => 'id' + (++n); })() });
  await s.submit('q', 'text');
  const k = t.calls[0].idempotencyKey;
  t.rejectLast(new Error('net')); await tick();
  s.retry();
  assert.equal(t.calls[1].idempotencyKey, k);
});

// ── (4) safe interruption ordering ───────────────────────────────────────────
test('interrupt() awaits cancel BEFORE start; mic never listens while cancel is unsettled', async () => {
  const order = [];
  let releaseCancel; let started = 0;
  const synthesizer = { speak: () => new Promise(() => {}), cancel: () => { order.push('cancel:start'); return new Promise((res) => { releaseCancel = () => { order.push('cancel:done'); res(); }; }); } };
  const recognizer = { start() { order.push('recognizer:start'); started++; }, stop() {}, mute() {} };
  const t = deferredTransport();
  const s = createVoiceSession({ conversationId: 'conv-1', newId: (() => { let n = 0; return () => 'id' + (++n); })(), recognizer, synthesizer, submitTurn: t.submitTurn, isSpeechAllowed: () => true, assessTranscript: () => ({ decision: 'accept' }) });
  await s.submit('q', 'text'); t.resolveLast({ reply: 'r', speechSafe: 'say' }); await tick();
  const ip = s.interrupt();
  await tick();
  assert.equal(started, 0, 'recognition must NOT start while cancel is pending');
  assert.notEqual(s.getState(), 'listening');
  releaseCancel();
  assert.equal(await ip, true);
  assert.equal(s.getState(), 'listening');
  assert.deepEqual(order, ['cancel:start', 'cancel:done', 'recognizer:start'], 'cancel settles before start');
});
test('a thrown or rejected cancel fails interrupt closed and never starts recognition', async () => {
  for (const cancel of [() => { throw new Error('cancel boom'); }, () => Promise.reject(new Error('cancel reject'))]) {
    let started = 0;
    const recognizer = { start() { started++; }, stop() {}, mute() {} };
    const s = createVoiceSession({ conversationId: 'conv-1', newId: () => 'id1', recognizer, synthesizer: { speak: () => Promise.resolve(), cancel }, submitTurn: () => new Promise(() => {}) });
    const r = await s.interrupt();
    assert.equal(r, false);
    assert.equal(started, 0, 'recognition never started after a failed cancel');
    assert.equal(s.getState(), 'error');
  }
});

// ── (5) injected dependency failures never escape ────────────────────────────
test('a throwing isEmergencyOff never escapes and fails closed (blocks dispatch/speak/start)', async () => {
  const t = deferredTransport();
  const rec = { started: 0, start() { this.started++; }, stop() {}, mute() {} };
  const s = createVoiceSession({ conversationId: 'conv-1', newId: () => 'id1', recognizer: rec, submitTurn: t.submitTurn, isEmergencyOff: () => { throw new Error('off boom'); } });
  // no public method throws; all fail closed to OFF
  assert.equal(await s.startListening(), false);
  assert.equal(s.getState(), 'off');
  assert.equal((await s.submit('x', 'text')).reason, 'off');
  assert.equal(s.handleTranscript('x', { final: true, eventId: 'e', generation: s.getGeneration() }).reason, 'off');
  assert.equal(t.calls.length, 0);
});
test('a malformed (non-boolean) isEmergencyOff is treated as OFF (fail closed)', async () => {
  const t = deferredTransport();
  const s = createVoiceSession({ conversationId: 'conv-1', newId: () => 'id1', recognizer: { start() {}, stop() {}, mute() {} }, submitTurn: t.submitTurn, isEmergencyOff: () => ({ weird: true }) });
  assert.equal((await s.submit('x', 'text')).reason, 'off');
  assert.equal(s.getState(), 'off');
  assert.equal(t.calls.length, 0);
});

test('authoritative OFF that flips while async speech policy is pending prevents playback', async () => {
  let resolveSpeech;
  let emergencyOff = false;
  const spoken = [];
  const turn = deferredTransport();
  const session = createVoiceSession({
    conversationId: 'conv-off-policy-race',
    newId: () => 'turn-off-policy-race',
    recognizer: { start() {}, stop() {}, mute() {} },
    synthesizer: {
      speak(text) { spoken.push(text); return Promise.resolve(); },
      cancel() {},
    },
    submitTurn: turn.submitTurn,
    isEmergencyOff: () => emergencyOff,
    isSpeechAllowed: () => new Promise((resolve) => { resolveSpeech = resolve; }),
  });

  const submitted = await session.submit('hello', 'typed');
  assert.equal(submitted.accepted, true);
  turn.resolveLast({ reply: 'written remains available', speechSafe: 'must not speak' });
  await tick();
  assert.equal(typeof resolveSpeech, 'function');
  emergencyOff = true;
  resolveSpeech(true);
  await tick();
  await tick();

  assert.deepEqual(spoken, []);
  assert.equal(session.getState(), 'off');
});
test('a throwing verdict.decision getter never escapes handleTranscript (falls to confirmation)', async () => {
  const t = deferredTransport();
  const verdict = {}; Object.defineProperty(verdict, 'decision', { get() { throw new Error('getter boom'); } });
  const s = createVoiceSession({ conversationId: 'conv-1', newId: () => 'id1', recognizer: { start() {}, stop() {}, mute() {} }, submitTurn: t.submitTurn, assessTranscript: () => verdict });
  await s.startListening();
  const r = s.handleTranscript('hi', { final: true, eventId: 'e', generation: s.getGeneration() });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'confirmation_required', 'a throwing decision is not treated as accept');
  assert.equal(t.calls.length, 0, 'nothing dispatched');
});

// ── source boundary ──────────────────────────────────────────────────────────
test('no DOM/speech/network globals and no invented threshold in source', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'public', 'reina-voice-session.js'), 'utf8');
  for (const banned of ['navigator', 'window.speech', 'SpeechRecognition', 'fetch(', 'XMLHttpRequest', 'document.', 'twilio', '/api/', '0.5', 'replied']) {
    assert.ok(!src.includes(banned), `voice core must not reference "${banned}"`);
  }
});
