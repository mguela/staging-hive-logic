// api/schedule/confirm.js
// The customer-facing confirm/decline link.
//
// GET  /api/schedule/confirm?token=...            -> a small HTML page
// POST /api/schedule/confirm  { token, decision }  -> records the decision
//
// PUBLIC BY NECESSITY: the person clicking this has no HiveLogic account and
// never will. That makes it the most exposed surface in the scheduling system,
// so it is scoped as tightly as it can be:
//
//   - The token is 256 bits of CSPRNG entropy, stored only as a SHA-256 hash.
//   - It authorises exactly two writes (confirm / decline) to exactly one
//     column of exactly one appointment. It cannot move, cancel, read, or list
//     anything.
//   - The response never reveals whether a token existed: unknown and expired
//     produce the same words, so the endpoint cannot be used to enumerate.
//   - Rate limited per token AND per IP, failing CLOSED, reusing the same
//     limiter that protects the portal recovery endpoints.
//   - GET is a read-only preview. Nothing mutates on GET, because mail clients
//     and link scanners prefetch URLs -- a GET that confirmed would mean
//     Outlook's scanner confirms appointments on the customer's behalf.
import { supabaseRequest } from '../_lib/jobber.js';
import { checkRateLimit } from '../_lib/portal-auth.js';
import { hashToken } from '../_lib/portal-auth.js';
import { refuseReason, decisionPatch, isWellFormedToken } from '../_lib/appointment-confirm.js';

const SELECT = 'id,title,client,start_at,end_at,canceled,confirm_state,confirm_expires_at';

async function sb(path, opts) {
  const r = await supabaseRequest(path, opts);
  const text = await r.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { ok: r.ok, status: r.status, json };
}

async function loadByHash(hash) {
  const r = await sb(`hl_appointments?confirm_token_hash=eq.${encodeURIComponent(hash)}&select=${SELECT}`);
  return (Array.isArray(r.json) ? r.json : [])[0] || null;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'] || '';
  return String(fwd).split(',')[0].trim() || req.headers['x-real-ip'] || 'unknown';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page({ title, message, appt, token, done }) {
  const when = appt && appt.start_at
    ? new Date(appt.start_at).toLocaleString('en-US', {
        timeZone: 'America/New_York', weekday: 'long', month: 'long',
        day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : null;
  const buttons = done || !appt ? '' : `
    <form method="POST" style="display:flex;gap:12px;margin-top:28px">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <button name="decision" value="confirmed" style="flex:1;padding:14px;border:0;border-radius:8px;background:#f5a623;color:#111;font-weight:700;font-size:16px;cursor:pointer">Confirm</button>
      <button name="decision" value="declined" style="flex:1;padding:14px;border:1px solid #ccc;border-radius:8px;background:#fff;color:#333;font-size:16px;cursor:pointer">Can't make it</button>
    </form>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#faf9f7;color:#1a1a1a">
<div style="max-width:520px;margin:8vh auto;padding:32px;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
<h1 style="margin:0 0 16px;font-size:22px">${escapeHtml(title)}</h1>
<p style="margin:0;line-height:1.6;color:#444">${escapeHtml(message)}</p>
${when ? `<p style="margin:20px 0 0;padding:16px;background:#faf9f7;border-radius:8px;font-size:17px"><strong>${escapeHtml(when)}</strong></p>` : ''}
${buttons}
</div></body></html>`;
}

export default async function handler(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only.' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const raw = (method === 'POST' ? body.token : (req.query && req.query.token)) || '';
  const token = String(raw).trim();

  // Reject a malformed token before spending a database lookup on it -- this is
  // what stops a brute-force sweep from costing us a query per guess.
  if (!isWellFormedToken(token)) {
    const msg = 'That link is no longer valid. Please contact the office and we will send a new one.';
    if (method === 'GET') return res.status(400).setHeader('content-type', 'text/html; charset=utf-8').send(page({ title: 'Link not valid', message: msg }));
    return res.status(400).json({ ok: false, error: msg });
  }

  // Per-token and per-IP, both fail-closed. Per-token alone would let one
  // attacker grind many tokens; per-IP alone would let a distributed attempt
  // grind one.
  for (const [bucket, identifier] of [['appt_confirm_token', hashToken(token)], ['appt_confirm_ip', clientIp(req)]]) {
    const rl = await checkRateLimit({ bucket, identifier, limit: 10, windowMs: 15 * 60 * 1000, deps: { supabaseRequest } });
    if (!rl.allowed) {
      const msg = 'Too many attempts. Please wait a few minutes and try again.';
      if (method === 'GET') return res.status(429).setHeader('content-type', 'text/html; charset=utf-8').send(page({ title: 'Please wait', message: msg }));
      return res.status(429).json({ ok: false, error: msg });
    }
  }

  const now = Date.now();
  const appt = await loadByHash(hashToken(token));
  const refusal = refuseReason(appt, now);
  if (refusal) {
    if (method === 'GET') return res.status(404).setHeader('content-type', 'text/html; charset=utf-8').send(page({ title: 'Link not valid', message: refusal }));
    return res.status(404).json({ ok: false, error: refusal });
  }

  // GET is a preview and mutates nothing -- see the header note about link
  // prefetching.
  if (method === 'GET') {
    const already = appt.confirm_state === 'confirmed' || appt.confirm_state === 'declined';
    return res.status(200).setHeader('content-type', 'text/html; charset=utf-8').send(page({
      title: already
        ? (appt.confirm_state === 'confirmed' ? 'Already confirmed' : 'Already declined')
        : 'Confirm your appointment',
      message: already
        ? 'You have already replied. If this is wrong, contact the office and we will sort it out.'
        : 'Please let us know whether this time still works for you.',
      appt,
      token,
      done: already,
    }));
  }

  const decision = String(body.decision || '').trim();
  const patch = decisionPatch(appt, decision, now);
  if (!patch) {
    // Either an unrecognised decision, or the state is already what was asked
    // for. The second is a success from the customer's point of view.
    if (decision === 'confirmed' || decision === 'declined') {
      return res.status(200).json({ ok: true, confirm_state: appt.confirm_state, unchanged: true });
    }
    return res.status(400).json({ ok: false, error: "decision must be 'confirmed' or 'declined'." });
  }

  const upd = await sb(`hl_appointments?id=eq.${encodeURIComponent(appt.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!upd.ok) {
    return res.status(500).json({ ok: false, error: 'Could not record that. Please contact the office.' });
  }

  const isForm = String(req.headers['content-type'] || '').includes('form');
  if (isForm) {
    return res.status(200).setHeader('content-type', 'text/html; charset=utf-8').send(page({
      title: decision === 'confirmed' ? 'Confirmed — thank you' : 'Thanks for letting us know',
      message: decision === 'confirmed'
        ? 'We have you down for this time. See you then.'
        : 'We have marked that you cannot make it. The office will be in touch to rebook.',
      appt,
      done: true,
    }));
  }
  return res.status(200).json({ ok: true, confirm_state: decision });
}
