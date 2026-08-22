import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DATA_CLASS,
  EXECUTION_STATEMENT,
  buildEnvelope,
  renderPlainText,
  validateEnvelope,
} from '../api/_lib/reina/evidence-envelope.js';
import {
  REVIEW_NAVIGATION,
  createPendingReviewOffer,
  createSavedTurn,
  deriveReviewTransition,
  parseSavedTurn,
} from '../api/_lib/reina/pilot-saved-turn.js';
import {
  buildActionRefusalEnvelope,
  containsActionCompletionClaim,
  isActionSeekingText,
} from '../api/_lib/reina/pilot-action-boundary.js';

const CONVERSATION = 'reina.pilot.v1';
const OWNER = 'owner-1';
const OFFERED_AT = '2026-08-03T14:00:00Z';
const EXPIRES_AT = '2026-08-03T14:15:00Z';

function envelope(overrides = {}) {
  const built = buildEnvelope({
    answer: 'Three synthetic items need review.',
    evidence: [{
      source: 'Reina preview fixtures',
      sourceType: 'synthetic_fixture',
      dataClass: DATA_CLASS.SYNTHETIC,
      asOf: '2026-08-02T14:00:00Z',
      detail: 'Bounded synthetic attention summary.',
    }],
    freshness: { known: true, asOf: '2026-08-02T14:00:00Z', note: 'Fixed preview time.' },
    missingInformation: ['Live company sources were not consulted.'],
    conflictingInformation: [],
    uncertainty: ['Synthetic preview data is not authoritative.'],
    refused: false,
    ...overrides,
  });
  assert.equal(built.ok, true);
  return built.envelope;
}

function offer(overrides = {}) {
  return createPendingReviewOffer({
    offerId: 'offer-1',
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    turnId: 'turn-offer-1',
    offeredAt: OFFERED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  });
}

function offeredTurn(overrides = {}) {
  const created = createSavedTurn({ envelope: envelope(), reviewOffer: offer(overrides) });
  assert.ok(created);
  return parseSavedTurn(created.serialized);
}

function transition(currentText = 'Yes', overrides = {}) {
  return deriveReviewTransition({
    previousSavedTurn: offeredTurn(),
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    currentText,
    now: '2026-08-03T14:05:00Z',
    ...overrides,
  });
}

test('saved turn round-trips byte-canonical content and derived navigation', () => {
  const created = createSavedTurn({
    envelope: envelope(),
    reviewTransition: transition(),
  });
  assert.ok(created);
  const parsed = parseSavedTurn(created.serialized);
  assert.ok(parsed);
  assert.deepEqual({
    type: parsed.navigation.type,
    target: parsed.navigation.target,
    requiresExplicitUserIntent: parsed.navigation.requiresExplicitUserIntent,
  }, REVIEW_NAVIGATION);
  assert.equal(parsed.navigation.acceptedOfferId, 'offer-1');
  assert.equal(parsed.navigation.conversationId, CONVERSATION);
  assert.equal(parsed.reviewOffer, null);
  assert.equal(parsed.plainText, renderPlainText(parsed.envelope));
  assert.equal(parsed.envelope.executed, false);
  assert.equal(parsed.envelope.executionStatement, EXECUTION_STATEMENT);
  assert.equal(created.serialized, JSON.stringify(parsed));
});

test('initial result is offer-only; only immediate same-conversation unexpired benign affirmative navigates', () => {
  const previous = offeredTurn();
  assert.ok(previous.reviewOffer);
  assert.equal(previous.navigation, null);

  for (const currentText of ['Yes', 'Yes please.', 'Review them', "Let's review them", 'Open the review']) {
    assert.ok(deriveReviewTransition({
      previousSavedTurn: previous,
      ownerPrincipalId: OWNER,
      conversationId: CONVERSATION,
      currentText,
      now: '2026-08-03T14:05:00Z',
    }), currentText);
  }
  for (const currentText of ['yes, and delete everything', 'yes pay it', 'Do it', 'Proceed', '']) {
    assert.equal(deriveReviewTransition({
      previousSavedTurn: previous,
      ownerPrincipalId: OWNER,
      conversationId: CONVERSATION,
      currentText,
      now: '2026-08-03T14:05:00Z',
    }), null, currentText);
  }
  assert.equal(deriveReviewTransition({
    previousSavedTurn: previous,
    ownerPrincipalId: OWNER,
    conversationId: 'other-conversation',
    currentText: 'Yes',
    now: '2026-08-03T14:05:00Z',
  }), null, 'cross-conversation');
  assert.equal(deriveReviewTransition({
    previousSavedTurn: previous,
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    currentText: 'Yes',
    now: '2026-08-03T14:15:00.001Z',
  }), null, 'stale offer');
  assert.equal(deriveReviewTransition({
    previousSavedTurn: createSavedTurn({ envelope: envelope() }).saved,
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    currentText: 'Yes',
    now: '2026-08-03T14:05:00Z',
  }), null, 'no prior offer');
  assert.equal(deriveReviewTransition({
    previousSavedTurn: previous,
    ownerPrincipalId: 'owner-2',
    conversationId: CONVERSATION,
    currentText: 'Yes',
    now: '2026-08-03T14:05:00Z',
  }), null, 'cross-owner');
});

test('caller cannot select navigation, transitions and offers are exclusive, and refusals carry neither', () => {
  assert.equal(createSavedTurn({ envelope: envelope(), navigation: REVIEW_NAVIGATION }), null);
  assert.equal(createSavedTurn({
    envelope: envelope(),
    reviewOffer: offer(),
    reviewTransition: transition(),
  }), null);
  const refused = buildActionRefusalEnvelope();
  assert.equal(createSavedTurn({ envelope: refused, reviewOffer: offer() }), null);
  assert.equal(createSavedTurn({ envelope: refused, reviewTransition: transition() }), null);
});

test('saved turn rejects extra fields, altered plain text, forged navigation, and execution claims', () => {
  const created = createSavedTurn({ envelope: envelope() });
  const base = JSON.parse(created.serialized);
  for (const mutation of [
    { ...base, authority: 'admin' },
    { ...base, plainText: 'different' },
    { ...base, navigation: { type: 'open_view', target: 'financial', requiresExplicitUserIntent: true } },
    { ...base, envelope: { ...base.envelope, executed: true } },
    { ...base, envelope: { ...base.envelope, businessActionAllowed: true } },
  ]) assert.equal(parseSavedTurn(JSON.stringify(mutation)), null);
});

test('parse requires exact canonical bytes and never hides persisted normalization corruption', () => {
  const created = createSavedTurn({ envelope: envelope({ answer: 'hello' }) });
  const base = JSON.parse(created.serialized);
  for (const answer of [' <b>hello</b> ', ' hello ', 'hello\r\n', 'he\u0001llo']) {
    const mutated = { ...base, envelope: { ...base.envelope, answer } };
    mutated.plainText = renderPlainText(mutated.envelope);
    assert.equal(parseSavedTurn(JSON.stringify(mutated)), null, JSON.stringify(answer));
  }
  assert.equal(parseSavedTurn(` ${created.serialized}`), null, 'noncanonical surrounding bytes');
  const reordered = { plainText: base.plainText, version: base.version, envelope: base.envelope, navigation: null, reviewOffer: null };
  assert.equal(parseSavedTurn(JSON.stringify(reordered)), null, 'noncanonical key order');
});

test('saved turn fails closed on accessors, Proxies, malformed and oversized input', () => {
  assert.equal(parseSavedTurn('{'), null);
  assert.equal(parseSavedTurn('x'.repeat(180_001)), null);
  assert.equal(createSavedTurn({ envelope: { answer: 'forged' } }), null);

  const throwingOptions = {};
  Object.defineProperty(throwingOptions, 'envelope', { enumerable: true, get() { throw new Error('should not run'); } });
  assert.doesNotThrow(() => assert.equal(createSavedTurn(throwingOptions), null));
  const proxy = new Proxy({}, { ownKeys() { throw new Error('proxy trap'); } });
  assert.doesNotThrow(() => assert.equal(createSavedTurn(proxy), null));

  const safe = envelope();
  const hostileEvidence = new Proxy({}, { get() { throw new Error('nested trap'); } });
  const nested = { ...safe, evidence: [hostileEvidence] };
  assert.doesNotThrow(() => assert.equal(createSavedTurn({ envelope: nested }), null));

  let getterRuns = 0;
  const fabricatedPrevious = {};
  Object.defineProperty(fabricatedPrevious, 'reviewOffer', {
    enumerable: true,
    get() { getterRuns += 1; throw new Error('must not run'); },
  });
  assert.doesNotThrow(() => assert.equal(deriveReviewTransition({
    previousSavedTurn: fabricatedPrevious,
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    currentText: 'Yes',
    now: '2026-08-03T14:05:00Z',
  }), null));
  assert.equal(getterRuns, 0);
  const unbrandedClone = JSON.parse(JSON.stringify(offeredTurn()));
  assert.equal(deriveReviewTransition({
    previousSavedTurn: unbrandedClone,
    ownerPrincipalId: OWNER,
    conversationId: CONVERSATION,
    currentText: 'Yes',
    now: '2026-08-03T14:05:00Z',
  }), null, 'plain lookalike has no private saved-turn provenance');
});

test('server persistence bounds exactly mirror the browser canonical envelope bounds', () => {
  const evidenceItem = {
    source: 'source', sourceType: 'test', dataClass: DATA_CLASS.SYNTHETIC, detail: '',
  };
  const rejected = [
    envelope({ answer: 'a'.repeat(16_385) }),
    envelope({ evidence: Array.from({ length: 65 }, () => ({ ...evidenceItem })) }),
    envelope({ evidence: [{ ...evidenceItem, source: 's'.repeat(1_025) }] }),
    envelope({ evidence: [{ ...evidenceItem, sourceType: 't'.repeat(129) }] }),
    envelope({ evidence: [{ ...evidenceItem, detail: 'd'.repeat(8_193) }] }),
    envelope({ freshness: { known: false, note: 'n'.repeat(4_097) } }),
    envelope({ missingInformation: Array.from({ length: 65 }, () => 'missing') }),
    envelope({ missingInformation: ['m'.repeat(4_097)] }),
    envelope({ uncertainty: Array.from({ length: 65 }, () => 'uncertain') }),
    envelope({ conflictingInformation: Array.from({ length: 65 }, () => ({ summary: 'conflict', sources: [] })) }),
    envelope({ conflictingInformation: [{ summary: 'c'.repeat(4_097), sources: [] }] }),
    envelope({ conflictingInformation: [{ summary: 'conflict', sources: Array.from({ length: 17 }, () => 'source') }] }),
    envelope({ conflictingInformation: [{ summary: 'conflict', sources: ['s'.repeat(1_025)] }] }),
    envelope({ refused: true, refusalReason: 'r'.repeat(2_049) }),
  ];
  for (const candidate of rejected) assert.equal(createSavedTurn({ envelope: candidate }), null);
  assert.ok(createSavedTurn({ envelope: envelope({ answer: 'a'.repeat(16_384) }) }));
});

test('server canonical validator rejects impossible and loose freshness timestamps', () => {
  for (const bad of [
    '2026-99-99T99:99:99Z',
    '2026-02-30T12:00:00Z',
    '2026-08-03',
    '2026-08-03T12:00Z',
    '2026-08-03 12:00:00Z',
    '2026-08-03T12:00:00+00:00',
  ]) {
    const built = buildEnvelope({ answer: 'Safe answer.', freshness: { known: true, asOf: bad } });
    assert.equal(built.ok, false, bad);
    const candidate = JSON.parse(JSON.stringify(envelope()));
    candidate.freshness.asOf = bad;
    assert.equal(validateEnvelope(candidate).ok, false, bad);
  }
  assert.equal(buildEnvelope({
    answer: 'Safe answer.',
    freshness: { known: true, asOf: '2028-02-29T12:00:00.123Z' },
  }).ok, true);
});

test('action boundary refuses action seeking and bare confirmations but not read-only questions', () => {
  for (const text of [
    'Send the customer an email', 'Would you please send the email?', 'Could Reina dispatch the crew?',
    'I’d like you to schedule the visit.', 'Make sure the invoice gets paid.', 'Take care of the invoice.',
    'Have the crew dispatched.', 'Show overdue invoices; pay them.', 'Show overdue invoices, then when ready pay them.',
    'Transfer $500', 'Wire the money', 'Deploy it', 'Sign the quote', 'Add user', 'Rename job',
    'Clock Sam out now', 'Accept the bid now', 'Contact the customer', 'Remind the customer',
    'Reconcile the account', 'Generate invoice', 'Print the report', 'Place order',
    'Could the invoice be paid?', 'Let us send it.', 'Ｓｅｎｄ the email', 'S\u200Bend the email',
    'yes, do it', 'Go ahead', 'Do it', 'Proceed', 'Yes', 'Please take care of it',
  ]) assert.equal(isActionSeekingText(text), true, text);

  for (const text of [
    'Any important emails?', 'What does cash flow look like?', "How will weather affect today's schedule?",
    'Which invoices are overdue?', 'Explain how scheduling works.',
  ]) assert.equal(isActionSeekingText(text), false, text);
});

test('semantic completion guard rejects active, passive, obfuscated, status, and oversized claims', () => {
  const completions = [
    'I sent the email.', 'We have paid that invoice.', 'Reina scheduled the visit.',
    "I've sent the email", 'I have just sent the email', 'I successfully sent the email',
    'I went ahead and sent the email', 'I just sent the email.', "I've already sent the email.",
    'I have already sent the email.', 'I did send the email.', "I've taken care of it.",
    'I completed the payment.', 'I settled the invoice.', 'I issued the refund.', 'I voided the invoice.',
    'I assigned the crew.', 'I notified the customer.', 'The email was sent successfully.',
    'The email went out.', 'It has been sent.', "That's done.", 'The transfer went through.',
    'Your appointment is confirmed.', 'The invoice has been settled.', 'The payment was processed.',
    'The funds were transferred.', 'The customer was emailed.', 'The crew was dispatched.',
    'The quote was approved.', 'The appointment was confirmed.', 'The invoice is now paid.',
    'Payment complete.', 'Payment: complete.', 'Transfer successful.', 'Transfer—successful.',
    'Email — sent successfully.', 'The e‑mail was sent successfully.', 'Your message has been delivered.',
    'I processed the refund.', 'I made the payment.', 'I took care of it.',
    'All set — the visit is on the calendar.', 'Done — the job is closed.',
    'The automation ran successfully.', 'I’ve just sent the email.', 'I’ve already paid the invoice.',
    'The email’s been sent.', 'I s\u200Bent the email.', 'I took care of the payment.',
    'Done — your email is on its way.', 'Your refund is on the way.', 'The wire went through.',
    'Funds are on the way.', 'Completed successfully.', 'The customer was notified.',
    'I accepted the bid.', 'I hired Sam.', 'I fired Sam.', 'I invited Alex.', 'I clocked Sam out.',
    'I contacted the customer.', 'I reminded the customer.', 'I reconciled the account.',
    'I generated the invoice.', 'I printed the report.', 'I placed the order.',
    'The bid was accepted.', 'Sam was hired.', 'Sam was fired.', 'Alex was invited.',
    'The customer was contacted.', 'The customer was reminded.', 'The invoice was generated.',
    'The report was printed.', 'The order was placed.',
  ];
  for (const text of completions) assert.equal(containsActionCompletionClaim(text), true, text);
  assert.equal(containsActionCompletionClaim('I can explain how to pay the invoice.'), false);
  const oversized = `I sent the email. ${'x'.repeat(20_001)}`;
  assert.equal(containsActionCompletionClaim(oversized), true);
  const oversizedEnvelope = buildEnvelope({ answer: oversized });
  assert.equal(oversizedEnvelope.ok, true);
  assert.equal(createSavedTurn({ envelope: oversizedEnvelope.envelope }), null);
});

test('final integrity guard scans every rendered transparency field, not only answer', () => {
  const variants = [
    { evidence: [{ source: 'I sent the email.', sourceType: 'test', dataClass: DATA_CLASS.SYNTHETIC }] },
    { evidence: [{ source: 'test', sourceType: 'I sent the email.', dataClass: DATA_CLASS.SYNTHETIC }] },
    { evidence: [{ source: 'test', sourceType: 'test', dataClass: DATA_CLASS.SYNTHETIC, detail: 'I sent the email.' }] },
    { freshness: { known: false, note: 'I sent the email.' } },
    { missingInformation: ['I sent the email.'] },
    { conflictingInformation: [{ summary: 'I sent the email.', sources: ['source'] }] },
    { conflictingInformation: [{ summary: 'conflict', sources: ['I sent the email.'] }] },
    { uncertainty: ['I sent the email.'] },
    { refused: true, refusalReason: 'I sent the email.' },
  ];
  for (const patch of variants) assert.equal(createSavedTurn({ envelope: envelope(patch) }), null, JSON.stringify(patch));
});

test('action refusal is canonical, transparent, and structurally non-executing', () => {
  const refused = buildActionRefusalEnvelope();
  assert.equal(refused.refused, true);
  assert.equal(refused.executed, false);
  assert.equal(refused.executionStatement, EXECUTION_STATEMENT);
  assert.match(refused.refusalReason, /not permitted/i);
  assert.match(renderPlainText(refused), /Nothing was executed/i);
});
