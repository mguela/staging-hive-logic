import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import RPC from '../public/reina-pilot-client.js';
import RTP from '../public/reina-typed-panel-controller.js';
import LoginBrief from '../public/reina-login-brief-controller.js';
import { createCanonicalVoiceTransport } from '../public/reina-canonical-voice-transport.js';
import {
  buildEnvelope,
  renderPlainText as renderServerPlainText,
} from '../api/_lib/reina/evidence-envelope.js';

const {
  createReinaPilotClient,
  validateRouteResponse,
  validateCanonicalEnvelope,
  renderPlainText,
  EXECUTION_STATEMENT,
  ENDPOINT,
} = RPC;

const REQUEST = Object.freeze({
  utterance: 'What needs attention?',
  conversationId: 'conv-1',
  turnId: 'turn-1',
  idempotencyKey: 'conv:conv-1::turn:turn-1',
  transport: 'typed',
});

function reviewFields(sessionId, suffix = '1') {
  const padded = String(suffix).padStart(32, '0');
  const intentId = `rui.${padded}`;
  const turnId = `bootstrap.${padded}`;
  const expiresAt = '2026-08-03T14:05:00.000Z';
  return {
    review: { intentId, available: true, expiresAt },
    uiIntent: {
      version: 'reina.ui-intent.v1', executed: false, requiresConfirmation: true,
      conversationId: sessionId, turnId, intentId, expiresAt,
      kind: 'navigate', destination: 'standup', parameters: {},
    },
  };
}

function validBootstrapBody(sessionId, displayName = 'Chris', suffix = '1') {
  return {
    ok: true,
    sessionId,
    generatedAt: '2026-08-03T14:00:00Z',
    executed: false,
    user: { displayName },
    attention: {
      total: 5,
      asOf: '2026-08-03T14:00:00Z',
      reviewAvailable: true,
      categories: [
        {
          key: 'jobs', label: 'Jobs', count: 5, available: true,
          asOf: '2026-08-03T14:00:00Z', evidence: ['Bounded synthetic Jobs fixture.'],
        },
        {
          key: 'mail', label: 'Important email', count: null, available: false,
          asOf: null, evidence: [],
        },
      ],
      unavailableSources: ['Important email is unavailable in this pilot.'],
    },
    ...reviewFields(sessionId, suffix),
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function evidence(dataClass = 'synthetic', over = {}) {
  return Object.assign({
    source: 'Reina pilot fixture',
    sourceType: 'synthetic_fixture',
    dataClass,
    synthetic: dataClass === 'synthetic',
    observedAt: '2026-08-03T12:00:00Z',
    asOf: null,
    detail: 'One bounded read-only item.',
  }, over);
}

function envelope(over = {}) {
  return Object.assign({
    version: 'reina.answer.v1',
    answer: 'One item needs attention.',
    evidence: [evidence()],
    freshness: {
      known: false,
      asOf: null,
      note: 'Freshness is unknown; no as-of time was recorded for this answer.',
    },
    missingInformation: [],
    conflictingInformation: [],
    uncertainty: [],
    refused: false,
    refusalReason: null,
    executed: false,
    executionStatement: EXECUTION_STATEMENT,
  }, over);
}

function accessFor(entries) {
  const syn = entries.some((entry) => entry.dataClass === 'synthetic');
  const auth = entries.some((entry) => entry.dataClass === 'authorized_read');
  if (syn && auth) return { synthetic: true, dataAccess: 'mixed' };
  if (syn) return { synthetic: true, dataAccess: 'synthetic' };
  if (auth) return { synthetic: false, dataAccess: 'authorized_read' };
  return { synthetic: false, dataAccess: 'none' };
}

function routeResponse(request, options = {}) {
  const env = options.envelope || envelope();
  const access = accessFor(env.evidence);
  return Object.assign({
    ok: true,
    enabled: true,
    stored: true,
    conversationId: request.conversationId,
    turnId: request.turnId,
    idempotencyKey: request.idempotencyKey,
    replayed: options.replayed === true,
    executed: false,
    nothingExecuted: true,
    businessActionAllowed: false,
    automationTaskAllowed: false,
    toolExecutionAllowed: false,
    synthetic: access.synthetic,
    dataAccess: access.dataAccess,
    reviewAvailable: false,
    envelope: env,
    plainText: renderPlainText(env),
    navigation: null,
  }, options.response || {});
}

function confirmationResponse(intentId, over = {}) {
  return Object.assign({
    ok: true,
    confirmed: true,
    intentId,
    executed: false,
    nothingExecuted: true,
    businessActionAllowed: false,
    automationTaskAllowed: false,
    toolExecutionAllowed: false,
  }, over);
}

function harness(options = {}) {
  const calls = [];
  const responder = options.responder || ((request) => routeResponse(request));
  const fetchFn = async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url, init, request });
    const body = await responder(request, calls.length);
    return {
      ok: options.httpStatus ? options.httpStatus >= 200 && options.httpStatus < 300 : true,
      status: options.httpStatus || 200,
      text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    };
  };
  const client = createReinaPilotClient({
    fetchFn,
    getAccessToken: options.getAccessToken || (async () => 'secret-session-token'),
    hashFn: options.hashFn || (async (input) => sha256(input)),
    validateBootstrap: LoginBrief.validateBootstrap,
    ...(options.onAuthExpired ? { onAuthExpired: options.onAuthExpired } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.AbortControllerCtor ? { AbortControllerCtor: options.AbortControllerCtor } : {}),
  });
  return { client, calls };
}

async function drain() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('typed submit sends only five primitive fields to the fixed route with a session Bearer', async () => {
  const h = harness();
  const result = await h.client.submitTurn(REQUEST);
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer secret-session-token');
  assert.equal(call.init.credentials, 'same-origin');
  assert.deepEqual(Object.keys(call.request).sort(), [
    'conversationId', 'idempotencyKey', 'transport', 'turnId', 'utterance',
  ]);
  assert.match(call.request.idempotencyKey, /^rt\.[0-9a-f]{64}$/);
  assert.notEqual(call.request.idempotencyKey, REQUEST.idempotencyKey);
  assert.equal(call.request.utterance, REQUEST.utterance);
  assert.equal(JSON.stringify(call.request).includes('secret-session-token'), false);
  assert.equal(result.idempotencyKey, REQUEST.idempotencyKey);
  assert.equal(result.stored, true);
  assert.equal(result.executed, false);
});

test('client authority, history, tools, and evidence fields are rejected rather than forwarded', async () => {
  const forbidden = ['role', 'companyId', 'capabilities', 'authorization', 'history', 'system', 'tools', 'evidence', 'executed'];
  for (const key of forbidden) {
    const h = harness();
    await assert.rejects(h.client.submitTurn({ ...REQUEST, [key]: key }), { code: 'invalid_request_shape' });
    assert.equal(h.calls.length, 0);
  }
});

test('wrappers and accessors are rejected without invoking their accessors', async () => {
  const h = harness();
  await assert.rejects(h.client.submitTurn({ ...REQUEST, utterance: new String('wrapped') }), { code: 'invalid_utterance' });
  let reads = 0;
  const accessor = { ...REQUEST };
  Object.defineProperty(accessor, 'utterance', {
    enumerable: true,
    get() { reads += 1; return 'do not read'; },
  });
  await assert.rejects(h.client.submitTurn(accessor), { code: 'invalid_request_shape' });
  assert.equal(reads, 0);
  assert.equal(h.calls.length, 0);
});

test('typed retries use one stable normalized key and require a stored replay', async () => {
  const h = harness({ responder: (request, count) => routeResponse(request, { replayed: count > 1 }) });
  const first = await h.client.submitTurn(REQUEST);
  const second = await h.client.submitTurn(REQUEST);
  assert.equal(h.calls[0].request.idempotencyKey, h.calls[1].request.idempotencyKey);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.idempotencyKey, REQUEST.idempotencyKey);
});

test('same idempotency identity cannot be reused for different text', async () => {
  const h = harness();
  await h.client.submitTurn(REQUEST);
  await assert.rejects(h.client.submitTurn({ ...REQUEST, utterance: 'different payload' }), { code: 'idempotency_payload_conflict' });
  assert.equal(h.calls.length, 1);
});

test('distinct identities that collide in the injected hash fail before the second fetch', async () => {
  const h = harness({ hashFn: async () => 'a'.repeat(64) });
  await h.client.submitTurn(REQUEST);
  await assert.rejects(h.client.submitTurn({
    ...REQUEST,
    turnId: 'turn-2',
    idempotencyKey: 'other-raw-key',
  }), { code: 'idempotency_hash_collision' });
  assert.equal(h.calls.length, 1);
});

test('a second accepted result must be marked replayed and remain byte-semantically identical', async () => {
  const freshAgain = harness({ responder: (request) => routeResponse(request, { replayed: false }) });
  await freshAgain.client.submitTurn(REQUEST);
  await assert.rejects(freshAgain.client.submitTurn(REQUEST), { code: 'replay_conflict' });

  const changed = harness({
    responder: (request, count) => routeResponse(request, {
      replayed: count > 1,
      envelope: envelope({ answer: count > 1 ? 'Changed replay.' : 'Original.' }),
    }),
  });
  await changed.client.submitTurn(REQUEST);
  await assert.rejects(changed.client.submitTurn(REQUEST), { code: 'replay_conflict' });
});

test('unsaved, disabled, non-ok, or malformed replay successes fail closed', async () => {
  for (const response of [
    { stored: false }, { enabled: false }, { ok: false }, { replayed: 'yes' },
  ]) {
    const h = harness({ responder: (request) => routeResponse(request, { response }) });
    await assert.rejects(h.client.submitTurn(REQUEST));
  }
});

test('conversation, turn, and normalized idempotency mismatches all fail closed', async () => {
  const cases = [
    { conversationId: 'other' },
    { turnId: 'other' },
    { idempotencyKey: 'rt.' + 'f'.repeat(64) },
  ];
  for (const response of cases) {
    const h = harness({ responder: (request) => routeResponse(request, { response }) });
    await assert.rejects(h.client.submitTurn(REQUEST));
  }
});

test('unknown response fields and every contradictory action claim are rejected', async () => {
  const mutations = [
    (r) => { r.authorization = { allowed: true }; },
    (r) => { r.businessActionAllowed = true; },
    (r) => { r.automationTaskAllowed = true; },
    (r) => { r.toolExecutionAllowed = true; },
    (r) => { r.executed = true; },
    (r) => { r.nothingExecuted = false; },
  ];
  for (const mutate of mutations) {
    const h = harness({ responder: (request) => {
      const response = routeResponse(request);
      mutate(response);
      return response;
    } });
    await assert.rejects(h.client.submitTurn(REQUEST));
  }
});

test('canonical envelope is exact at every level and rejects unknown or malformed fields', async () => {
  const badEnvelopes = [
    envelope({ toolCalls: [] }),
    envelope({ executed: true }),
    envelope({ executionStatement: 'Nothing happened.' }),
    envelope({ refusalReason: 'extra while not refused' }),
    envelope({ freshness: { known: false, asOf: null, note: 'Unknown.', extra: true } }),
    envelope({ evidence: [{ ...evidence(), authorization: true }] }),
    envelope({ evidence: [{ ...evidence(), synthetic: false }] }),
    envelope({ conflictingInformation: [{ summary: 'Conflict', sources: [], extra: true }] }),
  ];
  for (const bad of badEnvelopes) {
    const h = harness({ responder: (request) => routeResponse(request, { envelope: bad }) });
    await assert.rejects(h.client.submitTurn(REQUEST), { code: 'invalid_envelope' });
  }
  assert.throws(
    () => validateCanonicalEnvelope(envelope({ uncertainty: [new String('wrapped')] })),
    { code: 'invalid_envelope' },
  );
});

test('evidence and freshness require semantically valid canonical UTC timestamps', async () => {
  const badEnvelopes = [
    envelope({ evidence: [evidence('synthetic', { observedAt: '2026-99-99T99:99:99Z' })] }),
    envelope({ evidence: [evidence('synthetic', { observedAt: '2026-02-29T12:00:00Z' })] }),
    envelope({ evidence: [evidence('synthetic', { observedAt: null, asOf: '2026-08-03T12:00:00+00:00' })] }),
    envelope({ evidence: [evidence('synthetic', { observedAt: null, asOf: '2026-08-03' })] }),
    envelope({ freshness: { known: true, asOf: '2026-04-31T12:00:00Z', note: 'Impossible date.' } }),
  ];
  for (const bad of badEnvelopes) {
    const h = harness({ responder: (request) => routeResponse(request, { envelope: bad }) });
    await assert.rejects(h.client.submitTurn(REQUEST), { code: 'invalid_envelope' });
  }

  const valid = envelope({
    evidence: [evidence('synthetic', { observedAt: '2028-02-29T12:00:00.123Z' })],
    freshness: { known: true, asOf: '2028-02-29T12:00:00Z', note: 'Canonical UTC.' },
  });
  const h = harness({ responder: (request) => routeResponse(request, { envelope: valid }) });
  const result = await h.client.submitTurn(REQUEST);
  assert.equal(result.envelope.evidence[0].observedAt, '2028-02-29T12:00:00.123Z');
});

test('response accessors are rejected without invocation by the exported validation gate', () => {
  const request = {
    ...REQUEST,
    idempotencyKey: 'rt.' + '1'.repeat(64),
  };
  const response = routeResponse(request);
  let reads = 0;
  Object.defineProperty(response, 'stored', {
    enumerable: true,
    get() { reads += 1; return true; },
  });
  assert.throws(() => validateRouteResponse(response, request), { code: 'invalid_response_shape' });
  assert.equal(reads, 0);
});

test('plainText must exactly equal the deterministic full envelope rendering', async () => {
  const env = envelope({
    evidence: [evidence()],
    missingInformation: ['Site ZIP is missing.'],
    conflictingInformation: [{ summary: 'Two sources disagree.', sources: ['Jobs', 'Schedule'] }],
    uncertainty: ['No site-specific forecast was claimed.'],
  });
  const h = harness({ responder: (request) => routeResponse(request, {
    envelope: env,
    response: { plainText: renderPlainText(env) + '\nforged suffix' },
  }) });
  await assert.rejects(h.client.submitTurn(REQUEST), { code: 'plain_text_mismatch' });
});

test('browser renderer is byte-identical to the canonical server renderer', () => {
  const inputs = [
    {
      answer: 'No evidence was available.',
      missingInformation: ['The source is unavailable.'],
      uncertainty: ['No zero count was inferred.'],
    },
    {
      answer: 'Synthetic and authorized reads are clearly separated.',
      evidence: [
        {
          source: 'synthetic-pilot', sourceType: 'fixture', dataClass: 'synthetic',
          asOf: '2026-08-03T12:00:00Z', detail: 'Fixture detail.',
        },
        {
          source: 'authorized-schedule', sourceType: 'schedule', dataClass: 'authorized_read',
          observedAt: '2026-08-03T12:01:00Z', detail: 'Authorized detail.',
        },
      ],
      freshness: { known: true, asOf: '2026-08-03T12:01:00Z', note: 'Current bounded read.' },
      conflictingInformation: [{ summary: 'Sources disagree.', sources: ['pilot', 'schedule'] }],
    },
    {
      answer: 'I cannot make that change.',
      refused: true,
      refusalReason: 'action_not_permitted',
      uncertainty: ['The pilot is read-only.'],
    },
  ];
  for (const input of inputs) {
    const built = buildEnvelope(input);
    assert.equal(built.ok, true);
    assert.equal(renderPlainText(built.envelope), renderServerPlainText(built.envelope));
  }
});

test('executable script, img, svg, event-handler, javascript, and data payloads are rejected', async () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x>',
    '<svg><circle /></svg>',
    'safe onerror = alert(1)',
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
  ];
  for (const attack of attacks) {
    const h = harness({ responder: (request) => routeResponse(request, { envelope: envelope({ answer: attack }) }) });
    await assert.rejects(h.client.submitTurn(REQUEST), { code: 'invalid_envelope' });
  }
});

test('Markdown links/images and encoded entities remain literal inert text', async () => {
  const literal = 'See [docs](https://example.test) and ![weather](https://example.test/w.png); &lt;script&gt; &amp; stays text.';
  const env = envelope({ answer: literal });
  const h = harness({ responder: (request) => routeResponse(request, { envelope: env }) });
  const result = await h.client.submitTurn(REQUEST);
  assert.equal(result.envelope.answer, literal);
  assert.ok(result.plainText.includes(literal));
  assert.ok(result.plainText.includes('![weather]'));
  assert.ok(result.plainText.includes('&lt;script&gt;'));
});

test('synthetic/dataAccess must exactly reflect evidence and accepts authorized read-only answers', async () => {
  const accepted = harness({ responder: (request) => routeResponse(request, {
    envelope: envelope({ evidence: [evidence('synthetic')] }),
  }) });
  const result = await accepted.client.submitTurn(REQUEST);
  assert.equal(result.synthetic, true);
  assert.equal(result.dataAccess, 'synthetic');

  for (const entries of [
    [evidence('authorized_read')],
    [evidence('synthetic'), evidence('authorized_read', { source: 'Authorized schedule' })],
  ]) {
    const h = harness({ responder: (request) => routeResponse(request, { envelope: envelope({ evidence: entries }) }) });
    const acceptedRead = await h.client.submitTurn(REQUEST);
    assert.equal(acceptedRead.dataAccess, entries.length === 1 ? 'authorized_read' : 'mixed');
  }
  const empty = harness({ responder: (request) => routeResponse(request, { envelope: envelope({ evidence: [] }) }) });
  await assert.rejects(empty.client.submitTurn(REQUEST), { code: 'missing_evidence' });
  const dishonest = harness({ responder: (request) => routeResponse(request, {
    envelope: envelope({ evidence: [evidence('synthetic')] }),
    response: { synthetic: false, dataAccess: 'authorized_read' },
  }) });
  await assert.rejects(dishonest.client.submitTurn(REQUEST), { code: 'dishonest_data_access' });
});

test('the navigation-disabled RC rejects every navigation directive and never executes one', async () => {
  let navigations = 0;
  const originalLocation = globalThis.location;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { assign() { navigations += 1; } },
  });
  try {
    const allowed = { type: 'open_view', target: 'standup', requiresExplicitUserIntent: true };
    const h = harness({ responder: (request) => routeResponse(request, { response: { navigation: allowed } }) });
    await assert.rejects(h.client.submitTurn(REQUEST), { code: 'invalid_navigation' });
    assert.equal(navigations, 0);
  } finally {
    if (typeof originalLocation === 'undefined') delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { configurable: true, value: originalLocation });
  }

  for (const navigation of [
    { type: 'open_view', target: 'email', requiresExplicitUserIntent: true },
    { type: 'open_view', target: 'standup', requiresExplicitUserIntent: false },
    { type: 'mutate', target: 'standup', requiresExplicitUserIntent: true },
    { type: 'open_view', target: 'standup', requiresExplicitUserIntent: true, url: '/admin' },
  ]) {
    const h = harness({ responder: (request) => routeResponse(request, { response: { navigation } }) });
    await assert.rejects(h.client.submitTurn(REQUEST), { code: 'invalid_navigation' });
  }
});

test('a refusal cannot smuggle a navigation directive', async () => {
  const refused = envelope({
    answer: 'I cannot do that.',
    refused: true,
    refusalReason: 'action_not_permitted',
  });
  const h = harness({ responder: (request) => routeResponse(request, {
    envelope: refused,
    response: { navigation: { type: 'open_view', target: 'standup', requiresExplicitUserIntent: true } },
  }) });
  await assert.rejects(h.client.submitTurn(REQUEST), { code: 'invalid_navigation' });
});

test('Voice wrapper maps an invalid raw PR #81 key to the transport-neutral hash and returns PR #86 shape', async () => {
  const h = harness({ responder: (request) => routeResponse(request, {
    envelope: envelope({ evidence: [evidence()] }),
  }) });
  const raw = {
    utterance: 'yes, review them',
    conversationId: 'conv-voice',
    turnId: 'turn-voice',
    idempotencyKey: 'rvk1|10:conv-voice|10:turn-voice',
    transport: 'voice',
  };
  const result = await h.client.voiceServerTransport(raw);
  assert.match(h.calls[0].request.idempotencyKey, /^rt\.[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(h.calls[0].request).sort(), [
    'conversationId', 'idempotencyKey', 'transport', 'turnId', 'utterance',
  ]);
  assert.equal(result.executed, false);
  assert.equal(result.nothingExecuted, true);
  assert.equal(result.state, 'synthetic');
  assert.equal(result.answer.text, 'One item needs attention.');
  assert.equal(result.answer.speech, 'One item needs attention.');
  assert.equal(result.answer.speech, result.answer.text);
  assert.equal(result.navigation, null);
});

test('Voice stable retries use the same transport-neutral key and enforce exact replay', async () => {
  const h = harness({ responder: (request, count) => routeResponse(request, { replayed: count > 1 }) });
  const voice = { ...REQUEST, transport: 'voice', idempotencyKey: 'rvk1|bad|key' };
  await h.client.voiceServerTransport(voice);
  await h.client.voiceServerTransport(voice);
  assert.equal(h.calls[0].request.idempotencyKey, h.calls[1].request.idempotencyKey);
  assert.match(h.calls[0].request.idempotencyKey, /^rt\.[0-9a-f]{64}$/);
});

test('verbal review navigation is rejected and never enters the Voice pending cache', async () => {
  const navigation = { type: 'open_view', target: 'standup', requiresExplicitUserIntent: true };
  const h = harness({
    responder: (request, count) => routeResponse(request, {
      replayed: count > 1,
      response: { navigation },
    }),
  });
  const voice = createCanonicalVoiceTransport({ serverTransport: h.client.voiceServerTransport });
  const payload = {
    text: 'yes, review the attention items',
    conversationId: 'conv-verbal-review',
    turnId: 'turn-verbal-review',
    idempotencyKey: 'rvk1|verbal-review',
    source: 'voice',
  };
  await assert.rejects(voice.submitTurn(payload), { code: 'invalid_navigation' });
  assert.equal(h.client.takeVoiceNavigation('conv-verbal-review', 'turn-verbal-review'), null);
  assert.equal(h.client.takeVoiceNavigation('other', 'turn-verbal-review'), null);
});

test('Voice serverTransport rejects wrappers/accessors and never forwards authority', async () => {
  const h = harness();
  await assert.rejects(h.client.voiceServerTransport({ ...REQUEST, transport: 'voice', utterance: new String('wrapped') }), { code: 'invalid_utterance' });
  await assert.rejects(h.client.voiceServerTransport({ ...REQUEST, transport: 'voice', role: 'admin' }), { code: 'invalid_request_shape' });
  assert.equal(h.calls.length, 0);
});

test('PR #86 consumes the wrapper but cannot weaken idempotency or envelope validation', async () => {
  const h = harness({ responder: (request) => routeResponse(request, { envelope: envelope({ evidence: [evidence()] }) }) });
  const voice = createCanonicalVoiceTransport({ serverTransport: h.client.voiceServerTransport });
  const result = await voice.submitTurn({
    text: 'spoken question',
    conversationId: 'conv-spoken',
    turnId: 'turn-spoken',
    idempotencyKey: 'rvk1|11:conv-spoken|11:turn-spoken',
    source: 'voice',
    role: 'forged-admin',
  });
  assert.match(h.calls[0].request.idempotencyKey, /^rt\.[0-9a-f]{64}$/);
  assert.equal('role' in h.calls[0].request, false);
  assert.equal(result.speechSafe, 'One item needs attention.');
  assert.equal(result.reply, result.speechSafe);
  assert.equal(result.reply, 'One item needs attention.');
});

test('PR #84 typed controller consumes submitTurn and receives only a persisted validated answer', async () => {
  const h = harness({ responder: (request) => routeResponse(request, {
    envelope: envelope({ answer: 'Literal **Markdown** &lt;b&gt; stays inert.' }),
  }) });
  const views = [];
  const panel = RTP.createTypedPanel({
    conversationId: 'conv-panel',
    newId: () => 'turn-panel',
    submitTurn: h.client.submitTurn,
    onView: (view) => views.push(view),
  });
  const accepted = panel.submit('hello Reina');
  assert.equal(accepted.accepted, true);
  await drain();
  assert.equal(panel.getState(), 'answered');
  assert.equal(views.at(-1).answer, 'Literal **Markdown** &lt;b&gt; stays inert.');
  assert.match(h.calls[0].request.idempotencyKey, /^rt\.[0-9a-f]{64}$/);
});

test('HTTP authorization/session failures are sanitized and no token reaches request data', async () => {
  const missing = harness({ getAccessToken: async () => '' });
  await assert.rejects(missing.client.submitTurn(REQUEST), { code: 'auth_expired' });
  assert.equal(missing.calls.length, 0);

  const unauthorized = harness({ httpStatus: 401 });
  await assert.rejects(unauthorized.client.submitTurn(REQUEST), { code: 'auth_expired' });
  assert.equal(JSON.stringify(unauthorized.calls[0].request).includes('secret-session-token'), false);

  let expiredSignals = 0;
  const forbidden = harness({ httpStatus: 403, onAuthExpired: () => { expiredSignals += 1; } });
  await assert.rejects(forbidden.client.submitTurn(REQUEST), { code: 'auth_expired' });
  assert.equal(expiredSignals, 1);
});

test('review confirmation sends only the authenticated atomic consume identity and returns no action authority', async () => {
  const intentId = 'rui.confirm-exact-00000000000000000001';
  const h = harness({ responder: (request) => confirmationResponse(request.intentId) });

  const result = await h.client.confirmReviewIntent(intentId);

  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer secret-session-token');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.equal(call.init.headers.Accept, 'application/json');
  assert.equal(call.init.credentials, 'same-origin');
  assert.equal(call.init.cache, 'no-store');
  assert.deepEqual(call.request, { action: 'confirm_review', intentId });
  assert.deepEqual(Object.keys(call.request).sort(), ['action', 'intentId']);
  assert.equal(JSON.stringify(call.request).includes('secret-session-token'), false);
  assert.deepEqual(result, { ok: true, intentId, executed: false });
  assert.deepEqual(Object.keys(result).sort(), ['executed', 'intentId', 'ok']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal('businessActionAllowed' in result, false);
  assert.equal('automationTaskAllowed' in result, false);
  assert.equal('toolExecutionAllowed' in result, false);
});

test('review confirmation accepts only the exact executed:false denial envelope', async () => {
  const intentId = 'rui.confirm-strict-0000000000000000001';
  const cases = [
    { unknown: true },
    { ok: false },
    { confirmed: false },
    { intentId: 'rui.different-00000000000000000000001' },
    { executed: true },
    { nothingExecuted: false },
    { businessActionAllowed: true },
    { automationTaskAllowed: true },
    { toolExecutionAllowed: true },
  ];

  for (const mutation of cases) {
    const h = harness({
      responder: () => confirmationResponse(intentId, mutation),
    });
    await assert.rejects(h.client.confirmReviewIntent(intentId), { code: 'invalid_confirmation' });
    assert.equal(h.calls.length, 1);
  }
});

test('review confirmation fails closed for stale, duplicate, expired, unavailable, and revoked authority', async () => {
  const intentId = 'rui.confirm-denied-00000000000000000001';
  const statusCases = [
    [400, { ok: false, reason: 'stale_intent' }],
    [404, { ok: false, reason: 'stale_intent' }],
    [408, { ok: false, reason: 'timeout' }],
    [409, { ok: false, reason: 'duplicate' }],
    [410, { ok: false, reason: 'expired' }],
    [500, { ok: false, reason: 'confirmation_unavailable' }],
  ];
  for (const [httpStatus, expected] of statusCases) {
    const h = harness({ httpStatus });
    assert.deepEqual(await h.client.confirmReviewIntent(intentId), expected);
  }

  for (const httpStatus of [401, 403]) {
    let expiredSignals = 0;
    const h = harness({
      httpStatus,
      onAuthExpired: () => { expiredSignals += 1; },
    });
    await assert.rejects(h.client.confirmReviewIntent(intentId), { code: 'auth_expired' });
    assert.equal(expiredSignals, 1);
    assert.deepEqual(h.calls[0].request, { action: 'confirm_review', intentId });
  }
});

test('review confirmation shares the bounded abort deadline and rejects invalid intent IDs before fetch', async () => {
  const signals = [];
  class FakeAbortController {
    constructor() { this.signal = { aborted: false }; signals.push(this.signal); }
    abort() { this.signal.aborted = true; }
  }
  let fetches = 0;
  const client = createReinaPilotClient({
    fetchFn: async (_url, init) => {
      fetches += 1;
      assert.equal(init.signal, signals.at(-1));
      return new Promise(() => {});
    },
    getAccessToken: async () => 'session-token',
    hashFn: async (input) => sha256(input),
    timeoutMs: 10,
    AbortControllerCtor: FakeAbortController,
  });

  await assert.rejects(
    client.confirmReviewIntent('rui.confirm-timeout-0000000000000000001'),
    { code: 'timeout' },
  );
  assert.equal(fetches, 1);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);

  for (const invalidIntentId of ['', 'forged', 'rui.with\ncontrol', { toString: () => 'rui.forged' }]) {
    await assert.rejects(client.confirmReviewIntent(invalidIntentId), { code: 'invalid_review_intent' });
  }
  assert.equal(fetches, 1);
});

test('authenticated bootstrap accepts the server-issued opaque session only through the real validator', async () => {
  const sessionId = `rp.${'a'.repeat(64)}`;
  const body = {
    ok: true,
    sessionId,
    generatedAt: '2026-08-03T14:00:00Z',
    executed: false,
    user: { displayName: 'Chris' },
    attention: {
      total: 5,
      asOf: '2026-08-03T14:00:00Z',
      reviewAvailable: true,
      categories: [
        {
          key: 'jobs', label: 'Jobs', count: 5, available: true,
          asOf: '2026-08-03T14:00:00Z', evidence: ['Bounded synthetic Jobs fixture.'],
        },
        {
          key: 'mail', label: 'Important email', count: null, available: false,
          asOf: null, evidence: [],
        },
      ],
      unavailableSources: ['Important email is unavailable in this pilot.'],
    },
    ...reviewFields(sessionId),
  };
  const calls = [];
  const client = createReinaPilotClient({
    getAccessToken: async () => 'server-session-token',
    hashFn: async (input) => sha256(input),
    validateBootstrap: LoginBrief.validateBootstrap,
    fetchFn: async (_url, init) => {
      calls.push(init);
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  });
  const result = await client.bootstrap();
  assert.equal(result.sessionId, sessionId);
  assert.deepEqual(result.bootstrap, body);
  assert.equal(Object.isFrozen(result.bootstrap), true);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].body, undefined);
  assert.equal(JSON.stringify(result).includes('server-session-token'), false);
});

test('bootstrap rejects malformed review authority and all-unavailable attention', async () => {
  const sessionId = `rp.${'d'.repeat(64)}`;
  const cases = [
    (body) => { body.review.intentId = 'rui.mismatch'; },
    (body) => { body.review.available = false; },
    (body) => { body.uiIntent.executed = true; },
    (body) => { body.uiIntent.requiresConfirmation = false; },
    (body) => { body.uiIntent.conversationId = `rp.${'e'.repeat(64)}`; },
    (body) => { body.uiIntent.intentId = 'rui.mismatch'; },
    (body) => { body.uiIntent.kind = 'open_detail'; },
    (body) => { body.uiIntent.destination = 'settings'; },
    (body) => { body.uiIntent.parameters = { recordId: 'forged' }; },
    (body) => { body.attention.categories[0] = {
      key: 'jobs', label: 'Jobs', count: null, available: false, asOf: null, evidence: [],
    }; body.attention.total = null; body.attention.asOf = null; },
    (body) => { body.attention.categories[1].count = 0; },
  ];
  for (const mutate of cases) {
    const body = JSON.parse(JSON.stringify(validBootstrapBody(sessionId)));
    mutate(body);
    const client = createReinaPilotClient({
      getAccessToken: async () => 'server-session-token',
      hashFn: async (input) => sha256(input),
      fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }),
    });
    await assert.rejects(client.bootstrap(), { code: 'invalid_bootstrap' });
  }
});

test('client pins the genuine fetch identity before a later global reassignment', async () => {
  const source = readFileSync(new URL('../public/reina-pilot-client.js', import.meta.url), 'utf8');
  const loginSource = readFileSync(new URL('../public/reina-login-brief-controller.js', import.meta.url), 'utf8');
  const sessionId = `rp.${'c'.repeat(64)}`;
  const trustedBody = {
    ok: true,
    sessionId,
    generatedAt: '2026-08-03T14:00:00Z',
    executed: false,
    user: { displayName: 'Trusted Network Identity' },
    attention: {
      total: 5, asOf: '2026-08-03T14:00:00Z', reviewAvailable: true,
      categories: [
        {
          key: 'jobs', label: 'Jobs', count: 5, available: true,
          asOf: '2026-08-03T14:00:00Z', evidence: ['Bounded synthetic Jobs fixture.'],
        },
        {
          key: 'mail', label: 'Important email', count: null, available: false,
          asOf: null, evidence: [],
        },
      ],
      unavailableSources: ['Important email is unavailable in this pilot.'],
    },
    ...reviewFields(sessionId, '2'),
  };
  let trustedFetches = 0;
  let forgedFetches = 0;
  let forgedValidators = 0;
  const context = {
    fetch: async () => {
      trustedFetches += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify(trustedBody) };
    },
    setTimeout,
    clearTimeout,
    AbortController,
  };
  vm.runInNewContext(loginSource, context, { filename: 'reina-login-brief-controller.js' });
  vm.runInNewContext(source, context, { filename: 'reina-pilot-client.js' });
  context.fetch = async () => {
    forgedFetches += 1;
    const forged = { ...trustedBody, user: { displayName: 'Forged Network Identity' } };
    return { ok: true, status: 200, text: async () => JSON.stringify(forged) };
  };
  context.ReinaLoginBrief = {
    validateBootstrap(value) {
      forgedValidators += 1;
      value.user.displayName = 'Forged Late Validator';
      return { ok: true };
    },
  };

  const client = context.ReinaPilotClient.createReinaPilotClient({
    getAccessToken: async () => 'trusted-session-token',
    hashFn: async (input) => sha256(input),
  });
  const result = await client.bootstrap();
  assert.equal(trustedFetches, 1);
  assert.equal(forgedFetches, 0);
  assert.equal(forgedValidators, 0);
  assert.equal(result.bootstrap.user.displayName, 'Trusted Network Identity');
});

test('malformed and oversized HTTP bodies fail closed before rendering', async () => {
  const malformed = harness({ responder: () => '{not json' });
  await assert.rejects(malformed.client.submitTurn(REQUEST), { code: 'invalid_json' });

  const oversized = harness({ responder: () => 'x'.repeat(262145) });
  await assert.rejects(oversized.client.submitTurn(REQUEST), { code: 'response_too_large' });
});

test('typed and Voice fetches share a bounded AbortController timeout', async () => {
  const signals = [];
  class FakeAbortController {
    constructor() { this.signal = { aborted: false }; signals.push(this.signal); }
    abort() { this.signal.aborted = true; }
  }
  const client = createReinaPilotClient({
    fetchFn: async (_url, init) => {
      assert.equal(init.signal, signals.at(-1));
      return new Promise(() => {});
    },
    getAccessToken: async () => 'session-token',
    hashFn: async (input) => sha256(input),
    timeoutMs: 10,
    AbortControllerCtor: FakeAbortController,
  });
  await assert.rejects(client.submitTurn(REQUEST), { code: 'timeout' });
  await assert.rejects(client.voiceServerTransport({ ...REQUEST, transport: 'voice', idempotencyKey: 'rvk1|timeout' }), { code: 'timeout' });
  assert.equal(signals.length, 2);
  assert.equal(signals.every((signal) => signal.aborted === true), true);
});

test('the end-to-end deadline covers never-settling token lookup and hashing before fetch', async () => {
  let fetches = 0;
  const tokenClient = createReinaPilotClient({
    fetchFn: async () => { fetches += 1; throw new Error('must not fetch'); },
    getAccessToken: async () => new Promise(() => {}),
    hashFn: async (input) => sha256(input),
    timeoutMs: 5,
  });
  await assert.rejects(tokenClient.submitTurn(REQUEST), { code: 'timeout' });
  assert.equal(fetches, 0);

  const hashClient = createReinaPilotClient({
    fetchFn: async () => { fetches += 1; throw new Error('must not fetch'); },
    getAccessToken: async () => 'session-token',
    hashFn: async () => new Promise(() => {}),
    timeoutMs: 5,
  });
  await assert.rejects(hashClient.submitTurn(REQUEST), { code: 'timeout' });
  assert.equal(fetches, 0);
});

test('default session lookup errors are mapped to fixed auth expiry without leaking provider text', async () => {
  const prior = globalThis.sb;
  const views = [];
  try {
    globalThis.sb = {
      auth: {
        getSession: async () => { throw new Error('SYNTHETIC_SECRET_MARKER_DEFAULT'); },
      },
    };
    const client = createReinaPilotClient({
      fetchFn: async () => { throw new Error('must not fetch'); },
      hashFn: async (input) => sha256(input),
      validateBootstrap: LoginBrief.validateBootstrap,
    });
    const panel = RTP.createTypedPanel({
      conversationId: 'conv-secret-test',
      newId: () => 'turn-secret-test',
      submitTurn: client.submitTurn,
      onView: (view) => views.push(view),
    });
    panel.submit('hello');
    await drain();
    assert.equal(panel.getState(), 'auth_expired');
    assert.equal(JSON.stringify(views).includes('SYNTHETIC_SECRET_MARKER_DEFAULT'), false);
  } finally {
    if (prior === undefined) delete globalThis.sb;
    else globalThis.sb = prior;
  }
});

test('timeout remains armed until the bounded response body is fully read', async () => {
  let signal;
  class FakeAbortController {
    constructor() { this.signal = { aborted: false }; signal = this.signal; }
    abort() { this.signal.aborted = true; }
  }
  const client = createReinaPilotClient({
    fetchFn: async () => ({
      ok: true,
      status: 200,
      text: async () => new Promise(() => {}),
    }),
    getAccessToken: async () => 'session-token',
    hashFn: async (input) => sha256(input),
    timeoutMs: 10,
    AbortControllerCtor: FakeAbortController,
  });
  await assert.rejects(client.submitTurn(REQUEST), { code: 'timeout' });
  assert.equal(signal.aborted, true);
});

test('default browser crypto path emits a SHA-256 normalized key', async () => {
  const calls = [];
  const client = createReinaPilotClient({
    getAccessToken: async () => 'session-token',
    fetchFn: async (_url, init) => {
      const request = JSON.parse(init.body);
      calls.push(request);
      return { ok: true, status: 200, text: async () => JSON.stringify(routeResponse(request)) };
    },
  });
  await client.submitTurn(REQUEST);
  assert.match(calls[0].idempotencyKey, /^rt\.[0-9a-f]{64}$/);
});

test('controlled transcription sends only a bounded audio blob to its authenticated endpoint', async () => {
  const calls = [];
  const client = createReinaPilotClient({
    getAccessToken: async () => 'voice-session-token',
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ ok: true, transcript: 'What needs attention?' }),
      };
    },
  });
  const result = await client.transcribeVoiceAudio(new Blob(['short recording'], { type: 'audio/webm' }));
  assert.deepEqual(result, { ok: true, transcript: 'What needs attention?' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/reina-transcribe');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer voice-session-token');
  assert.equal(calls[0].init.headers['Content-Type'], 'audio/webm');
  assert.ok(calls[0].init.body instanceof Blob);
});

test('controlled transcription rejects oversized or malformed audio before network access', async () => {
  let calls = 0;
  const client = createReinaPilotClient({ fetchFn: async () => { calls += 1; throw new Error('must not fetch'); } });
  await assert.rejects(client.transcribeVoiceAudio({ size: 0, type: 'audio/webm' }), { code: 'invalid_audio' });
  await assert.rejects(client.transcribeVoiceAudio({ size: 3 * 1024 * 1024, type: 'audio/webm' }), { code: 'invalid_audio' });
  await assert.rejects(client.transcribeVoiceAudio({ size: 10, type: 'text/plain' }), { code: 'invalid_audio' });
  assert.equal(calls, 0);
});

test('controlled transcription preserves a safe server transcription error', async () => {
  const client = createReinaPilotClient({
    getAccessToken: async () => 'voice-session-token',
    fetchFn: async () => ({ ok: false, status: 502, text: async () => JSON.stringify({ ok: false, code: 'transcription_bad_audio' }) }),
  });
  const result = await client.transcribeVoiceAudio(new Blob(['valid short recording'], { type: 'audio/webm' }));
  assert.deepEqual(result, { ok: false, code: 'transcription_bad_audio', diagnostic: null });
});

test('a refused transcript carries the route\'s bounded explanation, rebuilt field by field', async () => {
  const respond = (diagnostic) => createReinaPilotClient({
    getAccessToken: async () => 'voice-session-token',
    fetchFn: async () => ({
      ok: false, status: 422,
      text: async () => JSON.stringify({ ok: false, code: 'no_speech', diagnostic }),
    }),
  });
  const clip = () => new Blob(['valid short recording'], { type: 'audio/webm' });

  const good = await respond({
    audioBytes: 52485, audioType: 'audio/webm', rawTextType: 'string', rawTextLength: 0, rawTextSample: '',
  }).transcribeVoiceAudio(clip());
  assert.deepEqual(good, {
    ok: false,
    code: 'no_speech',
    diagnostic: {
      audioBytes: 52485, audioType: 'audio/webm', rawTextType: 'string', rawTextLength: 0, rawTextSample: '',
    },
  });

  // It arrived over the wire, so it is rebuilt, not trusted: wrong-typed and
  // oversized fields become null and markup never survives into a log line.
  const hostile = await respond({
    audioBytes: 'lots', audioType: 'x'.repeat(200), rawTextType: 'string',
    rawTextLength: -1, rawTextSample: '<img src=x onerror=alert(1)>hello',
  }).transcribeVoiceAudio(clip());
  assert.deepEqual(hostile.diagnostic, {
    audioBytes: null, audioType: null, rawTextType: 'string', rawTextLength: null, rawTextSample: 'hello',
  });

  const missing = await respond(undefined).transcribeVoiceAudio(clip());
  assert.equal(missing.diagnostic, null);
});

// ── the route's own failure reason survives a non-2xx (2026-08-15) ───────────
// api/reina-pilot.js answers 503 {"error":"disabled"} when its four-flag
// production gate is not fully set. The client used to throw a bare
// 'route_unavailable', so the panel could only ever say "please try again".
// The reason is now attached as err.serverCode -- validated, bounded, and
// never rendered raw.
function clientWithFailure(status, body) {
  return createReinaPilotClient({
    getAccessToken: async () => 'server-session-token',
    hashFn: async (input) => sha256(input),
    validateBootstrap: LoginBrief.validateBootstrap,
    fetchFn: async () => ({
      ok: false,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }),
  });
}

test('a non-2xx route reason is attached to the thrown error', async () => {
  await assert.rejects(
    clientWithFailure(503, { ok: false, error: 'disabled' }).bootstrap(),
    (err) => {
      assert.equal(err.code, 'route_unavailable');
      assert.equal(err.serverCode, 'disabled');
      return true;
    },
  );
});

test('only a short lowercase machine token is accepted as a route reason', async () => {
  const rejected = [
    { ok: false, error: '<script>alert(1)</script>' },   // markup
    { ok: false, error: 'Not Signed In.' },              // prose / spaces / caps
    { ok: false, error: 'x'.repeat(200) },               // over-long
    { ok: false, error: 42 },                            // not a string
    { ok: false },                                       // absent
    'not json at all',                                   // unparseable
    [{ error: 'disabled' }],                             // array, not an object
  ];
  for (const body of rejected) {
    await assert.rejects(
      clientWithFailure(503, body).bootstrap(),
      (err) => {
        assert.equal(err.code, 'route_unavailable');
        assert.equal(err.serverCode, undefined, `must not adopt ${JSON.stringify(body)}`);
        return true;
      },
    );
  }
});

test('401/403 still expire the session rather than becoming a route reason', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(
      clientWithFailure(status, { ok: false, error: 'disabled' }).bootstrap(),
      (err) => {
        assert.equal(err.code, 'auth_expired');
        return true;
      },
    );
  }
});

test('a session read that never returns fails with a name instead of hanging forever', async () => {
  const timers = [];
  const client = createReinaPilotClient({
    // supabase-js holds a cross-tab lock before returning a session; a context
    // that died holding it leaves this pending forever.
    getAccessToken: () => new Promise(() => {}),
    fetchFn: async () => { throw new Error('must never be reached without a token'); },
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutFn: () => {},
    timeoutMs: 60_000,
  });

  const attempt = client.transcribeVoiceAudio(new Blob(['recording'], { type: 'audio/webm' }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const tokenDeadline = timers.find((timer) => timer.ms === 8000);
  assert.ok(tokenDeadline, 'the token read is bounded');
  tokenDeadline.fn();

  // 'auth_timeout', not 'auth_expired': re-authenticating cannot fix a lock
  // that never released, and telling the user their session expired would send
  // them to do exactly that.
  await assert.rejects(attempt, (error) => error.code === 'auth_timeout');
});

test('the diagnostic beacon is not silenced by the failure it exists to report', async () => {
  const timers = [];
  let posted = 0;
  const client = createReinaPilotClient({
    getAccessToken: () => new Promise(() => {}),
    fetchFn: async () => { posted += 1; return { ok: true, status: 202, text: async () => '{"ok":true}' }; },
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutFn: () => {},
  });

  const report = client.reportVoiceDiagnostic({ stage: 'transcription', code: 'transcription-timeout' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  timers.find((timer) => timer.ms === 8000)?.fn();

  // It gives up rather than waiting on the stuck token, and it still resolves
  // false rather than rejecting -- reporting a failure must never raise one.
  assert.equal(await report, false);
  assert.equal(posted, 0);
});
