import { createHash, randomBytes } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import { resolveActingContext } from './_lib/reina/acting-context.js';
import {
  REINA_OPERATION,
  decideAuthorization,
  isAuthorizedDecisionFor,
} from './_lib/reina/authorization.js';
import { buildEnvelope } from './_lib/reina/evidence-envelope.js';
import { ATTENTION_JOB_NUMBERS, PREVIEW_NOW } from './_lib/reina-preview-fixtures.js';
import {
  createSavedTurn,
  parseSavedTurn,
} from './_lib/reina/pilot-saved-turn.js';
import {
  buildActionRefusalEnvelope,
  isActionSeekingText,
} from './_lib/reina/pilot-action-boundary.js';
import {
  consumeSyntheticPilotReceipt,
  createSyntheticPilotComposer,
  isSyntheticPilotComposer,
} from './_lib/reina/pilot-synthetic-composer.js';
import {
  consumeIntelligencePilotReceipt,
  createIntelligencePilotComposer,
  isIntelligencePilotComposer,
} from './_lib/reina/pilot-intelligence-composer.js';
import {
  SERVER_DEADLINE,
  createBoundedConversationStore,
  createBoundedReviewIntentStore,
  createPilotServerDeadline,
  isReinaPilotDeadlineError,
} from './_lib/reina/pilot-server-deadline.js';
import { createSupabaseConversationStore } from './_lib/reina/supabase-conversation-store.js';
import {
  REASON as DURABLE_REASON,
  appendDurableTurn,
} from '../reina/runtime/durable-conversation-core.js';

export const PILOT_SESSION_PREFIX = 'rp.';
const SYNTHETIC_ATTENTION_JOB_NUMBERS = Object.freeze(
  ATTENTION_JOB_NUMBERS.map((value) => `${value}`),
);

const REQUEST_KEYS = Object.freeze([
  'utterance', 'conversationId', 'turnId', 'idempotencyKey', 'transport',
]);
const CONFIRM_REVIEW_REQUEST_KEYS = Object.freeze(['action', 'intentId']);
const CONFIRM_REVIEW_ACTION = 'confirm_review';
const MESSAGE_KEYS = Object.freeze([
  'messageId', 'sequence', 'role', 'content', 'contentDigest',
]);
const ISSUED_REVIEW_KEYS = Object.freeze(['status', 'review', 'uiIntent']);
const REVIEW_KEYS = Object.freeze(['intentId', 'available', 'expiresAt']);
const UI_INTENT_KEYS = Object.freeze([
  'version', 'executed', 'requiresConfirmation', 'conversationId', 'turnId',
  'intentId', 'expiresAt', 'kind', 'destination', 'parameters',
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const IDEMPOTENCY_PATTERN = /^rt\.[a-f0-9]{64}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const UNSAFE_TEXT_PATTERN = /[\p{Cf}\p{Cs}]/u;
const MAX_UTTERANCE_CHARACTERS = 4_000;
const DEFAULT_SYNTHETIC_COMPOSER = createSyntheticPilotComposer();

function isProxy(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && utilTypes.isProxy(value);
}

function dataRecord(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || isProxy(value)) return null;
  try {
    if (Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const out = Object.create(null);
    for (const key of required) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      out[key] = descriptor.value;
    }
    for (const key of optional) {
      const descriptor = descriptors[key];
      if (!descriptor) continue;
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      out[key] = descriptor.value;
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
}

function secure(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
}

function enabled(env) {
  const governedStackConfigured = env.REINA_PILOT_ENABLED === 'true'
    && env.REINA_ACTING_CONTEXT_ENABLED === 'true'
    && env.REINA_DURABLE_CONVERSATIONS_ENABLED === 'true';
  if (env.VERCEL_ENV === 'production') {
    return governedStackConfigured && env.REINA_PILOT_PRODUCTION_ENABLED === 'true';
  }
  if (env.VERCEL_ENV !== 'preview' && env.NODE_ENV !== 'test') return false;
  // Preserve the already-approved protected-preview switch while the three
  // governed switches remain the only route to production activation.
  return governedStackConfigured || env.REINA_PREVIEW_ENABLED === 'true';
}

function actingContextEnvironment(env) {
  if (env.VERCEL_ENV !== 'preview' || env.REINA_PREVIEW_ENABLED !== 'true'
    || env.REINA_ACTING_CONTEXT_ENABLED === 'true') return env;
  // The legacy preview switch may enable ActingContext only inside this
  // protected, read-only route. It cannot affect production or another API.
  return Object.freeze({ ...env, REINA_ACTING_CONTEXT_ENABLED: 'true' });
}

function unavailable(res, status, error = 'unavailable') {
  return res.status(status).json({
    ok: false,
    enabled: false,
    stored: false,
    executed: false,
    nothingExecuted: true,
    businessActionAllowed: false,
    automationTaskAllowed: false,
    toolExecutionAllowed: false,
    error,
  });
}

function normalizeUtterance(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_UTTERANCE_CHARACTERS
    || value.trim() === '') return null;
  let normalized;
  try { normalized = value.replace(/\r\n?/g, '\n').normalize('NFC'); } catch { return null; }
  if (UNSAFE_TEXT_PATTERN.test(normalized)
    || /[\p{Cc}]/u.test(normalized.replace(/[\t\n]/g, ''))) return null;
  return normalized;
}

function lengthPart(value) {
  return `${value.length}:${value}`;
}

function canonicalIdempotencyKey({ conversationId, turnId }) {
  if (typeof conversationId !== 'string'
    || typeof turnId !== 'string') return null;
  const material = `reina-pilot-idem-v3|${lengthPart(conversationId)}|${lengthPart(turnId)}`;
  return `rt.${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

function authorizationToken(req) {
  let value;
  try {
    value = req?.headers?.authorization;
  } catch {
    return null;
  }
  if (typeof value !== 'string' || value.length < 8 || value.length > 16_391 || /[\r\n]/u.test(value)) return null;
  const match = /^Bearer ([^\s]+)$/u.exec(value);
  return match && match[1].length <= 16_384 ? match[1] : null;
}

function sessionCorrelationId(req, principalId) {
  const token = authorizationToken(req);
  if (!token || typeof principalId !== 'string' || !IDENTIFIER_PATTERN.test(principalId)) return null;
  // Only this one-way, bounded correlation leaves the server. The bearer token
  // and profile identity are never returned, logged, persisted, or forwarded.
  const material = `reina-pilot-session-v2|${lengthPart(principalId)}`;
  return `${PILOT_SESSION_PREFIX}${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

function requestSnapshot(body, expectedConversationId) {
  const request = dataRecord(body, REQUEST_KEYS);
  if (!request) return null;
  if (typeof request.utterance !== 'string'
    || typeof request.conversationId !== 'string'
    || typeof request.turnId !== 'string'
    || typeof request.idempotencyKey !== 'string'
    || typeof request.transport !== 'string') return null;
  const utterance = normalizeUtterance(request.utterance);
  if (utterance === null
    || typeof expectedConversationId !== 'string'
    || request.conversationId !== expectedConversationId
    || !IDENTIFIER_PATTERN.test(request.turnId)
    || !IDEMPOTENCY_PATTERN.test(request.idempotencyKey)
    || (request.transport !== 'typed' && request.transport !== 'voice')
    || request.idempotencyKey !== canonicalIdempotencyKey(request)) return null;
  return Object.freeze({
    utterance,
    conversationId: expectedConversationId,
    turnId: request.turnId,
    idempotencyKey: request.idempotencyKey,
    transport: request.transport,
  });
}

function confirmReviewSnapshot(body) {
  const request = dataRecord(body, CONFIRM_REVIEW_REQUEST_KEYS);
  if (!request
    || request.action !== CONFIRM_REVIEW_ACTION
    || typeof request.intentId !== 'string'
    || !IDENTIFIER_PATTERN.test(request.intentId)
    || !request.intentId.startsWith('rui.')) return null;
  return Object.freeze({ action: CONFIRM_REVIEW_ACTION, intentId: request.intentId });
}

function canonicalNow(nowImpl) {
  let value;
  try { value = typeof nowImpl === 'function' ? nowImpl() : new Date().toISOString(); } catch { return null; }
  if (value instanceof Date) {
    try { value = value.toISOString(); } catch { return null; }
  }
  if (typeof value !== 'string') return null;
  const built = buildEnvelope({ answer: 'Time validation.', freshness: { known: true, asOf: value } });
  return built.ok ? value : null;
}

function historySnapshot(messages, tools, currentText) {
  if (!Object.isFrozen(tools) || !Array.isArray(tools) || tools.length !== 0
    || !Object.isFrozen(messages) || !Array.isArray(messages)
    || messages.length === 0 || messages.length % 2 !== 1 || messages.length > 200) return null;
  const safeHistory = [];
  let previousSavedTurn = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = dataRecord(messages[index], MESSAGE_KEYS);
    if (!message
      || !IDENTIFIER_PATTERN.test(message.messageId)
      || message.sequence !== index + 1
      || message.role !== (index % 2 === 0 ? 'user' : 'assistant')
      || typeof message.content !== 'string'
      || !DIGEST_PATTERN.test(message.contentDigest)) return null;
    if (message.role === 'assistant') {
      const parsed = parseSavedTurn(message.content);
      if (!parsed) return null;
      previousSavedTurn = index === messages.length - 2 ? parsed : null;
      safeHistory.push(Object.freeze({
        role: 'assistant',
        text: parsed.plainText,
        envelope: parsed.envelope,
        reviewOfferPending: parsed.reviewOffer !== null,
      }));
    } else {
      safeHistory.push(Object.freeze({ role: 'user', text: message.content }));
    }
  }
  const last = safeHistory.at(-1);
  if (!last || last.role !== 'user' || last.text !== currentText) return null;
  return Object.freeze({
    messages: Object.freeze(safeHistory),
    previousSavedTurn,
  });
}

function sameCanonicalValue(left, right) {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

async function savedMatchesRoutePolicy(saved, request, answerComposer) {
  if (!saved || !Array.isArray(saved.envelope?.evidence)
    || saved.envelope.evidence.length === 0) return false;
  if (saved.navigation !== null || saved.reviewOffer !== null) return false;

  if (isActionSeekingText(request.utterance)) {
    return saved.reviewOffer === null
      && sameCanonicalValue(saved.envelope, buildActionRefusalEnvelope());
  }

  if (isIntelligencePilotComposer(answerComposer)) {
    const allowedSources = new Set([
      'hivelogic_read_only_bridge', 'public_web_read', 'model_response', 'local_conversation_response',
    ]);
    return saved.envelope.executed === false
      && saved.envelope.refused === false
      && saved.envelope.evidence.every((entry) => allowedSources.has(entry?.sourceType)
        && (entry?.dataClass === 'authorized_read' || entry?.dataClass === 'synthetic'));
  }

  if (saved.envelope.evidence.some((entry) => entry?.dataClass !== 'synthetic')) return false;

  let receipt;
  try {
    receipt = consumeSyntheticPilotReceipt(await answerComposer(Object.freeze({
      utterance: request.utterance,
      history: Object.freeze([]),
    })));
  } catch {
    receipt = null;
  }
  if (!receipt || !sameCanonicalValue(saved.envelope, receipt.envelope)) return false;
  return receipt.offerReview === false;
}

function accessFor(envelope) {
  let synthetic = false;
  let authorized = false;
  for (const evidence of envelope.evidence) {
    if (evidence.dataClass === 'synthetic') synthetic = true;
    if (evidence.dataClass === 'authorized_read') authorized = true;
  }
  if (synthetic && authorized) return Object.freeze({ synthetic: true, dataAccess: 'mixed' });
  if (synthetic) return Object.freeze({ synthetic: true, dataAccess: 'synthetic' });
  if (authorized) return Object.freeze({ synthetic: false, dataAccess: 'authorized_read' });
  return Object.freeze({ synthetic: false, dataAccess: 'none' });
}

function successBody(request, outcome, saved) {
  const access = accessFor(saved.envelope);
  return {
    ok: true,
    enabled: true,
    stored: true,
    conversationId: request.conversationId,
    turnId: request.turnId,
    idempotencyKey: request.idempotencyKey,
    replayed: outcome.replayed === true,
    executed: false,
    nothingExecuted: true,
    businessActionAllowed: false,
    automationTaskAllowed: false,
    toolExecutionAllowed: false,
    synthetic: access.synthetic,
    dataAccess: access.dataAccess,
    reviewAvailable: saved.reviewOffer !== null,
    envelope: saved.envelope,
    plainText: saved.plainText,
    navigation: null,
  };
}

function confirmedReviewBody(intentId) {
  return {
    ok: true,
    confirmed: true,
    intentId,
    executed: false,
    nothingExecuted: true,
    businessActionAllowed: false,
    automationTaskAllowed: false,
    toolExecutionAllowed: false,
  };
}

function reviewPolicyReference(decision, actingContext) {
  if (!isAuthorizedDecisionFor(decision, actingContext, REINA_OPERATION.PILOT_ACCESS)) return null;
  return Object.freeze({
    kind: 'reina_ui_confirmation_policy',
    policyVersion: decision.policyVersion,
    operation: decision.operation,
    capability: decision.capability,
    resource: decision.resource,
    effect: decision.effect,
    ownerScope: decision.ownerScope,
    ownerPrincipalId: decision.ownerPrincipalId,
  });
}

function serviceHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  };
}

async function loadDisplayName(actingContext, { env, fetchImpl, signal }) {
  if (typeof env.SUPABASE_URL !== 'string'
    || typeof env.SUPABASE_SERVICE_KEY !== 'string'
    || typeof fetchImpl !== 'function') return null;
  const url = `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(actingContext.principalId)}&select=id,role,full_name&limit=2`;
  let response;
  try { response = await fetchImpl(url, { headers: serviceHeaders(env), signal }); } catch { return null; }
  if (response === null
    || (typeof response !== 'object' && typeof response !== 'function')
    || isProxy(response)) return null;
  let ok;
  try { ok = response.ok; } catch { return null; }
  if (ok !== true) return null;
  let rows;
  try {
    const json = response.json;
    if (typeof json !== 'function') return null;
    rows = await json.call(response);
  } catch { return null; }
  if (isProxy(rows) || !Array.isArray(rows) || rows.length !== 1) return null;
  const row = dataRecord(rows[0], ['id', 'role', 'full_name']);
  if (!row
    || row.id !== actingContext.principalId
    || (row.role !== 'admin' && row.role !== 'superadmin')
    || typeof row.full_name !== 'string'
    || row.full_name.length === 0
    || row.full_name.length > 120
    || row.full_name.trim() !== row.full_name
    || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(row.full_name)
    || /<[^>]*>|javascript\s*:|\bon\w+\s*=/iu.test(row.full_name)) return null;
  return row.full_name;
}

function bootstrapBody(displayName, sessionId, generatedAt, issuedReview) {
  return {
    ok: true,
    sessionId,
    generatedAt,
    executed: false,
    user: { displayName },
    attention: {
      total: SYNTHETIC_ATTENTION_JOB_NUMBERS.length,
      asOf: PREVIEW_NOW,
      reviewAvailable: true,
      categories: [
        {
          key: 'jobs',
          label: 'Synthetic jobs needing attention',
          count: SYNTHETIC_ATTENTION_JOB_NUMBERS.length,
          available: true,
          asOf: PREVIEW_NOW,
          evidence: SYNTHETIC_ATTENTION_JOB_NUMBERS.slice(),
        },
        { key: 'mail', label: 'Important email', count: null, available: false, asOf: null, evidence: [] },
        { key: 'finance', label: 'Cash and finance', count: null, available: false, asOf: null, evidence: [] },
        { key: 'weather', label: 'Schedule weather impact', count: null, available: false, asOf: null, evidence: [] },
      ],
      unavailableSources: [
        'Important email is unavailable because an owner-scoped mailbox read operation is not enabled.',
        'Cash and finance are unavailable because an exact finance capability is not present.',
        'Schedule weather impact is unavailable because no authorized schedule/location read is enabled.',
      ],
    },
    review: issuedReview.review,
    uiIntent: issuedReview.uiIntent,
  };
}

function issuedReviewSnapshot(raw, conversationId, generatedAt) {
  const issued = dataRecord(raw, ISSUED_REVIEW_KEYS);
  if (!issued || issued.status !== 'issued') return null;
  const review = dataRecord(issued.review, REVIEW_KEYS);
  const intent = dataRecord(issued.uiIntent, UI_INTENT_KEYS);
  const parameters = dataRecord(intent?.parameters, []);
  if (!review || !intent || !parameters
    || review.available !== true
    || typeof review.intentId !== 'string'
    || !IDENTIFIER_PATTERN.test(review.intentId)
    || typeof review.expiresAt !== 'string'
    || intent.version !== 'reina.ui-intent.v1'
    || intent.executed !== false
    || intent.requiresConfirmation !== true
    || intent.conversationId !== conversationId
    || typeof intent.turnId !== 'string'
    || !IDENTIFIER_PATTERN.test(intent.turnId)
    || intent.intentId !== review.intentId
    || intent.expiresAt !== review.expiresAt
    || intent.kind !== 'navigate'
    || intent.destination !== 'standup') return null;
  const issuedAtMs = Date.parse(generatedAt);
  const expiresAtMs = Date.parse(review.expiresAt);
  if (!Number.isFinite(issuedAtMs)
    || !Number.isFinite(expiresAtMs)
    || new Date(expiresAtMs).toISOString() !== review.expiresAt
    || expiresAtMs <= issuedAtMs
    || expiresAtMs > issuedAtMs + (10 * 60 * 1000)) return null;
  return Object.freeze({
    status: 'issued',
    review: Object.freeze({
      intentId: review.intentId,
      available: true,
      expiresAt: review.expiresAt,
    }),
    uiIntent: Object.freeze({
      version: 'reina.ui-intent.v1',
      executed: false,
      requiresConfirmation: true,
      conversationId,
      turnId: intent.turnId,
      intentId: intent.intentId,
      expiresAt: intent.expiresAt,
      kind: 'navigate',
      destination: 'standup',
      parameters: Object.freeze({}),
    }),
  });
}

function createServerIssuedReview(conversationId, generatedAt) {
  try {
    if (typeof conversationId !== 'string'
      || !IDENTIFIER_PATTERN.test(conversationId)
      || typeof generatedAt !== 'string') return null;
    const issuedAtMs = Date.parse(generatedAt);
    if (!Number.isFinite(issuedAtMs)) return null;
    const token = randomBytes(16).toString('hex');
    if (!/^[a-f0-9]{32}$/u.test(token)) return null;
    const intentId = `rui.${token}`;
    const turnId = `bootstrap.${token}`;
    const expiresAt = new Date(issuedAtMs + (5 * 60 * 1000)).toISOString();
    return issuedReviewSnapshot({
      status: 'issued',
      review: { intentId, available: true, expiresAt },
      uiIntent: {
        version: 'reina.ui-intent.v1',
        executed: false,
        requiresConfirmation: true,
        conversationId,
        turnId,
        intentId,
        expiresAt,
        kind: 'navigate',
        destination: 'standup',
        parameters: {},
      },
    }, conversationId, generatedAt);
  } catch {
    return null;
  }
}

async function resolveContext(req, dependencies, env, signal) {
  try {
    return await (dependencies.resolveActingContextImpl || resolveActingContext)(req, {
      env,
      fetchImpl: dependencies.fetchImpl,
      requireUserImpl: dependencies.requireUserImpl,
      signal,
    });
  } catch {
    return null;
  }
}

function runtimeStore(dependencies, env) {
  if (Object.prototype.hasOwnProperty.call(dependencies, 'store')) return dependencies.store;
  let urlDescriptor;
  let keyDescriptor;
  try {
    urlDescriptor = Object.getOwnPropertyDescriptor(env, 'SUPABASE_URL');
    keyDescriptor = Object.getOwnPropertyDescriptor(env, 'SUPABASE_SERVICE_KEY');
  } catch {
    return null;
  }
  if (!urlDescriptor || !Object.prototype.hasOwnProperty.call(urlDescriptor, 'value')
    || !keyDescriptor || !Object.prototype.hasOwnProperty.call(keyDescriptor, 'value')
    || typeof urlDescriptor.value !== 'string' || urlDescriptor.value.length === 0
    || typeof keyDescriptor.value !== 'string' || keyDescriptor.value.length === 0) return null;
  try {
    return createSupabaseConversationStore({
      env,
      fetchImpl: dependencies.fetchImpl || fetch,
    });
  } catch {
    return null;
  }
}

export function createReinaPilotHandler(dependencies = {}) {
  const configuredComposer = Object.prototype.hasOwnProperty.call(dependencies, 'syntheticComposer')
    ? dependencies.syntheticComposer
    : null;
  return async function reinaPilotHandler(req, res) {
    secure(res);
    const env = dependencies.env || process.env;
    if (!enabled(env)) return unavailable(res, 503, 'disabled');
    if (req.method !== 'GET' && req.method !== 'POST') return unavailable(res, 405, 'method_not_allowed');
    const deadline = createPilotServerDeadline(dependencies.deadlineOptions);
    try {
      let answerComposer = configuredComposer;
      if (!answerComposer) {
        try {
          answerComposer = typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.trim()
            ? createIntelligencePilotComposer({
              env,
              fetchImpl: dependencies.intelligenceFetchImpl || fetch,
              ...(dependencies.readContextImpl ? { readContextImpl: dependencies.readContextImpl } : {}),
            })
            : DEFAULT_SYNTHETIC_COMPOSER;
        } catch {
          answerComposer = null;
        }
      }
      const rawStore = runtimeStore(dependencies, env);
      const store = rawStore && createBoundedConversationStore(rawStore, deadline, dependencies.storeDeadlineOptions);
      const reviewStore = rawStore && createBoundedReviewIntentStore(rawStore, deadline, dependencies.storeDeadlineOptions);
      if (!store || !reviewStore
        || (!isSyntheticPilotComposer(answerComposer) && !isIntelligencePilotComposer(answerComposer))) {
        return unavailable(res, 503);
      }

      let resolved;
      try {
        resolved = await deadline.run(
          signal => resolveContext(req, dependencies, actingContextEnvironment(env), signal),
          SERVER_DEADLINE.stageMs,
        );
      } catch {
        return unavailable(res, 403, 'authorization_expired');
      }
      if (!resolved?.ok || !resolved.context) return unavailable(res, 403, 'authorization_expired');
      const pilotDecision = decideAuthorization(resolved.context, REINA_OPERATION.PILOT_ACCESS);
      if (!isAuthorizedDecisionFor(pilotDecision, resolved.context, REINA_OPERATION.PILOT_ACCESS)) {
        return unavailable(res, 403, 'authorization_expired');
      }
      const currentReviewPolicy = reviewPolicyReference(pilotDecision, resolved.context);
      if (!currentReviewPolicy) return unavailable(res, 403, 'authorization_expired');
      const sessionId = sessionCorrelationId(req, resolved.context.principalId);
      if (!sessionId) return unavailable(res, 403, 'authorization_expired');

      if (req.method === 'GET') {
        const generatedAt = canonicalNow(dependencies.now);
        if (!generatedAt) return unavailable(res, 503);
        let displayName;
        let issuedReview;
        try {
          displayName = await deadline.run(
            signal => (dependencies.loadDisplayNameImpl || loadDisplayName)(resolved.context, {
              env,
              fetchImpl: dependencies.fetchImpl || fetch,
              signal,
            }),
            SERVER_DEADLINE.stageMs,
          );
          issuedReview = createServerIssuedReview(sessionId, generatedAt);
          if (issuedReview) {
            const issued = await reviewStore.issueReviewIntent(Object.freeze({
              ownerPrincipalId: resolved.context.principalId,
              conversationId: sessionId,
              turnId: issuedReview.uiIntent.turnId,
              intentId: issuedReview.uiIntent.intentId,
              expiresAt: issuedReview.uiIntent.expiresAt,
              policyReference: currentReviewPolicy,
            }));
            if (!issued || issued.status !== 'issued'
              || issued.intentId !== issuedReview.uiIntent.intentId
              || issued.expiresAt !== issuedReview.uiIntent.expiresAt) issuedReview = null;
          }
        } catch {
          return unavailable(res, 503);
        }
        return displayName && issuedReview
          ? res.status(200).json(bootstrapBody(displayName, sessionId, generatedAt, issuedReview))
          : unavailable(res, 503);
      }

      const confirmation = confirmReviewSnapshot(req.body);
      if (confirmation) {
        let consumed;
        try {
          consumed = await reviewStore.consumeReviewIntent(Object.freeze({
            ownerPrincipalId: resolved.context.principalId,
            conversationId: sessionId,
            intentId: confirmation.intentId,
            policyReference: currentReviewPolicy,
          }));
        } catch {
          return unavailable(res, 408, 'confirmation_timeout');
        }
        if (consumed?.status === 'consumed' && consumed.intentId === confirmation.intentId) {
          return res.status(200).json(confirmedReviewBody(confirmation.intentId));
        }
        if (consumed?.status === 'duplicate') return unavailable(res, 409, 'confirmation_duplicate');
        if (consumed?.status === 'expired') return unavailable(res, 410, 'confirmation_expired');
        if (consumed?.status === 'not_found') return unavailable(res, 409, 'stale_intent');
        if (consumed?.status === 'owner_mismatch' || consumed?.status === 'policy_mismatch') {
          return unavailable(res, 403, 'authorization_expired');
        }
        return unavailable(res, 503, 'confirmation_unavailable');
      }

      const request = requestSnapshot(req.body, sessionId);
      if (!request) return unavailable(res, 400, 'invalid_request');
      const generate = async ({ messages, tools }) => deadline.run(async () => {
        const history = historySnapshot(messages, tools, request.utterance);
        if (!history) throw new Error('invalid_stored_history');
        const now = canonicalNow(dependencies.now);
        if (!now) throw new Error('invalid_server_time');

        if (isActionSeekingText(request.utterance)) {
          const saved = createSavedTurn({ envelope: buildActionRefusalEnvelope() });
          if (!saved) throw new Error('action_refusal_failed');
          return saved.serialized;
        }

        let providerResult;
        try {
          const rawProviderResult = await answerComposer(Object.freeze({
            utterance: request.utterance,
            history: history.messages,
          }));
          providerResult = isIntelligencePilotComposer(answerComposer)
            ? consumeIntelligencePilotReceipt(rawProviderResult)
            : consumeSyntheticPilotReceipt(rawProviderResult);
        } catch {
          providerResult = null;
        }
        if (!providerResult) throw new Error('answer_provider_failed');
        if (providerResult.offerReview !== false) throw new Error('review_offer_disabled');
        const saved = createSavedTurn({ envelope: providerResult.envelope });
        if (!saved) throw new Error('saved_turn_boundary_failed');
        return saved.serialized;
      }, SERVER_DEADLINE.composerMs);

      const outcome = await appendDurableTurn({
        enabled: true,
        actingContext: resolved.context,
        turn: {
          conversationId: request.conversationId,
          idempotencyKey: request.idempotencyKey,
          content: request.utterance,
        },
        store,
        generate,
      });
      if (outcome.reasonCode !== DURABLE_REASON.STORED
        && outcome.reasonCode !== DURABLE_REASON.REPLAYED) {
        const status = outcome.reasonCode === DURABLE_REASON.CONFLICT
          || outcome.reasonCode === DURABLE_REASON.IN_FLIGHT
          || outcome.reasonCode === DURABLE_REASON.INCOMPLETE
          ? 409
          : outcome.reasonCode === DURABLE_REASON.INVALID ? 400 : 503;
        return unavailable(res, status);
      }
      if (outcome.conversationId !== request.conversationId
        || outcome.idempotencyKey !== request.idempotencyKey
        || outcome.persisted !== true
        || outcome.businessActionAllowed !== false
        || outcome.automationTaskAllowed !== false
        || outcome.toolExecutionAllowed !== false
        || !outcome.assistantMessage
        || outcome.assistantMessage.role !== 'assistant') return unavailable(res, 503);
      const saved = parseSavedTurn(outcome.assistantMessage.content);
      if (!saved) return unavailable(res, 503);
      let policyMatches = false;
      try {
        policyMatches = await deadline.run(
          () => savedMatchesRoutePolicy(saved, request, answerComposer),
          SERVER_DEADLINE.composerMs,
        );
      } catch (error) {
        policyMatches = false;
        if (!isReinaPilotDeadlineError(error)) { /* fixed fail-closed response below */ }
      }
      if (!policyMatches) return unavailable(res, 503);
      return res.status(200).json(successBody(request, outcome, saved));
    } finally {
      deadline.close();
    }
  };
}

export const _internals = Object.freeze({
  accessFor,
  bootstrapBody,
  canonicalIdempotencyKey,
  confirmReviewSnapshot,
  dataRecord,
  enabled,
  historySnapshot,
  issuedReviewSnapshot,
  requestSnapshot,
  reviewPolicyReference,
  savedMatchesRoutePolicy,
  sessionCorrelationId,
});

export default createReinaPilotHandler();
