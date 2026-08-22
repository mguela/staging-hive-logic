import test from 'node:test';
import assert from 'node:assert/strict';

import {
  consumeSyntheticPilotReceipt,
  createSyntheticPilotComposer,
  isSyntheticPilotComposer,
} from '../api/_lib/reina/pilot-synthetic-composer.js';
import { PROMPTS } from '../api/_lib/reina-preview-fixtures.js';

const HISTORY = Object.freeze([{ role: 'user', text: 'What needs attention?' }]);

function input(utterance) {
  return Object.freeze({ utterance, history: HISTORY });
}

test('only the module factory creates a composer accepted by the route boundary', async () => {
  const composer = createSyntheticPilotComposer();
  assert.equal(isSyntheticPilotComposer(composer), true);
  assert.equal(isSyntheticPilotComposer(async () => ({})), false);
  assert.equal(consumeSyntheticPilotReceipt({
    kind: 'reina.synthetic-read-receipt.v1',
    promptId: 1,
    envelope: {},
    offerReview: true,
  }), null);
});

test('all ten exact fixture prompts produce branded synthetic receipts', async () => {
  const composer = createSyntheticPilotComposer();
  const prompts = [
    'What needs attention?',
    'What is blocking Demo Job 231?',
    'Which information is stale?',
    'Which sources disagree?',
    'What information is missing?',
    'What assumptions are you making?',
    'Show the evidence.',
    'Draft an internal follow-up, but do not send it.',
    "Show me the customer's banking information.",
    'Mark Demo Job 231 complete.',
  ];
  for (let index = 0; index < prompts.length; index += 1) {
    const raw = await composer(input(prompts[index]));
    const receipt = consumeSyntheticPilotReceipt(raw);
    assert.ok(receipt, prompts[index]);
    assert.equal(receipt.promptId, index + 1);
    assert.ok(receipt.envelope.evidence.every((entry) => entry.dataClass === 'synthetic'));
    assert.equal(receipt.offerReview, false);
  }
});

test('unsupported natural questions return one fixed refusal with no fabricated source', async () => {
  const composer = createSyntheticPilotComposer();
  for (const question of [
    "How will the weather affect today's schedule?",
    'Any important emails?',
    'What does cash flow look like?',
    'Contact the customer',
  ]) {
    const receipt = consumeSyntheticPilotReceipt(await composer(input(question)));
    assert.ok(receipt);
    assert.equal(receipt.promptId, null);
    assert.equal(receipt.offerReview, false);
    assert.equal(receipt.envelope.refused, true);
    assert.equal(receipt.envelope.evidence.length, 1);
    assert.equal(receipt.envelope.evidence[0].dataClass, 'synthetic');
    assert.equal(receipt.envelope.freshness.known, false);
  }
});

test('natural greetings receive a normal read-only pilot introduction without a refusal', async () => {
  const composer = createSyntheticPilotComposer();
  for (const greeting of ['Hi Reina', 'hello', 'Hey Reina']) {
    const receipt = consumeSyntheticPilotReceipt(await composer(input(greeting)));
    assert.ok(receipt, greeting);
    assert.equal(receipt.promptId, null);
    assert.equal(receipt.envelope.refused, false);
    assert.match(receipt.envelope.answer, /^Hello\. I am Reina\./u);
    assert.equal(receipt.envelope.evidence[0].dataClass, 'synthetic');
  }
});

test('adjacent server imports cannot mutate the composer fixture policy after initialization', async () => {
  const composer = createSyntheticPilotComposer();
  const originalAnswer = PROMPTS[0].answer;
  const originalMustInclude = PROMPTS[0].mustInclude[0];
  try {
    PROMPTS[0].answer = 'FORGED MUTABLE FIXTURE CLAIM';
    PROMPTS[0].mustInclude[0] = 'FORGED-NESTED';
    const receipt = consumeSyntheticPilotReceipt(await composer(input('What needs attention?')));
    assert.ok(receipt);
    assert.equal(receipt.envelope.answer, originalAnswer);
    assert.equal(JSON.stringify(receipt).includes('FORGED'), false);
  } finally {
    PROMPTS[0].answer = originalAnswer;
    PROMPTS[0].mustInclude[0] = originalMustInclude;
  }
});

test('wrappers, extra fields, accessors, Proxies, and malformed primitives fail closed', async () => {
  const composer = createSyntheticPilotComposer();
  let reads = 0;
  const accessor = { history: HISTORY };
  Object.defineProperty(accessor, 'utterance', {
    enumerable: true,
    get() { reads += 1; return 'What needs attention?'; },
  });
  for (const malformed of [
    null,
    { ...input('What needs attention?'), role: 'admin' },
    { ...input('What needs attention?'), utterance: new String('What needs attention?') },
    { ...input('What needs attention?'), transport: 'typed' },
    { ...input('What needs attention?'), history: [] },
    accessor,
    new Proxy(input('What needs attention?'), {}),
  ]) {
    assert.equal(await composer(malformed), null);
  }
  assert.equal(reads, 0);
});
