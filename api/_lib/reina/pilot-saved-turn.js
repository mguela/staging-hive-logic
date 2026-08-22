import { types as utilTypes } from 'node:util';

import {
  EXECUTION_STATEMENT,
  renderPlainText,
  validateEnvelope,
} from './evidence-envelope.js';
import { containsActionCompletionClaim } from './pilot-action-boundary.js';

export const SAVED_TURN_VERSION = 'reina.saved-turn.v1';
export const MAX_SAVED_TURN_BYTES = 180_000;
export const MAX_SAVED_ANSWER_CHARACTERS = 16_384;
export const MAX_SAVED_PLAIN_TEXT_CHARACTERS = 131_072;
export const REVIEW_OFFER_TTL_MS = 15 * 60 * 1000;
export const REVIEW_NAVIGATION = Object.freeze({
  type: 'open_view',
  target: 'standup',
  requiresExplicitUserIntent: true,
});

const SAVED_KEYS = Object.freeze([
  'version',
  'envelope',
  'plainText',
  'navigation',
  'reviewOffer',
]);
const CREATE_KEYS = Object.freeze(['envelope', 'reviewOffer', 'reviewTransition']);
const TRANSITION_INPUT_KEYS = Object.freeze([
  'previousSavedTurn', 'ownerPrincipalId', 'conversationId', 'currentText', 'now',
]);
const OFFER_INPUT_KEYS = Object.freeze([
  'offerId', 'ownerPrincipalId', 'conversationId', 'turnId', 'offeredAt', 'expiresAt',
]);
const NAVIGATION_KEYS = Object.freeze([
  'type',
  'target',
  'requiresExplicitUserIntent',
  'acceptedOfferId',
  'ownerPrincipalId',
  'conversationId',
  'acceptedAt',
]);
const ENVELOPE_KEYS = Object.freeze([
  'version',
  'answer',
  'evidence',
  'freshness',
  'missingInformation',
  'conflictingInformation',
  'uncertainty',
  'refused',
  'refusalReason',
  'executed',
  'executionStatement',
]);
const REVIEW_OFFER_KEYS = Object.freeze([
  'status',
  'target',
  'offerId',
  'ownerPrincipalId',
  'conversationId',
  'turnId',
  'offeredAt',
  'expiresAt',
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const HIDDEN_CONTROL_RE = /[\p{Cf}\p{Cs}]/u;
const reviewTransitions = new WeakMap();
const trustedSavedTurns = new WeakSet();

function isProxy(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && utilTypes.isProxy(value);
}

function exactDataRecord(value, keys) {
  if (value === null || typeof value !== 'object' || isProxy(value)) return null;
  try {
    if (Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length
      || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const values = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      values[key] = descriptor.value;
    }
    return Object.freeze(values);
  } catch {
    return null;
  }
}

function optionalDataRecord(value, required, optional) {
  if (value === null || typeof value !== 'object' || isProxy(value)) return null;
  try {
    if (Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const allowed = new Set([...required, ...optional]);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const values = Object.create(null);
    for (const key of required) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      values[key] = descriptor.value;
    }
    for (const key of optional) {
      const descriptor = descriptors[key];
      if (!descriptor) continue;
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      values[key] = descriptor.value;
    }
    return Object.freeze(values);
  } catch {
    return null;
  }
}

function byteLength(value) {
  try { return Buffer.byteLength(value, 'utf8'); } catch { return Number.POSITIVE_INFINITY; }
}

function validIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !CANONICAL_UTC_RE.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const normalized = value.includes('.') ? value : `${value.slice(0, -1)}.000Z`;
  try { return new Date(milliseconds).toISOString() === normalized; } catch { return false; }
}

function validEnvelopeTimes(envelope) {
  try {
    if (!Array.isArray(envelope.evidence)) return false;
    for (const evidence of envelope.evidence) {
      if (evidence === null || typeof evidence !== 'object') return false;
      if (evidence.observedAt !== null && !canonicalTimestamp(evidence.observedAt)) return false;
      if (evidence.asOf !== null && !canonicalTimestamp(evidence.asOf)) return false;
    }
    const freshness = envelope.freshness;
    if (freshness === null || typeof freshness !== 'object') return false;
    return freshness.known === true
      ? canonicalTimestamp(freshness.asOf)
      : freshness.known === false && freshness.asOf === null;
  } catch {
    return false;
  }
}

function boundedText(value, maximum, nonEmpty = false) {
  return typeof value === 'string'
    && value.length <= maximum
    && (!nonEmpty || value.length > 0);
}

// This is the server-side source of truth mirrored exactly by
// public/reina-pilot-client.js. No envelope can be persisted that a conforming
// browser must reject solely because of divergent canonical bounds.
function validEnvelopeBounds(envelope) {
  try {
    if (!boundedText(envelope.answer, MAX_SAVED_ANSWER_CHARACTERS, true)
      || !Array.isArray(envelope.evidence)
      || envelope.evidence.length > 64
      || !boundedText(envelope.freshness?.note, 4_096, true)
      || !Array.isArray(envelope.missingInformation)
      || envelope.missingInformation.length > 64
      || !Array.isArray(envelope.conflictingInformation)
      || envelope.conflictingInformation.length > 64
      || !Array.isArray(envelope.uncertainty)
      || envelope.uncertainty.length > 64
      || (envelope.refused
        ? !boundedText(envelope.refusalReason, 2_048, true)
        : envelope.refusalReason !== null)) return false;
    for (const evidence of envelope.evidence) {
      if (!boundedText(evidence.source, 1_024, true)
        || !boundedText(evidence.sourceType, 128, true)
        || !boundedText(evidence.detail, 8_192)) return false;
    }
    for (const value of [...envelope.missingInformation, ...envelope.uncertainty]) {
      if (!boundedText(value, 4_096)) return false;
    }
    for (const conflict of envelope.conflictingInformation) {
      if (!boundedText(conflict.summary, 4_096, true)
        || !Array.isArray(conflict.sources)
        || conflict.sources.length > 16
        || conflict.sources.some((source) => !boundedText(source, 1_024, true))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function validReviewOffer(value) {
  if (value === null) return true;
  const offer = exactDataRecord(value, REVIEW_OFFER_KEYS);
  if (!offer
    || offer.status !== 'pending'
    || offer.target !== REVIEW_NAVIGATION.target
    || !validIdentifier(offer.offerId)
    || !validIdentifier(offer.ownerPrincipalId)
    || !validIdentifier(offer.conversationId)
    || !validIdentifier(offer.turnId)
    || !canonicalTimestamp(offer.offeredAt)
    || !canonicalTimestamp(offer.expiresAt)) return false;
  const offered = Date.parse(offer.offeredAt);
  const expires = Date.parse(offer.expiresAt);
  return expires > offered && expires - offered <= REVIEW_OFFER_TTL_MS;
}

function validNavigation(value) {
  if (value === null) return true;
  const navigation = exactDataRecord(value, NAVIGATION_KEYS);
  return Boolean(navigation
    && navigation.type === REVIEW_NAVIGATION.type
    && navigation.target === REVIEW_NAVIGATION.target
    && navigation.requiresExplicitUserIntent === true
    && validIdentifier(navigation.acceptedOfferId)
    && validIdentifier(navigation.ownerPrincipalId)
    && validIdentifier(navigation.conversationId)
    && canonicalTimestamp(navigation.acceptedAt));
}

function normalizeAffirmative(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) return null;
  try {
    return value.normalize('NFKC').toLowerCase().trim().replace(/[.!?]+$/u, '').trim();
  } catch {
    return null;
  }
}

function exactReviewAffirmative(value) {
  const normalized = normalizeAffirmative(value);
  return normalized === 'yes'
    || normalized === 'yes please'
    || normalized === 'review them'
    || normalized === "let's review them"
    || normalized === 'open the review';
}

export function isExactReviewAffirmative(value) {
  return exactReviewAffirmative(value);
}

export function createPendingReviewOffer(input) {
  const data = exactDataRecord(input, OFFER_INPUT_KEYS);
  if (!data) return null;
  const offer = Object.freeze({
    status: 'pending',
    target: REVIEW_NAVIGATION.target,
    offerId: data.offerId,
    ownerPrincipalId: data.ownerPrincipalId,
    conversationId: data.conversationId,
    turnId: data.turnId,
    offeredAt: data.offeredAt,
    expiresAt: data.expiresAt,
  });
  return validReviewOffer(offer) ? offer : null;
}

// Navigation authority is minted only from the immediately preceding parsed
// saved turn supplied by the route. A bare affirmative has no authority by
// itself, and an expired or cross-conversation offer cannot create a token.
export function deriveReviewTransition(input) {
  const data = exactDataRecord(input, TRANSITION_INPUT_KEYS);
  if (!data || !exactReviewAffirmative(data.currentText) || !canonicalTimestamp(data.now)) return null;
  const previous = data.previousSavedTurn;
  if (!previous || typeof previous !== 'object' || isProxy(previous) || !trustedSavedTurns.has(previous)) return null;
  const previousData = exactDataRecord(previous, SAVED_KEYS);
  if (!previousData) return null;
  const offer = previousData.reviewOffer;
  if (offer === null
    || !validReviewOffer(offer)
    || offer.ownerPrincipalId !== data.ownerPrincipalId
    || offer.conversationId !== data.conversationId
    || Date.parse(data.now) < Date.parse(offer.offeredAt)
    || Date.parse(data.now) > Date.parse(offer.expiresAt)) return null;
  const transition = Object.freeze({});
  reviewTransitions.set(transition, Object.freeze({
    acceptedOfferId: offer.offerId,
    ownerPrincipalId: data.ownerPrincipalId,
    conversationId: data.conversationId,
    acceptedAt: data.now,
  }));
  return transition;
}

function navigationForTransition(value) {
  if (value === null || typeof value !== 'object' || isProxy(value)) return null;
  const binding = reviewTransitions.get(value);
  if (!binding) return null;
  return Object.freeze({
    ...REVIEW_NAVIGATION,
    acceptedOfferId: binding.acceptedOfferId,
    ownerPrincipalId: binding.ownerPrincipalId,
    conversationId: binding.conversationId,
    acceptedAt: binding.acceptedAt,
  });
}

function canonicalNavigation(value) {
  if (value === null) return null;
  return Object.freeze({
    type: value.type,
    target: value.target,
    requiresExplicitUserIntent: value.requiresExplicitUserIntent,
    acceptedOfferId: value.acceptedOfferId,
    ownerPrincipalId: value.ownerPrincipalId,
    conversationId: value.conversationId,
    acceptedAt: value.acceptedAt,
  });
}

function canonicalReviewOffer(value) {
  if (value === null) return null;
  return Object.freeze({
    status: value.status,
    target: value.target,
    offerId: value.offerId,
    ownerPrincipalId: value.ownerPrincipalId,
    conversationId: value.conversationId,
    turnId: value.turnId,
    offeredAt: value.offeredAt,
    expiresAt: value.expiresAt,
  });
}

function canonicalSaved(envelope, plainText, navigation, reviewOffer) {
  const saved = Object.freeze({
    version: SAVED_TURN_VERSION,
    envelope,
    plainText,
    navigation,
    reviewOffer,
  });
  trustedSavedTurns.add(saved);
  return saved;
}

export function createSavedTurn(input) {
  const options = optionalDataRecord(input, ['envelope'], ['reviewOffer', 'reviewTransition']);
  if (!options) return null;
  const envelopeData = exactDataRecord(options.envelope, ENVELOPE_KEYS);
  if (!envelopeData
    || typeof envelopeData.answer !== 'string'
    || envelopeData.answer.length === 0
    || envelopeData.answer.length > MAX_SAVED_ANSWER_CHARACTERS) return null;

  let checked;
  try { checked = validateEnvelope(options.envelope); } catch { return null; }
  if (!checked?.ok
    || !validEnvelopeTimes(checked.envelope)
    || !validEnvelopeBounds(checked.envelope)) return null;

  const reviewOffer = Object.prototype.hasOwnProperty.call(options, 'reviewOffer')
    ? options.reviewOffer
    : null;
  const transition = Object.prototype.hasOwnProperty.call(options, 'reviewTransition')
    ? options.reviewTransition
    : null;
  const navigation = transition === null ? null : navigationForTransition(transition);
  if (transition !== null && navigation === null) return null;
  if (!validReviewOffer(reviewOffer) || (navigation !== null && reviewOffer !== null)) return null;
  if (checked.envelope.refused === true && (navigation !== null || reviewOffer !== null)) return null;

  let plainText;
  try { plainText = renderPlainText(checked.envelope); } catch { return null; }
  if (typeof plainText !== 'string'
    || plainText.trim() === ''
    || plainText.length > MAX_SAVED_PLAIN_TEXT_CHARACTERS
    || HIDDEN_CONTROL_RE.test(plainText)
    || containsActionCompletionClaim(plainText)) return null;

  const saved = canonicalSaved(
    checked.envelope,
    plainText,
    canonicalNavigation(navigation),
    canonicalReviewOffer(reviewOffer),
  );
  let serialized;
  try { serialized = JSON.stringify(saved); } catch { return null; }
  return byteLength(serialized) <= MAX_SAVED_TURN_BYTES
    ? Object.freeze({ saved, serialized })
    : null;
}

export function parseSavedTurn(serialized) {
  if (typeof serialized !== 'string'
    || serialized.length === 0
    || byteLength(serialized) > MAX_SAVED_TURN_BYTES) return null;
  let candidate;
  try { candidate = JSON.parse(serialized); } catch { return null; }
  const savedData = exactDataRecord(candidate, SAVED_KEYS);
  if (!savedData || savedData.version !== SAVED_TURN_VERSION) return null;
  const envelopeData = exactDataRecord(savedData.envelope, ENVELOPE_KEYS);
  if (!envelopeData
    || typeof envelopeData.answer !== 'string'
    || envelopeData.answer.length === 0
    || envelopeData.answer.length > MAX_SAVED_ANSWER_CHARACTERS
    || typeof savedData.plainText !== 'string'
    || !validNavigation(savedData.navigation)
    || !validReviewOffer(savedData.reviewOffer)
    || (savedData.navigation !== null && savedData.reviewOffer !== null)) return null;

  let checked;
  let rendered;
  try {
    checked = validateEnvelope(savedData.envelope);
    if (!checked?.ok
      || !validEnvelopeTimes(checked.envelope)
      || !validEnvelopeBounds(checked.envelope)) return null;
    rendered = renderPlainText(checked.envelope);
  } catch {
    return null;
  }
  if (checked.envelope.refused === true
    && (savedData.navigation !== null || savedData.reviewOffer !== null)) return null;
  if (rendered === ''
    || savedData.plainText !== rendered
    || rendered.length > MAX_SAVED_PLAIN_TEXT_CHARACTERS
    || HIDDEN_CONTROL_RE.test(rendered)
    || containsActionCompletionClaim(rendered)
    || checked.envelope.executionStatement !== EXECUTION_STATEMENT) return null;

  const canonical = canonicalSaved(
    checked.envelope,
    rendered,
    canonicalNavigation(savedData.navigation),
    canonicalReviewOffer(savedData.reviewOffer),
  );
  let canonicalSerialized;
  try { canonicalSerialized = JSON.stringify(canonical); } catch { return null; }
  if (serialized !== canonicalSerialized) return null;
  return canonical;
}

export const _internals = Object.freeze({
  canonicalTimestamp,
  exactDataRecord,
  exactReviewAffirmative,
  validEnvelopeBounds,
  validNavigation,
  validReviewOffer,
});
