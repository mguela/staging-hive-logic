import test from 'node:test';
import assert from 'node:assert/strict';

import {
  _candidateInternals,
  createReinaBrowserCandidateHooks,
} from './_support/reina-acceptance/reina-pilot-browser-candidate.mjs';

function stimulus(action, overrides = {}) {
  return {
    sessionId: 'candidate-focused-session',
    conversationId: 'candidate-focused-conversation',
    action,
    message: null,
    inject: {},
    transport: action === 'submitSpokenTurn' ? 'voice' : 'typed',
    generation: 1,
    ...overrides,
  };
}

async function mountedHooks(overrides = {}) {
  const hooks = createReinaBrowserCandidateHooks();
  await hooks.authenticateSession(stimulus('authenticateSession', overrides.authenticate || {}));
  await hooks.mountReinaPanel(stimulus('mountReinaPanel', overrides.mount || {}));
  return hooks;
}

test('candidate drives authenticated bootstrap through the actual route and existing panel', async () => {
  const hooks = await mountedHooks();
  const runtime = _candidateInternals.getActiveRuntime();
  assert.equal(runtime.network.length, 1);
  assert.equal(runtime.network[0].endpoint, '/api/reina-pilot');
  assert.equal(runtime.network[0].method, 'GET');
  assert.equal(runtime.network[0].status, 200);
  assert.equal(runtime.bootstrap.user.displayName, 'Demo Admin');
  assert.equal(runtime.bootstrap.attention.total, 5);
  assert.equal(runtime.bootstrap.attention.categories[1].count, null);
  assert.match(runtime.bootstrap.review.intentId, /^rui\.[a-f0-9]{32}$/u);
  assert.equal(runtime.bootstrap.uiIntent.intentId, runtime.bootstrap.review.intentId);

  const panel = await hooks.inspectPanel();
  assert.equal(panel.panelMounted, true);
  assert.equal(panel.usesRnaElements, true);
  assert.equal(panel.greetingVisible, false, 'the compact popup does not display bootstrap briefing text');
  assert.equal(panel.renderMode, 'textContent');
  assert.equal(panel.structural.executed, false);
});

test('typed then gesture-enabled Voice use the actual single route without pre-gesture mic start', async () => {
  const hooks = await mountedHooks();
  const runtime = _candidateInternals.getActiveRuntime();
  assert.equal(runtime.recognitionStarts, 0);

  await hooks.submitTypedTurn(stimulus('submitTypedTurn', {
    message: 'What needs attention?',
  }));
  assert.equal(runtime.recognitionStarts, 0, 'typed input must not start recognition');

  const enabled = await hooks.enableVoiceFromGesture(stimulus('enableVoiceFromGesture'));
  assert.equal(enabled.micStarted, true);
  assert.equal(runtime.recognitionStarts, 1);
  await hooks.submitSpokenTurn(stimulus('submitSpokenTurn', {
    message: 'Hey Reina, show the evidence.',
  }));

  const posts = runtime.network.filter((call) => call.method === 'POST');
  assert.deepEqual(posts.map((call) => call.request.transport), ['typed', 'voice']);
  assert.equal(new Set(posts.map((call) => call.request.conversationId)).size, 1);
  for (const call of posts) {
    assert.deepEqual(Object.keys(call.request).sort(), [
      'conversationId', 'idempotencyKey', 'transport', 'turnId', 'utterance',
    ]);
    assert.equal(call.status, 200);
    assert.equal(call.response.stored, true);
    assert.equal(call.response.executed, false);
    assert.equal(call.response.businessActionAllowed, false);
    assert.equal(call.response.automationTaskAllowed, false);
    assert.equal(call.response.toolExecutionAllowed, false);
  }
  const network = await hooks.inspectNetworkAudit();
  assert.equal(network.typedVoiceContinuity, true);
  assert.equal(network.sameEndpoint, true);
  assert.equal(network.legacyUnsafeChatPathUsed, false);
  assert.equal((await hooks.inspectSpeechAudit()).micStartWithoutGestureRejected, true);
});

test('server-issued review intent confirms once through the actual PR87/PR88 host mapping', async () => {
  const intentId = 'intent-candidate-focused';
  const hooks = await mountedHooks({
    mount: {
      inject: {
        pendingUiIntent: {
          type: 'reina.ui-intent.v1',
          intentId,
          destination: 'untrusted-fixture-destination',
        },
      },
    },
  });
  const runtime = _candidateInternals.getActiveRuntime();
  assert.match(runtime.bootstrap.uiIntent.intentId, /^rui\.[a-f0-9]{32}$/u);
  assert.notEqual(runtime.bootstrap.uiIntent.intentId, intentId);
  assert.equal(runtime.bootstrap.uiIntent.destination, 'standup');

  const result = await hooks.confirmAttentionReview(stimulus('confirmAttentionReview', {
    inject: { intentId, confirmVia: 'button' },
  }));
  assert.equal(result.navigationPerformed, true);
  assert.equal(runtime.documentRef.byId.standup.style.display, 'block');
  assert.equal(runtime.navigationCalls.length, 1);
  const navigation = await hooks.inspectNavigationAudit();
  assert.equal(navigation.confirmationCount, 1);
  assert.equal(navigation.confirmedExactIntentId, true);
  assert.equal(navigation.navigationReadOnly, true);
  assert.equal(navigation.businessDataMutated, false);

  await hooks.confirmAttentionReview(stimulus('confirmAttentionReview', {
    inject: { intentId, confirmVia: 'button', duplicateConfirm: true },
  }));
  assert.equal(runtime.navigationCalls.length, 1);
});
