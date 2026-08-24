import test from 'node:test';
import assert from 'node:assert/strict';

import { makeHarness, flush } from './helpers/reina-pilot-harness.mjs';

// The regression this file exists for.
//
// The approval popup was wired into submitFromInput(), which is the KEYBOARD
// door. Press-and-hold voice never goes through it -- endLiveHold() calls
// submitTyped() directly. So every spoken "send an email of this plan to Allan
// and Andy" walked straight past the approval flow into the read-only pilot and
// came back "I cannot perform that action in this read-only pilot."
//
// Chris asked out loud every single time. It was shipped, deployed, and
// reported broken twice before anyone looked at which function the microphone
// actually calls.
//
// submitTyped IS the voice path. A test that drives it is testing the thing
// that was broken, not a paraphrase of it.

function fakeApprovals() {
  const proposed = [];
  globalThis.ReinaActionApproval = {
    createApprovalUi() {
      return {
        looksLikeEmailRequest(text) {
          return typeof text === 'string' && /\bemail\b/iu.test(text) && /@/u.test(text);
        },
        async propose(utterance, conversationId, turnId) {
          proposed.push({ utterance, conversationId, turnId });
          return { ok: true, approvalId: 'rap.test' };
        },
        close() {},
        isOpen() { return false; },
      };
    },
  };
  return proposed;
}

function turnPosts(calls) {
  return calls.filter((call) => call.method === 'POST' && !String(call.url || '').includes('voice-diagnostic'));
}

test.afterEach(() => { delete globalThis.ReinaActionApproval; });

test('a spoken request to send an email never reaches the read-only route', async () => {
  const proposed = fakeApprovals();
  const h = makeHarness();
  await h.host.mount();
  const before = turnPosts(h.calls).length;

  // Exactly what the microphone does when the talk button is released.
  const outcome = h.host.submitTyped('send an email of this plan to andy@ghgrp.net');
  await flush();

  assert.equal(outcome.accepted, true);
  assert.equal(outcome.action, 'approval_requested');
  assert.equal(proposed.length, 1, 'the request must reach the approval flow');
  assert.equal(proposed[0].utterance, 'send an email of this plan to andy@ghgrp.net');
  assert.equal(
    turnPosts(h.calls).length,
    before,
    'nothing may be sent to the read-only pilot -- that route exists to refuse this',
  );
});

test('the typed door behaves identically, because it is the same door', async () => {
  const proposed = fakeApprovals();
  const h = makeHarness();
  await h.host.mount();
  const before = turnPosts(h.calls).length;

  h.page.input.value = 'email this to andy@ghgrp.net';
  h.page.send.onclick();
  await flush();

  assert.equal(proposed.length, 1);
  assert.equal(turnPosts(h.calls).length, before);
  assert.equal(h.page.input.value, '', 'the request is consumed, not left sitting in the box');
});

test('an ordinary question still goes to Reina, and opens no popup', async () => {
  const proposed = fakeApprovals();
  const h = makeHarness();
  await h.host.mount();
  const before = turnPosts(h.calls).length;

  h.host.submitTyped('what needs my attention today?');
  await flush();

  assert.equal(proposed.length, 0, 'a question must not open an approval popup');
  assert.equal(turnPosts(h.calls).length, before + 1, 'and it must still be answered');
});

test('with the approval module absent, nothing changes and nothing throws', async () => {
  delete globalThis.ReinaActionApproval;
  const h = makeHarness();
  await h.host.mount();
  const before = turnPosts(h.calls).length;

  // The page may not have loaded the popup script. That must degrade to the old
  // behaviour -- a refusal -- rather than to a broken input box.
  const outcome = h.host.submitTyped('send an email of this plan to andy@ghgrp.net');
  await flush();

  assert.equal(outcome.accepted, true);
  assert.equal(turnPosts(h.calls).length, before + 1);
});

test('the approval request appears in the conversation, so it is not a silent hand-off', async () => {
  fakeApprovals();
  const h = makeHarness();
  await h.host.mount();

  h.host.submitTyped('send an email of this plan to andy@ghgrp.net');
  await flush();

  assert.match(h.page.feed.textContent, /send an email of this plan/i);
  assert.match(h.page.feed.textContent, /drafted it/i, 'and she says what she did');
});
