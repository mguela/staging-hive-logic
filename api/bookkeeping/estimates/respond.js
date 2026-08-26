// api/bookkeeping/estimates/respond.js — the public landing page behind the
// Approve/Reject links emailed to a client (send.js).
//
// GET  /api/bookkeeping/estimates/respond?token=...&action=approve|reject
//        -> a read-only preview page. Nothing mutates on GET: mail clients
//           and corporate link-scanners routinely pre-fetch GET links to
//           check for malware before a human ever opens the email, and a
//           GET that acted would mean the scanner approves/rejects estimates
//           on the client's behalf (same reasoning as api/schedule/confirm.js,
//           which this route otherwise mirrors closely).
// POST { token, action, note } -> records the decision. Only reachable by
//        the preview page's own <form>, never linked directly.
//
// PUBLIC BY NECESSITY: the person clicking this has no HiveLogic account and
// never will. Scoped as tightly as api/schedule/confirm.js's own pattern:
//   - The token is 256 bits of CSPRNG entropy (api/_lib/portal-auth.js's
//     genToken/hashToken), stored only as a SHA-256 hash.
//   - It authorizes exactly one estimate response, once.
//   - Every failure mode (unknown token, already used, expired) returns the
//     SAME words, so this can never be used to enumerate estimates or tell
//     an attacker which guess was closer.
//   - Rate limited per token AND per IP, failing CLOSED.
//
// 2026-08-25, jomell: "when clicking 'send to client'... i should receive an
// email... that email should contain details and there should be a button
// or lets say links either saying 'approve' or 'reject'."

import { getEstimate, updateEstimate } from './_store.js';
import { supabaseRequest } from '../../_lib/jobber.js';
import { hashToken, checkRateLimit } from '../../_lib/portal-auth.js';

const INVALID_MESSAGE = 'This link is no longer valid. If you still need to respond, ask for a new estimate email.';

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'] || '';
  return String(fwd).split(',')[0].trim() || req.headers['x-real-ip'] || 'unknown';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function page({ title, body }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#faf9f7;color:#161e2e">
<div style="max-width:480px;margin:8vh auto;padding:32px;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
${body}
</div></body></html>`;
}

async function loadLinkByToken(token) {
  const r = await supabaseRequest(`estimate_response_links?token_hash=eq.${encodeURIComponent(hashToken(token))}&select=*&limit=1`);
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

function isExpiredOrUsed(link) {
  if (!link) return true;
  if (link.used_at) return true;
  if (new Date(link.expires_at).getTime() < Date.now()) return true;
  return false;
}

async function markUsed(linkId, action, note) {
  await supabaseRequest(`estimate_response_links?id=eq.${encodeURIComponent(linkId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ used_at: new Date().toISOString(), used_action: action, note: note || null }),
  });
}

async function rateLimited(req, token) {
  for (const [bucket, identifier] of [['est_respond_token', hashToken(token)], ['est_respond_ip', clientIp(req)]]) {
    const rl = await checkRateLimit({ bucket, identifier, limit: 10, windowMs: 15 * 60 * 1000, deps: { supabaseRequest } });
    if (!rl.allowed) return true;
  }
  return false;
}

async function handleGet(req, res) {
  const token = String((req.query && req.query.token) || '').trim();
  const action = (req.query && req.query.action) === 'reject' ? 'reject' : 'approve';
  const html = (status, body) => res.status(status).setHeader('content-type', 'text/html; charset=utf-8').send(page({ title: 'Estimate response', body }));

  if (!token) return html(400, `<h1>${escapeHtml(INVALID_MESSAGE)}</h1>`);
  if (await rateLimited(req, token)) return html(429, '<h1>Too many attempts. Please wait a few minutes and try again.</h1>');

  const link = await loadLinkByToken(token);
  if (isExpiredOrUsed(link)) return html(410, `<h1>${escapeHtml(INVALID_MESSAGE)}</h1>`);

  const estimate = await getEstimate(link.company_id, link.estimate_id);
  if (!estimate) return html(410, `<h1>${escapeHtml(INVALID_MESSAGE)}</h1>`);

  const total = (estimate.totals && estimate.totals.cardPrice) || (estimate.totals && estimate.totals.price) || 0;
  const verb = action === 'reject' ? 'Reject' : 'Approve';
  const cls = action === 'reject' ? 'background:#c65b4e' : 'background:#1B7A50';
  const body = `
    <h1 style="margin:0 0 16px;font-size:20px">${verb} ${escapeHtml(estimate.estimateNumber || 'this estimate')}?</h1>
    <table style="width:100%;border-collapse:collapse;margin:0 0 16px">
      <tr><td style="padding:6px 0;color:#8b92a8">Estimate</td><td style="padding:6px 0;text-align:right;font-weight:700">${escapeHtml(estimate.estimateNumber || '')}</td></tr>
      ${estimate.title ? `<tr><td style="padding:6px 0;color:#8b92a8">Title</td><td style="padding:6px 0;text-align:right;font-weight:700">${escapeHtml(estimate.title)}</td></tr>` : ''}
      <tr><td style="padding:6px 0;color:#8b92a8">Total</td><td style="padding:6px 0;text-align:right;font-weight:700">${money(total)}</td></tr>
    </table>
    <form method="POST" action="/api/bookkeeping/estimates/respond">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <input type="hidden" name="action" value="${escapeHtml(action)}">
      <textarea name="note" placeholder="Add a note (optional)" style="width:100%;box-sizing:border-box;border:1px solid #dadde8;border-radius:7px;padding:10px;font-family:inherit;font-size:13px;min-height:64px"></textarea>
      <button type="submit" style="width:100%;margin-top:14px;padding:14px;border:0;border-radius:8px;color:#fff;font-weight:700;font-size:15px;cursor:pointer;${cls}">Confirm ${verb}</button>
    </form>
    <p style="color:#8b92a8;font-size:12px;margin-top:16px">This confirms your response — nothing happens until you click the button above. This link expires and can only be used once.</p>`;
  return html(200, body);
}

async function handlePost(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const token = String(body.token || '').trim();
  const action = body.action === 'reject' ? 'reject' : 'approve';
  const note = body.note;
  const html = (status, msg) => res.status(status).setHeader('content-type', 'text/html; charset=utf-8').send(page({ title: 'Estimate response', body: `<h1>${escapeHtml(msg)}</h1>` }));

  if (!token) return html(400, INVALID_MESSAGE);
  if (await rateLimited(req, token)) return html(429, 'Too many attempts. Please wait a few minutes and try again.');

  const link = await loadLinkByToken(token);
  if (isExpiredOrUsed(link)) return html(410, INVALID_MESSAGE);

  try {
    const { rejectEstimate, recordClientApproval } = await import('../../../server/bookkeeping/src/estimates.js');
    const systemActor = { id: 'client-email-link', role: 'client' };

    const updated = await updateEstimate(link.company_id, link.estimate_id, est => (
      action === 'reject'
        ? rejectEstimate(est, systemActor, { reason: note || 'Declined by the client via the emailed estimate link.' })
        : recordClientApproval(est, { note })
    ));

    await markUsed(link.id, action, note);

    return html(200, action === 'reject'
      ? `Got it — ${updated.estimateNumber || 'the estimate'} was marked declined. The team has been notified.`
      : `Thanks — ${updated.estimateNumber || 'the estimate'} is marked approved. The team will follow up with next steps.`);
  } catch (error) {
    return html(422, error.message || 'Something went wrong recording your response. Please contact us directly.');
  }
}

export default async function handler(req, res) {
  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) {
    res.status(200).setHeader('content-type', 'text/html; charset=utf-8').send(page({ title: 'Not available', body: '<h1>This link is not available right now.</h1>' }));
    return;
  }
  if (req.method === 'GET') { await handleGet(req, res); return; }
  if (req.method === 'POST') { await handlePost(req, res); return; }
  res.status(405).send('Only GET and POST are supported.');
}
