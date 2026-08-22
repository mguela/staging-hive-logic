// test/reina-typed-panel-controller.test.mjs
// Focused tests for the dependency-injected typed Reina panel controller:
// natural typed submission + follow-up continuity; correction + unknown; one-
// submit-at-a-time (duplicate Enter/click suppression); stable retry idempotency;
// mismatched conversation/turn rejection; authorization expiry; network/backend/
// persistence failure; structural executed:false; transparency-field rendering;
// injection / unsafe-HTML rendered inertly (and HTML payloads rejected); and the
// fixed typed request shape with no client authority. Pure — no DOM or network.
//
//   node --test test/reina-typed-panel-controller.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import RTP from '../public/reina-typed-panel-controller.js';

const { createTypedPanel, EXECUTION_STATEMENT, ENVELOPE_VERSION, PREVIEW_NOTICE } = RTP;

function goodEnvelope(over = {}) {
  return Object.assign({
    version: ENVELOPE_VERSION,
    answer: 'DEMO-231 needs a materials confirmation.',
    evidence: [{ source: 'HiveLogic Reina synthetic preview fixtures', dataClass: 'synthetic', synthetic: true, detail: 'DEMO-231 has materials_confirm missing.' }],
    freshness: { known: true, asOf: '2026-08-02T14:00:00Z', note: 'Fixed synthetic snapshot.' },
    missingInformation: ['A real materials confirmation is not available.'],
    conflictingInformation: [],
    uncertainty: ['No live source was consulted.'],
    refused: false,
    refusalReason: null,
    executed: false,
    executionStatement: EXECUTION_STATEMENT,
  }, over);
}
function goodResponse(turn, over = {}) {
  return Object.assign({
    ok: true, enabled: true, previewMode: true, synthetic: true, kind: 'typed_answer',
    conversationId: turn.conversationId, turnId: turn.turnId, idempotencyKey: turn.idempotencyKey,
    replayed: false, stored: true, dataAccess: 'synthetic',
    toolExecutionAllowed: false, businessActionAllowed: false, automationTaskAllowed: false,
    envelope: goodEnvelope(),
  }, over);
}
function authorizedResponse(turn, over = {}) {
  return goodResponse(turn, Object.assign({
    synthetic: false,
    dataAccess: 'authorized_read',
    envelope: goodEnvelope({
      answer: 'The verified HiveLogic read is ready.',
      evidence: [{ source: 'HiveLogic read-only bridge', dataClass: 'authorized_read', synthetic: false, detail: 'Verified server-owned read.' }],
    }),
  }, over));
}
// A controllable transport: records requests, resolves/rejects on demand.
function harness(over = {}) {
  const requests = []; const pending = []; const views = []; let n = 0;
  const submitTurn = over.submitTurn || ((req) => new Promise((resolve, reject) => { requests.push(req); pending.push({ req, resolve, reject }); }));
  const panel = createTypedPanel({
    conversationId: over.conversationId || 'conv-preview-1',
    newId: over.newId || (() => 'turn-' + (++n)),
    submitTurn,
    onView: (vm) => views.push(vm),
  });
  return { panel, requests, pending, views, last: () => views[views.length - 1], resolveLast: (v) => pending[pending.length - 1].resolve(v), rejectLast: (e) => pending[pending.length - 1].reject(e) };
}
const tick = () => new Promise((r) => setImmediate(r));

// ── construction contract ────────────────────────────────────────────────────
test('requires conversationId, newId, and an injected submitTurn seam', () => {
  assert.throws(() => createTypedPanel({ newId: () => 'x', submitTurn: () => {} }), /conversationId is required/);
  assert.throws(() => createTypedPanel({ conversationId: 'c', submitTurn: () => {} }), /newId/);
  assert.throws(() => createTypedPanel({ conversationId: 'c', newId: () => 'x' }), /submitTurn/);
});

// ── fixed request shape — no client authority ────────────────────────────────
test('sends ONLY {utterance, conversationId, turnId, idempotencyKey, transport:typed} — no role/company/tools/auth', () => {
  const h = harness();
  const r = h.panel.submit('what is the status of DEMO-231?');
  assert.equal(r.accepted, true);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(Object.keys(h.requests[0]).sort(), ['conversationId', 'idempotencyKey', 'transport', 'turnId', 'utterance']);
  assert.equal(h.requests[0].transport, 'typed');
  assert.equal(h.requests[0].conversationId, 'conv-preview-1');
  assert.match(h.requests[0].idempotencyKey, /^conv:conv-preview-1::turn:turn-1$/);
});

// ── natural submission + follow-up continuity ────────────────────────────────
test('natural typed submission answers; a follow-up keeps the same conversationId with a new turnId', async () => {
  const h = harness();
  const first = h.panel.submit('how is DEMO-231 doing?');
  h.resolveLast(goodResponse({ conversationId: 'conv-preview-1', turnId: first.turnId, idempotencyKey: first.idempotencyKey })); await tick();
  assert.equal(h.panel.getState(), 'answered');
  assert.equal(h.last().answer, 'DEMO-231 needs a materials confirmation.');
  const follow = h.panel.submit('and what is missing?');
  assert.equal(follow.conversationId, 'conv-preview-1', 'same conversation');
  assert.notEqual(follow.turnId, first.turnId, 'new turn');
  h.resolveLast(goodResponse({ conversationId: 'conv-preview-1', turnId: follow.turnId, idempotencyKey: follow.idempotencyKey })); await tick();
  assert.equal(h.panel.getState(), 'answered');
});

test('a correlated authorized read-only Reina answer renders instead of being silently rejected', async () => {
  const h = harness();
  const turn = h.panel.submit('How is the business doing today?');
  h.resolveLast(authorizedResponse({ conversationId: 'conv-preview-1', turnId: turn.turnId, idempotencyKey: turn.idempotencyKey }));
  await tick();
  assert.equal(h.panel.getState(), 'answered');
  assert.equal(h.last().answer, 'The verified HiveLogic read is ready.');
});

// ── correction + unknown question ────────────────────────────────────────────
test('a correction and an unknown-question answer both render honestly (refusal/uncertainty visible)', async () => {
  const h = harness();
  h.panel.submit("no, I meant DEMO-240");
  h.resolveLast(goodResponse({}, { conversationId: 'conv-preview-1', turnId: 'turn-1', idempotencyKey: 'conv:conv-preview-1::turn:turn-1', envelope: goodEnvelope({ answer: 'DEMO-240 is unscheduled.', uncertainty: ['Synthetic snapshot only.'] }) })); await tick();
  assert.equal(h.last().answer, 'DEMO-240 is unscheduled.');
  assert.deepEqual(h.last().uncertainty, ['Synthetic snapshot only.']);

  const h2 = harness();
  h2.panel.submit('what will the weather be next week?');
  h2.resolveLast(goodResponse({}, { conversationId: 'conv-preview-1', turnId: 'turn-1', idempotencyKey: 'conv:conv-preview-1::turn:turn-1', envelope: goodEnvelope({ answer: 'I cannot answer that from synthetic preview data.', refused: true, refusalReason: 'Outside read-only synthetic scope.', missingInformation: ['No live source.'] }) })); await tick();
  assert.equal(h2.last().refused, true);
  assert.equal(h2.last().refusalReason, 'Outside read-only synthetic scope.');
});

// ── one submit at a time: duplicate Enter/click suppression ───────────────────
test('duplicate click/Enter while a turn is in flight is suppressed (one submit at a time)', async () => {
  const h = harness();
  const a = h.panel.submit('first');
  const b = h.panel.submit('first again (double-enter)');
  const c = h.panel.submit('triple');
  assert.equal(a.accepted, true);
  assert.equal(b.accepted, false); assert.equal(b.reason, 'busy');
  assert.equal(c.accepted, false);
  assert.equal(h.requests.length, 1, 'only one request dispatched');
  assert.equal(h.panel.isBusy(), true);
  h.resolveLast(goodResponse({ conversationId: 'conv-preview-1', turnId: a.turnId, idempotencyKey: a.idempotencyKey })); await tick();
  assert.equal(h.panel.isBusy(), false);
});

// ── stable retry idempotency ─────────────────────────────────────────────────
test('retry after failure reuses the SAME turnId + idempotencyKey (stable identity)', async () => {
  const h = harness();
  const s = h.panel.submit('status?');
  h.rejectLast(new Error('network down')); await tick();
  assert.equal(h.panel.getState(), 'error');
  const r = h.panel.retry();
  assert.equal(r.accepted, true);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].turnId, s.turnId, 'same turnId on retry');
  assert.equal(h.requests[1].idempotencyKey, s.idempotencyKey, 'same idempotency key on retry');
});

// ── mismatched conversation/turn rejection ───────────────────────────────────
test('a response with a mismatched conversationId or turnId is rejected (not shown as an answer)', async () => {
  for (const bad of [{ conversationId: 'conv-OTHER' }, { turnId: 'turn-OTHER' }, { idempotencyKey: 'nope' }]) {
    const h = harness();
    const s = h.panel.submit('q');
    h.resolveLast(goodResponse({ conversationId: 'conv-preview-1', turnId: s.turnId, idempotencyKey: s.idempotencyKey }, bad)); await tick();
    assert.equal(h.panel.getState(), 'error', `${JSON.stringify(bad)} must be rejected`);
    assert.equal(h.last().answer, '', 'no answer rendered on mismatch');
  }
});

// ── authorization expiry ─────────────────────────────────────────────────────
test('an authorization-expired backend signal enters the auth_expired state (recoverable)', async () => {
  const h = harness();
  h.panel.submit('q');
  h.resolveLast({ ok: false, error: 'auth_expired' }); await tick();
  assert.equal(h.panel.getState(), 'auth_expired');
  assert.equal(h.last().recoverable, 'reauth');
});

// ── a rejected transport keeps the route's own reason (2026-08-15) ───────────
// api/reina-pilot.js answers 503 {"error":"disabled"} when its production flag
// gate is not fully set. The client rejects on any non-2xx, so this landed in
// .catch and was reported as 'network_error' -- the availability branch was
// unreachable for every HTTP-level failure, and the panel told users to retry
// something that cannot succeed until the route is switched on.
function routeError(serverCode) {
  const err = new Error('reina_pilot_client:route_unavailable');
  err.code = 'route_unavailable';
  if (serverCode) err.serverCode = serverCode;
  return err;
}

test('a rejection carrying a route reason is reported as that reason, not the network', async () => {
  for (const code of ['disabled', 'unavailable', 'not_enabled']) {
    const h = harness();
    h.panel.submit('q');
    h.rejectLast(routeError(code));
    await tick();
    assert.equal(h.panel.getState(), 'unavailable', `${code} must surface as unavailable`);
    assert.equal(h.last().state, 'unavailable');
  }
});

test('a rejection carrying an auth reason expires the session instead of blaming the network', async () => {
  const h = harness();
  h.panel.submit('q');
  h.rejectLast(routeError('authorization_expired'));
  await tick();
  assert.equal(h.panel.getState(), 'auth_expired');
});

test('an unrecognized route reason is a backend error; a bare rejection is still the network', async () => {
  const other = harness();
  other.panel.submit('q');
  other.rejectLast(routeError('internal'));
  await tick();
  assert.equal(other.panel.getState(), 'error');
  assert.equal(other.last().reason, 'backend_error');

  // No serverCode at all (a genuine transport drop) keeps the old reason.
  const net = harness();
  net.panel.submit('q');
  net.rejectLast(new Error('ECONNRESET'));
  await tick();
  assert.equal(net.panel.getState(), 'error');
  assert.equal(net.last().reason, 'network_error');
});

// ── network/backend/persistence failure ──────────────────────────────────────
test('network rejection, backend error, and unsaved-success each fail closed honestly', async () => {
  const net = harness(); net.panel.submit('q'); net.rejectLast(new Error('ECONNRESET')); await tick();
  assert.equal(net.panel.getState(), 'error'); assert.equal(net.last().reason, 'network_error');

  const be = harness(); const s = be.panel.submit('q'); be.resolveLast({ ok: false, error: 'internal' }); await tick();
  assert.equal(be.panel.getState(), 'error'); assert.equal(be.last().reason, 'backend_error');

  // persistence not affirmed -> unsaved success rejected
  const un = harness(); const u = un.panel.submit('q');
  un.resolveLast(goodResponse({ conversationId: 'conv-preview-1', turnId: u.turnId, idempotencyKey: u.idempotencyKey }, { stored: false })); await tick();
  assert.equal(un.panel.getState(), 'error'); assert.equal(un.last().reason, 'unsaved_success');
});

test('an unavailable/disabled backend enters the unavailable state and is retryable', async () => {
  const h = harness();
  h.panel.submit('q');
  h.resolveLast({ ok: false, error: 'unavailable', enabled: false }); await tick();
  assert.equal(h.panel.getState(), 'unavailable');
  const r = h.panel.retry();
  assert.equal(r.accepted, true);
});

// ── structural executed:false ────────────────────────────────────────────────
test('executed:true or a tampered/missing execution statement is rejected (structural executed:false)', async () => {
  for (const bad of [{ executed: true }, { executed: 'false' }, { executionStatement: 'it ran fine' }]) {
    const h = harness();
    const s = h.panel.submit('q');
    h.resolveLast(goodResponse({ conversationId: 'conv-preview-1', turnId: s.turnId, idempotencyKey: s.idempotencyKey }, { envelope: goodEnvelope(bad) })); await tick();
    assert.equal(h.panel.getState(), 'error', `${JSON.stringify(bad)} must be rejected`);
  }
  // a claimed action-permission also rejected
  const h2 = harness(); const s2 = h2.panel.submit('q');
  h2.resolveLast(goodResponse({ conversationId: 'conv-preview-1', turnId: s2.turnId, idempotencyKey: s2.idempotencyKey }, { businessActionAllowed: true })); await tick();
  assert.equal(h2.panel.getState(), 'error');
});

// ── transparency-field rendering ─────────────────────────────────────────────
test('a valid answer renders evidence, freshness, missing, conflicts, uncertainty, synthetic + nothing-executed notices', async () => {
  const h = harness();
  const s = h.panel.submit('q');
  h.resolveLast(goodResponse({ conversationId: 'conv-preview-1', turnId: s.turnId, idempotencyKey: s.idempotencyKey }, {
    envelope: goodEnvelope({ conflictingInformation: ['Two sources disagree on status.'] }),
  })); await tick();
  const vm = h.last();
  assert.equal(vm.state, 'answered');
  assert.ok(vm.evidence.length >= 1, 'evidence shown');
  assert.match(vm.freshness, /As of 2026-08-02/);
  assert.deepEqual(vm.missingInformation, ['A real materials confirmation is not available.']);
  assert.deepEqual(vm.conflictingInformation, ['Two sources disagree on status.']);
  assert.ok(vm.uncertainty.length >= 1);
  assert.equal(vm.executionNotice, EXECUTION_STATEMENT);
  assert.equal(vm.previewNotice, PREVIEW_NOTICE);
  assert.match(vm.syntheticNotice, /Read-only evidence/);
});

// ── injection / unsafe HTML rendered inertly AND html payloads rejected ───────
test('an HTML/script payload in the envelope is rejected (not rendered)', async () => {
  const h = harness();
  const s = h.panel.submit('render this');
  h.resolveLast(goodResponse({ conversationId: 'conv-preview-1', turnId: s.turnId, idempotencyKey: s.idempotencyKey }, {
    envelope: goodEnvelope({ answer: '<script>steal()</script> hi' }),
  })); await tick();
  assert.equal(h.panel.getState(), 'error');
  assert.equal(h.last().answer, '', 'HTML payload never rendered as an answer');
});
test('view-model text is always inert (control chars/tags stripped) even for accepted content', () => {
  const vm = RTP.toViewModel('answered', goodEnvelope({ answer: 'safe answer with‮ tricks' }));
  assert.ok(!/[\x00-\x08\x0B-\x1F\x7F]/.test(vm.answer), 'control chars stripped');
  assert.ok(!/[<>]/.test(vm.answer) || !/<[^>]+>/.test(vm.answer));
  assert.equal(RTP.renderPlainText(goodEnvelope({ answer: '<b>x</b>plain' })), '', 'html answer yields no plain text (rejected)');
});

// ── stale response suppression ───────────────────────────────────────────────
test('a superseded (reset) in-flight response is ignored', async () => {
  const h = harness();
  const s = h.panel.submit('q');
  h.panel.reset();
  assert.equal(h.panel.getState(), 'idle');
  h.resolveLast(goodResponse({ conversationId: 'conv-preview-1', turnId: s.turnId, idempotencyKey: s.idempotencyKey })); await tick();
  assert.equal(h.panel.getState(), 'idle', 'stale response did not overwrite state');
});

// ── no business action / Automation call is ever made by the controller ──────
test('the controller never invokes anything but the injected submitTurn seam', async () => {
  let calls = 0;
  const h = harness({ submitTurn: (req) => { calls += 1; assert.equal(req.transport, 'typed'); return Promise.resolve(goodResponse({ conversationId: req.conversationId, turnId: req.turnId, idempotencyKey: req.idempotencyKey })); } });
  h.panel.submit('q'); await tick();
  assert.equal(calls, 1, 'exactly one seam call; no other side effects');
  assert.equal(h.panel.getState(), 'answered');
});

// ── source boundary: no DOM/network/speech/business globals ───────────────────
test('controller source references no DOM/network/speech/tool globals', async () => {
  const fs = await import('node:fs'); const path = await import('node:path');
  const src = fs.readFileSync(path.join(process.cwd(), 'public', 'reina-typed-panel-controller.js'), 'utf8');
  for (const banned of ['document.', 'window.fetch', 'XMLHttpRequest', 'innerHTML', 'fetch(', 'SpeechRecognition', 'navigator', 'twilio', '/api/', 'child_process']) {
    assert.ok(!src.includes(banned), `must not reference "${banned}"`);
  }
});
