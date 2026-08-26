// api/_lib/email.js
// Shared helper for outbound campaign/transactional email via Resend.
// Same pattern as api/_lib/voice.js (Twilio) and api/_lib/jobber.js --
// raw fetch, no SDK dependency. Resend's send API is one plain HTTP
// POST endpoint, so nothing beyond fetch is needed.
//
// LAW 1, applied literally: this file CAN send real email once wired up,
// but it never fires on its own. The only caller is api/marketing.js's
// campaign_send handler, which is itself gated behind
// MARKETING_EMAIL_SEND_ENABLED (unset/off by default) -- so nothing sends
// until a human explicitly flips that on in Vercel, on top of adding a
// real RESEND_API_KEY. Domain: mail.ghgrp.net, verified in Resend
// 2026-07-24 (see reina/ for the setup notes).

const RESEND_API_BASE = 'https://api.resend.com';

export function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

// Separate from isEmailConfigured() on purpose -- lets the API report two
// different honest states to the caller: "not set up yet" vs. "set up but
// deliberately turned off", instead of collapsing them into one generic
// error.
export function isEmailSendEnabled() {
  return isEmailConfigured() && process.env.MARKETING_EMAIL_SEND_ENABLED === 'true';
}

function defaultFromAddress() {
  return process.env.EMAIL_FROM_ADDRESS || 'HiveLogic <no-reply@mail.ghgrp.net>';
}

// Sends one email. Never throws -- returns { ok, id, error } so a caller
// looping over a recipient list can keep going even if one send fails.
//
// attachments: [{ filename, content }], content a base64 string (Resend's
// own format -- see https://resend.com/docs/api-reference/emails/send-email).
// Optional and additive: every existing caller that doesn't pass it behaves
// exactly as before.
export async function sendEmail({ to, subject, html, text, from, replyTo, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY is not set for this deployment.' };
  if (!to) return { ok: false, error: 'to is required.' };
  if (!subject) return { ok: false, error: 'subject is required.' };
  if (!html && !text) return { ok: false, error: 'html or text body is required.' };

  const body = {
    from: from || defaultFromAddress(),
    to: [to],
    subject,
  };
  if (html) body.html = html;
  if (text) body.text = text;
  if (replyTo) body.reply_to = replyTo;
  if (Array.isArray(attachments) && attachments.length) body.attachments = attachments;

  try {
    const res = await fetch(`${RESEND_API_BASE}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: (data && (data.message || data.error)) || `Resend API error (${res.status})` };
    }
    return { ok: true, id: (data && data.id) || null };
  } catch (e) {
    return { ok: false, error: e.message || 'Network error sending email.' };
  }
}
