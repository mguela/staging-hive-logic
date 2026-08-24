import test from 'node:test';
import assert from 'node:assert/strict';

import Approval from '../public/reina-action-approval.js';

const { createApprovalUi, looksLikeEmailRequest, splitAddresses } = Approval;

// ---- Which requests open a popup at all ------------------------------------
//
// A false positive is worse than a false negative here. Missing a request costs
// one retyped sentence; opening an unwanted popup teaches the habit of clicking
// through popups, and that habit is the only thing this design cannot survive.

test('a request to send an email is recognised, in the words people actually use', () => {
  for (const request of [
    'send an email of this plan to Allan, Andy, Kevin and Rich - all emails are Names@ghgrp.net',
    'email this to andy@ghgrp.net',
    'can you draft an email to Kevin about the quote',
    'shoot an email over to rich@ghgrp.net',
  ]) {
    assert.equal(looksLikeEmailRequest(request), true, request);
  }
});

test('ordinary questions never open the popup', () => {
  for (const question of [
    'what needs my attention today',
    'how many jobs are open',
    'explain what a GFCI outlet does',
    'grade this plan for me',
    'i need a plan to increase productivity by 25% in the next 60 days',
    'send Andy over to the Miller job',
    '',
  ]) {
    assert.equal(looksLikeEmailRequest(question), false, JSON.stringify(question));
  }
});

test('addresses are split the way people type them', () => {
  assert.deepEqual(splitAddresses('a@x.com, b@x.com;c@x.com  d@x.com'), ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']);
  assert.deepEqual(splitAddresses(''), []);
});

// ---- The popup itself ------------------------------------------------------

function fakeDom() {
  const created = [];
  function makeNode(tag) {
    const node = {
      tag,
      className: '',
      style: {},
      children: [],
      listeners: {},
      value: '',
      textContent: '',
      disabled: false,
      parentNode: null,
      appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
      removeChild(child) {
        const at = node.children.indexOf(child);
        if (at >= 0) node.children.splice(at, 1);
        child.parentNode = null;
        return child;
      },
      addEventListener(name, fn) { node.listeners[name] = fn; },
      focus() {},
    };
    created.push(node);
    return node;
  }
  const body = makeNode('body');
  return {
    created,
    body,
    documentRef: { createElement: makeNode, body },
  };
}

function find(dom, className) {
  return dom.created.find((node) => node.className === className);
}

function findAll(dom, className) {
  return dom.created.filter((node) => node.className === className);
}

const PROPOSAL = {
  ok: true,
  approvalId: 'rap.0123456789abcdef0123456789abcdef',
  proposal: {
    to: ['allan@ghgrp.net'],
    cc: [],
    bcc: [],
    subject: 'Productivity plan',
    body: 'Here is the plan.',
    from: 'chris@ghgrp.net',
  },
};

function build({ responses = [], onResolved = () => {} } = {}) {
  const dom = fakeDom();
  const posted = [];
  const queue = responses.slice();
  const ui = createApprovalUi({
    documentRef: dom.documentRef,
    onResolved,
    fetchFn: async (url, options) => {
      posted.push({ url, body: JSON.parse(options.body) });
      const next = queue.length ? queue.shift() : { ok: false, code: 'network' };
      return { json: async () => next };
    },
  });
  return { dom, ui, posted };
}

test('proposing shows the draft and sends nothing', async () => {
  const { dom, ui, posted } = build({ responses: [PROPOSAL] });
  const outcome = await ui.propose('email allan the plan', 'rp.conv', 't.one');

  assert.equal(outcome.ok, true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.op, 'propose');
  assert.equal(ui.isOpen(), true);

  const inputs = findAll(dom, 'rna-approve-input');
  assert.equal(inputs.length, 4, 'to, cc, subject, body -- all editable');
  assert.equal(inputs[0].value, 'allan@ghgrp.net');
  assert.equal(inputs[2].value, 'Productivity plan');
  assert.equal(inputs[3].value, 'Here is the plan.');
});

test('pressing send sends exactly what is in the boxes, edits included', async () => {
  const resolved = [];
  const { dom, ui, posted } = build({
    responses: [PROPOSAL, { ok: true, executed: true, to: ['kevin@ghgrp.net'] }],
    onResolved: (outcome) => resolved.push(outcome),
  });
  await ui.propose('email allan the plan', 'rp.conv', 't.one');

  const inputs = findAll(dom, 'rna-approve-input');
  inputs[0].value = 'kevin@ghgrp.net, rich@ghgrp.net';
  inputs[2].value = 'Productivity plan (revised)';
  inputs[3].value = 'Rewritten by hand.';

  await find(dom, 'rna-approve-send').listeners.click();

  assert.equal(posted.length, 2);
  assert.equal(posted[1].body.op, 'execute');
  assert.equal(posted[1].body.approvalId, PROPOSAL.approvalId);
  assert.deepEqual(posted[1].body.payload.to, ['kevin@ghgrp.net', 'rich@ghgrp.net']);
  assert.equal(posted[1].body.payload.subject, 'Productivity plan (revised)');
  assert.equal(posted[1].body.payload.body, 'Rewritten by hand.');
  assert.equal(ui.isOpen(), false);
  assert.equal(resolved[0].status, 'sent');
});

test('cancelling tells the server no, and sends nothing', async () => {
  const resolved = [];
  const { dom, ui, posted } = build({
    responses: [PROPOSAL, { ok: true, rejected: true }],
    onResolved: (outcome) => resolved.push(outcome),
  });
  await ui.propose('email allan the plan', 'rp.conv', 't.one');

  await find(dom, 'rna-approve-cancel').listeners.click();

  assert.equal(posted[1].body.op, 'reject');
  assert.equal(posted.some((call) => call.body.op === 'execute'), false, 'cancel must never execute');
  assert.equal(ui.isOpen(), false);
  assert.equal(resolved[0].status, 'cancelled');
});

// A double-click on Send is the single most likely way a person creates two of
// something they wanted one of.
test('the send button cannot be pressed twice', async () => {
  const { dom, ui, posted } = build({
    responses: [PROPOSAL, { ok: true, executed: true, to: ['allan@ghgrp.net'] }],
  });
  await ui.propose('email allan the plan', 'rp.conv', 't.one');

  const send = find(dom, 'rna-approve-send');
  const first = send.listeners.click();
  const second = send.listeners.click();
  await Promise.all([first, second]);

  const executes = posted.filter((call) => call.body.op === 'execute');
  assert.equal(executes.length, 1, `two clicks produced ${executes.length} sends`);
});

test('a fixable refusal keeps the draft open instead of throwing it away', async () => {
  const resolved = [];
  const { dom, ui } = build({
    responses: [PROPOSAL, { ok: false, code: 'draft_invalid' }],
    onResolved: (outcome) => resolved.push(outcome),
  });
  await ui.propose('email allan the plan', 'rp.conv', 't.one');

  await find(dom, 'rna-approve-send').listeners.click();

  assert.equal(ui.isOpen(), true, 'the person must be able to fix the address and try again');
  assert.match(find(dom, 'rna-approve-error').textContent, /cannot be sent|not something that can be sent/i);
  assert.equal(resolved.length, 0);
  assert.equal(find(dom, 'rna-approve-send').disabled, false, 'and the button has to work again');
});

test('a refusal that spent the approval closes the draft and says so', async () => {
  const resolved = [];
  const { dom, ui } = build({
    responses: [PROPOSAL, { ok: false, code: 'approval_duplicate' }],
    onResolved: (outcome) => resolved.push(outcome),
  });
  await ui.propose('email allan the plan', 'rp.conv', 't.one');
  await find(dom, 'rna-approve-send').listeners.click();

  assert.equal(ui.isOpen(), false);
  assert.equal(resolved[0].status, 'failed');
  assert.match(resolved[0].message, /already sent once/i);
});

test('a failed proposal never opens a popup', async () => {
  const { ui } = build({ responses: [{ ok: false, code: 'no_mailbox_connected' }] });
  const outcome = await ui.propose('email allan the plan', 'rp.conv', 't.one');
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /No mailbox is connected/i);
  assert.equal(ui.isOpen(), false);
});
