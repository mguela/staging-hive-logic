// api/resend-webhook.js
// Receives delivery-event webhooks from Resend (bounce, complaint, delivered)
// and turns hard bounces / spam complaints into a marketing_suppressions
// row, so the next campaign send automatically skips that address --
// closing the loop the audit flagged: the suppression table existed but
// nothing populated it from real bounce/complaint signals.
//
// Configure in Resend's dashboard: Webhooks -> Add endpoint ->
//   https://<your-domain>/api/resend-webhook
// Subscribe to at least: email.bounced, email.complained. Copy the endpoint's
// "Signing Secret" (starts with `whsec_`) into the RESEND_WEBHOOK_SECRET env
// var.
//
// SECURITY (2026-08-01, Item 6 — replaced the old ?secret= URL param):
// Resend signs webhooks with Svix. This endpoint now verifies that signature
// against the RAW, untouched request body (bodyParser disabled so we get the
// exact bytes), checks the timestamp is within a 5-minute window (replay
// guard), and compares the HMAC timing-safely. No secret ever travels in the
// URL. Fails closed if RESEND_WEBHOOK_SECRET is unset.
//
// LAW 1: this endpoint only ever writes a suppression row; it cannot send
// email/SMS itself and has no code path that calls sendEmail().

import crypto from 'node:crypto';
import { supabaseRequest } from './_lib/jobber.js';

// The HMAC must be computed over the exact bytes Resend sent — disable Vercel's
// automatic JSON body parsing so we can read the raw body.
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

// Svix signature verification (Resend's mechanism). Returns true only for a
// genuine, unexpired, correctly-signed delivery.
function verifySvixSignature(rawBody, headers, secret) {
  const id = headers['svix-id'];
  const ts = headers['svix-timestamp'];
  const sigHeader = headers['svix-signature'];
  if (!id || !ts || !sigHeader) return false;

  // Replay guard: reject timestamps more than 5 minutes from now.
  const now = Math.floor(Date.now() / 1000);
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > 300) return false;

  const key = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  let keyBytes;
  try { keyBytes = Buffer.from(key, 'base64'); } catch { return false; }
  if (!keyBytes || keyBytes.length === 0) return false;

  const signedContent = `${id}.${ts}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', keyBytes).update(signedContent).digest('base64');

  // svix-signature is a space-separated list of "<version>,<base64sig>".
  return String(sigHeader).split(' ').some((part) => {
    const idx = part.indexOf(',');
    if (idx < 0) return false;
    const version = part.slice(0, idx);
    const sig = part.slice(idx + 1);
    return version === 'v1' && sig && timingSafeEqualStr(sig, expected);
  });
}

async function findClientIdByEmail(email) {
  if (!email) return null;
  const r = await supabaseRequest(`clients?email=eq.${encodeURIComponent(email)}&select=jobber_id&limit=1`);
  if (!r.ok) return null;
  const rows = await r.json();
  return rows.length ? rows[0].jobber_id : null;
}

async function recordSuppression(clientId, channel, reason, notes) {
  try {
    await supabaseRequest('marketing_suppressions', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{ client_id: clientId, channel, reason, notes }]),
    });
    return true;
  } catch (e) {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'This endpoint only accepts POST from Resend.' });
  }

  const configuredSecret = process.env.RESEND_WEBHOOK_SECRET;
  if (!configuredSecret) {
    // Fail closed -- an unconfigured secret must never silently accept
    // unauthenticated webhook calls.
    return res.status(503).json({ ok: false, error: 'RESEND_WEBHOOK_SECRET is not set for this deployment -- configure it before enabling this webhook in Resend.' });
  }

  const rawBody = await readRawBody(req);
  if (!verifySvixSignature(rawBody, req.headers, configuredSecret)) {
    return res.status(401).json({ ok: false, error: 'Invalid or missing webhook signature.' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Malformed JSON body.' });
  }

  const type = String(event.type || '');
  const data = event.data || {};
  const toList = Array.isArray(data.to) ? data.to : (data.to ? [data.to] : []);

  const bounceTypes = new Set(['email.bounced']);
  const complaintTypes = new Set(['email.complained']);

  if (!bounceTypes.has(type) && !complaintTypes.has(type)) {
    // Delivered / opened / clicked / other events -- acknowledged but no
    // suppression action needed.
    return res.status(200).json({ ok: true, ignored: true, type });
  }

  const reason = bounceTypes.has(type) ? 'bounce' : 'complaint';
  const results = [];
  for (const email of toList) {
    const clientId = await findClientIdByEmail(email);
    if (!clientId) {
      results.push({ email, matched: false });
      continue;
    }
    const ok = await recordSuppression(clientId, 'email', reason, `Resend ${type} event, recipient ${email}.`);
    results.push({ email, matched: true, clientId, suppressed: ok });
  }

  res.status(200).json({ ok: true, type, processed: results.length, results });
}

// Exported for unit tests (no network).
export { verifySvixSignature };
