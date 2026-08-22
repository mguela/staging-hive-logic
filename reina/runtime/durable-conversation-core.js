import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  AUTHORIZATION_POLICY_VERSION,
  REINA_OPERATION,
  decideAuthorization,
  isAuthorizedDecisionFor,
} from '../../api/_lib/reina/authorization.js';

export const DURABLE_CONVERSATIONS_ENABLED = false;

export const REASON = Object.freeze({
  DISABLED: 'DURABLE_CONVERSATIONS_DISABLED',
  INVALID: 'INVALID_CONVERSATION_TURN',
  UNAUTHORIZED: 'CONVERSATION_UNAUTHORIZED',
  STORE_INVALID: 'CONVERSATION_STORE_INVALID',
  LOAD_FAILED: 'CONVERSATION_LOAD_FAILED',
  CREATE_FAILED: 'CONVERSATION_CREATE_FAILED',
  CLAIM_FAILED: 'TURN_CLAIM_FAILED',
  IN_FLIGHT: 'TURN_IN_FLIGHT',
  INCOMPLETE: 'TURN_INCOMPLETE',
  PREVIOUS_FAILED: 'TURN_PREVIOUSLY_FAILED',
  CONFLICT: 'TURN_INPUT_CONFLICT',
  USER_FAILED: 'USER_MESSAGE_PERSIST_FAILED',
  HISTORY_FAILED: 'CONVERSATION_HISTORY_FAILED',
  MODEL_FAILED: 'MODEL_GENERATION_FAILED',
  ASSISTANT_FAILED: 'ASSISTANT_MESSAGE_PERSIST_FAILED',
  STORED: 'CONVERSATION_TURN_STORED',
  REPLAYED: 'CONVERSATION_TURN_REPLAYED',
});

export const DURABLE_STORE_METHODS = Object.freeze([
  'loadConversation',
  'createConversation',
  'claimTurn',
  'appendUserMessageOnce',
  'loadHistory',
  'appendAssistantAndCompleteTurn',
  'markTurnFailed',
]);

export const LIMITS = Object.freeze({
  identifierCharacters: 128,
  contentCharacters: 100_000,
  contentBytes: 400_000,
  historyMessages: 200,
  historyBytes: 1_000_000,
});

const EMPTY_TOOLS = Object.freeze([]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const UNSAFE_TEXT_CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/u;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObjectLike = value => value !== null && (typeof value === 'object' || typeof value === 'function');
const isProxy = value => isObjectLike(value) && utilTypes.isProxy(value);

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

function dataRecord(value, { required = [], optional = [] } = {}) {
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
  return Object.freeze({
    keys: Object.freeze(keys.slice()),
    values: Object.freeze(values),
  });
}

function hasDataKey(snapshot, key) {
  return snapshot.keys.includes(key);
}

function safeIdentifier(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= LIMITS.identifierCharacters
    && IDENTIFIER_PATTERN.test(value);
}

function normalizeContent(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.contentCharacters) return null;
  let normalized;
  try {
    normalized = value.replace(/\r\n?/g, '\n').normalize('NFC');
  } catch {
    return null;
  }
  if (normalized.length === 0 || normalized.length > LIMITS.contentCharacters || normalized.trim().length === 0) return null;
  if (Buffer.byteLength(normalized, 'utf8') > LIMITS.contentBytes) return null;
  const withoutAllowedWhitespace = normalized.replace(/[\t\n]/g, '');
  if (UNSAFE_TEXT_CONTROL_PATTERN.test(withoutAllowedWhitespace)) return null;
  return normalized;
}

function snapshotTurn(turn) {
  const snapshot = dataRecord(turn, {
    required: ['conversationId', 'idempotencyKey', 'content'],
  });
  if (!snapshot) return null;
  const conversationId = snapshot.values.conversationId;
  const idempotencyKey = snapshot.values.idempotencyKey;
  const content = normalizeContent(snapshot.values.content);
  if (!safeIdentifier(conversationId) || !safeIdentifier(idempotencyKey) || content === null) return null;
  return Object.freeze({ conversationId, idempotencyKey, content });
}

export function validateTurnInput(turn) {
  return snapshotTurn(turn) !== null;
}

function canonicalize(value, seen = new WeakSet()) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical numbers must be finite.');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (!isObjectLike(value) || isProxy(value)) throw new TypeError('Canonical input must contain plain JSON data.');
  if (seen.has(value)) throw new TypeError('Canonical input cannot contain cycles.');
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0) throw new TypeError('Canonical arrays must be dense.');
      const ownKeys = Reflect.ownKeys(value);
      const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
      if (ownKeys.some(key => typeof key !== 'string' || !expected.has(key)) || ownKeys.length !== expected.size) {
        throw new TypeError('Canonical arrays must be dense data arrays.');
      }
      const parts = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !hasOwn(descriptor, 'value')) throw new TypeError('Canonical arrays cannot contain accessors.');
        parts.push(canonicalize(descriptor.value, seen));
      }
      return `[${parts.join(',')}]`;
    }

    if (!plainRecord(value)) throw new TypeError('Canonical objects must be plain records.');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) throw new TypeError('Canonical objects cannot contain symbol keys.');
    keys.sort();
    const parts = keys.map(key => {
      const descriptor = descriptors[key];
      if (!descriptor || !hasOwn(descriptor, 'value')) throw new TypeError('Canonical objects cannot contain accessors.');
      return `${JSON.stringify(key)}:${canonicalize(descriptor.value, seen)}`;
    });
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalDigest(value) {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

function turnPayloadDigest(ownerPrincipalId, turn) {
  return canonicalDigest(Object.freeze({
    version: 1,
    operation: REINA_OPERATION.CONVERSATION_APPEND,
    ownerPrincipalId,
    conversationId: turn.conversationId,
    idempotencyKey: turn.idempotencyKey,
    content: turn.content,
  }));
}

function policyReferenceFields(operation, ownerPrincipalId, decidedAt) {
  return Object.freeze({
    kind: 'reina_authorization_reference',
    policyVersion: AUTHORIZATION_POLICY_VERSION,
    operation,
    ownerPrincipalId,
    decidedAt,
  });
}

function authorizeExact(actingContext, operation) {
  const decision = decideAuthorization(actingContext, operation);
  if (!isAuthorizedDecisionFor(decision, actingContext, operation)) return null;
  const decidedAt = new Date().toISOString();
  const fields = policyReferenceFields(operation, actingContext.principalId, decidedAt);
  return Object.freeze({
    policyVersion: fields.policyVersion,
    operation: fields.operation,
    ownerPrincipalId: fields.ownerPrincipalId,
    decidedAt: fields.decidedAt,
    decisionReference: canonicalDigest(fields),
  });
}

function snapshotPolicyReference(value, operation, ownerPrincipalId) {
  const snapshot = dataRecord(value, {
    required: ['policyVersion', 'operation', 'ownerPrincipalId', 'decidedAt', 'decisionReference'],
  });
  if (!snapshot) return null;
  const { policyVersion, decidedAt, decisionReference } = snapshot.values;
  if (policyVersion !== AUTHORIZATION_POLICY_VERSION
    || snapshot.values.operation !== operation
    || snapshot.values.ownerPrincipalId !== ownerPrincipalId
    || typeof decidedAt !== 'string'
    || typeof decisionReference !== 'string'
    || !DIGEST_PATTERN.test(decisionReference)) return null;
  const parsedTime = Date.parse(decidedAt);
  if (!Number.isFinite(parsedTime) || new Date(parsedTime).toISOString() !== decidedAt) return null;
  if (decisionReference !== canonicalDigest(policyReferenceFields(operation, ownerPrincipalId, decidedAt))) return null;
  return Object.freeze({
    policyVersion,
    operation,
    ownerPrincipalId,
    decidedAt,
    decisionReference,
  });
}

function fixedOutcome(turn, reasonCode, turnState, patch = {}) {
  const success = reasonCode === REASON.STORED || reasonCode === REASON.REPLAYED;
  return Object.freeze({
    allowed: success,
    reasonCode,
    turnState,
    conversationId: turn?.conversationId || null,
    idempotencyKey: turn?.idempotencyKey || null,
    persisted: success,
    replayed: reasonCode === REASON.REPLAYED,
    modelInvoked: patch.modelInvoked === true,
    toolExecutionAllowed: false,
    businessActionAllowed: false,
    automationTaskAllowed: false,
    assistantMessage: patch.assistantMessage || null,
    resultReference: patch.resultReference || null,
  });
}

function findDataMethod(store, methodName) {
  let cursor = store;
  while (cursor && cursor !== Object.prototype) {
    if (isProxy(cursor)) return null;
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(cursor, methodName);
    } catch {
      return null;
    }
    if (descriptor) {
      if (!hasOwn(descriptor, 'value')
        || typeof descriptor.value !== 'function'
        || isProxy(descriptor.value)) return null;
      const method = descriptor.value;
      return (...args) => Reflect.apply(method, store, args);
    }
    try {
      cursor = Object.getPrototypeOf(cursor);
    } catch {
      return null;
    }
  }
  return null;
}

function bindStore(store) {
  if (store === null || typeof store !== 'object' || isProxy(store)) return null;
  const methods = Object.create(null);
  for (const methodName of DURABLE_STORE_METHODS) {
    const method = findDataMethod(store, methodName);
    if (!method) return null;
    methods[methodName] = method;
  }
  return Object.freeze(methods);
}

function denseArrayValues(value, maximumLength) {
  if (isProxy(value)) return null;
  let descriptors;
  let ownKeys;
  try {
    if (!Array.isArray(value)) return null;
    descriptors = Object.getOwnPropertyDescriptors(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength) return null;
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  if (ownKeys.length !== expected.size || ownKeys.some(key => typeof key !== 'string' || !expected.has(key))) return null;
  const values = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !hasOwn(descriptor, 'value')) return null;
    values.push(descriptor.value);
  }
  return values;
}

function persistedMessage(value, expectedRole = null) {
  const snapshot = dataRecord(value, {
    required: ['messageId', 'sequence', 'role', 'content', 'contentDigest'],
  });
  if (!snapshot) return null;
  const { messageId, sequence, role, content, contentDigest } = snapshot.values;
  const normalized = normalizeContent(content);
  if (!safeIdentifier(messageId)
    || !Number.isSafeInteger(sequence)
    || sequence < 1
    || (role !== 'user' && role !== 'assistant')
    || (expectedRole !== null && role !== expectedRole)
    || normalized === null
    || normalized !== content
    || typeof contentDigest !== 'string'
    || !DIGEST_PATTERN.test(contentDigest)
    || canonicalDigest(content) !== contentDigest) return null;
  return Object.freeze({ messageId, sequence, role, content, contentDigest });
}

function conversationScope(value, ownerPrincipalId, conversationId) {
  const snapshot = dataRecord(value, {
    required: ['ownerPrincipalId', 'conversationId'],
  });
  if (!snapshot
    || snapshot.values.ownerPrincipalId !== ownerPrincipalId
    || snapshot.values.conversationId !== conversationId) return null;
  return Object.freeze({ ownerPrincipalId, conversationId });
}

function parseLoadResult(value, ownerPrincipalId, conversationId) {
  const snapshot = dataRecord(value, {
    required: ['status'],
    optional: ['conversation'],
  });
  if (!snapshot || typeof snapshot.values.status !== 'string') return null;
  if (snapshot.values.status === 'not_found' && snapshot.keys.length === 1) return Object.freeze({ status: 'not_found' });
  if (snapshot.values.status !== 'found' || !hasDataKey(snapshot, 'conversation') || snapshot.keys.length !== 2) return null;
  const conversation = conversationScope(snapshot.values.conversation, ownerPrincipalId, conversationId);
  return conversation ? Object.freeze({ status: 'found', conversation }) : null;
}

function parseCreateResult(value, ownerPrincipalId, conversationId) {
  const snapshot = dataRecord(value, {
    required: ['status'],
    optional: ['conversation'],
  });
  if (!snapshot || typeof snapshot.values.status !== 'string') return null;
  if (snapshot.values.status === 'exists' && snapshot.keys.length === 1) return Object.freeze({ status: 'exists' });
  if (snapshot.values.status !== 'created' || !hasDataKey(snapshot, 'conversation') || snapshot.keys.length !== 2) return null;
  const conversation = conversationScope(snapshot.values.conversation, ownerPrincipalId, conversationId);
  return conversation ? Object.freeze({ status: 'created', conversation }) : null;
}

function parseClaimResult(value) {
  const snapshot = dataRecord(value, {
    required: ['status'],
    optional: ['claimId', 'progress', 'result'],
  });
  if (!snapshot || typeof snapshot.values.status !== 'string') return null;
  const { status } = snapshot.values;
  if ((status === 'claimed' || status === 'resumed')
    && snapshot.keys.length === 3
    && hasDataKey(snapshot, 'claimId')
    && hasDataKey(snapshot, 'progress')
    && safeIdentifier(snapshot.values.claimId)
    && ['claimed', 'user_persisted'].includes(snapshot.values.progress)
    && (status !== 'claimed' || snapshot.values.progress === 'claimed')) {
    return Object.freeze({ status, claimId: snapshot.values.claimId, progress: snapshot.values.progress });
  }
  if (status === 'replay' && snapshot.keys.length === 2 && hasDataKey(snapshot, 'result')) {
    return Object.freeze({ status, result: snapshot.values.result });
  }
  if (['conflict', 'in_flight', 'incomplete', 'failed'].includes(status) && snapshot.keys.length === 1) {
    return Object.freeze({ status });
  }
  return null;
}

function parseUserAppendResult(value, ownerPrincipalId, conversationId, expectedContent, expectedDigest, expectedStatus) {
  const snapshot = dataRecord(value, {
    required: ['status', 'ownerPrincipalId', 'conversationId', 'message'],
  });
  if (!snapshot
    || snapshot.values.status !== expectedStatus
    || snapshot.values.ownerPrincipalId !== ownerPrincipalId
    || snapshot.values.conversationId !== conversationId) return null;
  const message = persistedMessage(snapshot.values.message, 'user');
  if (!message || message.content !== expectedContent || message.contentDigest !== expectedDigest) return null;
  return Object.freeze({ status: snapshot.values.status, message });
}

function parseHistoryResult(value, ownerPrincipalId, conversationId, expectedUserMessage) {
  const snapshot = dataRecord(value, {
    required: ['status', 'ownerPrincipalId', 'conversationId', 'messages'],
  });
  if (!snapshot
    || snapshot.values.status !== 'loaded'
    || snapshot.values.ownerPrincipalId !== ownerPrincipalId
    || snapshot.values.conversationId !== conversationId) return null;
  const rawMessages = denseArrayValues(snapshot.values.messages, LIMITS.historyMessages);
  if (!rawMessages || rawMessages.length === 0) return null;

  const messages = [];
  const ids = new Set();
  let totalBytes = 0;
  for (let index = 0; index < rawMessages.length; index += 1) {
    const expectedRole = index % 2 === 0 ? 'user' : 'assistant';
    const message = persistedMessage(rawMessages[index], expectedRole);
    if (!message
      || ids.has(message.messageId)
      || message.sequence !== index + 1) return null;
    ids.add(message.messageId);
    totalBytes += Buffer.byteLength(message.content, 'utf8');
    if (totalBytes > LIMITS.historyBytes) return null;
    messages.push(message);
  }

  const current = messages.at(-1);
  if (messages.length % 2 !== 1
    || current.messageId !== expectedUserMessage.messageId
    || current.sequence !== expectedUserMessage.sequence
    || current.role !== 'user'
    || current.content !== expectedUserMessage.content
    || current.contentDigest !== expectedUserMessage.contentDigest) return null;
  return Object.freeze(messages);
}

function storedResult(value, expected) {
  const snapshot = dataRecord(value, {
    required: [
      'ownerPrincipalId',
      'conversationId',
      'idempotencyKey',
      'inputDigest',
      'userMessageId',
      'userMessageSequence',
      'assistantMessage',
      'resultReference',
      'policyReference',
    ],
  });
  if (!snapshot) return null;
  const assistantMessage = persistedMessage(snapshot.values.assistantMessage, 'assistant');
  const policyReference = snapshotPolicyReference(
    snapshot.values.policyReference,
    REINA_OPERATION.CONVERSATION_APPEND,
    expected.ownerPrincipalId,
  );
  if (!assistantMessage
    || !policyReference
    || snapshot.values.ownerPrincipalId !== expected.ownerPrincipalId
    || snapshot.values.conversationId !== expected.conversationId
    || snapshot.values.idempotencyKey !== expected.idempotencyKey
    || snapshot.values.inputDigest !== expected.inputDigest
    || !safeIdentifier(snapshot.values.userMessageId)
    || !Number.isSafeInteger(snapshot.values.userMessageSequence)
    || snapshot.values.userMessageSequence < 1
    || assistantMessage.messageId === snapshot.values.userMessageId
    || assistantMessage.sequence !== snapshot.values.userMessageSequence + 1
    || !safeIdentifier(snapshot.values.resultReference)) return null;
  if (expected.userMessage
    && (snapshot.values.userMessageId !== expected.userMessage.messageId
      || snapshot.values.userMessageSequence !== expected.userMessage.sequence)) return null;
  if (expected.assistantContent !== undefined
    && (assistantMessage.content !== expected.assistantContent
      || assistantMessage.contentDigest !== expected.assistantContentDigest)) return null;
  return Object.freeze({
    ownerPrincipalId: snapshot.values.ownerPrincipalId,
    conversationId: snapshot.values.conversationId,
    idempotencyKey: snapshot.values.idempotencyKey,
    inputDigest: snapshot.values.inputDigest,
    userMessageId: snapshot.values.userMessageId,
    userMessageSequence: snapshot.values.userMessageSequence,
    assistantMessage,
    resultReference: snapshot.values.resultReference,
    policyReference,
  });
}

function parseCompletionResult(value, expected) {
  const snapshot = dataRecord(value, {
    required: ['status', 'result'],
  });
  if (!snapshot || snapshot.values.status !== 'completed') return null;
  const result = storedResult(snapshot.values.result, expected);
  return result ? Object.freeze({ status: 'completed', result }) : null;
}

async function recordFailure(methods, input) {
  try {
    const result = await methods.markTurnFailed(Object.freeze(input));
    const snapshot = dataRecord(result, {
      required: ['status'],
      optional: ['state'],
    });
    if (!snapshot) return 'incomplete';
    if (snapshot.values.status === 'recorded') {
      return snapshot.keys.length === 2
        && ['failed_retryable', 'failed_terminal'].includes(snapshot.values.state)
        ? snapshot.values.state
        : 'incomplete';
    }
    return 'incomplete';
  } catch {
    return 'incomplete';
  }
}

async function prepareConversation(methods, actingContext, ownerPrincipalId, conversationId, mustExist) {
  const readReference = authorizeExact(actingContext, REINA_OPERATION.CONVERSATION_READ);
  if (!readReference) return Object.freeze({ reasonCode: REASON.UNAUTHORIZED, failureStage: 'conversation_authorization' });
  let loaded;
  try {
    loaded = parseLoadResult(
      await methods.loadConversation(Object.freeze({ ownerPrincipalId, conversationId, policyReference: readReference })),
      ownerPrincipalId,
      conversationId,
    );
  } catch {
    loaded = null;
  }
  if (!loaded) return Object.freeze({ reasonCode: REASON.LOAD_FAILED, failureStage: 'conversation_load' });
  if (loaded.status === 'found') return Object.freeze({ conversation: loaded.conversation });
  if (mustExist) return Object.freeze({ reasonCode: REASON.LOAD_FAILED, failureStage: 'conversation_load' });

  const createReference = authorizeExact(actingContext, REINA_OPERATION.CONVERSATION_CREATE);
  if (!createReference) return Object.freeze({ reasonCode: REASON.UNAUTHORIZED, failureStage: 'conversation_authorization' });
  let created;
  try {
    created = parseCreateResult(
      await methods.createConversation(Object.freeze({ ownerPrincipalId, conversationId, policyReference: createReference })),
      ownerPrincipalId,
      conversationId,
    );
  } catch {
    created = null;
  }
  if (!created) return Object.freeze({ reasonCode: REASON.CREATE_FAILED, failureStage: 'conversation_create' });
  if (created.status === 'created') return Object.freeze({ conversation: created.conversation });

  const raceReadReference = authorizeExact(actingContext, REINA_OPERATION.CONVERSATION_READ);
  if (!raceReadReference) return Object.freeze({ reasonCode: REASON.UNAUTHORIZED, failureStage: 'conversation_authorization' });
  try {
    loaded = parseLoadResult(
      await methods.loadConversation(Object.freeze({ ownerPrincipalId, conversationId, policyReference: raceReadReference })),
      ownerPrincipalId,
      conversationId,
    );
  } catch {
    loaded = null;
  }
  return loaded?.status === 'found'
    ? Object.freeze({ conversation: loaded.conversation })
    : Object.freeze({ reasonCode: REASON.LOAD_FAILED, failureStage: 'conversation_load' });
}

// Atomic store contract:
// - loadConversation/createConversation are always principal-owner scoped;
//   every locator is data only and every policy reference is metadata only.
// - claimTurn runs before any persistence, serializes one unresolved head for
//   each owner+conversation, and atomically returns claimed/resumed/replay/
//   conflict/in_flight/incomplete/failed. Every claimed or resumed attempt gets
//   a fresh claimId fencing token. Progress `claimed` requires one appended user;
//   resumed `user_persisted` requires an existing conversation and user echo.
// - appendUserMessageOnce is idempotent by owner+conversation+key+digest and
//   compare-and-sets the current claimId fencing token.
// - appendAssistantAndCompleteTurn atomically appends the ordered assistant
//   message and records the immutable replay result in the same transaction,
//   compare-and-setting the current claimId fencing token.
// - loadHistory returns the complete owner-scoped sequence through the current
//   user: completed user/assistant pairs followed by that one persisted user.
// - markTurnFailed compare-and-sets that token and never downgrades completion.
export class DisabledConversationStore {
  async loadConversation() { throw new Error(REASON.DISABLED); }
  async createConversation() { throw new Error(REASON.DISABLED); }
  async claimTurn() { throw new Error(REASON.DISABLED); }
  async appendUserMessageOnce() { throw new Error(REASON.DISABLED); }
  async loadHistory() { throw new Error(REASON.DISABLED); }
  async appendAssistantAndCompleteTurn() { throw new Error(REASON.DISABLED); }
  async markTurnFailed() { throw new Error(REASON.DISABLED); }
}

export async function appendDurableTurn(options) {
  const optionSnapshot = options === undefined
    ? Object.freeze({ keys: Object.freeze([]), values: Object.freeze(Object.create(null)) })
    : dataRecord(options, {
      optional: ['enabled', 'actingContext', 'turn', 'store', 'generate'],
    });
  if (!optionSnapshot) return fixedOutcome(null, REASON.INVALID, 'invalid');
  if (optionSnapshot.values.enabled !== true) return fixedOutcome(null, REASON.DISABLED, 'disabled');

  const turn = snapshotTurn(optionSnapshot.values.turn);
  if (!turn) return fixedOutcome(null, REASON.INVALID, 'invalid');
  const store = bindStore(optionSnapshot.values.store);
  const generate = optionSnapshot.values.generate;
  if (!store || typeof generate !== 'function' || isProxy(generate)) {
    return fixedOutcome(turn, REASON.STORE_INVALID, 'invalid');
  }

  const actingContext = optionSnapshot.values.actingContext;
  const pilotReference = authorizeExact(actingContext, REINA_OPERATION.PILOT_ACCESS);
  if (!pilotReference) return fixedOutcome(turn, REASON.UNAUTHORIZED, 'denied');
  const ownerPrincipalId = actingContext.principalId;
  const inputDigest = turnPayloadDigest(ownerPrincipalId, turn);

  const claimAppendReference = authorizeExact(actingContext, REINA_OPERATION.CONVERSATION_APPEND);
  const replayReadReference = authorizeExact(actingContext, REINA_OPERATION.CONVERSATION_READ);
  if (!claimAppendReference || !replayReadReference) return fixedOutcome(turn, REASON.UNAUTHORIZED, 'denied');
  let claim;
  try {
    claim = parseClaimResult(await store.claimTurn(Object.freeze({
      ownerPrincipalId,
      conversationId: turn.conversationId,
      idempotencyKey: turn.idempotencyKey,
      inputDigest,
      appendPolicyReference: claimAppendReference,
      replayReadPolicyReference: replayReadReference,
    })));
  } catch {
    claim = null;
  }
  if (!claim) return fixedOutcome(turn, REASON.CLAIM_FAILED, 'claim_failed');
  if (claim.status === 'conflict') return fixedOutcome(turn, REASON.CONFLICT, 'conflict');
  if (claim.status === 'in_flight') return fixedOutcome(turn, REASON.IN_FLIGHT, 'in_flight');
  if (claim.status === 'incomplete') return fixedOutcome(turn, REASON.INCOMPLETE, 'incomplete');
  if (claim.status === 'failed') return fixedOutcome(turn, REASON.PREVIOUS_FAILED, 'failed');
  if (claim.status === 'replay') {
    let replay;
    try {
      replay = storedResult(claim.result, {
        ownerPrincipalId,
        conversationId: turn.conversationId,
        idempotencyKey: turn.idempotencyKey,
        inputDigest,
      });
    } catch {
      replay = null;
    }
    return replay
      ? fixedOutcome(turn, REASON.REPLAYED, 'completed', {
        assistantMessage: replay.assistantMessage,
        resultReference: replay.resultReference,
      })
      : fixedOutcome(turn, REASON.CLAIM_FAILED, 'claim_failed');
  }

  const claimId = claim.claimId;
  const failureBase = Object.freeze({
    ownerPrincipalId,
    conversationId: turn.conversationId,
    idempotencyKey: turn.idempotencyKey,
    inputDigest,
    claimId,
  });

  const userWasPersisted = claim.status === 'resumed' && claim.progress === 'user_persisted';
  const prepared = await prepareConversation(
    store,
    actingContext,
    ownerPrincipalId,
    turn.conversationId,
    userWasPersisted,
  );
  if (!prepared.conversation) {
    const failureState = await recordFailure(store, {
      ...failureBase,
      stage: prepared.failureStage,
      reasonCode: prepared.reasonCode,
      policyReference: claimAppendReference,
    });
    return fixedOutcome(turn, prepared.reasonCode, failureState);
  }

  const userReference = authorizeExact(actingContext, REINA_OPERATION.CONVERSATION_APPEND);
  if (!userReference) {
    const failureState = await recordFailure(store, { ...failureBase, stage: 'user_authorization', reasonCode: REASON.UNAUTHORIZED, policyReference: claimAppendReference });
    return fixedOutcome(turn, REASON.UNAUTHORIZED, failureState);
  }
  const userContentDigest = canonicalDigest(turn.content);
  let userAppend;
  try {
    userAppend = parseUserAppendResult(
      await store.appendUserMessageOnce(Object.freeze({
        ...failureBase,
        content: turn.content,
        contentDigest: userContentDigest,
        policyReference: userReference,
      })),
      ownerPrincipalId,
      turn.conversationId,
      turn.content,
      userContentDigest,
      userWasPersisted ? 'existing' : 'appended',
    );
  } catch {
    userAppend = null;
  }
  if (!userAppend) {
    const failureState = await recordFailure(store, { ...failureBase, stage: 'user_persist', reasonCode: REASON.USER_FAILED, policyReference: userReference });
    return fixedOutcome(turn, REASON.USER_FAILED, failureState);
  }

  const historyReference = authorizeExact(actingContext, REINA_OPERATION.CONVERSATION_READ);
  if (!historyReference) {
    const failureState = await recordFailure(store, { ...failureBase, stage: 'history_authorization', reasonCode: REASON.UNAUTHORIZED, policyReference: userReference });
    return fixedOutcome(turn, REASON.UNAUTHORIZED, failureState);
  }
  let history;
  try {
    history = parseHistoryResult(
      await store.loadHistory(Object.freeze({
        ownerPrincipalId,
        conversationId: turn.conversationId,
        throughMessageId: userAppend.message.messageId,
        policyReference: historyReference,
      })),
      ownerPrincipalId,
      turn.conversationId,
      userAppend.message,
    );
  } catch {
    history = null;
  }
  if (!history) {
    const failureState = await recordFailure(store, { ...failureBase, stage: 'history_load', reasonCode: REASON.HISTORY_FAILED, policyReference: userReference });
    return fixedOutcome(turn, REASON.HISTORY_FAILED, failureState);
  }

  let assistantContent;
  try {
    assistantContent = normalizeContent(await generate(Object.freeze({ messages: history, tools: EMPTY_TOOLS })));
  } catch {
    assistantContent = null;
  }
  if (assistantContent === null) {
    const failureState = await recordFailure(store, { ...failureBase, stage: 'model', reasonCode: REASON.MODEL_FAILED, policyReference: userReference });
    return fixedOutcome(turn, REASON.MODEL_FAILED, failureState, { modelInvoked: true });
  }

  const assistantReference = authorizeExact(actingContext, REINA_OPERATION.CONVERSATION_APPEND);
  if (!assistantReference) {
    const failureState = await recordFailure(store, { ...failureBase, stage: 'assistant_authorization', reasonCode: REASON.UNAUTHORIZED, policyReference: userReference });
    return fixedOutcome(turn, REASON.UNAUTHORIZED, failureState, { modelInvoked: true });
  }
  const assistantContentDigest = canonicalDigest(assistantContent);
  let completion;
  try {
    completion = parseCompletionResult(
      await store.appendAssistantAndCompleteTurn(Object.freeze({
        ...failureBase,
        userMessageId: userAppend.message.messageId,
        userMessageSequence: userAppend.message.sequence,
        content: assistantContent,
        contentDigest: assistantContentDigest,
        policyReference: assistantReference,
      })),
      {
        ownerPrincipalId,
        conversationId: turn.conversationId,
        idempotencyKey: turn.idempotencyKey,
        inputDigest,
        userMessage: userAppend.message,
        assistantContent,
        assistantContentDigest,
      },
    );
  } catch {
    completion = null;
  }
  if (!completion) {
    const failureState = await recordFailure(store, { ...failureBase, stage: 'assistant_persist', reasonCode: REASON.ASSISTANT_FAILED, policyReference: assistantReference });
    return fixedOutcome(turn, REASON.ASSISTANT_FAILED, failureState, { modelInvoked: true });
  }

  return fixedOutcome(turn, REASON.STORED, 'completed', {
    modelInvoked: true,
    assistantMessage: completion.result.assistantMessage,
    resultReference: completion.result.resultReference,
  });
}

export const _internals = Object.freeze({ canonicalize });
