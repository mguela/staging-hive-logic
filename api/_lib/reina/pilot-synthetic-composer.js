// Deterministic, server-owned answer source for the disabled-by-default Reina
// pilot. This module is intentionally not a model/tool seam. It can return only
// the ten bundled synthetic fixtures or one fixed unsupported-question refusal.
// Evidence, freshness, data class, and review-offer state are constructed here;
// no caller/provider/model object can assert them.

import { types as utilTypes } from 'node:util';

import { PREVIEW_NOW, PROMPTS } from '../reina-preview-fixtures.js';
import { buildEnvelope, DATA_CLASS } from './evidence-envelope.js';

const COMPOSERS = new WeakSet();
const RECEIPTS = new WeakSet();
const INPUT_KEYS = Object.freeze(['utterance', 'history']);
const MAX_UTTERANCE = 4_000;
const MAX_TEST_DELAY_MS = 4_000;
const NATIVE_SET_TIMEOUT = setTimeout;

function deepSnapshot(value) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item) => deepSnapshot(item)));
  if (typeof value !== 'object') throw new Error('invalid_fixture');
  const out = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error('invalid_fixture');
    out[key] = deepSnapshot(descriptor.value);
  }
  return Object.freeze(out);
}

// Do not retain references to the fixture module's exported mutable arrays or
// records. Adjacent server modules cannot alter policy/evidence after this
// module initializes.
const SNAPSHOT_PROMPTS = deepSnapshot(PROMPTS);

function isProxy(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && utilTypes.isProxy(value);
}

function configuredDelay(options) {
  if (options === undefined) return 0;
  if (options === null || typeof options !== 'object' || isProxy(options)) return null;
  try {
    if (Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(options);
    if (keys.length !== 1 || keys[0] !== 'delayMs') return null;
    const descriptor = Object.getOwnPropertyDescriptor(options, 'delayMs');
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    return Number.isSafeInteger(descriptor.value)
      && descriptor.value >= 0
      && descriptor.value <= MAX_TEST_DELAY_MS
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function exactInput(value) {
  if (value === null || typeof value !== 'object' || isProxy(value)) return null;
  try {
    if (Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== INPUT_KEYS.length
      || keys.some((key) => typeof key !== 'string' || !INPUT_KEYS.includes(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const out = Object.create(null);
    for (const key of INPUT_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      out[key] = descriptor.value;
    }
    if (typeof out.utterance !== 'string'
      || out.utterance.length < 1
      || out.utterance.length > MAX_UTTERANCE
      || !Object.isFrozen(out.history)
      || !Array.isArray(out.history)) return null;
    return Object.freeze(out);
  } catch {
    return null;
  }
}

function normalizedText(value) {
  try {
    return value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
  } catch {
    return '';
  }
}

const PROMPT_BY_TEXT = new Map(SNAPSHOT_PROMPTS.map((prompt) => [normalizedText(prompt.prompt), prompt]));
const SAFE_VARIANTS = new Map([
  ['what needs review', 1],
  ['what needs my attention', 1],
  ['show me what needs attention', 1],
  ['what is blocking demo 231', 2],
  ['what is stale', 3],
  ['show evidence', 7],
]);
const GREETINGS = new Set([
  'hi', 'hello', 'hi reina', 'hello reina', 'hey reina', 'good morning reina',
]);

function promptFor(utterance) {
  const normalized = normalizedText(utterance);
  const exact = PROMPT_BY_TEXT.get(normalized);
  if (exact) return exact;
  const id = SAFE_VARIANTS.get(normalized);
  return id ? SNAPSHOT_PROMPTS.find((prompt) => prompt.promptId === id) || null : null;
}

function transparencyFor(prompt) {
  const conflicts = prompt.promptId === 1 || prompt.promptId === 4
    ? [{
      summary: prompt.missingOrConflicting,
      sources: ['HiveLogic demo', 'Sync demo feed'],
    }]
    : [];
  const missing = prompt.missingOrConflicting !== 'N/A'
    && !/^none\b/iu.test(prompt.missingOrConflicting)
    && conflicts.length === 0
    ? [prompt.missingOrConflicting]
    : [];
  return Object.freeze({ missing, conflicts });
}

function fixtureEnvelope(prompt) {
  const transparency = transparencyFor(prompt);
  const refused = prompt.promptId === 9 || prompt.promptId === 10;
  const built = buildEnvelope({
    answer: prompt.answer,
    evidence: [{
      source: 'Reina synthetic preview fixtures',
      sourceType: 'synthetic_fixture',
      dataClass: DATA_CLASS.SYNTHETIC,
      asOf: PREVIEW_NOW,
      detail: prompt.evidence,
    }],
    freshness: {
      known: true,
      asOf: PREVIEW_NOW,
      note: `${prompt.freshness} Synthetic fixture time; not a live source read.`,
    },
    missingInformation: transparency.missing,
    conflictingInformation: transparency.conflicts,
    uncertainty: [
      prompt.factOrInference,
      prompt.safeRecommendation,
      'This answer is synthetic preview evidence and does not establish current business facts.',
    ],
    refused,
    refusalReason: refused
      ? prompt.promptId === 9 ? 'sensitive_data_not_available' : 'action_not_permitted'
      : null,
  });
  return built.ok ? built.envelope : null;
}

function unsupportedEnvelope() {
  const built = buildEnvelope({
    answer: 'That question is unavailable in this synthetic read-only pilot.',
    evidence: [{
      source: 'Reina synthetic pilot registry',
      sourceType: 'server_policy',
      dataClass: DATA_CLASS.SYNTHETIC,
      detail: 'Only the fixed synthetic fixture questions are available; live domain tools and public web research are disabled.',
    }],
    freshness: {
      known: false,
      note: 'No source was read because the question is outside the finite synthetic pilot fixture set.',
    },
    missingInformation: [
      'No verified company, finance, mailbox, weather, or live Jobs authority is available to this pilot path.',
    ],
    conflictingInformation: [],
    uncertainty: [
      'A broader answer would require a separately authorized server-owned read operation.',
    ],
    refused: true,
    refusalReason: 'unsupported_synthetic_question',
  });
  return built.ok ? built.envelope : null;
}

// A greeting is not a request for business data.  Answer it normally, while
// still making the pilot boundary visible in the written/auditable envelope.
function greetingEnvelope() {
  const built = buildEnvelope({
    answer: 'Hello. I am Reina. I can help with the available read-only pilot questions, and I will be clear when a live source is not connected.',
    evidence: [{
      source: 'Reina synthetic pilot registry',
      sourceType: 'server_policy',
      dataClass: DATA_CLASS.SYNTHETIC,
      detail: 'Greeting and pilot capability statement; no business source was read.',
    }],
    freshness: {
      known: false,
      note: 'No business source was read for this greeting.',
    },
    missingInformation: [
      'Live company, finance, mailbox, weather, and Jobs reads are not enabled in this pilot.',
    ],
    conflictingInformation: [],
    uncertainty: [
      'This is a synthetic read-only pilot response, not a current business-data answer.',
    ],
    refused: false,
    refusalReason: null,
  });
  return built.ok ? built.envelope : null;
}

function receipt(envelope, promptId) {
  if (!envelope) return null;
  const value = Object.freeze({
    kind: 'reina.synthetic-read-receipt.v1',
    promptId,
    envelope,
    offerReview: false,
  });
  RECEIPTS.add(value);
  return value;
}

export function createSyntheticPilotComposer(options) {
  const delayMs = configuredDelay(options);
  if (delayMs === null) throw new Error('invalid_composer_options');
  const composer = async (raw) => {
    const input = exactInput(raw);
    if (!input) return null;
    if (delayMs > 0) {
      await new Promise((resolve) => Reflect.apply(NATIVE_SET_TIMEOUT, undefined, [resolve, delayMs]));
    }
    const prompt = promptFor(input.utterance);
    if (prompt) return receipt(fixtureEnvelope(prompt), prompt.promptId);
    if (GREETINGS.has(normalizedText(input.utterance))) return receipt(greetingEnvelope(), null);
    return receipt(unsupportedEnvelope(), null);
  };
  COMPOSERS.add(composer);
  return composer;
}

export function isSyntheticPilotComposer(value) {
  return typeof value === 'function' && COMPOSERS.has(value);
}

export function consumeSyntheticPilotReceipt(value) {
  return value !== null && typeof value === 'object' && RECEIPTS.has(value) ? value : null;
}
