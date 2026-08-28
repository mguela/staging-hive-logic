// api/bookkeeping/estimates/send.js — draft -> sent. Body: { id }.
//
// Sending is also the moment the lead this estimate came from moves to
// 'estimate_sent' (Phase 0, item 5). Creating the estimate deliberately does
// not move the card: a draft can still fail to send, and a lead claiming "sent"
// on the strength of a draft would be lying.
//
// 2026-08-25, jomell: sending an estimate to a client should also email
// them the details, with Approve/Reject links. Added here, right after the
// real transition succeeds -- same "the estimate is sent, that already
// happened" reasoning as advanceLeadOnSend below: a failure to email the
// client must never fail (or look like it failed) the send itself, only
// report honestly that the email didn't go out.

let _load_estimates_cache;
async function _load_estimates() {
  if (!_load_estimates_cache) _load_estimates_cache = await import('../../../server/bookkeeping/src/estimates.js');
  return _load_estimates_cache;
}
import { getEstimate, updateEstimate } from './_store.js';
import { getTrustedActor } from '../purchase-orders/_actor.js';
import { advanceLeadOnSend } from '../../_lib/lead-estimate-link.js';
import { supabaseRequest } from '../../_lib/jobber.js';
import { sendEmail, isEmailConfigured } from '../../_lib/email.js';
import { genToken, hashToken } from '../../_lib/portal-auth.js';
import { generateEstimatePdf } from '../../_lib/estimate-pdf.js';

const RESPONSE_LINK_EXPIRY_DAYS = 30;

function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

async function lookupClient(clientId) {
  if (!clientId) return null;
  const r = await supabaseRequest(`clients?jobber_id=eq.${encodeURIComponent(clientId)}&select=email,name,first_name,phone&limit=1`);
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

// jomell, 2026-08-27: the estimate email should also show the client's
// address on file, same as the invoice PDF already does. A real address is
// its own row in client_locations, not every client has one.
async function lookupClientAddress(clientId) {
  if (!clientId) return null;
  const r = await supabaseRequest(`client_locations?jobber_id=eq.${encodeURIComponent(clientId)}&select=street,city,province,postal_code&limit=1`);
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

function formatAddress(address) {
  if (!address || !address.street) return null;
  const cityLine = [address.city, address.province].filter(Boolean).join(', ') + (address.postal_code ? ' ' + address.postal_code : '');
  return cityLine.trim() ? `${address.street}, ${cityLine}` : address.street;
}

async function lookupCompanyName(companyId) {
  try {
    const r = await supabaseRequest(`companies?slug=eq.${encodeURIComponent(companyId)}&select=name&limit=1`);
    if (r.ok) { const row = (await r.json())[0]; if (row && row.name) return row.name; }
  } catch { /* fall through */ }
  return 'HiveLogic';
}

function scheduleRowsHtml(estimate) {
  const rows = estimate.paymentSchedule || [];
  if (!rows.length) return '';
  const totalPrice = (estimate.totals && estimate.totals.price) || 0;
  const lines = rows.map(r => {
    const amt = totalPrice * (Number(r.pct) || 0) / 100;
    const label = r.isDeposit ? 'Deposit' : (r.label || 'Payment');
    return `<tr><td style="padding:6px 0;color:#484f64">${escapeHtml(label)} (${Number(r.pct) || 0}%)</td><td style="padding:6px 0;text-align:right;font-weight:700;color:#161e2e">${money(amt)}</td></tr>`;
  }).join('');
  return `<table style="width:100%;border-collapse:collapse;margin:14px 0" role="presentation">${lines}</table>`;
}

// Creates the single-use token + email. Best-effort: any failure here is
// caught by the caller and reported, never thrown back through the send.
async function emailClientEstimate(req, estimate, actor) {
  const client = await lookupClient(estimate.clientId);
  if (!client || !client.email) {
    return { sent: false, reason: 'No email on file for this client.' };
  }
  if (!isEmailConfigured()) {
    return { sent: false, reason: 'Email is not configured for this deployment (RESEND_API_KEY unset).' };
  }

  const rawToken = genToken(32);
  const expires_at = new Date(Date.now() + RESPONSE_LINK_EXPIRY_DAYS * 86400 * 1000).toISOString();
  const ins = await supabaseRequest('estimate_response_links', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      company_id: actor.companyId,
      estimate_id: estimate.id,
      estimate_number: estimate.estimateNumber,
      client_email: client.email,
      token_hash: hashToken(rawToken),
      expires_at,
    }]),
  });
  if (!ins.ok) return { sent: false, reason: `Could not create the response link: ${(await ins.text()).slice(0, 200)}` };

  const companyName = await lookupCompanyName(actor.companyId);
  const link = (action) => `${baseUrl(req)}/api/bookkeeping/estimates/respond?token=${encodeURIComponent(rawToken)}&action=${action}`;
  const approveUrl = link('approve');
  const rejectUrl = link('reject');
  const total = (estimate.totals && estimate.totals.cardPrice) || (estimate.totals && estimate.totals.price) || 0;
  const clientName = client.first_name || client.name || 'there';
  const rawAddress = await lookupClientAddress(estimate.clientId);
  const address = formatAddress(rawAddress);
  const addressRow = address ? `<tr><td style="padding:6px 0;color:#484f64">Address</td><td style="padding:6px 0;text-align:right;font-weight:700">${escapeHtml(address)}</td></tr>` : '';

  // jomell, 2026-08-27: the client should also receive a PDF of the
  // estimate's scope of work, same as an invoice email already attaches
  // one. Best-effort: a PDF-generation failure must not stop the estimate
  // email itself from going out.
  let attachments;
  try {
    const pdfBytes = await generateEstimatePdf({ estimate, client, address: rawAddress });
    attachments = [{ filename: `Estimate-${estimate.estimateNumber || estimate.id}.pdf`, content: Buffer.from(pdfBytes).toString('base64') }];
  } catch { /* the email still goes out without the PDF */ }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
      <p>Hi ${escapeHtml(clientName)},</p>
      <p>${escapeHtml(companyName)} has sent you an estimate${estimate.title ? ` for <b>${escapeHtml(estimate.title)}</b>` : ''}.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0" role="presentation">
        <tr><td style="padding:6px 0;color:#484f64">Estimate</td><td style="padding:6px 0;text-align:right;font-weight:700">${escapeHtml(estimate.estimateNumber || '')}</td></tr>
        ${addressRow}
        <tr><td style="padding:6px 0;color:#484f64">Total</td><td style="padding:6px 0;text-align:right;font-weight:700;font-size:16px">${money(total)}</td></tr>
      </table>
      ${scheduleRowsHtml(estimate)}
      <div style="margin:24px 0;text-align:center">
        <a href="${escapeHtml(approveUrl)}" style="display:inline-block;padding:12px 28px;margin:0 8px;background:#1B7A50;color:#fff;text-decoration:none;font-weight:700;border-radius:6px">Approve</a>
        <a href="${escapeHtml(rejectUrl)}" style="display:inline-block;padding:12px 28px;margin:0 8px;background:#fff;color:#c65b4e;border:1px solid #c65b4e;text-decoration:none;font-weight:700;border-radius:6px">Reject</a>
      </div>
      <p style="color:#8b92a8;font-size:12px">This link is unique to you and expires in ${RESPONSE_LINK_EXPIRY_DAYS} days. If you weren't expecting this, you can ignore this email.</p>
    </div>`;
  const text = `${companyName} has sent you estimate ${estimate.estimateNumber || ''} for ${money(total)}.${address ? `\nAddress: ${address}` : ''}\n\nApprove: ${approveUrl}\nReject: ${rejectUrl}\n\nThis link expires in ${RESPONSE_LINK_EXPIRY_DAYS} days.`;

  const result = await sendEmail({
    to: client.email,
    subject: `Your estimate ${estimate.estimateNumber || ''} from ${companyName}`,
    html,
    text,
    attachments,
  });
  return result.ok ? { sent: true, email: client.email } : { sent: false, reason: result.error };
}

export default async function handler(req, res) {
  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { sendEstimate } = await _load_estimates();
    const { id } = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!id) { res.status(422).json({ ok: false, error: 'An estimate id is required.' }); return; }

    const current = await getEstimate(actor.companyId, id);
    if (!current) { res.status(404).json({ ok: false, error: 'Estimate not found.' }); return; }

    const updated = await updateEstimate(actor.companyId, id, est => sendEstimate(est, actor, {}));

    // The estimate is sent -- that is the real outcome and it has happened. If
    // the lead card can't be moved, say so rather than failing the send.
    let leadMove = null;
    if (updated.sourceLeadId) leadMove = await advanceLeadOnSend(updated.sourceLeadId);

    let clientEmail = { sent: false, reason: null };
    try {
      clientEmail = await emailClientEstimate(req, updated, actor);
    } catch (emailError) {
      clientEmail = { sent: false, reason: emailError.message || 'Unexpected error emailing the client.' };
    }

    res.status(200).json({
      ok: true,
      estimate: updated,
      leadAdvanced: leadMove ? leadMove.advanced : undefined,
      leadStage: leadMove ? leadMove.stage : undefined,
      clientEmailSent: clientEmail.sent,
      clientEmailAddress: clientEmail.email,
      clientEmailError: clientEmail.sent ? undefined : clientEmail.reason,
    });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not send this estimate.' });
  }
}
