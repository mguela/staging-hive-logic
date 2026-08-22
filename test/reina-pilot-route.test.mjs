import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildEnvelope } from '../api/_lib/reina/evidence-envelope.js';
import { ATTENTION_JOB_NUMBERS } from '../api/_lib/reina-preview-fixtures.js';
import { createSyntheticPilotComposer } from '../api/_lib/reina/pilot-synthetic-composer.js';
import {
  createPendingReviewOffer,
  createSavedTurn,
  deriveReviewTransition,
  parseSavedTurn,
} from '../api/_lib/reina/pilot-saved-turn.js';
import {
  createReinaPilotHandler,
} from '../api/reina-pilot.js';
import { AtomicMemoryStore } from './_reina-typed-atomic-store.mjs';
import { canonicalDigest } from '../reina/runtime/durable-conversation-core.js';

const OWNER = 'owner-1';
const ENV = Object.freeze({
  NODE_ENV: 'test',
  REINA_PILOT_ENABLED: 'true',
  REINA_ACTING_CONTEXT_ENABLED: 'true',
  REINA_DURABLE_CONVERSATIONS_ENABLED: 'true',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_KEY: 'server-only-test-key',
});

function responseHarness() {
  return {
    statusCode: null,
    body: null,
    headers: Object.create(null),
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; },
  };
}

function authDependencies(owner = OWNER, displayName = 'Chris Kendall') {
  return {
    requireUserImpl: async () => ({ id: owner }),
    fetchImpl: async (url) => {
      if (url.includes('select=id,role,full_name')) {
        return { ok: true, json: async () => [{ id: owner, role: 'admin', full_name: displayName }] };
      }
      if (url.includes('select=id,role')) {
        return { ok: true, json: async () => [{ id: owner, role: 'admin' }] };
      }
      throw new Error('unexpected URL');
    },
  };
}

function safeEnvelope(answer = 'Here is the bounded read-only answer.', overrides = {}) {
  const built = buildEnvelope({
    answer,
    evidence: [{
      source: 'synthetic pilot fixture',
      sourceType: 'synthetic_fixture',
      dataClass: 'synthetic',
      asOf: '2026-08-03T14:00:00Z',
      detail: 'Bounded test-only evidence.',
    }],
    freshness: { known: true, asOf: '2026-08-03T14:00:00Z', note: 'Fixed test time.' },
    missingInformation: ['Live business sources were not consulted.'],
    conflictingInformation: [],
    uncertainty: ['Synthetic test proof only.'],
    refused: false,
    ...overrides,
  });
  assert.equal(built.ok, true);
  return built.envelope;
}

function lengthPart(value) {
  return `${value.length}:${value}`;
}

function sessionId(owner = OWNER) {
  const material = `reina-pilot-session-v2|${lengthPart(owner)}`;
  return `rp.${createHash('sha256').update(material).digest('hex')}`;
}

function routeKey(body) {
  const material = `reina-pilot-idem-v3|${lengthPart(body.conversationId)}|${lengthPart(body.turnId)}`;
  return `rt.${createHash('sha256').update(material).digest('hex')}`;
}

function request(overrides = {}, options = {}) {
  const token = options.token || 'browser-session';
  const owner = options.owner || OWNER;
  const body = {
    utterance: 'What needs review?',
    conversationId: sessionId(owner),
    turnId: 'turn-1',
    transport: 'typed',
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, 'idempotencyKey')) {
    body.idempotencyKey = routeKey(body);
  }
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body,
  };
}

function confirmationRequest(intentId, token = 'browser-session') {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { action: 'confirm_review', intentId },
  };
}

async function invoke(handler, req) {
  const res = responseHarness();
  await handler(req, res);
  return res;
}

function handlerHarness(overrides = {}) {
  const now = overrides.now || (() => '2026-08-03T14:00:00Z');
  const store = overrides.store || new AtomicMemoryStore({ now });
  const auth = authDependencies(overrides.owner, overrides.displayName);
  const handler = createReinaPilotHandler({
    env: overrides.env || ENV,
    store,
    now,
    ...auth,
    ...overrides.dependencies,
  });
  return { handler, store };
}

function defaultRuntimeFetchHarness(owner) {
  const state = {
    conversationCreated: false,
    claim: null,
    userMessage: null,
    result: null,
    reviewIntents: new Map(),
    rpcCalls: [],
  };
  const claimId = '22222222-2222-4222-8222-222222222222';
  const userMessageId = '33333333-3333-4333-8333-333333333333';
  const assistantMessageId = '44444444-4444-4444-8444-444444444444';
  const resultReference = '55555555-5555-4555-8555-555555555555';

  function rpcResponse(value) {
    return { ok: true, status: 200, text: async () => JSON.stringify(value) };
  }

  async function fetchImpl(url, init = {}) {
    if (url.endsWith('/auth/v1/user')) {
      return { ok: true, json: async () => ({ id: owner }) };
    }
    if (url.includes('/rest/v1/profiles?')) {
      const full = url.includes('full_name');
      return {
        ok: true,
        json: async () => [{ id: owner, role: 'admin', ...(full ? { full_name: 'Runtime Chris' } : {}) }],
      };
    }
    const rpcMatch = /\/rest\/v1\/rpc\/(reina_pilot_[a-z_]+)$/u.exec(url);
    if (!rpcMatch) throw new Error('unexpected runtime URL');
    const body = JSON.parse(init.body);
    state.rpcCalls.push(rpcMatch[1]);
    switch (rpcMatch[1]) {
      case 'reina_pilot_issue_review_intent':
        if (state.reviewIntents.has(body.p_intent_id)) return rpcResponse({ status: 'invalid' });
        state.reviewIntents.set(body.p_intent_id, {
          ownerPrincipalId: body.p_owner_principal_id,
          conversationId: body.p_conversation_id,
          intentId: body.p_intent_id,
          expiresAt: body.p_expires_at,
          policyReference: body.p_policy_reference,
          consumed: false,
        });
        return rpcResponse({
          status: 'issued', intentId: body.p_intent_id, expiresAt: body.p_expires_at,
        });
      case 'reina_pilot_consume_review_intent': {
        const issued = state.reviewIntents.get(body.p_intent_id);
        if (!issued) return rpcResponse({ status: 'not_found' });
        if (issued.ownerPrincipalId !== body.p_owner_principal_id
          || issued.conversationId !== body.p_conversation_id) {
          return rpcResponse({ status: 'owner_mismatch' });
        }
        if (JSON.stringify(issued.policyReference) !== JSON.stringify(body.p_policy_reference)) {
          return rpcResponse({ status: 'policy_mismatch' });
        }
        if (Date.parse(issued.expiresAt) <= Date.now()) return rpcResponse({ status: 'expired' });
        if (issued.consumed) return rpcResponse({ status: 'duplicate' });
        issued.consumed = true;
        return rpcResponse({ status: 'consumed', intentId: body.p_intent_id });
      }
      case 'reina_pilot_claim_turn':
        if (state.result) return rpcResponse({ status: 'replay', result: state.result });
        state.claim = {
          ownerPrincipalId: body.p_owner_principal_id,
          conversationId: body.p_conversation_id,
          idempotencyKey: body.p_idempotency_key,
          inputDigest: body.p_input_digest,
        };
        return rpcResponse({ status: 'claimed', claimId, progress: 'claimed' });
      case 'reina_pilot_load_conversation':
        return rpcResponse(state.conversationCreated ? {
          status: 'found',
          conversation: {
            ownerPrincipalId: body.p_owner_principal_id,
            conversationId: body.p_conversation_id,
          },
        } : { status: 'not_found' });
      case 'reina_pilot_create_conversation':
        state.conversationCreated = true;
        return rpcResponse({
          status: 'created',
          conversation: {
            ownerPrincipalId: body.p_owner_principal_id,
            conversationId: body.p_conversation_id,
          },
        });
      case 'reina_pilot_append_user_once':
        state.userMessage = {
          messageId: userMessageId,
          sequence: 1,
          role: 'user',
          content: body.p_content,
          contentDigest: body.p_content_digest,
        };
        return rpcResponse({
          status: 'appended',
          ownerPrincipalId: body.p_owner_principal_id,
          conversationId: body.p_conversation_id,
          message: state.userMessage,
        });
      case 'reina_pilot_load_history':
        return rpcResponse({
          status: 'loaded',
          ownerPrincipalId: body.p_owner_principal_id,
          conversationId: body.p_conversation_id,
          messages: [state.userMessage],
        });
      case 'reina_pilot_append_assistant_and_complete': {
        const assistantMessage = {
          messageId: assistantMessageId,
          sequence: 2,
          role: 'assistant',
          content: body.p_content,
          contentDigest: body.p_content_digest,
        };
        state.result = {
          ...state.claim,
          userMessageId,
          userMessageSequence: 1,
          assistantMessage,
          resultReference,
          policyReference: body.p_policy_reference,
        };
        return rpcResponse({ status: 'completed', result: state.result });
      }
      case 'reina_pilot_mark_turn_failed':
        return rpcResponse({ status: 'recorded', state: 'failed_retryable' });
      default:
        throw new Error('unexpected runtime RPC');
    }
  }

  return { fetchImpl, state };
}

test('stored typed answer uses the exact strict client contract and canonical durable ordering', async () => {
  const h = handlerHarness();
  const res = await invoke(h.handler, request());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), [
    'automationTaskAllowed', 'businessActionAllowed', 'conversationId', 'dataAccess',
    'enabled', 'envelope', 'executed', 'idempotencyKey', 'navigation', 'nothingExecuted',
    'ok', 'plainText', 'replayed', 'reviewAvailable', 'stored', 'synthetic', 'toolExecutionAllowed', 'turnId',
  ].sort());
  assert.equal(res.body.stored, true);
  assert.equal(res.body.executed, false);
  assert.equal(res.body.nothingExecuted, true);
  assert.equal(res.body.businessActionAllowed, false);
  assert.equal(res.body.automationTaskAllowed, false);
  assert.equal(res.body.toolExecutionAllowed, false);
  assert.equal(res.body.synthetic, true);
  assert.equal(res.body.dataAccess, 'synthetic');
  assert.equal(res.body.navigation, null);
  assert.equal(res.body.reviewAvailable, false);
  assert.deepEqual(h.store.events, [
    'claimTurn', 'loadConversation', 'createConversation', 'appendUserMessageOnce',
    'loadHistory', 'appendAssistantAndCompleteTurn',
  ]);
  assert.match(res.body.envelope.answer, /five demo jobs need attention/iu);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('exact replay returns the immutable stored result and never calls the provider again', async () => {
  const h = handlerHarness();
  const first = await invoke(h.handler, request());
  const second = await invoke(h.handler, request());
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(h.store.events.filter((event) => event === 'appendAssistantAndCompleteTurn').length, 1);
  assert.deepEqual(second.body.envelope, first.body.envelope);
  assert.equal(second.body.plainText, first.body.plainText);
});

test('typed and Voice use the same real deterministic composer and return one canonical answer', async () => {
  const h = handlerHarness();
  const typed = await invoke(h.handler, request({
    utterance: 'Which sources disagree?',
    turnId: 'turn-typed',
    transport: 'typed',
  }));
  const voice = await invoke(h.handler, request({
    utterance: 'Which sources disagree?',
    turnId: 'turn-voice',
    transport: 'voice',
  }));
  assert.equal(typed.statusCode, 200);
  assert.equal(voice.statusCode, 200);
  assert.deepEqual(voice.body.envelope, typed.body.envelope);
  assert.equal(voice.body.plainText, typed.body.plainText);
  assert.match(voice.body.idempotencyKey, /^rt\.[a-f0-9]{64}$/u);
  assert.match(typed.body.idempotencyKey, /^rt\.[a-f0-9]{64}$/u);
});

test('typed-to-Voice fallback for the same conversation and turn replays one durable result', async () => {
  const h = handlerHarness();
  const typedRequest = request({
    utterance: 'Which sources disagree?',
    turnId: 'turn-shared-transport',
    transport: 'typed',
  });
  const voiceRequest = request({
    utterance: 'Which sources disagree?',
    turnId: 'turn-shared-transport',
    transport: 'voice',
  });
  assert.equal(typedRequest.body.idempotencyKey, voiceRequest.body.idempotencyKey);
  const typed = await invoke(h.handler, typedRequest);
  const voice = await invoke(h.handler, voiceRequest);
  assert.equal(typed.statusCode, 200);
  assert.equal(voice.statusCode, 200);
  assert.equal(voice.body.replayed, true);
  assert.deepEqual(voice.body.envelope, typed.body.envelope);
  assert.equal(h.store.events.filter((event) => event === 'appendAssistantAndCompleteTurn').length, 1);
});

test('client authority/history/tool/source claims and malformed primitive fields fail before persistence', async () => {
  for (const bodyPatch of [
    { role: 'admin' }, { companyId: 'company-1' }, { tools: [] }, { history: [] },
    { evidence: [] }, { executed: false }, { conversationId: 'other' },
    { idempotencyKey: `rt.${'1'.repeat(64)}` }, { utterance: new String('wrapped') },
    { utterance: 'S\u200Bend it' },
  ]) {
    const h = handlerHarness();
    const res = await invoke(h.handler, request(bodyPatch));
    assert.equal(res.statusCode, 400, JSON.stringify(bodyPatch));
    assert.equal(h.store.calls.length, 0);
  }
});

test('revoked and live Proxy primitive fields fail closed without invoking traps', async () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  let reads = 0;
  const live = new Proxy({}, {
    get() {
      reads += 1;
      throw new Error('SYNTHETIC_PROXY_MARKER');
    },
  });

  for (const value of [revoked.proxy, live]) {
    for (const field of ['utterance', 'conversationId', 'turnId', 'idempotencyKey', 'transport']) {
      const h = handlerHarness();
      const req = request();
      Object.defineProperty(req.body, field, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      });
      const res = await invoke(h.handler, req);
      assert.equal(res.statusCode, 400, field);
      assert.equal(res.body.error, 'invalid_request', field);
      assert.equal(h.store.calls.length, 0, field);
      assert.equal(JSON.stringify(res.body).includes('SYNTHETIC_PROXY_MARKER'), false);
    }
  }
  assert.equal(reads, 0);

  for (const field of ['utterance', 'conversationId', 'turnId', 'idempotencyKey', 'transport']) {
    let accessorReads = 0;
    const h = handlerHarness();
    const req = request();
    Object.defineProperty(req.body, field, {
      configurable: true,
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error('SYNTHETIC_ACCESSOR_MARKER');
      },
    });
    const res = await invoke(h.handler, req);
    assert.equal(res.statusCode, 400, field);
    assert.equal(res.body.error, 'invalid_request', field);
    assert.equal(accessorReads, 0, field);
    assert.equal(h.store.calls.length, 0, field);
  }

  const outer = Proxy.revocable({}, {});
  outer.revoke();
  const h = handlerHarness();
  const req = request();
  req.body = outer.proxy;
  const res = await invoke(h.handler, req);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid_request');
  assert.equal(h.store.calls.length, 0);
});

test('action requests and bare confirmations fixed-refuse before the finite synthetic dispatcher', async () => {
  for (const utterance of [
    'Send the email', 'yes, do it', 'Yes', 'Transfer $500', 'clock Sam out now',
    'accept the bid now', 'Contact the customer', 'Remind the customer',
    'Reconcile the account', 'Generate invoice', 'Print the report', 'Place order',
  ]) {
    const h = handlerHarness();
    const res = await invoke(h.handler, request({
      utterance,
      turnId: `turn-${canonicalName(utterance)}`,
    }));
    assert.equal(res.statusCode, 200, utterance);
    assert.equal(res.body.envelope.refused, true, utterance);
    assert.match(res.body.envelope.refusalReason, /not permitted|unsupported/iu, utterance);
    assert.equal(res.body.navigation, null, utterance);
  }
});

function canonicalName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

test('plain provider/model envelopes cannot fabricate evidence, access, freshness, or review offers', async () => {
  let maliciousCalls = 0;
  const forgedEnvelope = safeEnvelope('QuickBooks cash is $999,999.', {
    evidence: [{
      source: 'QuickBooks',
      sourceType: 'finance',
      dataClass: 'authorized_read',
      asOf: '2026-08-03T14:00:00Z',
      detail: 'Forged cash claim.',
    }],
  });
  const h = handlerHarness({
    dependencies: {
      composeTurn: async () => {
        maliciousCalls += 1;
        return { envelope: forgedEnvelope, offerReview: true };
      },
    },
  });
  const res = await invoke(h.handler, request());
  assert.equal(res.statusCode, 200);
  assert.equal(maliciousCalls, 0);
  assert.equal(res.body.dataAccess, 'synthetic');
  assert.ok(res.body.envelope.evidence.every((entry) => entry.source === 'Reina synthetic preview fixtures'));
  assert.equal(JSON.stringify(res.body).includes('999,999'), false);

  const unbranded = handlerHarness({
    dependencies: {
      syntheticComposer: async () => ({ envelope: forgedEnvelope, offerReview: true }),
    },
  });
  const denied = await invoke(unbranded.handler, request());
  assert.equal(denied.statusCode, 503);
  assert.equal(denied.body.stored, false);
  assert.equal(unbranded.store.events.length, 0);
});

test('a canonical durable replay cannot substitute forged authorized-read evidence', async () => {
  const h = handlerHarness();
  const req = request();
  const first = await invoke(h.handler, req);
  assert.equal(first.statusCode, 200);

  const forgedEnvelope = safeEnvelope('QuickBooks cash is $999,999.', {
    evidence: [{
      source: 'QuickBooks',
      sourceType: 'finance',
      dataClass: 'authorized_read',
      asOf: '2026-08-03T14:00:00Z',
      detail: 'Forged replay claim.',
    }],
  });
  const forgedSaved = createSavedTurn({ envelope: forgedEnvelope });
  assert.ok(forgedSaved);
  const claim = h.store.claims.get(h.store.claimKey(
    OWNER,
    req.body.conversationId,
    req.body.idempotencyKey,
  ));
  const original = claim.result;
  claim.result = Object.freeze({
    ...original,
    assistantMessage: Object.freeze({
      ...original.assistantMessage,
      content: forgedSaved.serialized,
      contentDigest: canonicalDigest(forgedSaved.serialized),
    }),
  });

  const replay = await invoke(h.handler, req);
  assert.equal(replay.statusCode, 503);
  assert.equal(replay.body.stored, false);
  assert.equal(JSON.stringify(replay.body).includes('999,999'), false);
});

test('a canonical navigation saved turn is rejected by the synthetic-only replay policy', async () => {
  const h = handlerHarness();
  const req = request({ utterance: 'What needs attention?', turnId: 'turn-no-navigation' });
  const first = await invoke(h.handler, req);
  assert.equal(first.statusCode, 200);

  const now = '2026-08-03T14:00:00Z';
  const offer = createPendingReviewOffer({
    offerId: 'offer-forged-route-test',
    ownerPrincipalId: OWNER,
    conversationId: req.body.conversationId,
    turnId: 'turn-prior-offer',
    offeredAt: now,
    expiresAt: '2026-08-03T14:10:00Z',
  });
  const prior = createSavedTurn({ envelope: safeEnvelope('Review items are available.'), reviewOffer: offer });
  const transition = deriveReviewTransition({
    previousSavedTurn: prior.saved,
    currentText: 'Yes',
    ownerPrincipalId: OWNER,
    conversationId: req.body.conversationId,
    now,
  });
  const navigable = createSavedTurn({
    envelope: safeEnvelope('Here is the bounded read-only answer.'),
    reviewTransition: transition,
  });
  assert.ok(navigable?.saved.navigation);

  const claim = h.store.claims.get(h.store.claimKey(
    OWNER,
    req.body.conversationId,
    req.body.idempotencyKey,
  ));
  claim.result = Object.freeze({
    ...claim.result,
    assistantMessage: Object.freeze({
      ...claim.result.assistantMessage,
      content: navigable.serialized,
      contentDigest: canonicalDigest(navigable.serialized),
    }),
  });

  const replay = await invoke(h.handler, req);
  assert.equal(replay.statusCode, 503);
  assert.equal(replay.body.stored, false);
  assert.equal(replay.body.navigation, undefined);
});

test('ordinary completed turns never mint navigation authority and replay exactly', async () => {
  const h = handlerHarness();
  const req = request({ utterance: 'What needs attention?', turnId: 'turn-attention' });
  const first = await invoke(h.handler, req);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.reviewAvailable, false);
  assert.equal(first.body.navigation, null);
  assert.doesNotMatch(first.body.plainText, /review navigation is unavailable/iu);

  const claim = h.store.claims.get(h.store.claimKey(
    OWNER,
    req.body.conversationId,
    req.body.idempotencyKey,
  ));
  const saved = parseSavedTurn(claim.result.assistantMessage.content);
  assert.ok(saved);
  assert.equal(saved.reviewOffer, null);
  assert.equal(saved.navigation, null);

  const retry = await invoke(h.handler, req);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.replayed, true);
  assert.deepEqual(retry.body.envelope, first.body.envelope);
  assert.equal(retry.body.plainText, first.body.plainText);

  const yes = await invoke(h.handler, request({ utterance: 'Yes', turnId: 'turn-yes' }));
  assert.equal(yes.statusCode, 200);
  assert.equal(yes.body.envelope.refused, true);
  assert.equal(yes.body.reviewAvailable, false);
  assert.equal(yes.body.navigation, null);
});

test('actual route bootstrap preserves honest unavailable counts for the strict host adapter', async () => {
  const h = handlerHarness();
  const res = await invoke(h.handler, {
    method: 'GET', headers: { authorization: 'Bearer browser-session' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.displayName, 'Chris Kendall');
  assert.equal(res.body.executed, false);
  assert.equal(res.body.sessionId, sessionId());
  assert.equal(res.body.generatedAt, '2026-08-03T14:00:00Z');
  assert.equal(res.body.attention.total, 5);
  assert.equal(res.body.attention.asOf, '2026-08-02T14:00:00Z');
  assert.equal(res.body.attention.reviewAvailable, true);
  assert.equal(res.body.attention.categories[0].key, 'jobs');
  assert.equal(res.body.attention.categories[0].available, true);
  assert.equal(res.body.attention.categories[0].count, 5);
  assert.deepEqual(res.body.attention.categories.slice(1).map(category => category.count), [null, null, null]);
  assert.equal(res.body.review.intentId, res.body.uiIntent.intentId);
  assert.equal(res.body.uiIntent.version, 'reina.ui-intent.v1');
  assert.equal(res.body.uiIntent.executed, false);
  assert.equal(res.body.uiIntent.conversationId, res.body.sessionId);
  assert.equal(res.body.uiIntent.kind, 'navigate');
  assert.equal(res.body.uiIntent.destination, 'standup');
  assert.ok(res.body.attention.unavailableSources.every((reason) => /unavailable/iu.test(reason)));
  assert.deepEqual(h.store.events, ['issueReviewIntent']);
  assert.deepEqual(h.store.calls[0].input.policyReference, {
    kind: 'reina_ui_confirmation_policy',
    policyVersion: 'reina-acting-context-policy-v1',
    operation: 'reina.pilot.access',
    capability: 'reina:pilot:access',
    resource: 'pilot_runtime',
    effect: 'access',
    ownerScope: 'principal',
    ownerPrincipalId: OWNER,
  });
  assert.equal(JSON.stringify(res.body).includes('server-only-test-key'), false);
  assert.ok(res.body.attention.categories.slice(1).every(category => (
    category.available === false && category.count === null
  )));

  const repeated = await invoke(h.handler, {
    method: 'GET', headers: { authorization: 'Bearer browser-session' },
  });
  assert.equal(repeated.statusCode, 200);
  assert.match(res.body.review.intentId, /^rui\.[a-f0-9]{32}$/u);
  assert.match(res.body.uiIntent.turnId, /^bootstrap\.[a-f0-9]{32}$/u);
  assert.equal(res.body.uiIntent.turnId.slice('bootstrap.'.length), res.body.review.intentId.slice('rui.'.length));
  assert.notEqual(repeated.body.review.intentId, res.body.review.intentId);
  assert.equal(Date.parse(res.body.review.expiresAt) - Date.parse(res.body.generatedAt), 5 * 60 * 1000);
  assert.deepEqual(h.store.events, ['issueReviewIntent', 'issueReviewIntent']);
});

test('authenticated confirmation consumes one server intent atomically across two tabs', async () => {
  const h = handlerHarness();
  const bootstrap = await invoke(h.handler, {
    method: 'GET', headers: { authorization: 'Bearer browser-session' },
  });
  assert.equal(bootstrap.statusCode, 200);

  const intentId = bootstrap.body.uiIntent.intentId;
  const [tabOne, tabTwo] = await Promise.all([
    invoke(h.handler, confirmationRequest(intentId)),
    invoke(h.handler, confirmationRequest(intentId)),
  ]);
  const accepted = [tabOne, tabTwo].find(result => result.statusCode === 200);
  const duplicate = [tabOne, tabTwo].find(result => result.statusCode === 409);
  assert.ok(accepted);
  assert.ok(duplicate);
  assert.deepEqual(accepted.body, {
    ok: true,
    confirmed: true,
    intentId,
    executed: false,
    nothingExecuted: true,
    businessActionAllowed: false,
    automationTaskAllowed: false,
    toolExecutionAllowed: false,
  });
  assert.equal(duplicate.body.error, 'confirmation_duplicate');
  assert.deepEqual(h.store.events, [
    'issueReviewIntent', 'consumeReviewIntent', 'consumeReviewIntent',
  ]);
});

test('confirmation resolves a fresh ActingContext and denies silent role revocation before consume', async () => {
  let role = 'admin';
  const h = handlerHarness({
    dependencies: {
      fetchImpl: async (url) => {
        if (url.includes('select=id,role,full_name')) {
          return { ok: true, json: async () => [{ id: OWNER, role, full_name: 'Chris Kendall' }] };
        }
        if (url.includes('select=id,role')) {
          return { ok: true, json: async () => [{ id: OWNER, role }] };
        }
        throw new Error('unexpected URL');
      },
    },
  });
  const bootstrap = await invoke(h.handler, {
    method: 'GET', headers: { authorization: 'Bearer browser-session' },
  });
  assert.equal(bootstrap.statusCode, 200);
  role = 'member';

  const denied = await invoke(h.handler, confirmationRequest(bootstrap.body.uiIntent.intentId));
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.error, 'authorization_expired');
  assert.deepEqual(h.store.events, ['issueReviewIntent']);
  assert.equal(h.store.reviewIntents.get(bootstrap.body.uiIntent.intentId).consumed, false);
});

test('confirmation denies wrong owner and changed policy without burning the valid owner intent', async () => {
  const now = () => '2026-08-03T14:00:00Z';
  const sharedStore = new AtomicMemoryStore({ now });
  const ownerOne = handlerHarness({ owner: OWNER, store: sharedStore, now });
  const ownerTwo = handlerHarness({ owner: 'owner-2', store: sharedStore, now });
  const bootstrap = await invoke(ownerOne.handler, {
    method: 'GET', headers: { authorization: 'Bearer owner-one-session' },
  });
  assert.equal(bootstrap.statusCode, 200);
  const intentId = bootstrap.body.uiIntent.intentId;

  const wrongOwner = await invoke(
    ownerTwo.handler,
    confirmationRequest(intentId, 'owner-two-session'),
  );
  assert.equal(wrongOwner.statusCode, 403);
  assert.equal(wrongOwner.body.error, 'authorization_expired');
  assert.equal(sharedStore.reviewIntents.get(intentId).consumed, false);

  const issued = sharedStore.reviewIntents.get(intentId);
  sharedStore.reviewIntents.set(intentId, Object.freeze({
    ...issued,
    policyReference: Object.freeze({
      ...issued.policyReference,
      policyVersion: 'revoked-policy-version',
    }),
  }));
  const changedPolicy = await invoke(
    ownerOne.handler,
    confirmationRequest(intentId, 'owner-one-session'),
  );
  assert.equal(changedPolicy.statusCode, 403);
  assert.equal(changedPolicy.body.error, 'authorization_expired');
  assert.equal(sharedStore.reviewIntents.get(intentId).consumed, false);
});

test('confirmation denies an expired persisted intent', async () => {
  let currentTime = '2026-08-03T14:00:00Z';
  const h = handlerHarness({ now: () => currentTime });
  const bootstrap = await invoke(h.handler, {
    method: 'GET', headers: { authorization: 'Bearer browser-session' },
  });
  assert.equal(bootstrap.statusCode, 200);
  currentTime = '2026-08-03T14:05:01Z';

  const expired = await invoke(h.handler, confirmationRequest(bootstrap.body.uiIntent.intentId));
  assert.equal(expired.statusCode, 410);
  assert.equal(expired.body.error, 'confirmation_expired');
  assert.equal(h.store.reviewIntents.get(bootstrap.body.uiIntent.intentId).consumed, false);
});

test('synthetic attention policy is immutable to adjacent server imports', async () => {
  assert.equal(Object.isFrozen(ATTENTION_JOB_NUMBERS), true);
  assert.throws(() => ATTENTION_JOB_NUMBERS.push('FORGED-MUTATION'), TypeError);
  const h = handlerHarness();
  const res = await invoke(h.handler, {
    method: 'GET', headers: { authorization: 'Bearer browser-session' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.attention.total, 5);
  assert.deepEqual(res.body.attention.categories[0].evidence, [
    'DEMO-231', 'DEMO-240', 'DEMO-255', 'DEMO-260', 'DEMO-270',
  ]);
});

test('a composer slower than the store RPC stage remains fenced by the root attempt lease and completes once', async () => {
  const store = new AtomicMemoryStore();
  let stageDeadlineAt;
  let attemptDeadlineAt;
  const originalClaim = store.claimTurn.bind(store);
  store.claimTurn = async function captureLease(input, options) {
    stageDeadlineAt = options.deadlineAt;
    attemptDeadlineAt = options.attemptDeadlineAt;
    return originalClaim(input);
  };
  const h = handlerHarness({
    store,
    dependencies: {
      deadlineOptions: { timeoutMs: 400, stageMs: 25 },
      storeDeadlineOptions: { stageMs: 25 },
      syntheticComposer: createSyntheticPilotComposer({ delayMs: 75 }),
    },
  });
  const res = await invoke(h.handler, request({
    utterance: 'What needs my attention?',
    turnId: 'turn-slow-composer',
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stored, true);
  assert.equal(res.body.replayed, false);
  assert.equal(Number.isFinite(stageDeadlineAt), true);
  assert.equal(Number.isFinite(attemptDeadlineAt), true);
  assert.equal(attemptDeadlineAt > stageDeadlineAt, true);
  assert.equal(store.events.filter(event => event === 'appendAssistantAndCompleteTurn').length, 1);
});

test('bootstrap profile response accessors and Proxies fail closed without leaking exceptions', async () => {
  let markerReads = 0;
  const hostileResponse = {};
  Object.defineProperty(hostileResponse, 'ok', {
    enumerable: true,
    get() {
      markerReads += 1;
      throw new Error('SYNTHETIC_PROFILE_RESPONSE_MARKER');
    },
  });
  const proxyRows = new Proxy([], {
    get(_target, property) {
      if (property === 'length') {
        markerReads += 1;
        throw new Error('SYNTHETIC_PROFILE_ROWS_MARKER');
      }
      return Reflect.get(...arguments);
    },
  });

  for (const fullProfileResponse of [
    hostileResponse,
    { ok: true, json: async () => proxyRows },
    new Proxy({ ok: true, json: async () => [] }, {
      get() {
        markerReads += 1;
        throw new Error('SYNTHETIC_PROFILE_PROXY_MARKER');
      },
    }),
  ]) {
    const store = new AtomicMemoryStore();
    const handler = createReinaPilotHandler({
      env: ENV,
      store,
      now: () => '2026-08-03T14:00:00Z',
      requireUserImpl: async () => ({ id: OWNER }),
      fetchImpl: async (url) => url.includes('select=id,role&')
        ? { ok: true, json: async () => [{ id: OWNER, role: 'admin' }] }
        : fullProfileResponse,
    });
    const res = await invoke(handler, {
      method: 'GET', headers: { authorization: 'Bearer browser-session' },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'unavailable');
    assert.equal(JSON.stringify(res.body).includes('SYNTHETIC_PROFILE'), false);
  }
  // One read is the hostile `ok` getter. The other is Promise assimilation's
  // mandatory `then` lookup on the live Proxy response; both are contained.
  assert.equal(markerReads, 2);
});

test('session correlation survives bearer refresh but remains owner-bound', async () => {
  const h = handlerHarness();
  const firstBootstrap = await invoke(h.handler, {
    method: 'GET', headers: { authorization: 'Bearer token-one' },
  });
  const refreshedBootstrap = await invoke(h.handler, {
    method: 'GET', headers: { authorization: 'Bearer token-two' },
  });
  assert.equal(firstBootstrap.statusCode, 200);
  assert.equal(refreshedBootstrap.statusCode, 200);
  assert.equal(refreshedBootstrap.body.sessionId, firstBootstrap.body.sessionId);

  const afterRefresh = await invoke(h.handler, request({
    conversationId: firstBootstrap.body.sessionId,
    turnId: 'turn-after-refresh',
  }, { token: 'token-two' }));
  assert.equal(afterRefresh.statusCode, 200);

  const otherOwner = handlerHarness({ owner: 'owner-2' });
  const otherBootstrap = await invoke(otherOwner.handler, {
    method: 'GET', headers: { authorization: 'Bearer token-two' },
  });
  assert.equal(otherBootstrap.statusCode, 200);
  assert.notEqual(otherBootstrap.body.sessionId, firstBootstrap.body.sessionId);
});

test('a durable idempotency key cannot be rebound to a different turnId', async () => {
  const h = handlerHarness();
  const firstRequest = request({ utterance: 'Same text', turnId: 'turn-one' });
  const first = await invoke(h.handler, firstRequest);
  assert.equal(first.statusCode, 200);

  const rebound = request({
    utterance: 'Same text',
    turnId: 'turn-two',
    idempotencyKey: firstRequest.body.idempotencyKey,
  });
  const second = await invoke(h.handler, rebound);
  assert.equal(second.statusCode, 400);
  assert.equal(second.body.stored, false);
  assert.equal(h.store.events.filter((event) => event === 'claimTurn').length, 1);
});

test('production/default-disabled and missing durable-store configuration fail closed without model or data work', async () => {
  let authCalls = 0;
  const disabled = createReinaPilotHandler({
    env: { ...ENV, NODE_ENV: 'production' },
    requireUserImpl: async () => { authCalls += 1; return { id: OWNER }; },
  });
  const denied = await invoke(disabled, request());
  assert.equal(denied.statusCode, 503);
  assert.equal(authCalls, 0);

  const production = handlerHarness({
    env: {
      ...ENV,
      NODE_ENV: 'production',
      VERCEL_ENV: 'production',
      REINA_PILOT_PRODUCTION_ENABLED: 'true',
    },
  });
  const productionResult = await invoke(production.handler, request());
  assert.equal(productionResult.statusCode, 200);
  assert.equal(productionResult.body.executed, false);

  let previewAuthCalls = 0;
  const preview = handlerHarness({
    env: { ...ENV, NODE_ENV: 'production', VERCEL_ENV: 'preview' },
    dependencies: {
      requireUserImpl: async () => { previewAuthCalls += 1; return { id: OWNER }; },
    },
  });
  const previewResult = await invoke(preview.handler, request());
  assert.equal(previewResult.statusCode, 200);
  assert.equal(previewAuthCalls, 1);

  const existingPreviewSwitch = handlerHarness({
    env: {
      NODE_ENV: 'production',
      VERCEL_ENV: 'preview',
      REINA_PREVIEW_ENABLED: 'true',
      SUPABASE_URL: ENV.SUPABASE_URL,
      SUPABASE_SERVICE_KEY: ENV.SUPABASE_SERVICE_KEY,
    },
  });
  const existingPreviewResult = await invoke(existingPreviewSwitch.handler, request());
  assert.equal(existingPreviewResult.statusCode, 200);

  const productionCannotUsePreviewSwitch = createReinaPilotHandler({
    env: {
      NODE_ENV: 'production',
      VERCEL_ENV: 'production',
      REINA_PREVIEW_ENABLED: 'true',
      SUPABASE_URL: ENV.SUPABASE_URL,
      SUPABASE_SERVICE_KEY: ENV.SUPABASE_SERVICE_KEY,
    },
    requireUserImpl: async () => { throw new Error('production must remain off'); },
  });
  const productionPreviewDenied = await invoke(productionCannotUsePreviewSwitch, request());
  assert.equal(productionPreviewDenied.statusCode, 503);

  let missingStoreAuthCalls = 0;
  const noStore = createReinaPilotHandler({
    env: { ...ENV, SUPABASE_SERVICE_KEY: '' },
    requireUserImpl: async () => {
      missingStoreAuthCalls += 1;
      return { id: OWNER };
    },
    fetchImpl: async () => {
      throw new Error('must not read a profile without a durable store');
    },
  });
  const unavailable = await invoke(noStore, request());
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.stored, false);
  const unavailableBootstrap = await invoke(noStore, {
    method: 'GET', headers: { authorization: 'Bearer browser-session' },
  });
  assert.equal(unavailableBootstrap.statusCode, 503);
  assert.equal(unavailableBootstrap.body.stored, false);
  assert.equal(missingStoreAuthCalls, 0);
});

test('configured production intelligence answers greetings instantly while action requests still refuse before the model', async () => {
  let modelCalls = 0;
  let contextCalls = 0;
  const dependencies = {
    intelligenceFetchImpl: async (_url, init) => {
      modelCalls += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'gpt-5.6-terra');
      return { ok: true, json: async () => ({ output_text: 'Good morning, Chris. I am ready. What should we tackle first?' }) };
    },
    readContextImpl: async () => { contextCalls += 1; return null; },
  };
  const live = handlerHarness({ env: { ...ENV, OPENAI_API_KEY: 'test-key' }, dependencies });
  const greeting = await invoke(live.handler, request({ utterance: 'Good morning, Reina.' }));
  assert.equal(greeting.statusCode, 200);
  assert.match(greeting.body.envelope.answer, /ready to help/i);
  assert.equal(greeting.body.envelope.answer.includes('synthetic read-only pilot'), false);
  assert.equal(modelCalls, 0);
  assert.equal(contextCalls, 0);

  const guarded = handlerHarness({ env: { ...ENV, OPENAI_API_KEY: 'test-key' }, dependencies });
  const action = await invoke(guarded.handler, request({ utterance: 'Send this estimate to the customer.' }));
  assert.equal(action.statusCode, 200);
  assert.equal(action.body.envelope.refused, true);
  assert.equal(action.body.executed, false);
  assert.equal(modelCalls, 0, 'the fixed action boundary runs before intelligence');
});

test('server-owned deadlines settle hostile context, profile, store, and review-intent operations', async () => {
  const deadlineOptions = { timeoutMs: 35, stageMs: 10 };

  let contextSignal;
  const context = handlerHarness({
    dependencies: {
      deadlineOptions,
      resolveActingContextImpl: async (_req, options) => {
        contextSignal = options.signal;
        return new Promise(() => {});
      },
    },
  });
  const contextResult = await invoke(context.handler, request());
  assert.equal(contextResult.statusCode, 403);
  assert.equal(contextResult.body.error, 'authorization_expired');
  assert.equal(contextSignal.aborted, true);
  assert.equal(context.store.calls.length, 0);

  let profileSignal;
  const profile = handlerHarness({
    dependencies: {
      deadlineOptions,
      loadDisplayNameImpl: async (_actingContext, options) => {
        profileSignal = options.signal;
        return new Promise(() => {});
      },
    },
  });
  const profileResult = await invoke(profile.handler, {
    method: 'GET', headers: { authorization: 'Bearer browser-session' },
  });
  assert.equal(profileResult.statusCode, 503);
  assert.equal(profileSignal.aborted, true);
  assert.equal(profile.store.events.length, 0);

  let claimSignal;
  const claimStore = new AtomicMemoryStore({
    overrides: {
      claimTurn: async (_input, _store) => new Promise(() => {}),
    },
  });
  const originalClaim = claimStore.claimTurn.bind(claimStore);
  claimStore.claimTurn = async function claimWithSignal(input, options) {
    claimSignal = options.signal;
    return originalClaim(input);
  };
  const claim = handlerHarness({ store: claimStore, dependencies: { deadlineOptions } });
  const claimResult = await invoke(claim.handler, request({ turnId: 'turn-deadline-claim' }));
  assert.equal(claimResult.statusCode, 503);
  assert.equal(claimSignal.aborted, true);

  let confirmationSignal;
  const fixedNow = () => '2026-08-03T14:00:00Z';
  const confirmationStore = new AtomicMemoryStore({
    now: fixedNow,
    overrides: {
      consumeReviewIntent: async () => new Promise(() => {}),
    },
  });
  const originalConsume = confirmationStore.consumeReviewIntent.bind(confirmationStore);
  confirmationStore.consumeReviewIntent = async function consumeWithSignal(input, options) {
    confirmationSignal = options.signal;
    return originalConsume(input);
  };
  const confirmation = handlerHarness({
    store: confirmationStore,
    now: fixedNow,
    dependencies: { deadlineOptions },
  });
  const confirmationBootstrap = await invoke(confirmation.handler, {
    method: 'GET', headers: { authorization: 'Bearer browser-session' },
  });
  assert.equal(confirmationBootstrap.statusCode, 200);
  const confirmationResult = await invoke(
    confirmation.handler,
    confirmationRequest(confirmationBootstrap.body.uiIntent.intentId),
  );
  assert.equal(confirmationResult.statusCode, 408);
  assert.equal(confirmationResult.body.error, 'confirmation_timeout');
  assert.equal(confirmationSignal.aborted, true);
  assert.equal(
    confirmationStore.reviewIntents.get(confirmationBootstrap.body.uiIntent.intentId).consumed,
    false,
  );

});

test('default route uses real authenticated Supabase RPC adapter for bootstrap, durable save, and replay', async () => {
  const owner = '11111111-1111-4111-8111-111111111111';
  const runtime = defaultRuntimeFetchHarness(owner);
  const handler = createReinaPilotHandler({
    env: ENV,
    fetchImpl: runtime.fetchImpl,
    now: () => new Date().toISOString(),
  });
  const bootstrap = await invoke(handler, {
    method: 'GET', headers: { authorization: 'Bearer runtime-session' },
  });
  assert.equal(bootstrap.statusCode, 200, JSON.stringify({ body: bootstrap.body, calls: runtime.state.rpcCalls }));
  assert.equal(bootstrap.body.user.displayName, 'Runtime Chris');
  assert.equal(bootstrap.body.attention.total, 5);
  assert.equal(bootstrap.body.review.intentId, bootstrap.body.uiIntent.intentId);

  const confirmed = await invoke(
    handler,
    confirmationRequest(bootstrap.body.uiIntent.intentId, 'runtime-session'),
  );
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.body.executed, false);
  assert.equal(confirmed.body.businessActionAllowed, false);

  const req = request({
    conversationId: bootstrap.body.sessionId,
    turnId: 'turn-runtime-default',
  }, { owner, token: 'runtime-session' });
  const stored = await invoke(handler, req);
  const replayed = await invoke(handler, req);
  assert.equal(stored.statusCode, 200);
  assert.equal(stored.body.stored, true);
  assert.equal(stored.body.executed, false);
  assert.equal(replayed.statusCode, 200);
  assert.equal(replayed.body.replayed, true);
  assert.deepEqual(replayed.body.envelope, stored.body.envelope);
  assert.equal(runtime.state.rpcCalls.filter(name => name === 'reina_pilot_append_assistant_and_complete').length, 1);
  assert.equal(runtime.state.rpcCalls.filter(name => name === 'reina_pilot_issue_review_intent').length, 1);
  assert.equal(runtime.state.rpcCalls.filter(name => name === 'reina_pilot_consume_review_intent').length, 1);
});
