// api/schedule/outbox.js
// Cron entry point for the client-messaging outbox.
//
// GET /api/schedule/outbox?resource=process   (Vercel Cron, Bearer CRON_SECRET)
//
// All of the judgement lives in api/_lib/outbox-processor.js so it can be
// tested offline; this file is the thin shell that authenticates the cron and
// binds the real Supabase and Resend clients to it.
//
// Pinned to GET because Vercel Cron issues GET, and because a POST door into a
// sender is exactly the shape of thing that must not exist.
import { supabaseRequest } from '../_lib/jobber.js';
import { sendEmail } from '../_lib/email.js';
import { twilioRequest } from '../_lib/voice.js';
import { processOutbox, OUTBOX_QUERIES } from '../_lib/outbox-processor.js';

// The SMS half of the sender. Same shape as sendEmail() — never throws for an
// ordinary refusal, returns { ok, id, error } — so the processor's retry logic
// treats both channels identically.
//
// The From number is the company's active main line, the same one the voice
// webhook texts voicemail alerts from, so replies land where staff already
// look instead of on a number nobody watches.
async function sendSmsVia(supabase) {
  let cachedFrom;
  return async function sendSms({ to, body }) {
    if (!to) return { ok: false, error: 'no phone number on this row' };
    if (cachedFrom === undefined) {
      const r = await supabase('voice_numbers?role=eq.main&active=eq.true&select=e164&limit=1');
      const rows = Array.isArray(r) ? r : [];
      cachedFrom = rows[0] ? rows[0].e164 : null;
    }
    if (!cachedFrom) return { ok: false, error: 'no active main number to send from (voice_numbers role=main)' };

    let res;
    try {
      res = await twilioRequest('Messages.json', {
        method: 'POST',
        body: new URLSearchParams({ From: cachedFrom, To: to, Body: body || '' }),
      });
    } catch (e) {
      // No answer from Twilio. Surfaced as a failure so the row is retried at
      // most MAX_ATTEMPTS times rather than left claimed; the stale sweep is
      // what covers the case where the process dies outright.
      return { ok: false, error: `no response from Twilio: ${e && e.message ? e.message : String(e)}` };
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, error: `Twilio ${res.status}: ${text.slice(0, 300)}` };
    let sid = null;
    try { sid = JSON.parse(text).sid || null; } catch (e) { sid = null; }
    return { ok: true, id: sid };
  };
}

async function sbJson(path, opts) {
  const r = await supabaseRequest(path, opts);
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { ok: r.ok, status: r.status, json };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only.' });
  }

  // The edge guard already checks this, but a handler that trusts the edge
  // alone breaks the moment someone reaches it by another route.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ ok: false, error: 'Not authorized.' });
  }

  const resource = (req.query && req.query.resource) || '';
  if (resource !== 'process') {
    return res.status(400).json({ ok: false, error: "resource must be 'process'." });
  }

  try {
    // A failed read must NOT look like an empty queue. Without this throw a
    // Supabase outage returns 200 {sent: 0, due: 0} -- indistinguishable from
    // a healthy idle tick, on a job whose health signal is already
    // 'unverifiable'. Throwing surfaces it as a 500 in the cron log.
    const readOrThrow = async (path) => {
      const r = await sbJson(path);
      if (!r.ok) throw new Error(`Supabase read failed (${r.status}) for ${String(path).split('?')[0]}`);
      return r.json;
    };

    const out = await processOutbox({
      env: process.env,
      sendEmail,
      sendSms: await sendSmsVia(readOrThrow),
      sb: async (path) => {
        const r = await sbJson(path);
        if (!r.ok) throw new Error(`Supabase read failed (${r.status}) for ${String(path).split('?')[0]}`);
        return r.json;
      },
      loadSettings: async () => {
        const r = await sbJson('hl_message_settings?id=eq.true&select=*');
        return (Array.isArray(r.json) ? r.json : [])[0] || null;
      },
      loadAppointment: async (id) => {
        const r = await sbJson(`hl_appointments?id=eq.${encodeURIComponent(id)}&select=id,start_at,canceled`);
        return (Array.isArray(r.json) ? r.json : [])[0] || null;
      },
      // Conditional claim: the status=eq.queued predicate is the lock. If a
      // concurrent tick already moved this row, zero rows come back and we
      // treat it as claimed elsewhere rather than sending twice.
      claimRow: async (id) => {
        const r = await sbJson(
          OUTBOX_QUERIES.claim(id),
          { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'sending', claimed_at: new Date().toISOString() }) },
        );
        return Array.isArray(r.json) && r.json.length > 0;
      },
      // Rows a dead run left claimed. Measured from claimed_at -- when the
      // claim was TAKEN -- not from scheduled_for. Filtering on scheduled_for
      // would match every backlogged row the moment it was claimed, letting one
      // tick steal a row another tick is actively sending and deliver it twice.
      //
      // These are PARKED as 'unknown', not requeued. A run can die after the
      // provider accepted the message and before the row was updated, and from
      // here that is indistinguishable from dying before the call went out --
      // so requeueing risks sending a customer a second copy of something they
      // already received. Parking keeps the row visible for a human to settle
      // against the provider's log, which preserves "never silently lost"
      // without buying it at the price of "sometimes silently sent twice".
      sweepStale: async (before) => {
        const r = await sbJson(
          OUTBOX_QUERIES.stale(before),
          {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
              status: 'unknown',
              error: 'Claimed by a run that never finished. It is not known whether the provider accepted this message -- check the provider log before requeueing by hand.',
            }),
          },
        );
        return Array.isArray(r.json) ? r.json.length : 0;
      },
      updateRow: async (id, patch) => {
        await sbJson(OUTBOX_QUERIES.byId(id), {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
      },
    });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
}
