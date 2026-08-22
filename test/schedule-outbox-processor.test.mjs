// The outbox processor, exercised offline against fakes.
//
// What these tests are really defending: this is the only code in the repo that
// can put a message in front of a customer. The interesting assertions are
// therefore not "it sends" but "it does NOT send" -- every gate, independently,
// with the others open, so a single flag flipped by mistake cannot start
// mailing people.

import test from 'node:test';
import assert from 'node:assert';
import { processOutbox, sendBlockedReason, skipReason, OUTBOX_QUERIES } from '../api/_lib/outbox-processor.js';

const NOW = Date.parse('2026-08-18T12:00:00Z');
const OPEN_ENV = { SCHEDULE_MESSAGING_SEND_ENABLED: 'true', RESEND_API_KEY: 'rk_test' };
const OPEN_SETTINGS = { enabled: true, channels: { email: true } };

// Both channels open. Used by the SMS cases; the email-only OPEN_SETTINGS above
// stays as-is so every pre-existing test keeps testing exactly what it did.
const SMS_ENV = { ...OPEN_ENV, TWILIO_ACCOUNT_SID: 'AC-test', TWILIO_AUTH_TOKEN: 'tok' };
const SMS_SETTINGS = { enabled: true, channels: { email: true, sms: true } };

function harness({ rows = [], settings = OPEN_SETTINGS, env = OPEN_ENV, appointments = {}, send, sendSms } = {}) {
  const updates = [];
  const sends = [];
  const texts = [];
  const claimed = new Set();
  const deps = {
    env,
    now: () => NOW,
    sb: async () => rows,
    loadSettings: async () => settings,
    loadAppointment: async (id) => appointments[id] || null,
    claimRow: async (id) => {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    },
    updateRow: async (id, patch) => { updates.push({ id, ...patch }); },
    sweepStale: async () => 0,
    sendEmail: send || (async (m) => { sends.push(m); return { ok: true, id: 'msg_1' }; }),
    sendSms: sendSms || (async (m) => { texts.push(m); return { ok: true, id: 'SM123' }; }),
  };
  return { deps, updates, sends, texts };
}

const row = (over = {}) => ({
  id: 'r1', step: 'd1', channel: 'email', recipient_contact: 'client@example.com',
  subject: 'Reminder', body: 'See you tomorrow', scheduled_for: '2026-08-18T11:00:00Z',
  status: 'queued', attempts: 0, ...over,
});

// --- the gates -------------------------------------------------------------

test('master switch off: nothing sends, and the reason says which gate', async () => {
  const { deps, sends } = harness({ rows: [row()], settings: { enabled: false, channels: { email: true } } });
  const out = await processOutbox(deps);
  assert.equal(out.sent, 0);
  assert.equal(sends.length, 0);
  assert.match(out.blocked, /master switch/i);
  // Still reports what WOULD have gone -- that number is the point of a preview.
  assert.equal(out.due, 1);
});

test('env var off: nothing sends even with the master switch on', async () => {
  const { deps, sends } = harness({ rows: [row()], env: { RESEND_API_KEY: 'rk_test' } });
  const out = await processOutbox(deps);
  assert.equal(sends.length, 0);
  assert.match(out.blocked, /SCHEDULE_MESSAGING_SEND_ENABLED/);
});

test('no API key: nothing sends', async () => {
  const { deps, sends } = harness({ rows: [row()], env: { SCHEDULE_MESSAGING_SEND_ENABLED: 'true' } });
  const out = await processOutbox(deps);
  assert.equal(sends.length, 0);
  assert.match(out.blocked, /RESEND_API_KEY/);
});

test('email channel off in settings: nothing sends', async () => {
  const { deps, sends } = harness({ rows: [row()], settings: { enabled: true, channels: { email: false } } });
  const out = await processOutbox(deps);
  assert.equal(sends.length, 0);
  assert.match(out.blocked, /email channel/i);
});

test('all gates open: it actually sends', async () => {
  const { deps, sends, updates } = harness({ rows: [row()] });
  const out = await processOutbox(deps);
  assert.equal(out.sent, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, 'client@example.com');
  assert.equal(updates[0].status, 'sent');
});

// --- the test-recipient safety valve ---------------------------------------

test('test recipient redirects every message away from the real client', async () => {
  const { deps, sends, updates } = harness({
    rows: [row({ recipient_contact: 'realclient@example.com' })],
    env: { ...OPEN_ENV, SCHEDULE_MESSAGING_TEST_RECIPIENT: 'chris@ghgrp.net' },
  });
  const out = await processOutbox(deps);
  assert.equal(out.sent, 1);
  assert.equal(sends[0].to, 'chris@ghgrp.net');
  assert.notEqual(sends[0].to, 'realclient@example.com');
  // The body is untouched by the redirect, so the test inbox shows exactly what
  // the customer would have read.
  assert.equal(sends[0].text, 'See you tomorrow');
  assert.match(updates[0].error, /redirected to test recipient/);
});

// --- send-time truth -------------------------------------------------------

test('a cancelled appointment is skipped, not sent', async () => {
  const { deps, sends, updates } = harness({
    rows: [row({ appointment_id: 'a1' })],
    appointments: { a1: { id: 'a1', canceled: true, start_at: '2026-08-19T12:00:00Z' } },
  });
  await processOutbox(deps);
  assert.equal(sends.length, 0);
  assert.equal(updates[0].status, 'skipped');
  assert.match(updates[0].error, /cancelled/);
});

test('a reminder for an appointment that already started is skipped', async () => {
  const { deps, sends } = harness({
    rows: [row({ appointment_id: 'a1' })],
    appointments: { a1: { id: 'a1', canceled: false, start_at: '2026-08-18T09:00:00Z' } },
  });
  await processOutbox(deps);
  assert.equal(sends.length, 0);
});

test('a confirm request is still sent for an appointment under way', async () => {
  // Confirming a visit in progress is useful; reminding someone about it is not.
  const { deps, sends } = harness({
    rows: [row({ step: 'confirm', appointment_id: 'a1' })],
    appointments: { a1: { id: 'a1', canceled: false, start_at: '2026-08-18T09:00:00Z' } },
  });
  await processOutbox(deps);
  assert.equal(sends.length, 1);
});

test('a row with no recipient is skipped rather than attempted', async () => {
  const { deps, sends, updates } = harness({ rows: [row({ recipient_contact: null })] });
  await processOutbox(deps);
  assert.equal(sends.length, 0);
  assert.equal(updates[0].status, 'skipped');
});

// --- sms ------------------------------------------------------------------
// SMS used to be terminally skipped here. It is now delivered via Twilio, so
// these pin the new contract: never emailed by mistake, never skipped merely
// because a gate is shut, and never sent while that gate IS shut.

test('an sms row goes out as a text, and is never emailed instead', async () => {
  const { deps, sends, texts, updates } = harness({
    rows: [row({ channel: 'sms', recipient_contact: '+12035551212' })],
    settings: SMS_SETTINGS, env: SMS_ENV,
  });
  await processOutbox(deps);
  assert.equal(sends.length, 0, 'an sms row must never be emailed');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].to, '+12035551212');
  assert.equal(texts[0].body, 'See you tomorrow');
  assert.equal(updates[0].status, 'sent');
});

test('sms is LEFT QUEUED, not skipped, when its channel is switched off', async () => {
  // The distinction that matters: skipping is terminal, and the gate it is
  // waiting on is one a human opens later.
  const { deps, texts, updates } = harness({
    rows: [row({ channel: 'sms', recipient_contact: '+12035551212' })],
    settings: OPEN_SETTINGS, env: SMS_ENV, // email on, sms off
  });
  const out = await processOutbox(deps);
  assert.equal(texts.length, 0);
  assert.equal(updates.length, 0, 'the row must be left alone, not marked skipped');
  assert.equal(out.results[0].outcome, 'channel-blocked');
  assert.match(out.results[0].reason, /sms channel is off/i);
});

test('sms is left queued when Twilio is not configured', async () => {
  const { deps, texts, updates } = harness({
    rows: [row({ channel: 'sms', recipient_contact: '+12035551212' })],
    settings: SMS_SETTINGS, env: OPEN_ENV, // no Twilio credentials
  });
  const out = await processOutbox(deps);
  assert.equal(texts.length, 0);
  assert.equal(updates.length, 0);
  assert.match(out.results[0].reason, /Twilio is not configured/i);
});

test('email still flows when sms is unconfigured, and vice versa', async () => {
  // One channel being shut must not stop the other.
  const a = harness({ rows: [row()], settings: SMS_SETTINGS, env: OPEN_ENV });
  await processOutbox(a.deps);
  assert.equal(a.sends.length, 1, 'email must send even with Twilio absent');

  const b = harness({
    rows: [row({ channel: 'sms', recipient_contact: '+1' })],
    settings: { enabled: true, channels: { sms: true } },
    env: { SCHEDULE_MESSAGING_SEND_ENABLED: 'true', TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't' },
  });
  await processOutbox(b.deps);
  assert.equal(b.texts.length, 1, 'sms must send even with Resend absent');
});

test('the sms test recipient redirects texts away from the real client', async () => {
  const { deps, texts, updates } = harness({
    rows: [row({ channel: 'sms', recipient_contact: '+12035551212' })],
    settings: SMS_SETTINGS,
    env: { ...SMS_ENV, SCHEDULE_MESSAGING_TEST_SMS_RECIPIENT: '+15550000000' },
  });
  await processOutbox(deps);
  assert.equal(texts[0].to, '+15550000000', 'no real client may be reached during a test');
  assert.match(updates[0].error, /redirected to test recipient/);
});

test('an unknown channel is still terminally skipped', async () => {
  const { deps, updates } = harness({
    rows: [row({ channel: 'carrier-pigeon' })], settings: SMS_SETTINGS, env: SMS_ENV,
  });
  await processOutbox(deps);
  assert.match(updates[0].error, /not implemented/i);
});

test('a failing text is retried like a failing email', async () => {
  const { deps, updates } = harness({
    rows: [row({ channel: 'sms', recipient_contact: '+1', attempts: 0 })],
    settings: SMS_SETTINGS, env: SMS_ENV,
    sendSms: async () => ({ ok: false, error: 'Twilio 500: down' }),
  });
  await processOutbox(deps);
  assert.equal(updates[0].status, 'queued');
  assert.equal(updates[0].attempts, 1);
});

// --- failure handling ------------------------------------------------------

test('a failed send is retried, not lost', async () => {
  const { deps, updates } = harness({
    rows: [row({ attempts: 0 })],
    send: async () => ({ ok: false, error: 'Resend 500' }),
  });
  await processOutbox(deps);
  assert.equal(updates[0].status, 'queued', 'stays queued for the next tick');
  assert.equal(updates[0].attempts, 1);
});

test('retries stop at the limit instead of hammering a bad address forever', async () => {
  const { deps, updates } = harness({
    rows: [row({ attempts: 2 })],
    send: async () => ({ ok: false, error: 'invalid recipient' }),
  });
  await processOutbox(deps);
  assert.equal(updates[0].status, 'failed');
  assert.equal(updates[0].attempts, 3);
});

test('a thrown sender is caught and treated as a failure, not a crash', async () => {
  const { deps, updates } = harness({
    rows: [row()],
    send: async () => { throw new Error('socket hang up'); },
  });
  const out = await processOutbox(deps);
  assert.equal(out.ok, true);
  assert.equal(updates[0].status, 'queued');
  assert.match(updates[0].error, /socket hang up/);
});

test('one bad row does not stop the rest of the batch', async () => {
  let n = 0;
  const { deps, updates } = harness({
    rows: [row({ id: 'bad' }), row({ id: 'good' })],
    send: async () => { n += 1; return n === 1 ? { ok: false, error: 'nope' } : { ok: true }; },
  });
  const out = await processOutbox(deps);
  assert.equal(out.sent, 1);
  assert.equal(updates.length, 2);
});

// --- concurrency -----------------------------------------------------------

test('a row already claimed by a concurrent run is not sent twice', async () => {
  const { deps, sends } = harness({ rows: [row({ id: 'dup' }), row({ id: 'dup' })] });
  const out = await processOutbox(deps);
  // Same id offered twice; the conditional claim only succeeds once.
  assert.equal(sends.length, 1);
  assert.equal(out.results.filter((r) => r.outcome === 'claimed-elsewhere').length, 1);
});

test('stale claims from a dead run are PARKED for a human, never requeued', async () => {
  // Changed deliberately. Requeueing a row stuck in 'sending' assumes the run
  // died before the provider accepted the message -- but it may have died
  // after, and from here the two are indistinguishable, so requeueing can send
  // a customer a second copy. Parking keeps "never silently lost" without
  // buying it at the price of "sometimes silently sent twice".
  let askedBefore = null;
  const { deps } = harness({ rows: [] });
  deps.sweepStale = async (before) => { askedBefore = before; return 2; };
  const out = await processOutbox(deps);
  assert.equal(out.parked, 2);
  assert.equal(out.requeued, 2, 'the old field name stays as an alias so nothing reading it breaks');
  // Ten minutes back, not "now" -- a live run must never be stolen from.
  assert.equal(Date.parse(askedBefore), NOW - 10 * 60 * 1000);
});

test('the old requeueStale dep name still works, so an un-updated caller does not silently stop sweeping', async () => {
  const { deps } = harness({ rows: [] });
  delete deps.sweepStale;
  deps.requeueStale = async () => 3;
  const out = await processOutbox(deps);
  assert.equal(out.parked, 3);
});

// --- unit-level ------------------------------------------------------------

test('sendBlockedReason returns null only when every gate is open', () => {
  assert.equal(sendBlockedReason(OPEN_SETTINGS, OPEN_ENV), null);
  assert.ok(sendBlockedReason(null, OPEN_ENV));
  assert.ok(sendBlockedReason({ enabled: true, channels: {} }, OPEN_ENV));
});

test('skipReason passes a good row', () => {
  assert.equal(skipReason(row(), null, NOW), null);
});

// --- the queries themselves ------------------------------------------------
// These pin the exact defect a self-review caught before this shipped: the
// stale-claim sweep originally filtered on scheduled_for, which is the time the
// message was DUE, not the time the claim was taken.

test('the stale sweep measures from claimed_at, never scheduled_for', () => {
  const q = OUTBOX_QUERIES.stale('2026-08-18T11:50:00.000Z');
  assert.match(q, /claimed_at=lt\./);
  assert.equal(
    /scheduled_for/.test(q), false,
    'filtering on scheduled_for matches every backlogged row the instant it is claimed, so a second tick steals a row the first is mid-send on and the customer is emailed twice',
  );
  assert.match(q, /status=eq\.sending/);
});

test('the claim is conditional on the row still being queued', () => {
  // This predicate IS the lock. Without status=eq.queued two ticks both "claim"
  // the same row and both send it.
  assert.match(OUTBOX_QUERIES.claim('abc'), /status=eq\.queued/);
});

test('the due query only ever selects queued rows that are actually due', () => {
  const q = OUTBOX_QUERIES.due('2026-08-18T12:00:00.000Z', 50);
  assert.match(q, /status=eq\.queued/);
  assert.match(q, /scheduled_for=lte\./);
});
