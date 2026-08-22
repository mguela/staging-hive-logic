// The unattended half of Reina's mail: read the inbox and reach him on his
// desktop, with no HiveLogic tab open and nobody signed in.
//
// Chris, 2026-08-19: "lets add the notifications while hivelogic is closed."
//
// Until now every read started from his browser -- the login scan, the popup's
// poll. Close the tab and Reina stopped looking, however urgent the mail. This
// runs on a schedule instead, and it can, because the mailbox credentials live
// in hc_ms_tokens on the server rather than in the page.
//
// WHAT IT WILL NOT DO:
//   - It never sends for junk or fyi. That filter lives in shouldNotify and no
//     sender rule can override it.
//   - It never decides on its own that he does not care. Silence only ever
//     comes from a rule he pressed.
//   - It never sends the same message twice: notified_at is stamped before the
//     next sweep can look, and a message he already acted on is skipped.
//   - It cannot read the Gmail mailbox. Those credentials live in the other
//     Supabase project and only /api/mail can open them, which needs a browser
//     session. That is a real gap and it is reported, not hidden.

import { supabaseRequest as defaultSupabaseRequest } from '../_lib/jobber.js';
import { requireApiAuth } from '../_lib/guard.js';
import { scanMailboxes } from './mail-triage.js';
import { shouldNotify, isQuietHour, notificationFor, NOTIFY_LABELS } from '../_lib/reina-notify.js';
import { sendPush, vapidConfigured } from '../_lib/reina-push-send.js';

function enc(v) { return encodeURIComponent(String(v)); }

// At most this many toasts per owner per sweep. Chris's whole complaint about
// the in-app popup was that a backlog arrived as a conveyor belt; a backlog
// arriving as eleven Windows toasts is the same mistake with a louder speaker.
// The rest are left unnotified and the count rides along on the last one.
export const MAX_TOASTS_PER_SWEEP = 3;

// Only mail that just ARRIVED can interrupt him. Older than this is backlog,
// and backlog belongs on the Team To-Do where a list belongs.
//
// This is not a guess. The morning this was built there were 129 open
// actionable rows in the table and 5 of them were from the last four hours.
// Without this line the first sweep would have started working through all 129
// at three Windows toasts every ten minutes -- seven hours of pinging, which is
// precisely the complaint that started this ("im getting a bunch of email
// notifications"), rebuilt on top of the operating system where he cannot
// dismiss it as easily.
//
// Nothing is lost: an old row keeps notified_at null, stays on the Team To-Do,
// and still shows up in the in-app popup the moment he opens HiveLogic.
export const FRESH_MS = 4 * 60 * 60 * 1000;

/** Owners who have at least one live browser subscribed. Nobody else is worth
 *  spending a mailbox read or a model call on. */
async function ownersToSweep(deps) {
  const r = await deps.supabaseRequest(
    'reina_push_subscriptions?failed_at=is.null&select=owner_id'
  );
  if (!r.ok) return [];
  const rows = (await r.json().catch(() => [])) || [];
  return [...new Set(rows.map((x) => x.owner_id).filter(Boolean))];
}

async function notifyRulesFor(ownerId, deps) {
  const r = await deps.supabaseRequest(
    `reina_notify_rules?owner_id=eq.${enc(ownerId)}&select=match_kind,match_value,notify&limit=500`
  );
  if (!r.ok) return [];       // rules failing must not turn into silence
  return (await r.json().catch(() => [])) || [];
}

async function subscriptionsFor(ownerId, deps) {
  const r = await deps.supabaseRequest(
    `reina_push_subscriptions?owner_id=eq.${enc(ownerId)}&failed_at=is.null&select=*`
  );
  if (!r.ok) return [];
  return (await r.json().catch(() => [])) || [];
}

/** Judged, not dealt with, never sent -- newest first, because if he is only
 *  getting three then they should be the three that just happened. */
async function candidatesFor(ownerId, deps) {
  const labels = NOTIFY_LABELS.map((l) => `"${l}"`).join(',');
  const r = await deps.supabaseRequest(
    `reina_mail_triage?owner_id=eq.${enc(ownerId)}` +
    `&notified_at=is.null&acted_at=is.null` +
    `&or=(and(corrected_label.is.null,label.in.(${labels})),corrected_label.in.(${labels}))` +
    `&select=message_id,graph_id,home_account_id,subject,from_name,from_address,received_at,` +
    `label,corrected_label,reason,summary_text,action_text,notified_at,acted_at` +
    `&order=received_at.desc&limit=50`
  );
  if (!r.ok) return [];
  return (await r.json().catch(() => [])) || [];
}

export async function sweepOwner(ownerId, deps, opts) {
  const options = opts || {};
  const now = (deps.now || (() => new Date()))();
  const quiet = isQuietHour(now, options.timeZone, options.quietFrom, options.quietTo);

  // Read the mailbox first. Without this the sweep can only ever notify about
  // mail some browser already pulled, which is the exact limitation it exists
  // to remove.
  let scan = null;
  let scanError = null;
  try {
    scan = await scanMailboxes(ownerId, deps);
  } catch (e) {
    // A mailbox that needs reconnecting must not stop him being told about the
    // mail already judged and still waiting.
    scanError = String((e && e.message) || e).slice(0, 200);
  }

  const rules = await notifyRulesFor(ownerId, deps);
  const rows = await candidatesFor(ownerId, deps);

  const freshMs = Number.isFinite(options.freshMs) ? options.freshMs : FRESH_MS;
  const cutoff = now.getTime() - freshMs;
  const worth = [];
  const held = [];
  let stale = 0;
  for (const row of rows) {
    const at = row.received_at ? new Date(row.received_at).getTime() : 0;
    if (at && at < cutoff) { stale += 1; continue; }
    const verdict = shouldNotify(row, rules, { quiet });
    if (verdict.notify) worth.push(row);
    else if (verdict.reason === 'quiet hours') held.push(row);
  }

  if (!worth.length) {
    return {
      ownerId, sent: 0, quiet, heldForQuietHours: held.length, backlogSkipped: stale,
      scanned: scan ? scan.rows && scan.rows.length : 0, scanError,
    };
  }

  const subs = await subscriptionsFor(ownerId, deps);
  if (!subs.length) return { ownerId, sent: 0, note: 'no live subscription', scanError };

  const batch = worth.slice(0, MAX_TOASTS_PER_SWEEP);
  const overflow = worth.length - batch.length;
  let sent = 0;

  for (let i = 0; i < batch.length; i++) {
    const row = batch[i];
    // The "+N more" rides on the LAST toast only. Putting it on every one of
    // three toasts is three lies of the same count.
    const extra = (i === batch.length - 1) ? overflow : 0;
    const result = await sendPush(subs, notificationFor(row, extra), deps);
    if (result.sent > 0) {
      sent += 1;
      // Stamped only after a push service accepted it. Stamping first would
      // mean one bad minute at Google silently costs him that email forever.
      await deps.supabaseRequest(
        `reina_mail_triage?owner_id=eq.${enc(ownerId)}&message_id=eq.${enc(row.message_id)}`,
        { method: 'PATCH', body: JSON.stringify({ notified_at: now.toISOString() }) }
      ).catch(() => {});
    }
  }

  return {
    ownerId, sent, quiet, considered: rows.length, worth: worth.length,
    overflow, heldForQuietHours: held.length, backlogSkipped: stale, scanError,
  };
}

export default async function handler(req, res, injected = {}) {
  const deps = Object.assign({
    supabaseRequest: defaultSupabaseRequest,
    fetchImpl: (...a) => fetch(...a),
  }, injected);

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use GET or POST.' });
  }
  const auth = await requireApiAuth(req, { fetchImpl: deps.fetchImpl });
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Authentication required.' });

  if (!vapidConfigured()) {
    // Said plainly rather than reported as a successful sweep that sent
    // nothing -- "it ran fine and you got nothing" is the worst possible
    // description of a missing key.
    return res.status(200).json({
      ok: true, enabled: false, swept: 0,
      note: 'Desktop notifications are off: set REINA_VAPID_PUBLIC_KEY and REINA_VAPID_PRIVATE_KEY, then reload HiveLogic and turn them on.',
    });
  }

  if (!deps.anthropic) {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      deps.anthropic = new Anthropic();
    } catch (_) { deps.anthropic = null; }
  }

  // A single owner can be swept on demand, which is how this gets tested
  // without waiting for the schedule.
  const only = (auth.user && auth.user.id && req.method === 'POST') ? auth.user.id : null;
  const owners = only ? [only] : await ownersToSweep(deps);

  const results = [];
  for (const ownerId of owners) {
    try {
      results.push(await sweepOwner(ownerId, deps, {
        timeZone: process.env.REINA_NOTIFY_TZ || 'America/New_York',
        quietFrom: Number(process.env.REINA_NOTIFY_QUIET_FROM || 21),
        quietTo: Number(process.env.REINA_NOTIFY_QUIET_TO || 7),
      }));
    } catch (e) {
      // One owner's broken mailbox must not end the sweep for everyone else.
      results.push({ ownerId, sent: 0, error: String((e && e.message) || e).slice(0, 200) });
    }
  }

  return res.status(200).json({
    ok: true,
    enabled: true,
    swept: owners.length,
    sent: results.reduce((n, r) => n + (r.sent || 0), 0),
    results,
  });
}
