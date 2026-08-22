import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createSupabaseConversationStore } from '../api/_lib/reina/supabase-conversation-store.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = `rp.${'a'.repeat(64)}`;
const KEY = `rt.${'b'.repeat(64)}`;
const INPUT_DIGEST = 'c'.repeat(64);
const CLAIM = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const ASSISTANT_ID = '44444444-4444-4444-8444-444444444444';
const RESULT_ID = '55555555-5555-4555-8555-555555555555';
const USER_TEXT = 'What needs attention?';
const ASSISTANT_TEXT = '{"safe":"synthetic answer"}';
const REVIEW_TURN = `bootstrap.${'e'.repeat(32)}`;
const REVIEW_INTENT = `rui.${'e'.repeat(32)}`;
const REVIEW_EXPIRES_AT = '2026-08-03T12:05:00.000Z';

const ENV = Object.freeze({
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_KEY: 'server-service-key',
});

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function policy(operation, ownerPrincipalId = OWNER) {
  return Object.freeze({
    policyVersion: 'reina-acting-context-policy-v1',
    operation,
    ownerPrincipalId,
    decidedAt: '2026-08-03T12:00:00.000Z',
    decisionReference: 'd'.repeat(64),
  });
}

function reviewPolicy(ownerPrincipalId = OWNER) {
  return Object.freeze({
    kind: 'reina_ui_confirmation_policy',
    policyVersion: 'reina-acting-context-policy-v1',
    operation: 'reina.pilot.access',
    capability: 'reina:pilot:access',
    resource: 'pilot_runtime',
    effect: 'access',
    ownerScope: 'principal',
    ownerPrincipalId,
  });
}

function message({
  messageId = USER_ID,
  sequence = 1,
  role = 'user',
  content = USER_TEXT,
} = {}) {
  return {
    messageId,
    sequence,
    role,
    content,
    contentDigest: digest(content),
  };
}

function storedResult() {
  return {
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    idempotencyKey: KEY,
    inputDigest: INPUT_DIGEST,
    userMessageId: USER_ID,
    userMessageSequence: 1,
    assistantMessage: message({
      messageId: ASSISTANT_ID,
      sequence: 2,
      role: 'assistant',
      content: ASSISTANT_TEXT,
    }),
    resultReference: RESULT_ID,
    policyReference: policy('reina.conversation.append'),
  };
}

function mockResponse(value, { status = 200, extra = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => typeof value === 'string' ? value : JSON.stringify(value),
    ...extra,
  };
}

function scriptedStore(responder, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return mockResponse(await responder(url, init, calls.at(-1)));
  };
  return {
    calls,
    store: createSupabaseConversationStore({ env: ENV, fetchImpl, timeoutMs: 1_000, ...options }),
  };
}

test('all seven finite methods call only their fixed RPC and return exact core-safe results', async () => {
  const replies = {
    reina_pilot_load_conversation: {
      status: 'found', conversation: { ownerPrincipalId: OWNER, conversationId: CONVERSATION },
    },
    reina_pilot_create_conversation: {
      status: 'created', conversation: { ownerPrincipalId: OWNER, conversationId: CONVERSATION },
    },
    reina_pilot_claim_turn: { status: 'claimed', claimId: CLAIM, progress: 'claimed' },
    reina_pilot_append_user_once: {
      status: 'appended', ownerPrincipalId: OWNER, conversationId: CONVERSATION, message: message(),
    },
    reina_pilot_load_history: {
      status: 'loaded', ownerPrincipalId: OWNER, conversationId: CONVERSATION, messages: [message()],
    },
    reina_pilot_append_assistant_and_complete: { status: 'completed', result: storedResult() },
    reina_pilot_mark_turn_failed: { status: 'recorded', state: 'failed_retryable' },
  };
  const { store, calls } = scriptedStore((url) => replies[url.split('/').at(-1)]);
  const readPolicy = policy('reina.conversation.read');
  const createPolicy = policy('reina.conversation.create');
  const appendPolicy = policy('reina.conversation.append');

  assert.deepEqual(await store.loadConversation({
    ownerPrincipalId: OWNER, conversationId: CONVERSATION, policyReference: readPolicy,
  }), replies.reina_pilot_load_conversation);
  assert.deepEqual(await store.createConversation({
    ownerPrincipalId: OWNER, conversationId: CONVERSATION, policyReference: createPolicy,
  }), replies.reina_pilot_create_conversation);
  assert.deepEqual(await store.claimTurn({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    idempotencyKey: KEY,
    inputDigest: INPUT_DIGEST,
    appendPolicyReference: appendPolicy,
    replayReadPolicyReference: readPolicy,
  }), replies.reina_pilot_claim_turn);
  assert.deepEqual(await store.appendUserMessageOnce({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    idempotencyKey: KEY,
    inputDigest: INPUT_DIGEST,
    claimId: CLAIM,
    content: USER_TEXT,
    contentDigest: digest(USER_TEXT),
    policyReference: appendPolicy,
  }), replies.reina_pilot_append_user_once);
  assert.deepEqual(await store.loadHistory({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    throughMessageId: USER_ID,
    policyReference: readPolicy,
  }), replies.reina_pilot_load_history);
  assert.deepEqual(await store.appendAssistantAndCompleteTurn({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    idempotencyKey: KEY,
    inputDigest: INPUT_DIGEST,
    claimId: CLAIM,
    userMessageId: USER_ID,
    userMessageSequence: 1,
    content: ASSISTANT_TEXT,
    contentDigest: digest(ASSISTANT_TEXT),
    policyReference: appendPolicy,
  }), replies.reina_pilot_append_assistant_and_complete);
  assert.deepEqual(await store.markTurnFailed({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    idempotencyKey: KEY,
    inputDigest: INPUT_DIGEST,
    claimId: CLAIM,
    stage: 'model',
    reasonCode: 'MODEL_GENERATION_FAILED',
    policyReference: appendPolicy,
  }), replies.reina_pilot_mark_turn_failed);
  assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), Object.keys(replies));
  for (const call of calls) {
    assert.equal(call.url.startsWith('https://project.supabase.co/rest/v1/rpc/'), true);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.headers.apikey, ENV.SUPABASE_SERVICE_KEY);
    assert.equal(call.init.headers.Authorization, `Bearer ${ENV.SUPABASE_SERVICE_KEY}`);
    assert.equal(call.init.signal instanceof AbortSignal, true);
  }
  for (const call of calls) {
    assert.equal(Object.hasOwn(call.body, 'p_deadline_at'), true);
    const deadline = Date.parse(call.body.p_deadline_at);
    assert.equal(Number.isFinite(deadline), true);
    assert.equal(deadline > Date.now() - 1_000, true);
    assert.equal(deadline <= Date.now() + 15_000, true);
  }
  const claimCall = calls.find(call => call.url.endsWith('/reina_pilot_claim_turn'));
  assert.ok(claimCall);
  assert.equal(Object.hasOwn(claimCall.body, 'p_attempt_deadline_at'), true);
  assert.equal(Date.parse(claimCall.body.p_attempt_deadline_at) >= Date.parse(claimCall.body.p_deadline_at), true);
  assert.deepEqual(Object.keys(store).sort(), [
    'appendAssistantAndCompleteTurn', 'appendUserMessageOnce', 'claimTurn',
    'consumeReviewIntent', 'createConversation', 'issueReviewIntent',
    'loadConversation', 'loadHistory', 'markTurnFailed',
  ]);
});

test('review intent issue and consume use only fixed service RPCs and exact policy bindings', async () => {
  const replies = {
    reina_pilot_issue_review_intent: {
      status: 'issued', intentId: REVIEW_INTENT, expiresAt: REVIEW_EXPIRES_AT,
    },
    reina_pilot_consume_review_intent: { status: 'consumed', intentId: REVIEW_INTENT },
  };
  const { store, calls } = scriptedStore(url => replies[url.split('/').at(-1)]);
  const policyReference = reviewPolicy();

  assert.deepEqual(await store.issueReviewIntent({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    turnId: REVIEW_TURN,
    intentId: REVIEW_INTENT,
    expiresAt: REVIEW_EXPIRES_AT,
    policyReference,
  }), replies.reina_pilot_issue_review_intent);
  assert.deepEqual(await store.consumeReviewIntent({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    intentId: REVIEW_INTENT,
    policyReference,
  }), replies.reina_pilot_consume_review_intent);

  assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), Object.keys(replies));
  assert.deepEqual(calls[0].body, {
    p_owner_principal_id: OWNER,
    p_conversation_id: CONVERSATION,
    p_turn_id: REVIEW_TURN,
    p_intent_id: REVIEW_INTENT,
    p_expires_at: REVIEW_EXPIRES_AT,
    p_policy_reference: reviewPolicy(),
    p_deadline_at: calls[0].body.p_deadline_at,
  });
  assert.deepEqual(calls[1].body, {
    p_owner_principal_id: OWNER,
    p_conversation_id: CONVERSATION,
    p_intent_id: REVIEW_INTENT,
    p_policy_reference: reviewPolicy(),
    p_deadline_at: calls[1].body.p_deadline_at,
  });
  for (const call of calls) {
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.headers.apikey, ENV.SUPABASE_SERVICE_KEY);
    assert.equal(call.init.headers.Authorization, `Bearer ${ENV.SUPABASE_SERVICE_KEY}`);
    assert.equal(call.init.signal instanceof AbortSignal, true);
    assert.equal(Date.parse(call.body.p_deadline_at) > Date.now() - 1_000, true);
  }
});

test('review intent validation rejects forged owner, policy, expiry, and response shapes before authority can widen', async () => {
  let calls = 0;
  const store = createSupabaseConversationStore({
    env: ENV,
    fetchImpl: async () => {
      calls += 1;
      return mockResponse({ status: 'issued', intentId: REVIEW_INTENT, expiresAt: REVIEW_EXPIRES_AT });
    },
  });
  const valid = {
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    turnId: REVIEW_TURN,
    intentId: REVIEW_INTENT,
    expiresAt: REVIEW_EXPIRES_AT,
    policyReference: reviewPolicy(),
  };
  const invalid = [
    { ...valid, ownerPrincipalId: 'not-a-uuid' },
    { ...valid, conversationId: 'bad conversation' },
    { ...valid, turnId: 'bad turn' },
    { ...valid, intentId: 'bad intent' },
    { ...valid, expiresAt: '2026-08-03T12:05:00Z' },
    { ...valid, policyReference: reviewPolicy('22222222-2222-4222-8222-222222222222') },
    { ...valid, policyReference: { ...reviewPolicy(), extraAuthority: true } },
    { ...valid, extraAuthority: true },
  ];
  for (const input of invalid) {
    assert.deepEqual(await store.issueReviewIntent(input), { status: 'invalid' });
  }
  assert.equal(calls, 0);

  const forgedResponse = scriptedStore(() => ({
    status: 'issued',
    intentId: REVIEW_INTENT,
    expiresAt: REVIEW_EXPIRES_AT,
    executed: true,
  })).store;
  assert.deepEqual(await forgedResponse.issueReviewIntent(valid), { status: 'invalid' });
});

test('revocation results fail closed and two-tab consume exposes one consumed result then duplicate', async () => {
  const consumeInput = {
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    intentId: REVIEW_INTENT,
    policyReference: reviewPolicy(),
  };
  for (const status of [
    'not_found', 'owner_mismatch', 'policy_mismatch', 'expired', 'duplicate', 'invalid',
  ]) {
    const store = scriptedStore(() => ({ status })).store;
    assert.deepEqual(await store.consumeReviewIntent(consumeInput), { status });
  }

  let calls = 0;
  const twoTabs = scriptedStore(() => {
    calls += 1;
    return calls === 1
      ? { status: 'consumed', intentId: REVIEW_INTENT }
      : { status: 'duplicate' };
  }).store;
  assert.deepEqual(await Promise.all([
    twoTabs.consumeReviewIntent(consumeInput),
    twoTabs.consumeReviewIntent(consumeInput),
  ]), [
    { status: 'consumed', intentId: REVIEW_INTENT },
    { status: 'duplicate' },
  ]);

  const wrongIntent = scriptedStore(() => ({
    status: 'consumed', intentId: `rui.${'f'.repeat(32)}`,
  })).store;
  assert.deepEqual(await wrongIntent.consumeReviewIntent(consumeInput), { status: 'invalid' });
});

test('claim replay is fully correlated and malformed or forged replay fails closed', async () => {
  const { store } = scriptedStore(() => ({ status: 'replay', result: storedResult() }));
  const input = {
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    idempotencyKey: KEY,
    inputDigest: INPUT_DIGEST,
    appendPolicyReference: policy('reina.conversation.append'),
    replayReadPolicyReference: policy('reina.conversation.read'),
  };
  const result = await store.claimTurn(input);
  assert.equal(result.status, 'replay');
  assert.deepEqual(result.result, storedResult());

  const forged = storedResult();
  forged.ownerPrincipalId = '66666666-6666-4666-8666-666666666666';
  const other = scriptedStore(() => ({ status: 'replay', result: forged })).store;
  assert.deepEqual(await other.claimTurn(input), { status: 'incomplete' });
});

test('completion accepts equivalent jsonb policy fields regardless of object key order', async () => {
  const result = storedResult();
  result.policyReference = {
    decisionReference: 'd'.repeat(64),
    decidedAt: '2026-08-03T12:00:00.000Z',
    ownerPrincipalId: OWNER,
    operation: 'reina.conversation.append',
    policyVersion: 'reina-acting-context-policy-v1',
  };
  const { store } = scriptedStore(() => ({ status: 'completed', result }));
  const completed = await store.appendAssistantAndCompleteTurn({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    idempotencyKey: KEY,
    inputDigest: INPUT_DIGEST,
    claimId: CLAIM,
    userMessageId: USER_ID,
    userMessageSequence: 1,
    content: ASSISTANT_TEXT,
    contentDigest: digest(ASSISTANT_TEXT),
    policyReference: policy('reina.conversation.append'),
  });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result.policyReference, policy('reina.conversation.append'));
});

test('extra or contradictory RPC fields are rejected instead of forwarded', async () => {
  const extra = scriptedStore(() => ({
    status: 'appended',
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    message: message(),
    businessActionAllowed: true,
  })).store;
  const result = await extra.appendUserMessageOnce({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    idempotencyKey: KEY,
    inputDigest: INPUT_DIGEST,
    claimId: CLAIM,
    content: USER_TEXT,
    contentDigest: digest(USER_TEXT),
    policyReference: policy('reina.conversation.append'),
  });
  assert.deepEqual(result, { status: 'invalid' });

  const contradictoryFetch = async () => ({
    ok: true,
    status: 500,
    text: async () => JSON.stringify({ status: 'not_found' }),
  });
  const contradictory = createSupabaseConversationStore({ env: ENV, fetchImpl: contradictoryFetch });
  assert.deepEqual(await contradictory.loadConversation({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    policyReference: policy('reina.conversation.read'),
  }), { status: 'invalid' });
});

test('history validates dense alternating canonical messages, IDs, digests, and through-message binding', async () => {
  const invalidHistory = {
    status: 'loaded',
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    messages: [message(), message({
      messageId: ASSISTANT_ID, sequence: 3, role: 'assistant', content: ASSISTANT_TEXT,
    })],
  };
  const { store } = scriptedStore(() => invalidHistory);
  assert.deepEqual(await store.loadHistory({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    throughMessageId: USER_ID,
    policyReference: policy('reina.conversation.read'),
  }), { status: 'invalid' });
});

test('descriptor-only input snapshots reject getters, proxies, extra keys, and wrong policy operations before fetch', async () => {
  let fetchCalls = 0;
  let getterCalls = 0;
  const store = createSupabaseConversationStore({
    env: ENV,
    fetchImpl: async () => { fetchCalls += 1; return mockResponse({ status: 'not_found' }); },
  });
  const accessor = Object.create(null);
  Object.defineProperties(accessor, {
    ownerPrincipalId: { enumerable: true, value: OWNER },
    conversationId: { enumerable: true, get() { getterCalls += 1; throw new Error('secret getter'); } },
    policyReference: { enumerable: true, value: policy('reina.conversation.read') },
  });
  assert.deepEqual(await store.loadConversation(accessor), { status: 'invalid' });
  assert.equal(getterCalls, 0);

  const proxy = new Proxy({
    ownerPrincipalId: OWNER, conversationId: CONVERSATION,
    policyReference: policy('reina.conversation.read'),
  }, { ownKeys() { throw new Error('secret proxy'); } });
  assert.deepEqual(await store.loadConversation(proxy), { status: 'invalid' });
  assert.deepEqual(await store.loadConversation({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    policyReference: policy('reina.conversation.read'),
    role: 'admin',
  }), { status: 'invalid' });
  assert.deepEqual(await store.loadConversation({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    policyReference: policy('reina.conversation.append'),
  }), { status: 'invalid' });
  assert.equal(fetchCalls, 0);
});

test('response accessors and response proxies fail closed without invoking traps', async () => {
  let getterCalls = 0;
  const response = {};
  Object.defineProperties(response, {
    ok: { get() { getterCalls += 1; throw new Error('secret response getter'); } },
    text: { value: async () => JSON.stringify({ status: 'not_found' }) },
  });
  const accessorStore = createSupabaseConversationStore({ env: ENV, fetchImpl: async () => response });
  assert.deepEqual(await accessorStore.loadConversation({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    policyReference: policy('reina.conversation.read'),
  }), { status: 'invalid' });
  assert.equal(getterCalls, 0);

  const proxied = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('secret proxy'); } });
  const proxyStore = createSupabaseConversationStore({ env: ENV, fetchImpl: async () => proxied });
  assert.deepEqual(await proxyStore.loadConversation({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    policyReference: policy('reina.conversation.read'),
  }), { status: 'invalid' });
});

test('the end-to-end deadline covers a fetch that ignores AbortSignal', async () => {
  const store = createSupabaseConversationStore({
    env: ENV,
    timeoutMs: 10,
    fetchImpl: () => new Promise(() => {}),
  });
  const started = Date.now();
  assert.deepEqual(await store.loadConversation({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    policyReference: policy('reina.conversation.read'),
  }), { status: 'invalid' });
  assert.equal(Date.now() - started < 250, true);
});

test('a per-call child abort terminates a fetch that ignores AbortSignal', async () => {
  let fetchStarted;
  let capturedSignal;
  const started = new Promise(resolve => { fetchStarted = resolve; });
  const store = createSupabaseConversationStore({
    env: ENV,
    timeoutMs: 1_000,
    fetchImpl: (_url, init) => {
      capturedSignal = init.signal;
      fetchStarted();
      return new Promise(() => {});
    },
  });
  const controller = new AbortController();
  const pending = store.claimTurn({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    idempotencyKey: KEY,
    inputDigest: INPUT_DIGEST,
    appendPolicyReference: policy('reina.conversation.append'),
    replayReadPolicyReference: policy('reina.conversation.read'),
  }, {
    signal: controller.signal,
    deadlineAt: Date.now() + 1_000,
  });
  await started;
  const abortedAt = Date.now();
  controller.abort();
  assert.deepEqual(await pending, { status: 'incomplete' });
  assert.equal(Date.now() - abortedAt < 250, true);
  assert.equal(capturedSignal.aborted, true);
});

test('a per-call stage deadline terminates ignored fetches and is forwarded exactly to SQL', async () => {
  const stageDeadline = Date.now() + 20;
  const hanging = createSupabaseConversationStore({
    env: ENV,
    timeoutMs: 1_000,
    fetchImpl: () => new Promise(() => {}),
  });
  const started = Date.now();
  assert.deepEqual(await hanging.markTurnFailed({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    idempotencyKey: KEY,
    inputDigest: INPUT_DIGEST,
    claimId: CLAIM,
    stage: 'model',
    reasonCode: 'MODEL_GENERATION_FAILED',
    policyReference: policy('reina.conversation.append'),
  }, { deadlineAt: stageDeadline }), { status: 'incomplete' });
  assert.equal(Date.now() - started < 250, true);

  let sentBody;
  const callDeadline = Date.now() + 250;
  const exact = createSupabaseConversationStore({
    env: ENV,
    timeoutMs: 1_000,
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return mockResponse({ status: 'conflict' });
    },
  });
  assert.deepEqual(await exact.claimTurn({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    idempotencyKey: KEY,
    inputDigest: INPUT_DIGEST,
    appendPolicyReference: policy('reina.conversation.append'),
    replayReadPolicyReference: policy('reina.conversation.read'),
  }, { deadlineAt: callDeadline }), { status: 'conflict' });
  assert.equal(Date.parse(sentBody.p_deadline_at), callDeadline);
  assert.equal(Date.parse(sentBody.p_deadline_at) <= callDeadline, true);
  assert.equal(Date.parse(sentBody.p_attempt_deadline_at), callDeadline);
});

test('the same deadline covers a body read that never settles', async () => {
  const store = createSupabaseConversationStore({
    env: ENV,
    timeoutMs: 10,
    fetchImpl: async () => ({ ok: true, status: 200, text: () => new Promise(() => {}) }),
  });
  const started = Date.now();
  assert.deepEqual(await store.loadConversation({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    policyReference: policy('reina.conversation.read'),
  }), { status: 'invalid' });
  assert.equal(Date.now() - started < 250, true);
});

test('pre-aborted AbortSignal and expired deadlineAt fail before network', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const aborted = createSupabaseConversationStore({
    env: ENV,
    signal: controller.signal,
    fetchImpl: async () => { calls += 1; return mockResponse({ status: 'not_found' }); },
  });
  assert.deepEqual(await aborted.loadConversation({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    policyReference: policy('reina.conversation.read'),
  }), { status: 'invalid' });

  const expired = createSupabaseConversationStore({
    env: ENV,
    deadlineAt: new Date(Date.now() - 1).toISOString(),
    fetchImpl: async () => { calls += 1; return mockResponse({ status: 'not_found' }); },
  });
  assert.deepEqual(await expired.loadConversation({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    policyReference: policy('reina.conversation.read'),
  }), { status: 'invalid' });
  assert.equal(calls, 0);
});

test('hostile per-call options fail closed before network without invoking accessors or proxy traps', async () => {
  let calls = 0;
  let getterCalls = 0;
  let proxyTrapCalls = 0;
  const store = createSupabaseConversationStore({
    env: ENV,
    fetchImpl: async () => {
      calls += 1;
      return mockResponse({ status: 'not_found' });
    },
  });
  const input = {
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    policyReference: policy('reina.conversation.read'),
  };
  const accessor = {};
  Object.defineProperty(accessor, 'deadlineAt', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('SYNTHETIC_SECRET_OPTION_GETTER');
    },
  });
  const proxy = new Proxy({}, {
    ownKeys() {
      proxyTrapCalls += 1;
      throw new Error('SYNTHETIC_SECRET_OPTION_PROXY');
    },
  });
  const invalidOptions = [
    accessor,
    proxy,
    { deadlineAt: Date.now() + 1_000, extraAuthority: true },
    { signal: {} },
    { deadlineAt: '2026-99-99T99:99:99Z' },
    { deadlineAt: Date.now() - 1 },
  ];
  for (const callOptions of invalidOptions) {
    assert.deepEqual(await store.loadConversation(input, callOptions), { status: 'invalid' });
  }
  assert.equal(getterCalls, 0);
  assert.equal(proxyTrapCalls, 0);
  assert.equal(calls, 0);
});

test('oversized, malformed, HTTP-error, and thrown secret responses collapse to fixed failures', async () => {
  const input = {
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    policyReference: policy('reina.conversation.read'),
  };
  const stores = [
    createSupabaseConversationStore({ env: ENV, fetchImpl: async () => mockResponse('x'.repeat(2_200_001)) }),
    createSupabaseConversationStore({ env: ENV, fetchImpl: async () => mockResponse('{malformed') }),
    createSupabaseConversationStore({ env: ENV, fetchImpl: async () => mockResponse({ secret: 'LEAK' }, { status: 503 }) }),
    createSupabaseConversationStore({ env: ENV, fetchImpl: async () => { throw new Error('SYNTHETIC_SECRET_MARKER'); } }),
  ];
  for (const store of stores) {
    const result = await store.loadConversation(input);
    assert.deepEqual(result, { status: 'invalid' });
    assert.doesNotMatch(JSON.stringify(result), /LEAK|SECRET_MARKER/u);
  }
});

test('configuration and fetch identities are snapshotted at construction', async () => {
  const env = { ...ENV };
  let originalCalls = 0;
  const fetchImpl = async () => {
    originalCalls += 1;
    return mockResponse({ status: 'not_found' });
  };
  const store = createSupabaseConversationStore({ env, fetchImpl });
  env.SUPABASE_URL = 'https://forged.invalid';
  env.SUPABASE_SERVICE_KEY = 'forged';
  const result = await store.loadConversation({
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    policyReference: policy('reina.conversation.read'),
  });
  assert.deepEqual(result, { status: 'not_found' });
  assert.equal(originalCalls, 1);
});
