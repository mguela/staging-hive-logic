// api/_lib/reminder-resync.js
// Which queued messages a change to an appointment invalidates.
//
// Kept separate from api/schedule/hl.js so the rules are assertable without a
// database. The rules are small but each one is load-bearing:
//
//   - Only REMINDERS are dropped. A 'confirm' row is left alone even when it is
//     still queued, because re-queueing re-mints the token and kills the link
//     already sitting in the customer's inbox.
//   - Only QUEUED rows. Anything sent is history; rewriting it would make the
//     outbox lie about what the customer actually received.
//   - Only when the TIME moved. Reassigning crew does not make "your
//     appointment is Tuesday at 2" wrong, and requeueing on every edit churns
//     the outbox for nothing.

export const REMINDER_STEPS = ['d3', 'd1', 'd0', 'h1'];

/** Does this move actually invalidate the queued reminders? */
export function moveInvalidatesReminders(patch) {
  if (!patch) return false;
  return Boolean(patch.start_at || patch.end_at);
}

/** The rows a move should drop: this appointment's queued reminders only. */
export function staleReminderQuery(apptId) {
  return `hl_outbox?appointment_id=eq.${encodeURIComponent(apptId)}&status=eq.queued&step=in.(${REMINDER_STEPS.join(',')})`;
}

/** The rows a cancellation should retire. */
export function queuedForAppointmentQuery(apptId) {
  return `hl_outbox?appointment_id=eq.${encodeURIComponent(apptId)}&status=eq.queued`;
}
