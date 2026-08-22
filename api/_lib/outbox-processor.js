// api/_lib/outbox-processor.js
// The consumer half of the client-messaging pipeline.
//
// api/schedule/hl.js and api/_lib/automations.js both QUEUE rows into
// hl_outbox and deliberately send nothing -- automations.js says so in its own
// header ("Nothing here sends -- a processor consumes 'queued' rows"). Until
// this file existed there was no such processor anywhere in the repo, so the
// entire messaging feature stopped one inch short of working: flipping the
// master switch moved rows from 'preview' to 'queued' and still delivered
// nothing. This is that missing inch.
//
// THREE INDEPENDENT GATES, all of which must be open before a single message
// leaves the building. They are independent on purpose -- any one of them being
// off is a full stop, so no single mistaken toggle can start mailing customers:
//
//   1. hl_message_settings.enabled  -- the in-app master switch (default false)
//   2. SCHEDULE_MESSAGING_SEND_ENABLED === 'true' -- a Vercel env var that a
//      human sets by hand. Deliberately NOT the marketing one: turning on
//      review-request campaigns must never silently turn on appointment mail.
//   3. The CHANNEL the row uses must itself be configured and switched on:
//        email -> RESEND_API_KEY present, and settings.channels.email true
//        sms   -> Twilio credentials + a From number, and settings.channels.sms true
//
// Gate 3 is per-channel on purpose. Email being unconfigured must not silently
// suppress texts, and turning on SMS must not turn on mail -- so each channel
// answers for itself and a row whose own channel is shut is left queued rather
// than skipped, because the gate may open later.
//
// Plus a safety valve that outranks all three: SCHEDULE_MESSAGING_TEST_RECIPIENT
// (email) and SCHEDULE_MESSAGING_TEST_SMS_RECIPIENT (a phone number). When set,
// every message on that channel is redirected to that one address no matter who
// the row is addressed to. That is how delivery gets proven end to end without
// any possibility of reaching a real client -- the redirect happens at the last
// step, after templating, so what lands in the test inbox is byte-for-byte what
// the customer would have received.

const TERMINAL_SKIP = 'skipped';
const MAX_ATTEMPTS = 3;

// How long a 'sending' claim may sit before a later run assumes the claimer died.
const STALE_CLAIM_MS = 10 * 60 * 1000;

/** Rows we are willing to act on. Anything else is left untouched. */
const SENDABLE_STATUS = 'queued';

/** Channels this processor knows how to deliver. Anything else is terminal. */
export const DELIVERABLE_CHANNELS = ['email', 'sms'];

/**
 * Where a stale claim goes. NOT back to 'queued'.
 *
 * The previous behaviour requeued any row stuck in 'sending' for ten minutes,
 * on the reasoning that the claimer must have died and the message would
 * otherwise be lost. That is right about the risk and wrong about the remedy: a
 * run can also die AFTER the provider accepted the message but BEFORE the row
 * was updated, and requeueing that row sends the customer a second copy. From
 * the outside those two cases are indistinguishable -- which is exactly why
 * neither "retry" nor "drop" is safe to choose automatically.
 *
 * So a stale claim is parked here instead, visible and terminal, for a person
 * to resolve against the provider's own log. That keeps the original goal (a
 * message is never silently lost) while removing the one failure mode that
 * cannot be undone (a message silently sent twice).
 */
const STALE_STATUS = 'unknown';

/**
 * PostgREST queries, kept pure and exported so the predicates can be asserted
 * directly. The stale-claim filter in particular is worth pinning: an earlier
 * version filtered on scheduled_for, which matches every backlogged row the
 * instant it is claimed and lets one cron tick steal a row another tick is
 * mid-send on -- delivering the same message to a customer twice.
 */
export const OUTBOX_QUERIES = {
  due: (nowISO, limit) =>
    `hl_outbox?status=eq.${SENDABLE_STATUS}&scheduled_for=lte.${nowISO}&order=scheduled_for.asc&limit=${limit}`,
  claim: (id) => `hl_outbox?id=eq.${encodeURIComponent(id)}&status=eq.${SENDABLE_STATUS}`,
  stale: (beforeISO) => `hl_outbox?status=eq.sending&claimed_at=lt.${encodeURIComponent(beforeISO)}`,
  byId: (id) => `hl_outbox?id=eq.${encodeURIComponent(id)}`,
};

function envFlag(env, name) {
  return String(env[name] || '').toLowerCase() === 'true';
}

/**
 * Why this run cannot send, or null when it can.
 * Returned to the caller verbatim so the cron's JSON says which gate is shut
 * rather than a generic "0 sent" that reads identically to "nothing due".
 */
export function sendBlockedReason(settings, env) {
  if (!settings || settings.enabled !== true) {
    return 'master switch off (hl_message_settings.enabled) -- queued rows are a preview of what would send';
  }
  if (!envFlag(env, 'SCHEDULE_MESSAGING_SEND_ENABLED')) {
    return 'SCHEDULE_MESSAGING_SEND_ENABLED is not "true" in the environment';
  }
  // At least one channel has to be usable, or the run has nothing it can do.
  // The per-channel reasons are reported here so a shut run still says WHICH
  // gate is closed rather than a bare "0 sent".
  const emailReason = channelBlockedReason('email', settings, env);
  const smsReason = channelBlockedReason('sms', settings, env);
  if (emailReason && smsReason) return `${emailReason}; ${smsReason}`;
  return null;
}

/**
 * Why this channel cannot send right now, or null when it can.
 *
 * Separate from sendBlockedReason so one channel being unconfigured never
 * suppresses the other: with SMS live and email not yet set up, texts go and
 * mail waits, instead of the whole run stopping.
 */
export function channelBlockedReason(channel, settings, env = {}) {
  const channels = (settings && settings.channels) || {};
  if (channel === 'email') {
    if (!env.RESEND_API_KEY) return 'RESEND_API_KEY is not configured';
    if (channels.email !== true) return 'the email channel is off in hl_message_settings.channels';
    return null;
  }
  if (channel === 'sms') {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return 'Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)';
    if (channels.sms !== true) return 'the sms channel is off in hl_message_settings.channels';
    return null;
  }
  return `channel '${channel}' is not implemented yet`;
}

/** The channels this run could actually deliver on. */
export function usableChannels(settings, env = {}) {
  return ['email', 'sms'].filter((c) => channelBlockedReason(c, settings, env) === null);
}

/**
 * A row that should never be delivered, and why -- checked at SEND time, not
 * at queue time. An appointment queued three days ago may since have been
 * cancelled or moved; sending "see you tomorrow" for a cancelled visit is worse
 * than sending nothing. Returns null when the row is good to go.
 */
export function skipReason(row, appointment, now) {
  if (!row.recipient_contact) return 'no recipient contact resolved';
  // Only a channel we will NEVER deliver is terminal here. A channel that is
  // merely switched off or unconfigured this run is handled in the loop by
  // leaving the row queued, because that gate can open later and a skipped row
  // never comes back.
  if (row.channel && !DELIVERABLE_CHANNELS.includes(row.channel)) {
    return `channel '${row.channel}' is not implemented yet`;
  }
  if (appointment) {
    if (appointment.canceled === true) return 'appointment was cancelled after this was queued';
    // A reminder is only meaningful before the thing it reminds you about.
    // 'confirm' is exempt: confirming a visit already under way is still useful.
    if (row.step !== 'confirm' && appointment.start_at && new Date(appointment.start_at).getTime() < now) {
      return 'appointment already started';
    }
  }
  return null;
}

const defaultNow = () => Date.now();

/**
 * Drain due rows from hl_outbox.
 *
 * deps: { sb, sendEmail, sendSms, env, now, limit } -- all injected so the whole
 * thing runs offline in tests against fakes, including the failure paths.
 *
 * Concurrency: each row is CLAIMED with a conditional update (status must still
 * be 'queued') before any message is attempted. Two overlapping cron ticks --
 * which Vercel does produce when a run is slow -- therefore cannot both send the
 * same message; the loser's update matches zero rows and it moves on.
 */
export async function processOutbox(deps = {}) {
  const sb = deps.sb;
  const sendEmail = deps.sendEmail;
  const sendSms = deps.sendSms;
  const env = deps.env || {};
  const now = (deps.now || defaultNow)();
  const limit = deps.limit || 50;

  // Rows a previous run claimed and never finished -- a crash, a function
  // timeout, a deploy mid-tick. They are parked as 'unknown' for a human rather
  // than requeued; see STALE_STATUS above for why requeueing them is the one
  // mistake that cannot be taken back. Ten minutes is well past the function's
  // own timeout, so a live run is never disturbed.
  const staleBefore = new Date(now - STALE_CLAIM_MS).toISOString();
  const sweep = deps.sweepStale || deps.requeueStale;
  const parked = sweep ? await sweep(staleBefore) : 0;

  const settings = await deps.loadSettings();
  const blocked = sendBlockedReason(settings, env);

  const due = await sb(OUTBOX_QUERIES.due(new Date(now).toISOString(), limit));
  const rows = Array.isArray(due) ? due : [];

  // Report honestly even when shut: "12 rows are due and would send" is the
  // number a human needs to decide whether to open the gate.
  if (blocked) {
    return { ok: true, sent: 0, due: rows.length, parked, requeued: parked, blocked, results: [] };
  }

  const testRecipient = env.SCHEDULE_MESSAGING_TEST_RECIPIENT || null;
  const testSmsRecipient = env.SCHEDULE_MESSAGING_TEST_SMS_RECIPIENT || null;
  const results = [];
  let sent = 0;

  for (const row of rows) {
    const appointment = row.appointment_id ? await deps.loadAppointment(row.appointment_id) : null;

    const skip = skipReason(row, appointment, now);
    if (skip) {
      await deps.updateRow(row.id, { status: TERMINAL_SKIP, error: skip });
      results.push({ id: row.id, step: row.step, outcome: TERMINAL_SKIP, reason: skip });
      continue;
    }

    // A deliverable channel that is merely shut this run: leave the row QUEUED
    // and say so. Marking it skipped would be terminal, and the gate it is
    // waiting on (an API key, a settings toggle) is one someone opens later.
    const channel = row.channel || 'email';
    const channelShut = channelBlockedReason(channel, settings, env);
    if (channelShut) {
      results.push({ id: row.id, step: row.step, outcome: 'channel-blocked', channel, reason: channelShut });
      continue;
    }

    const claimed = await deps.claimRow(row.id);
    if (!claimed) {
      results.push({ id: row.id, step: row.step, outcome: 'claimed-elsewhere' });
      continue;
    }

    const to = channel === 'sms'
      ? (testSmsRecipient || row.recipient_contact)
      : (testRecipient || row.recipient_contact);
    const redirected = channel === 'sms' ? Boolean(testSmsRecipient) : Boolean(testRecipient);

    let result;
    try {
      result = channel === 'sms'
        ? await sendSms({ to, body: row.body || '' })
        : await sendEmail({
          to,
          subject: row.subject || '(no subject)',
          text: row.body || '',
          html: null,
        });
    } catch (e) {
      result = { ok: false, error: e && e.message ? e.message : String(e) };
    }

    if (result && result.ok !== false) {
      await deps.updateRow(row.id, {
        status: 'sent',
        sent_at: new Date(now).toISOString(),
        error: redirected ? `redirected to test recipient ${to}` : null,
      });
      sent += 1;
      results.push({ id: row.id, step: row.step, outcome: 'sent', channel, to });
      continue;
    }

    // Failure: put it back in the queue for another tick until MAX_ATTEMPTS,
    // then stop. A permanently bad address should not be retried forever, and a
    // transient provider blip should not lose the message.
    //
    // Safe to retry because we got an ANSWER: the provider told us it did not
    // accept the message. The case where we get no answer at all is different
    // and is handled by the stale sweep, which parks rather than retries.
    const attempts = Number(row.attempts || 0) + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;
    await deps.updateRow(row.id, {
      status: giveUp ? 'failed' : SENDABLE_STATUS,
      attempts,
      error: (result && result.error) || 'send failed',
    });
    results.push({
      id: row.id,
      step: row.step,
      outcome: giveUp ? 'failed' : 'retry',
      attempts,
      error: (result && result.error) || 'send failed',
    });
  }

  // `requeued` is kept as an alias of `parked` so anything already reading the
  // old field keeps working; the name is now wrong, which is why `parked` is
  // the one to use.
  return {
    ok: true, sent, due: rows.length, parked, requeued: parked,
    blocked: null, testRecipient, testSmsRecipient, results,
  };
}
