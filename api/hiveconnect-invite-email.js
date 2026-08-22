// api/hiveconnect-invite-email.js -- Vercel serverless function
// Sends the actual invite email for a HiveConnect invite (channel invites
// and HiveVideo call invites both funnel through here -- see
// public/hiveconnect/app.js sendHvInvites() and the lk-create handler).
//
// The invite itself is always created client-side via HiveConnect's own
// create_invite() RPC first -- that is what actually authorizes and
// persists it (admin-only, via HiveConnect's require_admin()). This
// endpoint only delivers it: given a token the caller already has, it
// re-validates that token server-side against HiveConnect's own
// invite_info() RPC (never trusts the email/role/workspace the browser
// sends) and, if the invite has an email on file, emails the join link
// through Resend (api/_lib/email.js -- same sender every other outbound
// email in this repo uses).
//
// Auth: same 'Authorization: Bearer <access token>' pattern every other
// api/*.js in this repo uses against ITS OWN Supabase project (see
// api/clientportal.js getStaffProfile) -- here verified against
// HiveConnect's project (HIVECONNECT_SUPABASE_URL/SERVICE_KEY, same env
// vars api/hiveconnect-bridge.js already depends on) and required to be
// role owner/admin + active, matching HiveConnect's own is_admin() check
// exactly -- so this endpoint can never do anything the caller could not
// already do directly through the RPC it's just emailing the result of.

import { sendEmail } from './_lib/email.js';

function hcUrl() { return process.env.HIVECONNECT_SUPABASE_URL; }
function hcKey() { return process.env.HIVECONNECT_SUPABASE_SERVICE_KEY; }

function escapeHtml(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function getHiveConnectAdmin(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const userRes = await fetch(hcUrl() + '/auth/v1/user', {
    headers: { apikey: hcKey(), Authorization: 'Bearer ' + token },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user || !user.id) return null;
  const profRes = await fetch(hcUrl() + '/rest/v1/profiles?id=eq.' + encodeURIComponent(user.id) + '&select=id,role,active,display_name', {
    headers: { apikey: hcKey(), Authorization: 'Bearer ' + hcKey() },
  });
  if (!profRes.ok) return null;
  const rows = await profRes.json();
  const profile = rows && rows[0];
  if (!profile || !profile.active || !['owner', 'admin'].includes(profile.role)) return null;
  return profile;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required.' });
  if (!hcUrl() || !hcKey()) return res.status(500).json({ ok: false, error: 'HiveConnect is not configured on this deployment.' });

  const admin = await getHiveConnectAdmin(req);
  if (!admin) return res.status(401).json({ ok: false, error: 'Admin sign-in required.' });

  const { token, url, inviterName } = req.body || {};
  if (!token || !url) return res.status(400).json({ ok: false, error: 'token and url are required.' });

  // Re-validate the invite server-side -- never trust the email/role/
  // expiry the browser sends, only what HiveConnect's own DB says now.
  const infoRes = await fetch(hcUrl() + '/rest/v1/rpc/invite_info', {
    method: 'POST',
    headers: { apikey: hcKey(), Authorization: 'Bearer ' + hcKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: token }),
  });
  if (!infoRes.ok) return res.status(502).json({ ok: false, error: 'Could not verify invite.' });
  const info = await infoRes.json();
  if (!info || !info.valid) return res.status(400).json({ ok: false, error: (info && info.reason) || 'Invalid invite.' });
  if (!info.email) return res.status(400).json({ ok: false, error: 'This invite has no email on file -- copy the link instead.' });

  const workspace = info.workspace || 'HiveConnect';
  const who = (inviterName && String(inviterName).trim()) || admin.display_name || 'A teammate';
  const subject = who + ' invited you to ' + workspace;
  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#161e2e">'
    + '<p>' + escapeHtml(who) + ' invited you to join <b>' + escapeHtml(workspace) + '</b> on HiveConnect'
    + (info.role === 'guest' ? ' as a guest' : '') + '.</p>'
    + '<p style="margin:24px 0"><a href="' + url + '" style="background:#1B7A50;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Accept invite</a></p>'
    + '<p style="color:#8892a6;font-size:12.5px">Or paste this link into your browser:<br>' + escapeHtml(url) + '</p>'
    + '<p style="color:#8892a6;font-size:12.5px">This link expires soon and can only be used once.</p>'
    + '</div>';

  const result = await sendEmail({ to: info.email, subject, html });
  if (!result.ok) return res.status(502).json({ ok: false, error: result.error || 'Send failed.' });
  res.status(200).json({ ok: true, id: result.id });
}
