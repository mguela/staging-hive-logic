// What a change to an appointment does to its already-queued messages.

import test from 'node:test';
import assert from 'node:assert';
import {
  REMINDER_STEPS, moveInvalidatesReminders, staleReminderQuery, queuedForAppointmentQuery,
} from '../api/_lib/reminder-resync.js';

test('moving the time invalidates reminders', () => {
  assert.equal(moveInvalidatesReminders({ start_at: '2026-08-20T14:00:00Z' }), true);
  assert.equal(moveInvalidatesReminders({ end_at: '2026-08-20T16:00:00Z' }), true);
});

test('reassigning crew does not', () => {
  // "Your appointment is Tuesday at 2" is still true after a crew swap.
  assert.equal(moveInvalidatesReminders({ crew_jids: ['1', '2'] }), false);
  assert.equal(moveInvalidatesReminders({ lead_jid: '7' }), false);
  assert.equal(moveInvalidatesReminders({}), false);
  assert.equal(moveInvalidatesReminders(null), false);
});

test('a move drops reminders but never the confirm row', () => {
  const q = staleReminderQuery('a1');
  for (const step of REMINDER_STEPS) assert.ok(q.includes(step), `${step} must be dropped`);
  assert.equal(
    q.includes('confirm'), false,
    're-queueing the confirm row re-mints the token and kills the link already in the customer inbox',
  );
});

test('a move only touches rows that have not been sent', () => {
  assert.match(staleReminderQuery('a1'), /status=eq\.queued/);
  assert.match(queuedForAppointmentQuery('a1'), /status=eq\.queued/);
});

test('a cancellation retires everything still queued, confirm included', () => {
  const q = queuedForAppointmentQuery('a1');
  assert.match(q, /appointment_id=eq\.a1/);
  assert.equal(/step=in/.test(q), false, 'a cancelled visit should send nothing at all');
});

test('the appointment id is encoded, not interpolated raw', () => {
  assert.ok(staleReminderQuery('a b&c').includes(encodeURIComponent('a b&c')));
});
