// api/marketing-unsubscribe.js
// Public, unauthenticated endpoint reached by clicking the unsubscribe link
// embedded in every marketing send (see unsubscribeUrl() in api/marketing.js).
// No login is possible here -- the recipient is not a HiveLogic user -- so
// the link's own HMAC signature is what proves it's genuine, not a session.
//
// GET /api/marketing-unsubscribe?c=<clientId>&ch=<channel>&s=<signature>
//   -> verifies the signature, records a marketing_suppressions row, and
//      returns a small confirmation page. Never sends anything; this is
//      the opposite of a send path.
//
// LAW 1: this endpoint cannot send email/SMS -- it only ever writes a
// suppression record that the send paths in api/marketing.js already check.

import { supabaseRequest } from './_lib/jobber.js';
import crypto from 'node:crypto';

function unsubscribeSecret() {
  return process.env.MARKETING_UNSUBSCRIBE_SECRET || process.env.SUPABASE_SERVICE_KEY || 'dev-only-insecure-fallback';
}

function signUnsubscribe(clientId, channel) {
  const payload = String(clientId) + ':' + String(channel);
  return crypto.createHmac('sha256', unsubscribeSecret()).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function htmlPage(title, message, ok) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f7f5f0;color:#1a1a1a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;}
  .card{max-width:420px;background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center;}
  h1{font-size:20px;margin:0 0 12px;}
  p{font-size:15px;line-height:1.5;color:#444;margin:0;}
  .icon{font-size:32px;margin-bottom:12px;}
</style></head>
<body><div class="card"><div class="icon">${ok ? '✓' : '⚠️'}</div><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(405).send(htmlPage('Method not allowed', 'This link only supports GET.', false));
  }

  const clientId = String(req.query.c || '').trim();
  const channel = String(req.query.ch || '').trim();
  const signature = String(req.query.s || '').trim();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!clientId || !channel || !signature) {
    return res.status(400).send(htmlPage('Invalid link', 'This unsubscribe link is missing required information. Please contact us directly if you no longer want to hear from us.', false));
  }

  const expected = signUnsubscribe(clientId, channel);
  if (!safeEqual(signature, expected)) {
    return res.status(400).send(htmlPage('Invalid link', 'We could not verify this unsubscribe link. Please contact us directly if you no longer want to hear from us.', false));
  }

  try {
    const r = await supabaseRequest('marketing_suppressions', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{ client_id: clientId, channel, reason: 'unsubscribe_link', notes: 'Recipient clicked the unsubscribe link in a campaign email.' }]),
    });
    if (!r.ok) {
      const text = await r.text();
      const notSynced = /relation .* does not exist/i.test(text);
      if (!notSynced) {
        return res.status(500).send(htmlPage('Something went wrong', 'We could not process your request right now. Please try again later or contact us directly.', false));
      }
    }
  } catch (e) {
    return res.status(500).send(htmlPage('Something went wrong', 'We could not process your request right now. Please try again later or contact us directly.', false));
  }

  return res.status(200).send(htmlPage('You have been unsubscribed', "You won't receive any more marketing emails from us on this address. If this was a mistake, just reply to any of our previous emails and let us know.", true));
}
