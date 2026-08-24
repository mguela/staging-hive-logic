import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

const DEFAULT_TIMEOUT_MS = 3_000;
// How long ONE database call may take. Unrelated to how long the turn runs.
const MAX_TIMEOUT_MS = 15_000;
// How long a turn may hold its claim on the conversation. This has to track
// SERVER_DEADLINE.totalMs: the route hands its own root deadline down as the
// attempt lease, so a ceiling below the route budget rejects every RPC as
// unconfigured and the whole turn 503s. It used to share MAX_TIMEOUT_MS, and
// with a 15s total the two were exactly equal -- raising the route budget to
// 40s on 2026-08-23 was what showed they were two different limits.
const MAX_ATTEMPT_LEASE_MS = 60_000;
const MAX_RESPONSE_BYTES = 2_200_000;
const MAX_HISTORY_MESSAGES = 200;
const MAX_HISTORY_BYTES = 1_000_000;
const MAX_CONTENT_CHARACTERS = 100_000;
const MAX_CONTENT_BYTES = 400_000;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const UNSAFE_CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/u;

const POLICY_VERSION = 'reina-acting-context-policy-v1';
const REVIEW_POLICY_KIND = 'reina_ui_confirmation_policy';
const REVIEW_POLICY_OPERATION = 'reina.pilot.access';
const REVIEW_POLICY_CAPABILITY = 'reina:pilot:access';
const REVIEW_POLICY_RESOURCE = 'pilot_runtime';
const REVIEW_POLICY_EFFECT = 'access';
const REVIEW_POLICY_OWNER_SCOPE = 'principal';
const OPERATION = Object.freeze({
  CREATE: 'reina.conversation.create',
  READ: 'reina.conversation.read',
  APPEND: 'reina.conversation.append',
});

const RPC = Object.freeze({
  loadConversation: 'reina_pilot_load_conversation',
  createConversation: 'reina_pilot_create_conversation',
  claimTurn: 'reina_pilot_claim_turn',
  appendUserMessageOnce: 'reina_pilot_append_user_once',
  loadHistory: 'reina_pilot_load_history',
  appendAssistantAndCompleteTurn: 'reina_pilot_append_assistant_and_complete',
  markTurnFailed: 'reina_pilot_mark_turn_failed',
  issueReviewIntent: 'reina_pilot_issue_review_intent',
  consumeReviewIntent: 'reina_pilot_consume_review_intent',
});

const FAIL = Object.freeze({
  loadConversation: Object.freeze({ status: 'invalid' }),
  createConversation: Object.freeze({ status: 'invalid' }),
  claimTurn: Object.freeze({ status: 'incomplete' }),
  appendUserMessageOnce: Object.freeze({ status: 'invalid' }),
  loadHistory: Object.freeze({ status: 'invalid' }),
  appendAssistantAndCompleteTurn: Object.freeze({ status: 'invalid' }),
  markTurnFailed: Object.freeze({ status: 'incomplete' }),
  issueReviewIntent: Object.freeze({ status: 'invalid' }),
  consumeReviewIntent: Object.freeze({ status: 'invalid' }),
});

const PINNED_FETCH = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
const PINNED_RESPONSE = typeof globalThis.Response === 'function' ? globalThis.Response : null;
const RESPONSE_STATUS_GETTER = PINNED_RESPONSE
  ? Object.getOwnPropertyDescriptor(PINNED_RESPONSE.prototype, 'status')?.get
  : null;
const RESPONSE_TEXT = PINNED_RESPONSE?.prototype?.text;
const EVENT_ADD = typeof EventTarget === 'function' ? EventTarget.prototype.addEventListener : null;
const EVENT_REMOVE = typeof EventTarget === 'function' ? EventTarget.prototype.removeEventListener : null;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const objectLike = value => value !== null && (typeof value === 'object' || typeof value === 'function');
const isProxy = value => objectLike(value) && utilTypes.isProxy(value);

function plainRecord(value) {
  if (value === null || typeof value !== 'object' || isProxy(value)) return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function snapshotRecord(value, required = [], optional = []) {
  if (!plainRecord(value)) return null;
  const allowed = new Set([...required, ...optional]);
  let keys;
  let descriptors;
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key))) return null;
  if (required.some(key => !hasOwn(descriptors, key))) return null;
  const values = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !hasOwn(descriptor, 'value')) return null;
    values[key] = descriptor.value;
  }
  return Object.freeze({ keys: Object.freeze(keys.slice()), values: Object.freeze(values) });
}

function exactKeys(snapshot, keys) {
  return snapshot !== null
    && snapshot.keys.length === keys.length
    && keys.every(key => snapshot.keys.includes(key));
}

function denseArray(value, maximum) {
  if (isProxy(value)) return null;
  let descriptors;
  let keys;
  try {
    if (!Array.isArray(value)) return null;
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return null;
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  if (keys.length !== expected.size || keys.some(key => typeof key !== 'string' || !expected.has(key))) return null;
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !hasOwn(descriptor, 'value')) return null;
    out.push(descriptor.value);
  }
  return out;
}

function environmentValue(env, key, maximum) {
  if (!objectLike(env) || isProxy(env)) return null;
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(env, key); } catch { return null; }
  if (!descriptor || !hasOwn(descriptor, 'value')) return null;
  const value = descriptor.value;
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\r\n]/u.test(value)) return null;
  return value;
}

function configuredEndpoint(env) {
  const rawUrl = environmentValue(env, 'SUPABASE_URL', 2_048);
  const serviceKey = environmentValue(env, 'SUPABASE_SERVICE_KEY', 32_768);
  if (!rawUrl || !serviceKey || /\s/u.test(serviceKey)) return null;
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return null; }
  if (parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== '') return null;
  const baseUrl = parsed.href.replace(/\/+$/u, '');
  return Object.freeze({ baseUrl, serviceKey });
}

function safeIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

function safeUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function safeDigest(value) {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeContent(value) {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_CONTENT_CHARACTERS
    || Buffer.byteLength(value, 'utf8') > MAX_CONTENT_BYTES
    || value.includes('\r')) return false;
  let normalized;
  try { normalized = value.normalize('NFC'); } catch { return false; }
  if (normalized !== value || value.trim().length === 0) return false;
  return !UNSAFE_CONTROL_PATTERN.test(value.replace(/[\t\n]/gu, ''));
}

function canonicalStringDigest(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function policyReference(value, expectedOwner, expectedOperation) {
  const snapshot = snapshotRecord(value, [
    'policyVersion', 'operation', 'ownerPrincipalId', 'decidedAt', 'decisionReference',
  ]);
  if (!exactKeys(snapshot, [
    'policyVersion', 'operation', 'ownerPrincipalId', 'decidedAt', 'decisionReference',
  ])) return null;
  const fields = snapshot.values;
  if (fields.policyVersion !== POLICY_VERSION
    || fields.operation !== expectedOperation
    || fields.ownerPrincipalId !== expectedOwner
    || !canonicalTimestamp(fields.decidedAt)
    || !safeDigest(fields.decisionReference)) return null;
  return Object.freeze({
    policyVersion: fields.policyVersion,
    operation: fields.operation,
    ownerPrincipalId: fields.ownerPrincipalId,
    decidedAt: fields.decidedAt,
    decisionReference: fields.decisionReference,
  });
}

function samePolicyReference(left, right) {
  return left !== null
    && right !== null
    && left.policyVersion === right.policyVersion
    && left.operation === right.operation
    && left.ownerPrincipalId === right.ownerPrincipalId
    && left.decidedAt === right.decidedAt
    && left.decisionReference === right.decisionReference;
}

function reviewPolicyReference(value, expectedOwner) {
  const keys = [
    'kind', 'policyVersion', 'operation', 'capability', 'resource', 'effect',
    'ownerScope', 'ownerPrincipalId',
  ];
  const snapshot = snapshotRecord(value, keys);
  if (!exactKeys(snapshot, keys)) return null;
  const fields = snapshot.values;
  if (fields.kind !== REVIEW_POLICY_KIND
    || fields.policyVersion !== POLICY_VERSION
    || fields.operation !== REVIEW_POLICY_OPERATION
    || fields.capability !== REVIEW_POLICY_CAPABILITY
    || fields.resource !== REVIEW_POLICY_RESOURCE
    || fields.effect !== REVIEW_POLICY_EFFECT
    || fields.ownerScope !== REVIEW_POLICY_OWNER_SCOPE
    || fields.ownerPrincipalId !== expectedOwner) return null;
  return Object.freeze({
    kind: REVIEW_POLICY_KIND,
    policyVersion: POLICY_VERSION,
    operation: REVIEW_POLICY_OPERATION,
    capability: REVIEW_POLICY_CAPABILITY,
    resource: REVIEW_POLICY_RESOURCE,
    effect: REVIEW_POLICY_EFFECT,
    ownerScope: REVIEW_POLICY_OWNER_SCOPE,
    ownerPrincipalId: expectedOwner,
  });
}

function baseScopeInput(input, policyOperation) {
  const snapshot = snapshotRecord(input, ['ownerPrincipalId', 'conversationId', 'policyReference']);
  if (!snapshot) return null;
  const ownerPrincipalId = snapshot.values.ownerPrincipalId;
  const conversationId = snapshot.values.conversationId;
  if (!safeUuid(ownerPrincipalId) || !safeIdentifier(conversationId)) return null;
  const policy = policyReference(snapshot.values.policyReference, ownerPrincipalId, policyOperation);
  return policy ? Object.freeze({ ownerPrincipalId, conversationId, policyReference: policy }) : null;
}

function turnBase(snapshot) {
  const ownerPrincipalId = snapshot.values.ownerPrincipalId;
  const conversationId = snapshot.values.conversationId;
  const idempotencyKey = snapshot.values.idempotencyKey;
  const inputDigest = snapshot.values.inputDigest;
  if (!safeUuid(ownerPrincipalId)
    || !safeIdentifier(conversationId)
    || !safeIdentifier(idempotencyKey)
    || !safeDigest(inputDigest)) return null;
  return Object.freeze({ ownerPrincipalId, conversationId, idempotencyKey, inputDigest });
}

function message(value, expected = {}) {
  const snapshot = snapshotRecord(value, ['messageId', 'sequence', 'role', 'content', 'contentDigest']);
  if (!snapshot) return null;
  const fields = snapshot.values;
  if (!safeUuid(fields.messageId)
    || !Number.isSafeInteger(fields.sequence)
    || fields.sequence < 1
    || fields.sequence > MAX_HISTORY_MESSAGES
    || (fields.role !== 'user' && fields.role !== 'assistant')
    || !safeContent(fields.content)
    || !safeDigest(fields.contentDigest)
    || canonicalStringDigest(fields.content) !== fields.contentDigest) return null;
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (fields[key] !== expectedValue) return null;
  }
  return Object.freeze({
    messageId: fields.messageId,
    sequence: fields.sequence,
    role: fields.role,
    content: fields.content,
    contentDigest: fields.contentDigest,
  });
}

function conversationResult(value, ownerPrincipalId, conversationId, expectedStatus) {
  const snapshot = snapshotRecord(value, ['status', 'conversation']);
  if (!snapshot || snapshot.values.status !== expectedStatus) return null;
  const conversation = snapshotRecord(snapshot.values.conversation, ['ownerPrincipalId', 'conversationId']);
  if (!conversation
    || conversation.values.ownerPrincipalId !== ownerPrincipalId
    || conversation.values.conversationId !== conversationId) return null;
  return Object.freeze({
    status: expectedStatus,
    conversation: Object.freeze({ ownerPrincipalId, conversationId }),
  });
}

function storedResult(value, expected, expectedAssistant = null) {
  const snapshot = snapshotRecord(value, [
    'ownerPrincipalId', 'conversationId', 'idempotencyKey', 'inputDigest',
    'userMessageId', 'userMessageSequence', 'assistantMessage',
    'resultReference', 'policyReference',
  ]);
  if (!snapshot) return null;
  const fields = snapshot.values;
  if (fields.ownerPrincipalId !== expected.ownerPrincipalId
    || fields.conversationId !== expected.conversationId
    || fields.idempotencyKey !== expected.idempotencyKey
    || fields.inputDigest !== expected.inputDigest
    || !safeUuid(fields.userMessageId)
    || !Number.isSafeInteger(fields.userMessageSequence)
    || fields.userMessageSequence < 1
    || fields.userMessageSequence >= MAX_HISTORY_MESSAGES
    || !safeUuid(fields.resultReference)) return null;
  if (expected.userMessageId !== undefined && fields.userMessageId !== expected.userMessageId) return null;
  if (expected.userMessageSequence !== undefined && fields.userMessageSequence !== expected.userMessageSequence) return null;
  const assistantExpected = {
    role: 'assistant',
    sequence: fields.userMessageSequence + 1,
    ...(expectedAssistant || {}),
  };
  const assistantMessage = message(fields.assistantMessage, assistantExpected);
  const policy = policyReference(fields.policyReference, expected.ownerPrincipalId, OPERATION.APPEND);
  if (!assistantMessage || !policy || assistantMessage.messageId === fields.userMessageId) return null;
  return Object.freeze({
    ownerPrincipalId: fields.ownerPrincipalId,
    conversationId: fields.conversationId,
    idempotencyKey: fields.idempotencyKey,
    inputDigest: fields.inputDigest,
    userMessageId: fields.userMessageId,
    userMessageSequence: fields.userMessageSequence,
    assistantMessage,
    resultReference: fields.resultReference,
    policyReference: policy,
  });
}

function validSignal(value) {
  return value === undefined || value === null
    || (!isProxy(value) && typeof AbortSignal === 'function' && value instanceof AbortSignal);
}

function deadlineMilliseconds(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && canonicalTimestamp(value)) return Date.parse(value);
  return Number.NaN;
}

function methodResponse(response) {
  if (!objectLike(response) || isProxy(response)) return null;
  if (PINNED_RESPONSE && RESPONSE_STATUS_GETTER && typeof RESPONSE_TEXT === 'function' && response instanceof PINNED_RESPONSE) {
    let status;
    try { status = Reflect.apply(RESPONSE_STATUS_GETTER, response, []); } catch { return null; }
    if (!Number.isInteger(status) || status < 200 || status > 299) return null;
    return Object.freeze({ text: () => Reflect.apply(RESPONSE_TEXT, response, []) });
  }
  let okDescriptor;
  let statusDescriptor;
  let textDescriptor;
  try {
    okDescriptor = Object.getOwnPropertyDescriptor(response, 'ok');
    statusDescriptor = Object.getOwnPropertyDescriptor(response, 'status');
    textDescriptor = Object.getOwnPropertyDescriptor(response, 'text');
  } catch {
    return null;
  }
  if (!textDescriptor || !hasOwn(textDescriptor, 'value') || typeof textDescriptor.value !== 'function' || isProxy(textDescriptor.value)) return null;
  const ok = okDescriptor && hasOwn(okDescriptor, 'value') ? okDescriptor.value : undefined;
  const status = statusDescriptor && hasOwn(statusDescriptor, 'value') ? statusDescriptor.value : undefined;
  if ((ok !== undefined && ok !== true)
    || (status !== undefined && (!Number.isInteger(status) || status < 200 || status > 299))
    || (ok === undefined && status === undefined)) return null;
  return Object.freeze({ text: () => Reflect.apply(textDescriptor.value, response, []) });
}

function parseTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS ? value : null;
}

export function createSupabaseConversationStore(options = {}) {
  const optionsSnapshot = snapshotRecord(options, [], ['env', 'fetchImpl', 'timeoutMs', 'deadlineAt', 'signal']);
  const values = optionsSnapshot?.values || Object.create(null);
  const env = hasOwn(values, 'env') ? values.env : process.env;
  const endpoint = configuredEndpoint(env);
  const fetchImpl = hasOwn(values, 'fetchImpl') ? values.fetchImpl : PINNED_FETCH;
  const timeoutMs = parseTimeout(values.timeoutMs);
  const routeDeadlineMs = deadlineMilliseconds(values.deadlineAt);
  const parentSignal = values.signal;
  const configured = Boolean(optionsSnapshot
    && endpoint
    && typeof fetchImpl === 'function'
    && !isProxy(fetchImpl)
    && timeoutMs !== null
    && !Number.isNaN(routeDeadlineMs)
    && validSignal(parentSignal));

  function invocationContext(callOptions) {
    const callSnapshot = snapshotRecord(
      callOptions === undefined ? {} : callOptions,
      [],
      ['signal', 'deadlineAt', 'attemptDeadlineAt'],
    );
    if (!configured || !callSnapshot) return null;
    const callSignal = callSnapshot.values.signal;
    const callDeadlineMs = deadlineMilliseconds(callSnapshot.values.deadlineAt);
    const requestedAttemptDeadlineMs = deadlineMilliseconds(callSnapshot.values.attemptDeadlineAt);
    if (!validSignal(callSignal)
      || Number.isNaN(callDeadlineMs)
      || Number.isNaN(requestedAttemptDeadlineMs)) return null;

    const now = Date.now();
    let effective = now + timeoutMs;
    if (routeDeadlineMs !== null) effective = Math.min(effective, routeDeadlineMs);
    if (callDeadlineMs !== null) effective = Math.min(effective, callDeadlineMs);
    if (!Number.isFinite(effective) || effective <= now) return null;
    const attemptDeadlineMs = requestedAttemptDeadlineMs ?? routeDeadlineMs ?? effective;
    if (!Number.isFinite(attemptDeadlineMs)
      || attemptDeadlineMs < effective
      || attemptDeadlineMs <= now
      || attemptDeadlineMs > now + MAX_ATTEMPT_LEASE_MS) return null;

    const signals = [];
    for (const signal of [parentSignal, callSignal]) {
      if (signal && !signals.includes(signal)) signals.push(signal);
    }
    if (signals.some(signal => signal.aborted === true)) return null;
    return Object.freeze({
      deadlineMs: effective,
      deadlineAt: new Date(effective).toISOString(),
      attemptDeadlineAt: new Date(attemptDeadlineMs).toISOString(),
      signals: Object.freeze(signals),
    });
  }

  async function callRpc(method, body, invocation) {
    const fallback = FAIL[method];
    if (!invocation || invocation.signals.some(signal => signal.aborted === true)) return fallback;

    const controller = new AbortController();
    let timer = null;
    let rejectDeadline;
    const deadlinePromise = new Promise((resolve, reject) => { rejectDeadline = reject; });
    const failDeadline = () => {
      try { controller.abort(); } catch { /* fixed failure below */ }
      rejectDeadline(new Error('REINA_STORE_DEADLINE'));
    };
    const onUpstreamAbort = () => failDeadline();
    timer = setTimeout(failDeadline, Math.max(1, invocation.deadlineMs - Date.now()));
    for (const signal of invocation.signals) {
      if (!EVENT_ADD) {
        failDeadline();
        break;
      }
      try { Reflect.apply(EVENT_ADD, signal, ['abort', onUpstreamAbort, { once: true }]); } catch { failDeadline(); }
    }

    const task = Promise.resolve().then(async () => {
      const response = await Reflect.apply(fetchImpl, undefined, [
        `${endpoint.baseUrl}/rest/v1/rpc/${RPC[method]}`,
        {
          method: 'POST',
          cache: 'no-store',
          signal: controller.signal,
          headers: {
            apikey: endpoint.serviceKey,
            Authorization: `Bearer ${endpoint.serviceKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
        },
      ]);
      const readable = methodResponse(response);
      if (!readable) throw new Error('REINA_STORE_RESPONSE');
      const text = await readable.text();
      if (typeof text !== 'string' || text.length < 2 || Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new Error('REINA_STORE_RESPONSE');
      }
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Error('REINA_STORE_RESPONSE'); }
      return parsed;
    });

    try {
      return await Promise.race([task, deadlinePromise]);
    } catch {
      return fallback;
    } finally {
      if (timer !== null) clearTimeout(timer);
      for (const signal of invocation.signals) {
        if (!EVENT_REMOVE) continue;
        try { Reflect.apply(EVENT_REMOVE, signal, ['abort', onUpstreamAbort]); } catch { /* no outward error */ }
      }
    }
  }

  async function loadConversation(input, callOptions) {
    const invocation = invocationContext(callOptions);
    if (!invocation) return FAIL.loadConversation;
    const clean = baseScopeInput(input, OPERATION.READ);
    if (!clean) return FAIL.loadConversation;
    const raw = await callRpc('loadConversation', {
      p_owner_principal_id: clean.ownerPrincipalId,
      p_conversation_id: clean.conversationId,
      p_policy_reference: clean.policyReference,
      p_deadline_at: invocation.deadlineAt,
    }, invocation);
    const top = snapshotRecord(raw, ['status'], ['conversation']);
    if (top?.values.status === 'not_found' && top.keys.length === 1) return Object.freeze({ status: 'not_found' });
    return conversationResult(raw, clean.ownerPrincipalId, clean.conversationId, 'found') || FAIL.loadConversation;
  }

  async function createConversation(input, callOptions) {
    const invocation = invocationContext(callOptions);
    if (!invocation) return FAIL.createConversation;
    const clean = baseScopeInput(input, OPERATION.CREATE);
    if (!clean) return FAIL.createConversation;
    const raw = await callRpc('createConversation', {
      p_owner_principal_id: clean.ownerPrincipalId,
      p_conversation_id: clean.conversationId,
      p_policy_reference: clean.policyReference,
      p_deadline_at: invocation.deadlineAt,
    }, invocation);
    const top = snapshotRecord(raw, ['status'], ['conversation']);
    if (top?.values.status === 'exists' && top.keys.length === 1) return Object.freeze({ status: 'exists' });
    return conversationResult(raw, clean.ownerPrincipalId, clean.conversationId, 'created') || FAIL.createConversation;
  }

  async function claimTurn(input, callOptions) {
    const invocation = invocationContext(callOptions);
    if (!invocation) return FAIL.claimTurn;
    const snapshot = snapshotRecord(input, [
      'ownerPrincipalId', 'conversationId', 'idempotencyKey', 'inputDigest',
      'appendPolicyReference', 'replayReadPolicyReference',
    ]);
    const base = snapshot && turnBase(snapshot);
    if (!base) return FAIL.claimTurn;
    const appendPolicy = policyReference(snapshot.values.appendPolicyReference, base.ownerPrincipalId, OPERATION.APPEND);
    const readPolicy = policyReference(snapshot.values.replayReadPolicyReference, base.ownerPrincipalId, OPERATION.READ);
    if (!appendPolicy || !readPolicy) return FAIL.claimTurn;
    const raw = await callRpc('claimTurn', {
      p_owner_principal_id: base.ownerPrincipalId,
      p_conversation_id: base.conversationId,
      p_idempotency_key: base.idempotencyKey,
      p_input_digest: base.inputDigest,
      p_append_policy_reference: appendPolicy,
      p_replay_read_policy_reference: readPolicy,
      p_deadline_at: invocation.deadlineAt,
      p_attempt_deadline_at: invocation.attemptDeadlineAt,
    }, invocation);
    const top = snapshotRecord(raw, ['status'], ['claimId', 'progress', 'result']);
    if (!top || typeof top.values.status !== 'string') return FAIL.claimTurn;
    if (['conflict', 'in_flight', 'incomplete', 'failed'].includes(top.values.status) && top.keys.length === 1) {
      return Object.freeze({ status: top.values.status });
    }
    if ((top.values.status === 'claimed' || top.values.status === 'resumed')
      && top.keys.length === 3
      && safeUuid(top.values.claimId)
      && (top.values.progress === 'claimed' || top.values.progress === 'user_persisted')
      && (top.values.status !== 'claimed' || top.values.progress === 'claimed')) {
      return Object.freeze({ status: top.values.status, claimId: top.values.claimId, progress: top.values.progress });
    }
    if (top.values.status === 'replay' && top.keys.length === 2) {
      const result = storedResult(top.values.result, base);
      return result ? Object.freeze({ status: 'replay', result }) : FAIL.claimTurn;
    }
    return FAIL.claimTurn;
  }

  async function appendUserMessageOnce(input, callOptions) {
    const invocation = invocationContext(callOptions);
    if (!invocation) return FAIL.appendUserMessageOnce;
    const snapshot = snapshotRecord(input, [
      'ownerPrincipalId', 'conversationId', 'idempotencyKey', 'inputDigest',
      'claimId', 'content', 'contentDigest', 'policyReference',
    ]);
    const base = snapshot && turnBase(snapshot);
    if (!base
      || !safeUuid(snapshot.values.claimId)
      || !safeContent(snapshot.values.content)
      || !safeDigest(snapshot.values.contentDigest)
      || canonicalStringDigest(snapshot.values.content) !== snapshot.values.contentDigest) return FAIL.appendUserMessageOnce;
    const policy = policyReference(snapshot.values.policyReference, base.ownerPrincipalId, OPERATION.APPEND);
    if (!policy) return FAIL.appendUserMessageOnce;
    const raw = await callRpc('appendUserMessageOnce', {
      p_owner_principal_id: base.ownerPrincipalId,
      p_conversation_id: base.conversationId,
      p_idempotency_key: base.idempotencyKey,
      p_input_digest: base.inputDigest,
      p_claim_id: snapshot.values.claimId,
      p_content: snapshot.values.content,
      p_content_digest: snapshot.values.contentDigest,
      p_policy_reference: policy,
      p_deadline_at: invocation.deadlineAt,
    }, invocation);
    const top = snapshotRecord(raw, ['status', 'ownerPrincipalId', 'conversationId', 'message']);
    if (!top
      || (top.values.status !== 'appended' && top.values.status !== 'existing')
      || top.values.ownerPrincipalId !== base.ownerPrincipalId
      || top.values.conversationId !== base.conversationId) return FAIL.appendUserMessageOnce;
    const savedMessage = message(top.values.message, {
      role: 'user', content: snapshot.values.content, contentDigest: snapshot.values.contentDigest,
    });
    return savedMessage ? Object.freeze({
      status: top.values.status,
      ownerPrincipalId: base.ownerPrincipalId,
      conversationId: base.conversationId,
      message: savedMessage,
    }) : FAIL.appendUserMessageOnce;
  }

  async function loadHistory(input, callOptions) {
    const invocation = invocationContext(callOptions);
    if (!invocation) return FAIL.loadHistory;
    const snapshot = snapshotRecord(input, ['ownerPrincipalId', 'conversationId', 'throughMessageId', 'policyReference']);
    if (!snapshot) return FAIL.loadHistory;
    const ownerPrincipalId = snapshot.values.ownerPrincipalId;
    const conversationId = snapshot.values.conversationId;
    if (!safeUuid(ownerPrincipalId) || !safeIdentifier(conversationId) || !safeUuid(snapshot.values.throughMessageId)) return FAIL.loadHistory;
    const policy = policyReference(snapshot.values.policyReference, ownerPrincipalId, OPERATION.READ);
    if (!policy) return FAIL.loadHistory;
    const raw = await callRpc('loadHistory', {
      p_owner_principal_id: ownerPrincipalId,
      p_conversation_id: conversationId,
      p_through_message_id: snapshot.values.throughMessageId,
      p_policy_reference: policy,
      p_deadline_at: invocation.deadlineAt,
    }, invocation);
    const top = snapshotRecord(raw, ['status', 'ownerPrincipalId', 'conversationId', 'messages']);
    if (!top
      || top.values.status !== 'loaded'
      || top.values.ownerPrincipalId !== ownerPrincipalId
      || top.values.conversationId !== conversationId) return FAIL.loadHistory;
    const rawMessages = denseArray(top.values.messages, MAX_HISTORY_MESSAGES);
    if (!rawMessages || rawMessages.length < 1 || rawMessages.length % 2 !== 1) return FAIL.loadHistory;
    const messages = [];
    const ids = new Set();
    let totalBytes = 0;
    for (let index = 0; index < rawMessages.length; index += 1) {
      const current = message(rawMessages[index], {
        sequence: index + 1,
        role: index % 2 === 0 ? 'user' : 'assistant',
      });
      if (!current || ids.has(current.messageId)) return FAIL.loadHistory;
      ids.add(current.messageId);
      totalBytes += Buffer.byteLength(current.content, 'utf8');
      if (totalBytes > MAX_HISTORY_BYTES) return FAIL.loadHistory;
      messages.push(current);
    }
    if (messages.at(-1).messageId !== snapshot.values.throughMessageId) return FAIL.loadHistory;
    return Object.freeze({
      status: 'loaded', ownerPrincipalId, conversationId, messages: Object.freeze(messages),
    });
  }

  async function appendAssistantAndCompleteTurn(input, callOptions) {
    const invocation = invocationContext(callOptions);
    if (!invocation) return FAIL.appendAssistantAndCompleteTurn;
    const snapshot = snapshotRecord(input, [
      'ownerPrincipalId', 'conversationId', 'idempotencyKey', 'inputDigest',
      'claimId', 'userMessageId', 'userMessageSequence', 'content',
      'contentDigest', 'policyReference',
    ]);
    const base = snapshot && turnBase(snapshot);
    if (!base
      || !safeUuid(snapshot.values.claimId)
      || !safeUuid(snapshot.values.userMessageId)
      || !Number.isSafeInteger(snapshot.values.userMessageSequence)
      || snapshot.values.userMessageSequence < 1
      || snapshot.values.userMessageSequence >= MAX_HISTORY_MESSAGES
      || !safeContent(snapshot.values.content)
      || !safeDigest(snapshot.values.contentDigest)
      || canonicalStringDigest(snapshot.values.content) !== snapshot.values.contentDigest) return FAIL.appendAssistantAndCompleteTurn;
    const policy = policyReference(snapshot.values.policyReference, base.ownerPrincipalId, OPERATION.APPEND);
    if (!policy) return FAIL.appendAssistantAndCompleteTurn;
    const raw = await callRpc('appendAssistantAndCompleteTurn', {
      p_owner_principal_id: base.ownerPrincipalId,
      p_conversation_id: base.conversationId,
      p_idempotency_key: base.idempotencyKey,
      p_input_digest: base.inputDigest,
      p_claim_id: snapshot.values.claimId,
      p_user_message_id: snapshot.values.userMessageId,
      p_user_message_sequence: snapshot.values.userMessageSequence,
      p_content: snapshot.values.content,
      p_content_digest: snapshot.values.contentDigest,
      p_policy_reference: policy,
      p_deadline_at: invocation.deadlineAt,
    }, invocation);
    const top = snapshotRecord(raw, ['status', 'result']);
    if (!top || top.values.status !== 'completed') return FAIL.appendAssistantAndCompleteTurn;
    const result = storedResult(top.values.result, {
      ...base,
      userMessageId: snapshot.values.userMessageId,
      userMessageSequence: snapshot.values.userMessageSequence,
    }, {
      content: snapshot.values.content,
      contentDigest: snapshot.values.contentDigest,
    });
    if (!result || !samePolicyReference(result.policyReference, policy)) return FAIL.appendAssistantAndCompleteTurn;
    return Object.freeze({ status: 'completed', result });
  }

  async function markTurnFailed(input, callOptions) {
    const invocation = invocationContext(callOptions);
    if (!invocation) return FAIL.markTurnFailed;
    const snapshot = snapshotRecord(input, [
      'ownerPrincipalId', 'conversationId', 'idempotencyKey', 'inputDigest',
      'claimId', 'stage', 'reasonCode', 'policyReference',
    ]);
    const base = snapshot && turnBase(snapshot);
    if (!base
      || !safeUuid(snapshot.values.claimId)
      || !safeIdentifier(snapshot.values.stage)
      || snapshot.values.stage.length > 80
      || !safeIdentifier(snapshot.values.reasonCode)
      || snapshot.values.reasonCode.length > 100) return FAIL.markTurnFailed;
    const policy = policyReference(snapshot.values.policyReference, base.ownerPrincipalId, OPERATION.APPEND);
    if (!policy) return FAIL.markTurnFailed;
    const raw = await callRpc('markTurnFailed', {
      p_owner_principal_id: base.ownerPrincipalId,
      p_conversation_id: base.conversationId,
      p_idempotency_key: base.idempotencyKey,
      p_input_digest: base.inputDigest,
      p_claim_id: snapshot.values.claimId,
      p_stage: snapshot.values.stage,
      p_reason_code: snapshot.values.reasonCode,
      p_policy_reference: policy,
      p_deadline_at: invocation.deadlineAt,
    }, invocation);
    const top = snapshotRecord(raw, ['status'], ['state']);
    if (top?.values.status === 'incomplete' && top.keys.length === 1) return Object.freeze({ status: 'incomplete' });
    if (top?.values.status === 'recorded'
      && top.keys.length === 2
      && (top.values.state === 'failed_retryable' || top.values.state === 'failed_terminal')) {
      return Object.freeze({ status: 'recorded', state: top.values.state });
    }
    return FAIL.markTurnFailed;
  }

  async function issueReviewIntent(input, callOptions) {
    const invocation = invocationContext(callOptions);
    if (!invocation) return FAIL.issueReviewIntent;
    const snapshot = snapshotRecord(input, [
      'ownerPrincipalId', 'conversationId', 'turnId', 'intentId', 'expiresAt',
      'policyReference',
    ]);
    if (!snapshot) return FAIL.issueReviewIntent;
    const ownerPrincipalId = snapshot.values.ownerPrincipalId;
    const conversationId = snapshot.values.conversationId;
    const turnId = snapshot.values.turnId;
    const intentId = snapshot.values.intentId;
    const expiresAt = snapshot.values.expiresAt;
    if (!safeUuid(ownerPrincipalId)
      || !safeIdentifier(conversationId)
      || !safeIdentifier(turnId)
      || !safeIdentifier(intentId)
      || !canonicalTimestamp(expiresAt)) return FAIL.issueReviewIntent;
    const policy = reviewPolicyReference(snapshot.values.policyReference, ownerPrincipalId);
    if (!policy) return FAIL.issueReviewIntent;
    const raw = await callRpc('issueReviewIntent', {
      p_owner_principal_id: ownerPrincipalId,
      p_conversation_id: conversationId,
      p_turn_id: turnId,
      p_intent_id: intentId,
      p_expires_at: expiresAt,
      p_policy_reference: policy,
      p_deadline_at: invocation.deadlineAt,
    }, invocation);
    const result = snapshotRecord(raw, ['status'], ['intentId', 'expiresAt']);
    if (result?.values.status === 'invalid' && result.keys.length === 1) {
      return FAIL.issueReviewIntent;
    }
    if (!result
      || result.keys.length !== 3
      || result.values.status !== 'issued'
      || result.values.intentId !== intentId
      || result.values.expiresAt !== expiresAt) return FAIL.issueReviewIntent;
    return Object.freeze({ status: 'issued', intentId, expiresAt });
  }

  async function consumeReviewIntent(input, callOptions) {
    const invocation = invocationContext(callOptions);
    if (!invocation) return FAIL.consumeReviewIntent;
    const snapshot = snapshotRecord(input, [
      'ownerPrincipalId', 'conversationId', 'intentId', 'policyReference',
    ]);
    if (!snapshot) return FAIL.consumeReviewIntent;
    const ownerPrincipalId = snapshot.values.ownerPrincipalId;
    const conversationId = snapshot.values.conversationId;
    const intentId = snapshot.values.intentId;
    if (!safeUuid(ownerPrincipalId)
      || !safeIdentifier(conversationId)
      || !safeIdentifier(intentId)) return FAIL.consumeReviewIntent;
    const policy = reviewPolicyReference(snapshot.values.policyReference, ownerPrincipalId);
    if (!policy) return FAIL.consumeReviewIntent;
    const raw = await callRpc('consumeReviewIntent', {
      p_owner_principal_id: ownerPrincipalId,
      p_conversation_id: conversationId,
      p_intent_id: intentId,
      p_policy_reference: policy,
      p_deadline_at: invocation.deadlineAt,
    }, invocation);
    const result = snapshotRecord(raw, ['status'], ['intentId']);
    if (!result || typeof result.values.status !== 'string') return FAIL.consumeReviewIntent;
    if (result.values.status === 'consumed'
      && result.keys.length === 2
      && result.values.intentId === intentId) {
      return Object.freeze({ status: 'consumed', intentId });
    }
    if (['not_found', 'owner_mismatch', 'policy_mismatch', 'expired', 'duplicate', 'invalid']
      .includes(result.values.status) && result.keys.length === 1) {
      return Object.freeze({ status: result.values.status });
    }
    return FAIL.consumeReviewIntent;
  }

  return Object.freeze({
    loadConversation,
    createConversation,
    claimTurn,
    appendUserMessageOnce,
    loadHistory,
    appendAssistantAndCompleteTurn,
    markTurnFailed,
    issueReviewIntent,
    consumeReviewIntent,
  });
}
