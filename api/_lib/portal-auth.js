// api/_lib/portal-auth.js
// Shared security primitives for the public portals (Client Portal +
// Sub Portal). Added 2026-08-01 to close the login-bypass hole where the
// public "email/text me a link" recovery endpoints returned a working
// magic-link URL straight back in the JSON response — meaning anyone who
// knew (or guessed) a client/sub's email or phone could mint themselves a
// session for that account.
//
// Three primitives, all dependency-injectable so they unit-test without a
// network or a live database:
//
//   1. Token hashing. Magic-link and device-session tokens are now stored as
//      SHA-256 hashes, never as the raw token. The raw token lives only in
//      the URL we hand the user (and, going forward, only in the email we
//      send them). A leaked DB row or backup can no longer be replayed as a
//      live link or session — the stored hash is not a usable credential.
//
//   2. Rate limiting. A Supabase-backed sliding-window counter (table
//      portal_rate_limits, sql/043_portal_rate_limits.sql) throttles the
//      public recovery endpoints per-IP and per-identifier so the recovery
//      form can't be used to blast sign-in emails or brute-force the space.
//      Fails CLOSED on any backing-store error AND on a missing store
//      (2026-08-02): if the store is erroring or was never wired in, the
//      throttle can't be enforced, so requests are DENIED rather than let
//      through unthrottled. There is no opt-out — every production call site
//      injects the store, and tests inject a functioning mock store. See
//      checkRateLimit.
//
//   3. Delivery. deliverLoginLink() sends the link out-of-band to the
//      contact ON FILE (never to an attacker-supplied address) via Resend
//      email. SMS is not wired, so a phone-only contact is simply not
//      deliverable — and the caller then returns the same generic response
//      as every other case, so the endpoint never reveals whether an
//      account exists.

import crypto from 'node:crypto';
import { sendEmail, isEmailConfigured } from './email.js';

// --- 1. tokens -------------------------------------------------------------

// A fresh, unguessable token. 32 bytes = 256 bits of entropy by default.
export function genToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

// Store hashToken(raw); look up rows by hashToken(rawFromRequest). Never
// store or query the raw token itself.
export function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

// Constant-time equality for two hex-encoded hashes of equal length.
export function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// --- 2. rate limiting ------------------------------------------------------

// Sliding-window limiter. Records this attempt, then counts attempts for the
// same bucket+identifier inside the window. Returns { allowed, count, limit }.
//
// FAIL-CLOSED on store errors (2026-08-02). The whole point of this limiter is
// to bound how fast the PUBLIC recovery endpoints can be hit. If the backing
// store is present but erroring, we can no longer enforce that bound — so we
// DENY (allowed:false) rather than silently dropping the throttle. The old
// behavior failed OPEN, which meant a store outage (or an attacker who could
// induce one) disabled rate limiting on exactly the endpoints it protects.
// The public recovery endpoints already return a single generic response on
// throttle, so a fail-closed 429 is uniform and does not reveal anything.
//
// MISSING STORE ALSO FAILS CLOSED (2026-08-02, Codex review of PR #43). A
// caller with no store wired in cannot throttle an authentication-sensitive
// endpoint, so the ONLY safe behavior is to DENY. There is no opt-out: every
// production call site injects `deps.supabaseRequest`, and tests must inject a
// functioning (mock) store to exercise throttled paths. A missing store always
// returns allowed:false.
export async function checkRateLimit({
  bucket,
  identifier,
  limit = 5,
  windowMs = 15 * 60 * 1000,
  deps,
  now = Date.now(),
}) {
  const supabaseRequest = deps && deps.supabaseRequest;
  if (!supabaseRequest) return { allowed: false, reason: 'no-store' };
  const key = `${bucket}:${identifier || 'unknown'}`;
  const windowStart = new Date(now - windowMs).toISOString();
  try {
    // Record this attempt first, so racing requests all get counted.
    const ins = await supabaseRequest('portal_rate_limits', {
      method: 'POST',
      body: JSON.stringify({ bucket: key, created_at: new Date(now).toISOString() }),
    });
    if (!ins.ok) return { allowed: false, reason: 'store-error' };

    const res = await supabaseRequest(
      `portal_rate_limits?bucket=eq.${encodeURIComponent(key)}&created_at=gte.${encodeURIComponent(windowStart)}&select=id`,
      { headers: { Prefer: 'count=exact' } },
    );
    if (!res.ok) return { allowed: false, reason: 'store-error' };

    let count = null;
    const range = res.headers && res.headers.get && res.headers.get('content-range');
    if (range && range.includes('/')) {
      const total = range.split('/')[1];
      if (total && total !== '*') count = Number(total);
    }
    if (count == null) {
      const rows = await res.json().catch(() => []);
      count = Array.isArray(rows) ? rows.length : 0;
    }
    return { allowed: count <= limit, count, limit };
  } catch (e) {
    // Network/timeout/parse throw: same posture — fail closed.
    return { allowed: false, reason: 'store-exception', error: e && e.message };
  }
}

// --- 3. delivery -----------------------------------------------------------

// Deliver a sign-in link to the contact ON FILE, out-of-band. Email only for
// now (Resend). Returns { delivered, channel }. A phone-only contact, or a
// deployment with no RESEND_API_KEY, is simply not deliverable — the caller
// must still return its generic, account-independent response so the endpoint
// stays non-enumerating.
export async function deliverLoginLink({ email, url, brandName = 'GH Group', purpose = 'sign-in', deps }) {
  const send = (deps && deps.sendEmail) || sendEmail;
  const emailConfigured = (deps && typeof deps.isEmailConfigured === 'function')
    ? deps.isEmailConfigured()
    : isEmailConfigured();

  if (email && emailConfigured) {
    const subject = `Your ${brandName} ${purpose} link`;
    const safeUrl = String(url);
    const r = await send({
      to: email,
      subject,
      text: `Here is your ${brandName} ${purpose} link. It expires soon and can be used once:\n\n${safeUrl}\n\nIf you didn't request this, you can ignore this email.`,
      html:
        `<p>Here is your ${escapeHtml(brandName)} ${escapeHtml(purpose)} link. ` +
        `It expires soon and can be used once:</p>` +
        `<p><a href="${escapeHtml(safeUrl)}">Sign in to your portal</a></p>` +
        `<p style="color:#666;font-size:12px">If you didn't request this, you can ignore this email.</p>`,
    });
    return { delivered: Boolean(r && r.ok), channel: 'email', error: r && r.error };
  }
  return { delivered: false, channel: null };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
