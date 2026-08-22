// The customer-facing confirm/decline link.
//
// This is the only appointment surface reachable without an account, so most of
// what is asserted here is what the link CANNOT do.

import test from 'node:test';
import assert from 'node:assert';
import {
  isWellFormedToken, refuseReason, decisionPatch, resolveToken, CONFIRM_STATES,
} from '../api/_lib/appointment-confirm.js';
import { genToken, hashToken } from '../api/_lib/portal-auth.js';

const NOW = Date.parse('2026-08-18T12:00:00Z');
const appt = (over = {}) => ({
  id: 'a1', client: 'Someone', start_at: '2026-08-19T14:00:00Z', end_at: '2026-08-19T16:00:00Z',
  canceled: false, confirm_state: 'unconfirmed', confirm_expires_at: '2026-08-19T16:00:00Z', ...over,
});

// --- token shape -----------------------------------------------------------

test('only a 64-hex token is even considered', () => {
  assert.equal(isWellFormedToken(genToken(32)), true);
  for (const bad of ['', null, undefined, 'short', 'g'.repeat(64), '../../etc/passwd', "' or 1=1--", 'a'.repeat(63), 'a'.repeat(65)]) {
    assert.equal(isWellFormedToken(bad), false, `${String(bad)} must be rejected`);
  }
});

test('a malformed token never reaches the database', async () => {
  let looked = 0;
  const out = await resolveToken('not-a-token', { loadByHash: async () => { looked += 1; return appt(); } });
  assert.equal(out, null);
  assert.equal(looked, 0, 'a lookup per guess is what makes brute force cheap for the attacker');
});

test('lookup is by hash — the raw token is never used as a key', async () => {
  const raw = genToken(32);
  let sawKey = null;
  await resolveToken(raw, { loadByHash: async (h) => { sawKey = h; return appt(); } });
  assert.equal(sawKey, hashToken(raw));
  assert.notEqual(sawKey, raw);
});

// --- refusals --------------------------------------------------------------

test('unknown and expired tokens are refused with identical wording', () => {
  const unknown = refuseReason(null, NOW);
  const expired = refuseReason(appt({ confirm_expires_at: '2026-08-17T00:00:00Z' }), NOW);
  assert.equal(unknown, expired, 'different wording lets an attacker learn which tokens exist');
});

test('a cancelled appointment cannot be confirmed', () => {
  assert.match(refuseReason(appt({ canceled: true }), NOW), /cancelled/i);
});

test('a live, unexpired appointment is not refused', () => {
  assert.equal(refuseReason(appt(), NOW), null);
});

// --- decisions -------------------------------------------------------------

test('confirm and decline are the only accepted decisions', () => {
  assert.ok(decisionPatch(appt(), 'confirmed', NOW));
  assert.ok(decisionPatch(appt(), 'declined', NOW));
  for (const bad of ['cancelled', 'deleted', 'moved', '', null, 'CONFIRMED', 'unconfirmed']) {
    assert.equal(decisionPatch(appt(), bad, NOW), null, `${String(bad)} must not be writable through a public link`);
  }
});

test('the patch touches only the confirm columns', () => {
  const patch = decisionPatch(appt(), 'confirmed', NOW);
  assert.deepEqual(Object.keys(patch).sort(), ['confirm_state', 'confirmed_at']);
  // Explicitly: a public token must not be able to move or cancel a visit.
  for (const forbidden of ['start_at', 'end_at', 'canceled', 'crew_jids', 'client', 'job_no']) {
    assert.equal(forbidden in patch, false);
  }
});

test('clicking confirm twice is a no-op, not an error', () => {
  assert.equal(decisionPatch(appt({ confirm_state: 'confirmed' }), 'confirmed', NOW), null);
});

test('a customer may change their mind after confirming', () => {
  const patch = decisionPatch(appt({ confirm_state: 'confirmed' }), 'declined', NOW);
  assert.equal(patch.confirm_state, 'declined');
});

test('every state the patch can produce is one the schema allows', () => {
  for (const d of ['confirmed', 'declined']) {
    assert.ok(CONFIRM_STATES.includes(decisionPatch(appt(), d, NOW).confirm_state));
  }
});

test('a token with no expiry is refused, not treated as immortal', () => {
  // Only reachable from a half-written row, but the failure mode -- a confirm
  // link that works forever -- is bad enough to close explicitly.
  assert.ok(refuseReason(appt({ confirm_expires_at: null }), NOW));
});
