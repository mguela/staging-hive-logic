import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import { resolveActingContext } from '../api/_lib/reina/acting-context.js';
import {
  AUTHORIZATION_POLICY_VERSION,
  REINA_OPERATION,
  decideAuthorization,
} from '../api/_lib/reina/authorization.js';
import {
  DURABLE_STORE_METHODS,
  DisabledConversationStore,
  LIMITS,
  REASON,
  appendDurableTurn,
  canonicalDigest,
  validateTurnInput,
} from '../reina/runtime/durable-conversation-core.js';

const BASE_TURN = Object.freeze({
  conversationId: 'conversation-1',
  idempotencyKey: 'turn-1',
  content: 'What needs attention?',
});

const PASS = Symbol('use-default-store-behavior');

async function verifiedContext(principalId = 'owner-1') {
  const resolved = await resolveActingContext({}, {
    env: {
      REINA_ACTING_CONTEXT_ENABLED: 'true',
      SUPABASE_URL: 'https://supabase.example',
      SUPABASE_SERVICE_KEY: 'server-only-key',
    },
    requireUserImpl: async () => ({ id: principalId }),
    fetchImpl: async () => ({
      ok: true,
      json: async () => [{ id: principalId, role: 'admin' }],
    }),
  });
  assert.equal(resolved.ok, true);
  return resolved.context;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function revokedProxy(target = {}) {
  const { proxy, revoke } = Proxy.revocable(target, {});
  revoke();
  return proxy;
}

class AtomicMemoryStore {
  constructor({ events = [], overrides = {} } = {}) {
    this.events = events;
    this.overrides = overrides;
    this.calls = [];
    this.conversations = new Map();
    this.claims = new Map();
    this.claimCounter = 0;
    this.resultCounter = 0;
  }

  scopeKey(ownerPrincipalId, conversationId) {
    return `${ownerPrincipalId}\u0000${conversationId}`;
  }

  claimKey(ownerPrincipalId, conversationId, idempotencyKey) {
    return `${this.scopeKey(ownerPrincipalId, conversationId)}\u0000${idempotencyKey}`;
  }

  record(method, input) {
    this.events.push(method);
    this.calls.push(Object.freeze({ method, input }));
  }

  async override(method, input) {
    if (!Object.hasOwn(this.overrides, method)) return Object.freeze({ used: false });
    const value = await this.overrides[method](input, this);
    return value === PASS
      ? Object.freeze({ used: false })
      : Object.freeze({ used: true, value });
  }

  findClaim(input) {
    const key = this.claimKey(input.ownerPrincipalId, input.conversationId, input.idempotencyKey);
    const claim = this.claims.get(key);
    return claim?.claimId === input.claimId && claim.inputDigest === input.inputDigest ? claim : null;
  }

  async loadConversation(input) {
    this.record('loadConversation', input);
    const overridden = await this.override('loadConversation', input);
    if (overridden.used) return overridden.value;
    const conversation = this.conversations.get(this.scopeKey(input.ownerPrincipalId, input.conversationId));
    return conversation
      ? { status: 'found', conversation: { ownerPrincipalId: input.ownerPrincipalId, conversationId: input.conversationId } }
      : { status: 'not_found' };
  }

  async createConversation(input) {
    this.record('createConversation', input);
    const overridden = await this.override('createConversation', input);
    if (overridden.used) return overridden.value;
    const key = this.scopeKey(input.ownerPrincipalId, input.conversationId);
    if (this.conversations.has(key)) return { status: 'exists' };
    this.conversations.set(key, { messages: [] });
    return { status: 'created', conversation: { ownerPrincipalId: input.ownerPrincipalId, conversationId: input.conversationId } };
  }

  async claimTurn(input) {
    this.record('claimTurn', input);
    const overridden = await this.override('claimTurn', input);
    if (overridden.used) return overridden.value;
    const scope = this.scopeKey(input.ownerPrincipalId, input.conversationId);
    const key = this.claimKey(input.ownerPrincipalId, input.conversationId, input.idempotencyKey);
    let claim = this.claims.get(key);
    if (!claim) {
      const unresolvedSibling = [...this.claims.entries()].find(([otherKey, otherClaim]) => (
        otherKey.startsWith(`${scope}\u0000`) && otherClaim.state !== 'completed'
      ));
      if (unresolvedSibling) {
        if (unresolvedSibling[1].state === 'in_flight') return { status: 'in_flight' };
        if (unresolvedSibling[1].state === 'failed_terminal') return { status: 'failed' };
        return { status: 'incomplete' };
      }
      claim = {
        claimId: `claim-${++this.claimCounter}`,
        inputDigest: input.inputDigest,
        state: 'in_flight',
        userMessage: null,
        result: null,
      };
      this.claims.set(key, claim);
      return { status: 'claimed', claimId: claim.claimId, progress: 'claimed' };
    }
    if (claim.inputDigest !== input.inputDigest) return { status: 'conflict' };
    if (claim.state === 'completed') return { status: 'replay', result: claim.result };
    if (claim.state === 'in_flight') return { status: 'in_flight' };
    if (claim.state === 'incomplete') return { status: 'incomplete' };
    if (claim.state === 'failed_terminal') return { status: 'failed' };
    if (claim.state === 'failed_retryable') {
      const unresolvedSibling = [...this.claims.entries()].some(([otherKey, otherClaim]) => (
        otherKey !== key
        && otherKey.startsWith(`${scope}\u0000`)
        && otherClaim.state !== 'completed'
      ));
      if (unresolvedSibling) return { status: 'incomplete' };
      claim.state = 'in_flight';
      claim.claimId = `claim-${++this.claimCounter}`;
      return {
        status: 'resumed',
        claimId: claim.claimId,
        progress: claim.userMessage ? 'user_persisted' : 'claimed',
      };
    }
    return { status: 'failed' };
  }

  async appendUserMessageOnce(input) {
    this.record('appendUserMessageOnce', input);
    const overridden = await this.override('appendUserMessageOnce', input);
    if (overridden.used) return overridden.value;
    const claim = this.findClaim(input);
    if (!claim || claim.state !== 'in_flight') throw new Error('unknown claim');
    if (claim.userMessage) {
      return {
        status: 'existing',
        ownerPrincipalId: input.ownerPrincipalId,
        conversationId: input.conversationId,
        message: claim.userMessage,
      };
    }
    const conversation = this.conversations.get(this.scopeKey(input.ownerPrincipalId, input.conversationId));
    const message = Object.freeze({
      messageId: `user-${claim.claimId}`,
      sequence: conversation.messages.length + 1,
      role: 'user',
      content: input.content,
      contentDigest: input.contentDigest,
    });
    conversation.messages.push(message);
    claim.userMessage = message;
    return {
      status: 'appended',
      ownerPrincipalId: input.ownerPrincipalId,
      conversationId: input.conversationId,
      message,
    };
  }

  async loadHistory(input) {
    this.record('loadHistory', input);
    const overridden = await this.override('loadHistory', input);
    if (overridden.used) return overridden.value;
    const conversation = this.conversations.get(this.scopeKey(input.ownerPrincipalId, input.conversationId));
    const throughIndex = conversation?.messages.findIndex(message => message.messageId === input.throughMessageId) ?? -1;
    if (throughIndex < 0) throw new Error('missing through message');
    return {
      status: 'loaded',
      ownerPrincipalId: input.ownerPrincipalId,
      conversationId: input.conversationId,
      messages: conversation.messages.slice(0, throughIndex + 1),
    };
  }

  async appendAssistantAndCompleteTurn(input) {
    this.record('appendAssistantAndCompleteTurn', input);
    const overridden = await this.override('appendAssistantAndCompleteTurn', input);
    if (overridden.used) return overridden.value;
    const claim = this.findClaim(input);
    if (!claim || !claim.userMessage || claim.userMessage.messageId !== input.userMessageId) {
      throw new Error('invalid completion claim');
    }
    if (claim.state === 'completed') return { status: 'completed', result: claim.result };
    if (claim.state !== 'in_flight') throw new Error('stale completion claim');
    const conversation = this.conversations.get(this.scopeKey(input.ownerPrincipalId, input.conversationId));
    const assistantMessage = Object.freeze({
      messageId: `assistant-${claim.claimId}`,
      sequence: conversation.messages.length + 1,
      role: 'assistant',
      content: input.content,
      contentDigest: input.contentDigest,
    });
    conversation.messages.push(assistantMessage);
    claim.result = Object.freeze({
      ownerPrincipalId: input.ownerPrincipalId,
      conversationId: input.conversationId,
      idempotencyKey: input.idempotencyKey,
      inputDigest: input.inputDigest,
      userMessageId: claim.userMessage.messageId,
      userMessageSequence: claim.userMessage.sequence,
      assistantMessage,
      resultReference: `result-${++this.resultCounter}`,
      policyReference: input.policyReference,
    });
    claim.state = 'completed';
    return { status: 'completed', result: claim.result };
  }

  async markTurnFailed(input) {
    this.record('markTurnFailed', input);
    const overridden = await this.override('markTurnFailed', input);
    if (overridden.used) return overridden.value;
    const claim = this.findClaim(input);
    if (!claim) return { status: 'incomplete' };
    if (claim.state === 'completed') return { status: 'already_completed' };
    if (claim.state !== 'in_flight') return { status: 'incomplete' };
    claim.state = 'failed_retryable';
    claim.failure = Object.freeze({ stage: input.stage, reasonCode: input.reasonCode });
    return { status: 'recorded', state: 'failed_retryable' };
  }
}

async function harness({ principalId = 'owner-1', store, storeOverrides, generate } = {}) {
  const actingContext = await verifiedContext(principalId);
  const events = [];
  const actualStore = store || new AtomicMemoryStore({ events, overrides: storeOverrides });
  if (store && store.events !== events) actualStore.events = events;
  const modelInputs = [];
  const generator = generate || (async input => {
    events.push('model');
    modelInputs.push(input);
    return 'Synthetic answer.';
  });
  return { actingContext, events, store: actualStore, modelInputs, generate: generator };
}

function execute(h, turn = BASE_TURN, extras = {}) {
  return appendDurableTurn({
    enabled: true,
    actingContext: h.actingContext,
    turn,
    store: h.store,
    generate: h.generate,
    ...extras,
  });
}

function assertPolicyReference(reference, operation, ownerPrincipalId) {
  assert.equal(Object.isFrozen(reference), true);
  assert.deepEqual(Object.keys(reference), [
    'policyVersion',
    'operation',
    'ownerPrincipalId',
    'decidedAt',
    'decisionReference',
  ]);
  assert.equal(reference.policyVersion, AUTHORIZATION_POLICY_VERSION);
  assert.equal(reference.operation, operation);
  assert.equal(reference.ownerPrincipalId, ownerPrincipalId);
  assert.match(reference.decisionReference, /^[a-f0-9]{64}$/);
  assert.equal(new Date(reference.decidedAt).toISOString(), reference.decidedAt);
  for (const forbidden of ['role', 'capabilities', 'companyId', 'allowed', 'decision']) {
    assert.equal(Object.hasOwn(reference, forbidden), false);
  }
}

function callsFor(store, method) {
  return store.calls.filter(call => call.method === method);
}

test('canonical digest is stable and rejects accessors and Proxies without reading them', () => {
  assert.equal(
    canonicalDigest({ b: 2, a: 'e\u0301' }),
    canonicalDigest({ a: '\u00e9', b: 2 }),
  );
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'a', { enumerable: true, get() { getterCalls += 1; return 'unsafe'; } });
  assert.throws(() => canonicalDigest(accessor), TypeError);
  assert.equal(getterCalls, 0);
  let proxyTraps = 0;
  const proxy = new Proxy({ a: 1 }, { get() { proxyTraps += 1; return 1; } });
  assert.throws(() => canonicalDigest(proxy), TypeError);
  assert.throws(() => canonicalDigest(revokedProxy({ a: 1 })), TypeError);
  assert.equal(proxyTraps, 0);
});

test('feature is disabled unless enabled is exactly true and touches no dependency', async () => {
  const calls = [];
  const explosive = new Proxy({}, { get() { calls.push('get'); throw new Error('must not read'); } });
  const disabled = await appendDurableTurn();
  const truthy = await appendDurableTurn({ enabled: 'true', actingContext: explosive, turn: explosive, store: explosive, generate: explosive });
  assert.equal(disabled.reasonCode, REASON.DISABLED);
  assert.equal(truthy.reasonCode, REASON.DISABLED);
  assert.deepEqual(calls, []);
});

test('disabled store exposes the complete finite seam and cannot masquerade as persistence', async () => {
  assert.deepEqual(DURABLE_STORE_METHODS, [
    'loadConversation',
    'createConversation',
    'claimTurn',
    'appendUserMessageOnce',
    'loadHistory',
    'appendAssistantAndCompleteTurn',
    'markTurnFailed',
  ]);
  const store = new DisabledConversationStore();
  for (const method of DURABLE_STORE_METHODS) {
    await assert.rejects(() => store[method]({}), /DURABLE_CONVERSATIONS_DISABLED/);
  }
});

test('success uses exact live policy boundaries, stored history, and atomic completion', async () => {
  const h = await harness();
  const result = await execute(h);
  assert.equal(result.reasonCode, REASON.STORED);
  assert.equal(result.persisted, true);
  assert.equal(result.replayed, false);
  assert.equal(result.modelInvoked, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.assistantMessage), true);
  assert.deepEqual(h.events, [
    'claimTurn',
    'loadConversation',
    'createConversation',
    'appendUserMessageOnce',
    'loadHistory',
    'model',
    'appendAssistantAndCompleteTurn',
  ]);

  assertPolicyReference(callsFor(h.store, 'loadConversation')[0].input.policyReference, REINA_OPERATION.CONVERSATION_READ, 'owner-1');
  assertPolicyReference(callsFor(h.store, 'createConversation')[0].input.policyReference, REINA_OPERATION.CONVERSATION_CREATE, 'owner-1');
  assertPolicyReference(callsFor(h.store, 'claimTurn')[0].input.appendPolicyReference, REINA_OPERATION.CONVERSATION_APPEND, 'owner-1');
  assertPolicyReference(callsFor(h.store, 'claimTurn')[0].input.replayReadPolicyReference, REINA_OPERATION.CONVERSATION_READ, 'owner-1');
  assertPolicyReference(callsFor(h.store, 'appendUserMessageOnce')[0].input.policyReference, REINA_OPERATION.CONVERSATION_APPEND, 'owner-1');
  assertPolicyReference(callsFor(h.store, 'loadHistory')[0].input.policyReference, REINA_OPERATION.CONVERSATION_READ, 'owner-1');
  assertPolicyReference(callsFor(h.store, 'appendAssistantAndCompleteTurn')[0].input.policyReference, REINA_OPERATION.CONVERSATION_APPEND, 'owner-1');

  assert.equal(h.modelInputs.length, 1);
  assert.deepEqual(Object.keys(h.modelInputs[0]), ['messages', 'tools']);
  assert.equal(Object.isFrozen(h.modelInputs[0]), true);
  assert.equal(Object.isFrozen(h.modelInputs[0].messages), true);
  assert.equal(Object.isFrozen(h.modelInputs[0].messages[0]), true);
  assert.equal(Object.isFrozen(h.modelInputs[0].tools), true);
  assert.deepEqual(h.modelInputs[0].tools, []);
  assert.equal(h.modelInputs[0].messages.at(-1).content, BASE_TURN.content);
  assert.equal(h.modelInputs[0].messages.at(-1).role, 'user');
  assert.equal(result.toolExecutionAllowed, false);
  assert.equal(result.businessActionAllowed, false);
  assert.equal(result.automationTaskAllowed, false);
});

test('existing owner-scoped conversation is loaded without another create', async () => {
  const h = await harness();
  assert.equal((await execute(h)).reasonCode, REASON.STORED);
  assert.equal((await execute(h, { ...BASE_TURN, idempotencyKey: 'turn-2', content: 'Second turn' })).reasonCode, REASON.STORED);
  assert.equal(callsFor(h.store, 'createConversation').length, 1);
  assert.equal(callsFor(h.store, 'loadConversation').length, 2);
});

test('only genuine resolver-issued ActingContexts can reach storage', async () => {
  const h = await harness();
  const genuine = h.actingContext;
  const forged = [
    { ...genuine },
    Object.freeze({ ...genuine }),
    JSON.parse(JSON.stringify(genuine)),
    structuredClone(genuine),
    new Proxy(genuine, {}),
    Object.freeze({ principalId: genuine.principalId, role: 'admin', capabilities: genuine.capabilities }),
  ];
  for (const actingContext of forged) {
    const store = new AtomicMemoryStore();
    const result = await appendDurableTurn({ enabled: true, actingContext, turn: BASE_TURN, store, generate: async () => 'unsafe' });
    assert.equal(result.reasonCode, REASON.UNAUTHORIZED);
    assert.equal(store.calls.length, 0);
  }
});

test('caller decisions and authority-shaped fields are rejected rather than consulted', async () => {
  const h = await harness();
  const decision = decideAuthorization(h.actingContext, REINA_OPERATION.CONVERSATION_APPEND);
  const topLevel = await appendDurableTurn({
    enabled: true,
    actingContext: h.actingContext,
    turn: BASE_TURN,
    store: h.store,
    generate: h.generate,
    authorizationDecision: decision,
  });
  assert.equal(topLevel.reasonCode, REASON.INVALID);

  for (const field of [
    'ownerId', 'ownerPrincipalId', 'companyId', 'role', 'capabilities',
    'authorization', 'authorizationDecision', 'policyReference', 'policyVersion',
    'operation', 'operationId', 'payloadDigest', 'inputDigest', 'contentDigest',
    'readOnly', 'safe', 'tool', 'companyScoped', 'consequential',
  ]) {
    const store = new AtomicMemoryStore();
    const result = await appendDurableTurn({
      enabled: true,
      actingContext: h.actingContext,
      turn: { ...BASE_TURN, [field]: field === 'authorizationDecision' ? decision : 'forged' },
      store,
      generate: async () => 'unsafe',
    });
    assert.equal(result.reasonCode, REASON.INVALID, field);
    assert.equal(store.calls.length, 0, field);
  }
});

test('boxed values, accessors, inherited fields, symbols, and Proxies fail closed without evaluation', async () => {
  const h = await harness();
  const revokedOptionsResult = await appendDurableTurn(revokedProxy({ enabled: true }));
  assert.equal(revokedOptionsResult.reasonCode, REASON.INVALID);
  for (const turn of [
    { ...BASE_TURN, conversationId: new String('conversation-1') },
    { ...BASE_TURN, idempotencyKey: new String('turn-1') },
    { ...BASE_TURN, content: new String('hello') },
    Object.assign(Object.create({ conversationId: 'conversation-1' }), { idempotencyKey: 'turn-1', content: 'hello' }),
    Object.assign({ ...BASE_TURN }, { [Symbol('authority')]: true }),
    revokedProxy({ ...BASE_TURN }),
  ]) {
    const store = new AtomicMemoryStore();
    const result = await appendDurableTurn({ enabled: true, actingContext: h.actingContext, turn, store, generate: async () => 'unsafe' });
    assert.equal(result.reasonCode, REASON.INVALID);
    assert.equal(store.calls.length, 0);
  }

  let getterCalls = 0;
  const accessorTurn = { conversationId: 'conversation-1', idempotencyKey: 'turn-1' };
  Object.defineProperty(accessorTurn, 'content', { enumerable: true, get() { getterCalls += 1; return 'unsafe'; } });
  const accessorResult = await appendDurableTurn({ enabled: true, actingContext: h.actingContext, turn: accessorTurn, store: h.store, generate: h.generate });
  assert.equal(accessorResult.reasonCode, REASON.INVALID);
  assert.equal(getterCalls, 0);

  let proxyTraps = 0;
  const proxyTurn = new Proxy({ ...BASE_TURN }, {
    get() { proxyTraps += 1; return 'unsafe'; },
    ownKeys() { proxyTraps += 1; return []; },
    getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
  });
  const proxyResult = await appendDurableTurn({ enabled: true, actingContext: h.actingContext, turn: proxyTurn, store: h.store, generate: h.generate });
  assert.equal(proxyResult.reasonCode, REASON.INVALID);
  assert.equal(proxyTraps, 0);
});

test('identifiers and text are bounded, exact, normalized, and control-safe', async () => {
  assert.equal(validateTurnInput(BASE_TURN), true);
  for (const turn of [
    { ...BASE_TURN, conversationId: ' conversation-1' },
    { ...BASE_TURN, conversationId: 'conversation\n1' },
    { ...BASE_TURN, idempotencyKey: 'turn/1' },
    { ...BASE_TURN, idempotencyKey: 'x'.repeat(LIMITS.identifierCharacters + 1) },
    { ...BASE_TURN, content: '' },
    { ...BASE_TURN, content: '   \n\t' },
    { ...BASE_TURN, content: 'unsafe\u0000text' },
    { ...BASE_TURN, content: 'unsafe\u202etext' },
    { ...BASE_TURN, content: '\ud800' },
    { ...BASE_TURN, content: 'x'.repeat(LIMITS.contentCharacters + 1) },
  ]) assert.equal(validateTurnInput(turn), false);

  const h = await harness();
  const result = await execute(h, { ...BASE_TURN, content: 'Cafe\u0301\r\nLine 2\tOK' });
  assert.equal(result.reasonCode, REASON.STORED);
  assert.equal(callsFor(h.store, 'appendUserMessageOnce')[0].input.content, 'Caf\u00e9\nLine 2\tOK');
});

test('turn input is snapshotted before the first await and client mutation cannot change scope or content', async () => {
  const mutable = { ...BASE_TURN, content: 'Original' };
  const h = await harness({
    storeOverrides: {
      async loadConversation() {
        mutable.conversationId = 'mutated-conversation';
        mutable.idempotencyKey = 'mutated-turn';
        mutable.content = 'Mutated';
        return PASS;
      },
    },
  });
  const result = await execute(h, mutable);
  assert.equal(result.conversationId, BASE_TURN.conversationId);
  assert.equal(result.idempotencyKey, BASE_TURN.idempotencyKey);
  assert.equal(callsFor(h.store, 'appendUserMessageOnce')[0].input.content, 'Original');
  assert.equal(h.modelInputs[0].messages.at(-1).content, 'Original');
});

test('digest is server-computed and NFC-equivalent retries replay while changed content conflicts', async () => {
  const h = await harness();
  const decomposed = { ...BASE_TURN, content: 'Cafe\u0301' };
  const composed = { ...BASE_TURN, content: 'Caf\u00e9' };
  assert.equal((await execute(h, decomposed)).reasonCode, REASON.STORED);
  const claimDigest = callsFor(h.store, 'claimTurn')[0].input.inputDigest;
  assert.match(claimDigest, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(decomposed, 'inputDigest'), false);
  assert.equal((await execute(h, composed)).reasonCode, REASON.REPLAYED);
  assert.equal((await execute(h, { ...BASE_TURN, content: 'Different' })).reasonCode, REASON.CONFLICT);
  assert.equal(h.modelInputs.length, 1);
});

test('concurrent duplicate is suppressed in flight and completed retry replays exact stored result', async () => {
  const modelStarted = deferred();
  const releaseModel = deferred();
  const h = await harness({
    generate: async input => {
      h.events.push('model');
      h.modelInputs.push(input);
      modelStarted.resolve();
      await releaseModel.promise;
      return 'One durable answer.';
    },
  });
  const firstPromise = execute(h);
  await modelStarted.promise;
  const duplicate = await execute(h);
  assert.equal(duplicate.reasonCode, REASON.IN_FLIGHT);
  assert.equal(duplicate.modelInvoked, false);
  releaseModel.resolve();
  const first = await firstPromise;
  const replay = await execute(h);
  assert.equal(first.reasonCode, REASON.STORED);
  assert.equal(replay.reasonCode, REASON.REPLAYED);
  assert.deepEqual(replay.assistantMessage, first.assistantMessage);
  assert.equal(replay.resultReference, first.resultReference);
  assert.equal(h.modelInputs.length, 1);
  assert.equal(callsFor(h.store, 'appendUserMessageOnce').length, 1);
  assert.equal(callsFor(h.store, 'appendAssistantAndCompleteTurn').length, 1);
});

test('same key with changed input conflicts even while the first model is in flight', async () => {
  const started = deferred();
  const release = deferred();
  const h = await harness({
    generate: async () => {
      h.events.push('model');
      started.resolve();
      await release.promise;
      return 'answer';
    },
  });
  const firstPromise = execute(h);
  await started.promise;
  const conflict = await execute(h, { ...BASE_TURN, content: 'changed' });
  assert.equal(conflict.reasonCode, REASON.CONFLICT);
  release.resolve();
  assert.equal((await firstPromise).reasonCode, REASON.STORED);
});

test('owner scope always comes from ActingContext and identical locators remain principal-isolated', async () => {
  const sharedStore = new AtomicMemoryStore();
  const ownerA = await harness({ principalId: 'owner-a', store: sharedStore });
  const ownerB = await harness({ principalId: 'owner-b', store: sharedStore });
  assert.equal((await execute(ownerA, { ...BASE_TURN, content: 'Owner A content' })).reasonCode, REASON.STORED);
  assert.equal((await execute(ownerB, { ...BASE_TURN, content: 'Owner B content' })).reasonCode, REASON.STORED);
  const owners = new Set(sharedStore.calls.map(call => call.input.ownerPrincipalId).filter(Boolean));
  assert.deepEqual([...owners].sort(), ['owner-a', 'owner-b']);
  assert.equal(ownerA.modelInputs[0].messages.some(message => message.content === 'Owner B content'), false);
  assert.equal(ownerB.modelInputs[0].messages.some(message => message.content === 'Owner A content'), false);
  assert.equal(sharedStore.conversations.size, 2);
});

test('malformed or cross-owner conversation load/create results fail after claim and before model', async () => {
  const cases = [
    {
      expected: REASON.LOAD_FAILED,
      overrides: { loadConversation: async input => ({ status: 'found', conversation: { ownerPrincipalId: 'other-owner', conversationId: input.conversationId } }) },
    },
    {
      expected: REASON.LOAD_FAILED,
      overrides: { loadConversation: async () => new Proxy({ status: 'not_found' }, {}) },
    },
    {
      expected: REASON.CREATE_FAILED,
      overrides: { createConversation: async input => ({ status: 'created', conversation: { ownerPrincipalId: 'other-owner', conversationId: input.conversationId } }) },
    },
    {
      expected: REASON.CREATE_FAILED,
      overrides: { createConversation: async () => ({ status: 'unknown' }) },
    },
  ];
  for (const entry of cases) {
    const h = await harness({ storeOverrides: entry.overrides });
    const result = await execute(h);
    assert.equal(result.reasonCode, entry.expected);
    assert.equal(callsFor(h.store, 'claimTurn').length, 1);
    assert.equal(callsFor(h.store, 'markTurnFailed').length, 1);
    assert.equal(result.turnState, 'failed_retryable');
    assert.equal(h.modelInputs.length, 0);
  }
});

test('malformed stores and accessor methods are rejected without invoking them', async () => {
  const actingContext = await verifiedContext();
  let getterCalls = 0;
  const store = {};
  Object.defineProperty(store, 'loadConversation', { get() { getterCalls += 1; return async () => ({}); } });
  for (const method of DURABLE_STORE_METHODS.slice(1)) store[method] = async () => ({});
  const result = await appendDurableTurn({ enabled: true, actingContext, turn: BASE_TURN, store, generate: async () => 'unsafe' });
  assert.equal(result.reasonCode, REASON.STORE_INVALID);
  assert.equal(getterCalls, 0);

  const callableStore = new AtomicMemoryStore();
  const claimMethod = async function claimMethod(input) {
    return Reflect.apply(AtomicMemoryStore.prototype.claimTurn, this, [input]);
  };
  Object.defineProperty(claimMethod, 'bind', {
    get() {
      getterCalls += 1;
      throw new Error('must not read function.bind');
    },
  });
  callableStore.claimTurn = claimMethod;
  const callableHarness = await harness({ store: callableStore });
  assert.equal((await execute(callableHarness)).reasonCode, REASON.STORED);
  assert.equal(getterCalls, 0);
});

test('claim result variants are finite, deterministic, and never reach persistence/model', async () => {
  const cases = [
    [{ status: 'conflict' }, REASON.CONFLICT],
    [{ status: 'in_flight' }, REASON.IN_FLIGHT],
    [{ status: 'incomplete' }, REASON.INCOMPLETE],
    [{ status: 'failed' }, REASON.PREVIOUS_FAILED],
    [{ status: 'claimed', claimId: '', progress: 'claimed' }, REASON.CLAIM_FAILED],
    [{ status: 'claimed', claimId: 'claim-1' }, REASON.CLAIM_FAILED],
    [{ status: 'unknown' }, REASON.CLAIM_FAILED],
    [new Proxy({ status: 'conflict' }, {}), REASON.CLAIM_FAILED],
    [revokedProxy({ status: 'conflict' }), REASON.CLAIM_FAILED],
    [{ status: 'replay', result: revokedProxy({}) }, REASON.CLAIM_FAILED],
  ];
  for (const [claimResult, expected] of cases) {
    const h = await harness({ storeOverrides: { claimTurn: async () => claimResult } });
    const result = await execute(h);
    assert.equal(result.reasonCode, expected);
    assert.equal(callsFor(h.store, 'appendUserMessageOnce').length, 0);
    assert.equal(h.modelInputs.length, 0);
  }
});

test('malformed replay cannot claim saved success or enable tools, business, or Automation', async () => {
  const h = await harness({
    storeOverrides: {
      claimTurn: async input => ({
        status: 'replay',
        result: {
          ownerPrincipalId: input.ownerPrincipalId,
          conversationId: input.conversationId,
          idempotencyKey: input.idempotencyKey,
          inputDigest: input.inputDigest,
          userMessageId: 'user-1',
          userMessageSequence: 1,
          assistantMessage: {
            messageId: 'assistant-1', sequence: 2, role: 'assistant', content: 'unsafe', contentDigest: canonicalDigest('unsafe'),
          },
          resultReference: 'result-1',
          policyReference: { policyVersion: AUTHORIZATION_POLICY_VERSION, operation: REINA_OPERATION.CONVERSATION_APPEND },
          toolExecutionAllowed: true,
        },
      }),
    },
  });
  const result = await execute(h);
  assert.equal(result.reasonCode, REASON.CLAIM_FAILED);
  assert.equal(result.persisted, false);
  assert.equal(result.toolExecutionAllowed, false);
  assert.equal(result.businessActionAllowed, false);
  assert.equal(result.automationTaskAllowed, false);
  assert.equal(h.modelInputs.length, 0);

  let coercions = 0;
  const unsafeDigest = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      throw new Error('must not coerce');
    },
  };
  const digestHarness = await harness({
    storeOverrides: {
      claimTurn: async input => ({
        status: 'replay',
        result: {
          ownerPrincipalId: input.ownerPrincipalId,
          conversationId: input.conversationId,
          idempotencyKey: input.idempotencyKey,
          inputDigest: input.inputDigest,
          userMessageId: 'user-1',
          userMessageSequence: 1,
          assistantMessage: {
            messageId: 'assistant-1', sequence: 2, role: 'assistant', content: 'unsafe', contentDigest: unsafeDigest,
          },
          resultReference: 'result-1',
          policyReference: input.appendPolicyReference,
        },
      }),
    },
  });
  const digestResult = await execute(digestHarness);
  assert.equal(digestResult.reasonCode, REASON.CLAIM_FAILED);
  assert.equal(coercions, 0);
});

test('user persistence is an unresolved barrier and model cannot start before it completes', async () => {
  const userEntered = deferred();
  const releaseUser = deferred();
  let modelStarted = false;
  const h = await harness({
    storeOverrides: {
      appendUserMessageOnce: async () => {
        userEntered.resolve();
        await releaseUser.promise;
        return PASS;
      },
    },
    generate: async () => {
      modelStarted = true;
      return 'answer';
    },
  });
  const pending = execute(h);
  await userEntered.promise;
  assert.equal(modelStarted, false);
  releaseUser.resolve();
  assert.equal((await pending).reasonCode, REASON.STORED);
  assert.equal(modelStarted, true);
});

test('user persistence rejection or malformed echo prevents history and model', async () => {
  const cases = [
    null,
    { status: 'appended', ownerPrincipalId: 'other-owner', conversationId: BASE_TURN.conversationId, message: {} },
    {
      status: 'appended',
      ownerPrincipalId: 'owner-1',
      conversationId: BASE_TURN.conversationId,
      message: { messageId: 'user-1', sequence: 1, role: 'user', content: 'changed', contentDigest: canonicalDigest('changed') },
    },
  ];
  for (const response of cases) {
    const h = await harness({ storeOverrides: { appendUserMessageOnce: async () => response } });
    const result = await execute(h);
    assert.equal(result.reasonCode, REASON.USER_FAILED);
    assert.equal(callsFor(h.store, 'loadHistory').length, 0);
    assert.equal(h.modelInputs.length, 0);
    assert.equal(result.persisted, false);
  }
});

test('claim progress exactly matches conversation and user persistence state', async () => {
  const userEcho = status => async input => ({
    status,
    ownerPrincipalId: input.ownerPrincipalId,
    conversationId: input.conversationId,
    message: {
      messageId: 'user-progress',
      sequence: 1,
      role: 'user',
      content: input.content,
      contentDigest: input.contentDigest,
    },
  });
  const cases = [
    {
      claim: { status: 'claimed', claimId: 'claim-progress-1', progress: 'claimed' },
      overrides: { appendUserMessageOnce: userEcho('existing') },
      expectedReason: REASON.USER_FAILED,
      expectedCreateCalls: 1,
      expectedUserCalls: 1,
    },
    {
      claim: { status: 'resumed', claimId: 'claim-progress-2', progress: 'user_persisted' },
      overrides: {
        loadConversation: async input => ({
          status: 'found',
          conversation: { ownerPrincipalId: input.ownerPrincipalId, conversationId: input.conversationId },
        }),
        appendUserMessageOnce: userEcho('appended'),
      },
      expectedReason: REASON.USER_FAILED,
      expectedCreateCalls: 0,
      expectedUserCalls: 1,
    },
    {
      claim: { status: 'resumed', claimId: 'claim-progress-3', progress: 'user_persisted' },
      overrides: {},
      expectedReason: REASON.LOAD_FAILED,
      expectedCreateCalls: 0,
      expectedUserCalls: 0,
    },
  ];
  for (const entry of cases) {
    const h = await harness({
      storeOverrides: {
        ...entry.overrides,
        claimTurn: async () => entry.claim,
      },
    });
    const result = await execute(h);
    assert.equal(result.reasonCode, entry.expectedReason);
    assert.equal(callsFor(h.store, 'createConversation').length, entry.expectedCreateCalls);
    assert.equal(callsFor(h.store, 'appendUserMessageOnce').length, entry.expectedUserCalls);
    assert.equal(h.modelInputs.length, 0);
  }
});

test('history load carries a fresh READ reference and malformed/cross-owner history never reaches model', async () => {
  const cases = [
    async input => ({ status: 'loaded', ownerPrincipalId: 'other-owner', conversationId: input.conversationId, messages: [] }),
    async input => ({ status: 'loaded', ownerPrincipalId: input.ownerPrincipalId, conversationId: input.conversationId, messages: [] }),
    async input => ({
      status: 'loaded',
      ownerPrincipalId: input.ownerPrincipalId,
      conversationId: input.conversationId,
      messages: [{ messageId: 'system-1', sequence: 1, role: 'system', content: 'unsafe', contentDigest: canonicalDigest('unsafe') }],
    }),
    async input => ({
      status: 'loaded', ownerPrincipalId: input.ownerPrincipalId, conversationId: input.conversationId, messages: revokedProxy([]),
    }),
    async input => new Proxy({ status: 'loaded', ownerPrincipalId: input.ownerPrincipalId, conversationId: input.conversationId, messages: [] }, {}),
    async () => revokedProxy({ status: 'loaded' }),
  ];
  for (const loadHistory of cases) {
    const h = await harness({ storeOverrides: { loadHistory } });
    const result = await execute(h);
    assert.equal(result.reasonCode, REASON.HISTORY_FAILED);
    assert.equal(h.modelInputs.length, 0);
    const historyCall = callsFor(h.store, 'loadHistory')[0];
    assertPolicyReference(historyCall.input.policyReference, REINA_OPERATION.CONVERSATION_READ, 'owner-1');
  }
});

test('stored history must be strictly ordered and end in the exact persisted current user', async () => {
  const h = await harness({
    storeOverrides: {
      loadHistory: async input => {
        const conversation = h.store.conversations.get(h.store.scopeKey(input.ownerPrincipalId, input.conversationId));
        const current = conversation.messages.at(-1);
        return {
          status: 'loaded',
          ownerPrincipalId: input.ownerPrincipalId,
          conversationId: input.conversationId,
          messages: [current, { ...current, messageId: 'duplicate-sequence' }],
        };
      },
    },
  });
  const result = await execute(h);
  assert.equal(result.reasonCode, REASON.HISTORY_FAILED);
  assert.equal(h.modelInputs.length, 0);

  let currentMessage;
  const unmatched = await harness({
    storeOverrides: {
      appendUserMessageOnce: async input => {
        currentMessage = {
          messageId: 'user-current',
          sequence: 2,
          role: 'user',
          content: input.content,
          contentDigest: input.contentDigest,
        };
        return {
          status: 'appended',
          ownerPrincipalId: input.ownerPrincipalId,
          conversationId: input.conversationId,
          message: currentMessage,
        };
      },
      loadHistory: async input => ({
        status: 'loaded',
        ownerPrincipalId: input.ownerPrincipalId,
        conversationId: input.conversationId,
        messages: [
          { messageId: 'user-prior', sequence: 1, role: 'user', content: 'Prior', contentDigest: canonicalDigest('Prior') },
          currentMessage,
        ],
      }),
    },
  });
  const unmatchedResult = await execute(unmatched);
  assert.equal(unmatchedResult.reasonCode, REASON.HISTORY_FAILED);
  assert.equal(unmatched.modelInputs.length, 0);
});

test('model output must be primitive, bounded, normalized text and cannot smuggle actions', async () => {
  let getterCalls = 0;
  const accessorOutput = {};
  Object.defineProperty(accessorOutput, 'content', { get() { getterCalls += 1; return 'unsafe'; } });
  const outputs = [
    '',
    new String('boxed'),
    accessorOutput,
    new Proxy({ content: 'unsafe' }, {
      get(target, key, receiver) {
        // Promise resolution is specified to inspect a returned object's
        // `then` property. No application/content property may be read.
        if (key !== 'then') getterCalls += 1;
        return Reflect.get(target, key, receiver);
      },
    }),
    { content: 'unsafe', toolCalls: [{ name: 'run_business_action' }] },
    'unsafe\u0000text',
    'x'.repeat(LIMITS.contentCharacters + 1),
  ];
  for (const output of outputs) {
    const h = await harness({ generate: async () => output });
    const result = await execute(h);
    assert.equal(result.reasonCode, REASON.MODEL_FAILED);
    assert.equal(result.persisted, false);
    assert.equal(callsFor(h.store, 'appendAssistantAndCompleteTurn').length, 0);
    assert.equal(callsFor(h.store, 'markTurnFailed').length, 1);
  }
  assert.equal(getterCalls, 0);
});

test('model failure is explicit, sanitized, and partial retry reuses the one durable user message', async () => {
  let attempts = 0;
  const h = await harness({
    generate: async input => {
      h.events.push('model');
      h.modelInputs.push(input);
      attempts += 1;
      if (attempts === 1) throw new Error('provider-secret-detail');
      return 'Recovered answer.';
    },
  });
  const first = await execute(h);
  assert.equal(first.reasonCode, REASON.MODEL_FAILED);
  assert.equal(first.turnState, 'failed_retryable');
  assert.equal(first.persisted, false);
  assert.doesNotMatch(JSON.stringify(first), /provider-secret-detail/);
  const blockedSibling = await execute(h, { ...BASE_TURN, idempotencyKey: 'turn-2', content: 'Must wait' });
  assert.equal(blockedSibling.reasonCode, REASON.INCOMPLETE);
  assert.equal(blockedSibling.modelInvoked, false);
  assert.equal(attempts, 1);
  const second = await execute(h);
  assert.equal(second.reasonCode, REASON.STORED);
  assert.equal(callsFor(h.store, 'appendUserMessageOnce').length, 2);
  const conversation = h.store.conversations.get(h.store.scopeKey('owner-1', BASE_TURN.conversationId));
  assert.equal(conversation.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(conversation.messages.filter(message => message.role === 'assistant').length, 1);
  assert.equal(attempts, 2);
});

test('retry acquisition is atomically suppressed and receives a fresh fencing token', async () => {
  const resumedModelStarted = deferred();
  const releaseResumedModel = deferred();
  let attempts = 0;
  const h = await harness({
    generate: async input => {
      h.events.push('model');
      h.modelInputs.push(input);
      attempts += 1;
      if (attempts === 1) throw new Error('first attempt failed');
      resumedModelStarted.resolve();
      await releaseResumedModel.promise;
      return 'Recovered once.';
    },
  });
  assert.equal((await execute(h)).reasonCode, REASON.MODEL_FAILED);
  const resumed = execute(h);
  await resumedModelStarted.promise;
  const duplicateResume = await execute(h);
  assert.equal(duplicateResume.reasonCode, REASON.IN_FLIGHT);
  const userCalls = callsFor(h.store, 'appendUserMessageOnce');
  assert.equal(userCalls.length, 2);
  assert.notEqual(userCalls[0].input.claimId, userCalls[1].input.claimId);
  releaseResumedModel.resolve();
  assert.equal((await resumed).reasonCode, REASON.STORED);
  assert.equal(attempts, 2);
});

test('assistant append and completion are one unresolved barrier; failure never reports saved success', async () => {
  const assistantEntered = deferred();
  const releaseAssistant = deferred();
  let settled = false;
  const h = await harness({
    storeOverrides: {
      appendAssistantAndCompleteTurn: async () => {
        assistantEntered.resolve();
        await releaseAssistant.promise;
        throw new Error('database-secret-detail');
      },
    },
  });
  const pending = execute(h).finally(() => { settled = true; });
  await assistantEntered.promise;
  assert.equal(settled, false);
  releaseAssistant.resolve();
  const result = await pending;
  assert.equal(result.reasonCode, REASON.ASSISTANT_FAILED);
  assert.equal(result.persisted, false);
  assert.equal(result.assistantMessage, null);
  assert.doesNotMatch(JSON.stringify(result), /database-secret-detail/);
});

test('assistant persistence failure can retry without duplicating the durable user message', async () => {
  let completionAttempts = 0;
  const h = await harness({
    storeOverrides: {
      appendAssistantAndCompleteTurn: async () => {
        completionAttempts += 1;
        if (completionAttempts === 1) throw new Error('temporary down');
        return PASS;
      },
    },
  });
  assert.equal((await execute(h)).reasonCode, REASON.ASSISTANT_FAILED);
  assert.equal((await execute(h)).reasonCode, REASON.STORED);
  const conversation = h.store.conversations.get(h.store.scopeKey('owner-1', BASE_TURN.conversationId));
  assert.equal(conversation.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(conversation.messages.filter(message => message.role === 'assistant').length, 1);
  assert.equal(h.modelInputs.length, 2);
});

test('malformed completion result cannot fabricate persistence and failure recording errors stay sanitized', async () => {
  const h = await harness({
    storeOverrides: {
      appendAssistantAndCompleteTurn: async input => ({
        status: 'completed',
        result: {
          ownerPrincipalId: 'other-owner',
          conversationId: input.conversationId,
          idempotencyKey: input.idempotencyKey,
          inputDigest: input.inputDigest,
          userMessageId: input.userMessageId,
          userMessageSequence: input.userMessageSequence,
          assistantMessage: {
            messageId: 'assistant-1', sequence: input.userMessageSequence + 1, role: 'assistant', content: input.content, contentDigest: input.contentDigest,
          },
          resultReference: 'result-1',
          policyReference: input.policyReference,
        },
      }),
      markTurnFailed: async () => { throw new Error('failure-log-secret'); },
    },
  });
  const result = await execute(h);
  assert.equal(result.reasonCode, REASON.ASSISTANT_FAILED);
  assert.equal(result.turnState, 'incomplete');
  assert.equal(result.persisted, false);
  assert.doesNotMatch(JSON.stringify(result), /failure-log-secret/);
});

test('completion echoes require adjacent distinct ordered messages and safe primitive digests', async () => {
  let coercions = 0;
  const unsafeDigest = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      throw new Error('must not coerce');
    },
  };
  const malformedResults = [
    input => ({
      messageId: 'assistant-gap',
      sequence: input.userMessageSequence + 2,
      role: 'assistant',
      content: input.content,
      contentDigest: input.contentDigest,
    }),
    input => ({
      messageId: input.userMessageId,
      sequence: input.userMessageSequence + 1,
      role: 'assistant',
      content: input.content,
      contentDigest: input.contentDigest,
    }),
    input => ({
      messageId: 'assistant-unsafe-digest',
      sequence: input.userMessageSequence + 1,
      role: 'assistant',
      content: input.content,
      contentDigest: unsafeDigest,
    }),
  ];
  for (const assistantMessage of malformedResults) {
    const h = await harness({
      storeOverrides: {
        appendAssistantAndCompleteTurn: async input => ({
          status: 'completed',
          result: {
            ownerPrincipalId: input.ownerPrincipalId,
            conversationId: input.conversationId,
            idempotencyKey: input.idempotencyKey,
            inputDigest: input.inputDigest,
            userMessageId: input.userMessageId,
            userMessageSequence: input.userMessageSequence,
            assistantMessage: assistantMessage(input),
            resultReference: 'result-1',
            policyReference: input.policyReference,
          },
        }),
      },
    });
    const result = await execute(h);
    assert.equal(result.reasonCode, REASON.ASSISTANT_FAILED);
    assert.equal(result.persisted, false);
  }
  assert.equal(coercions, 0);
});

test('incomplete and terminal failed claims never auto-run model or duplicate messages', async () => {
  for (const [state, expected] of [['incomplete', REASON.INCOMPLETE], ['failed_terminal', REASON.PREVIOUS_FAILED]]) {
    const h = await harness();
    const first = await execute(h);
    assert.equal(first.reasonCode, REASON.STORED);
    const claim = [...h.store.claims.values()][0];
    claim.state = state;
    claim.result = null;
    const beforeMessages = [...h.store.conversations.values()][0].messages.length;
    const result = await execute(h);
    assert.equal(result.reasonCode, expected);
    assert.equal([...h.store.conversations.values()][0].messages.length, beforeMessages);
    assert.equal(h.modelInputs.length, 1);
  }
});

test('stored policy reference is metadata only: replay still requires a fresh genuine context', async () => {
  const h = await harness();
  const stored = await execute(h);
  assert.equal(stored.reasonCode, REASON.STORED);
  const callsBeforeForgery = h.store.calls.length;
  const forged = Object.freeze({ ...h.actingContext });
  const denied = await appendDurableTurn({ enabled: true, actingContext: forged, turn: BASE_TURN, store: h.store, generate: h.generate });
  assert.equal(denied.reasonCode, REASON.UNAUTHORIZED);
  assert.equal(h.store.calls.length, callsBeforeForgery);

  const freshGenuineContext = await verifiedContext('owner-1');
  const replay = await appendDurableTurn({ enabled: true, actingContext: freshGenuineContext, turn: BASE_TURN, store: h.store, generate: h.generate });
  assert.equal(replay.reasonCode, REASON.REPLAYED);
  assert.equal(h.modelInputs.length, 1);
});

test('missing live READ verification denies before the first store call', () => {
  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
  const authorizationUrl = pathToFileURL(path.join(repositoryRoot, 'api/_lib/reina/authorization.js')).href;
  const coreUrl = `${pathToFileURL(path.join(repositoryRoot, 'reina/runtime/durable-conversation-core.js')).href}?missing-read`;
  const script = `
    import { mock } from 'node:test';
    const operations = Object.freeze({
      PILOT_ACCESS:'reina.pilot.access',
      CONVERSATION_CREATE:'reina.conversation.create',
      CONVERSATION_READ:'reina.conversation.read',
      CONVERSATION_APPEND:'reina.conversation.append',
    });
    mock.module(${JSON.stringify(authorizationUrl)}, { namedExports: {
      AUTHORIZATION_POLICY_VERSION:'reina-acting-context-policy-v1',
      REINA_OPERATION:operations,
      decideAuthorization:(context,operation)=>Object.freeze({context,operation}),
      isAuthorizedDecisionFor:(decision,context,operation)=>decision.context===context && decision.operation===operation && operation!==operations.CONVERSATION_READ,
    }});
    const { appendDurableTurn } = await import(${JSON.stringify(coreUrl)});
    const calls=[];
    const store={
      async loadConversation(){calls.push('load')},
      async createConversation(){calls.push('create')},
      async claimTurn(){calls.push('claim')},
      async appendUserMessageOnce(){calls.push('user')},
      async loadHistory(){calls.push('history')},
      async appendAssistantAndCompleteTurn(){calls.push('assistant')},
      async markTurnFailed(){calls.push('failed')},
    };
    const outcome=await appendDurableTurn({enabled:true,actingContext:{principalId:'owner-1'},turn:{conversationId:'conversation-1',idempotencyKey:'turn-1',content:'hello'},store,generate:async()=>{calls.push('model');return 'answer'}});
    console.log(JSON.stringify({reasonCode:outcome.reasonCode,calls}));
  `;
  const child = spawnSync(process.execPath, [
    '--experimental-test-module-mocks',
    '--input-type=module',
    '--eval',
    script,
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const resultLine = child.stdout.trim().split(/\r?\n/).at(-1);
  assert.deepEqual(JSON.parse(resultLine), { reasonCode: REASON.UNAUTHORIZED, calls: [] });
});
