// test/lead-estimate-link.test.mjs
// Phase 0, item 5 (2026-08-17) — the last unlinked hop in the chain.
//
// The lead board already tracked 'estimate_booked' and 'estimate_sent', and
// people already use it: 20 of 58 live leads sit in estimate_booked. But
// nothing connected a lead to an actual estimate — someone moved the card by
// hand, and the estimate had no idea which lead produced it.
//
// The two rules worth defending here are about honesty and about not undoing
// someone's work:
//
//   - Creating an estimate links it but does NOT move the card. The estimate is
//     still a draft and the send that follows can fail; a lead claiming "sent"
//     because a draft exists would be lying.
//   - Sending advances the lead, but only ever FORWARDS. A resend must never
//     drag a lead that is already 'won' backwards to 'estimate_sent'.
//
// And one about blast radius: a failed lead link must never sink a saved
// estimate. The estimate is the real record; a broken pointer is a reporting
// gap, not lost work.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { linkLeadToEstimate, advanceLeadOnSend, stageIsBefore } from '../api/_lib/lead-estimate-link.js';

function stub({ lead = { id: 'lead-1', stage: 'new' }, patchFails = null } = {}) {
  const state = { patches: [] };
  const sb = async (path, opts = {}) => {
    if (opts.method === 'PATCH') {
      state.patches.push({ path, body: JSON.parse(opts.body) });
      if (patchFails) return { ok: false, text: async () => patchFails };
      return { ok: true, json: async () => (lead ? [{ ...lead, ...JSON.parse(opts.body) }] : []) };
    }
    return { ok: true, json: async () => (lead ? [lead] : []) };
  };
  return { deps: { supabaseRequest: sb }, state };
}

// ------------------------------------------------------------- linking

test('creating an estimate points the lead at it', async () => {
  const { deps, state } = stub();
  const r = await linkLeadToEstimate('lead-1', 'est-uuid-1', deps);
  assert.equal(r.linked, true);
  assert.equal(state.patches.length, 1);
  assert.match(state.patches[0].path, /id=eq\.lead-1/);
  assert.equal(state.patches[0].body.estimate_id, 'est-uuid-1');
});

test('linking never moves the card', async () => {
  // The estimate is a draft at this point. Moving the lead to 'estimate_sent'
  // here would claim something that has not happened yet.
  const { deps, state } = stub();
  await linkLeadToEstimate('lead-1', 'est-uuid-1', deps);
  assert.ok(!('stage' in state.patches[0].body), 'create must not touch the stage');
});

test('a failed link is reported, never thrown', async () => {
  // The estimate already exists and is real by this point.
  const { deps } = stub({ patchFails: 'connection reset' });
  const r = await linkLeadToEstimate('lead-1', 'est-uuid-1', deps);
  assert.equal(r.linked, false);
  assert.match(r.reason, /connection reset/);
});

test('a lead that has since been deleted is reported, not thrown', async () => {
  const { deps } = stub({ lead: null });
  const r = await linkLeadToEstimate('lead-1', 'est-uuid-1', deps);
  assert.equal(r.linked, false);
  assert.match(r.reason, /no longer exists/i);
});

test('an estimate with no lead does nothing at all', async () => {
  const { deps, state } = stub();
  const r = await linkLeadToEstimate(null, 'est-uuid-1', deps);
  assert.equal(r.linked, false);
  assert.deepEqual(state.patches, []);
});

// ------------------------------------------------------------- advancing

test('sending the estimate advances the lead to estimate_sent', async () => {
  const { deps, state } = stub({ lead: { id: 'lead-1', stage: 'contacted' } });
  const r = await advanceLeadOnSend('lead-1', deps);
  assert.equal(r.advanced, true);
  assert.equal(state.patches[0].body.stage, 'estimate_sent');
  assert.ok(state.patches[0].body.last_contacted_at, 'sending is a contact');
});

test('a lead already past estimate_sent is left alone', async () => {
  // Someone marked this won. A resend must not drag it backwards.
  for (const stage of ['estimate_sent', 'won', 'lost']) {
    const { deps, state } = stub({ lead: { id: 'lead-1', stage } });
    const r = await advanceLeadOnSend('lead-1', deps);
    assert.equal(r.advanced, false, `stage ${stage}`);
    assert.deepEqual(state.patches, [], `stage ${stage} must not be written`);
  }
});

test('earlier stages do advance', async () => {
  for (const stage of ['new', 'contacted', 'estimate_booked']) {
    const { deps } = stub({ lead: { id: 'lead-1', stage } });
    const r = await advanceLeadOnSend('lead-1', deps);
    assert.equal(r.advanced, true, `stage ${stage} should advance`);
  }
});

test('an unrecognised stage is left alone rather than guessed at', async () => {
  const { deps, state } = stub({ lead: { id: 'lead-1', stage: 'something_new' } });
  const r = await advanceLeadOnSend('lead-1', deps);
  assert.equal(r.advanced, false);
  assert.deepEqual(state.patches, []);
});

test('a failed advance does not sink the send', async () => {
  const { deps } = stub({ lead: { id: 'lead-1', stage: 'new' }, patchFails: 'timeout' });
  const r = await advanceLeadOnSend('lead-1', deps);
  assert.equal(r.advanced, false);
  assert.match(r.reason, /timeout/);
});

// ------------------------------------------------------------- ordering

test('stage order matches the board', () => {
  assert.equal(stageIsBefore('new', 'estimate_sent'), true);
  assert.equal(stageIsBefore('estimate_booked', 'estimate_sent'), true);
  assert.equal(stageIsBefore('won', 'estimate_sent'), false);
  assert.equal(stageIsBefore('lost', 'estimate_sent'), false);
  assert.equal(stageIsBefore('estimate_sent', 'estimate_sent'), false, 'equal is not before');
  assert.equal(stageIsBefore('nonsense', 'estimate_sent'), false);
});
