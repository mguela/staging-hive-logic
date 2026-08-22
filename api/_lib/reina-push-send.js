// Sending a Web Push message, and retiring a subscription that is gone.
//
// This is the one place in the repo that uses an npm client rather than a raw
// fetch, and the reason is narrow: Web Push is not a REST call. RFC 8291 wants
// an ECDH key agreement with the browser's public key, HKDF, and aes128gcm
// encryption of the payload, plus an RFC 8292 VAPID JWT signed with ES256.
// Hand-rolling a REST wrapper (as jobber.js and voice.js do) is reading docs;
// hand-rolling this is writing crypto, and a subtle mistake there fails as a
// notification that silently never arrives.

let webPushPromise = null;
async function webPush() {
  if (!webPushPromise) webPushPromise = import('web-push').then((m) => m.default || m);
  return webPushPromise;
}

export function vapidPublicKey() {
  return String(process.env.REINA_VAPID_PUBLIC_KEY || '');
}

export function vapidConfigured() {
  return !!(process.env.REINA_VAPID_PUBLIC_KEY && process.env.REINA_VAPID_PRIVATE_KEY);
}

// The push services want a contact for whoever is sending. A real mailto is
// what they expect; some (Firefox) reject a subject that is not a URL/mailto.
function vapidSubject() {
  const raw = String(process.env.REINA_VAPID_SUBJECT || '').trim();
  if (/^(mailto:|https:)/.test(raw)) return raw;
  return 'mailto:chris@ghgrp.net';
}

/**
 * A push service answering 404 or 410 means this subscription is DEAD -- the
 * browser was uninstalled, the profile wiped, permission revoked. Anything
 * else (429, 500, a timeout) is the service having a bad minute, and retiring
 * a subscription over that would silently unsubscribe him from his own alerts.
 */
export function isGone(statusCode) {
  return statusCode === 404 || statusCode === 410;
}

/**
 * Send one payload to every subscription given.
 *
 * One dead browser must never stop the others: each send is independent, and
 * a failure is recorded against that row alone.
 */
export async function sendPush(subscriptions, payload, deps) {
  const d = deps || {};
  const supabaseRequest = d.supabaseRequest;
  if (!vapidConfigured()) {
    return { sent: 0, failed: 0, skipped: (subscriptions || []).length, reason: 'VAPID keys are not set' };
  }
  const wp = d.webPush || await webPush();
  try {
    wp.setVapidDetails(vapidSubject(), vapidPublicKey(), String(process.env.REINA_VAPID_PRIVATE_KEY || ''));
  } catch (e) {
    return { sent: 0, failed: 0, skipped: (subscriptions || []).length, reason: 'VAPID keys are not usable: ' + e.message };
  }

  const body = JSON.stringify(payload || {});
  const now = (d.now || (() => new Date()))().toISOString();
  let sent = 0;
  let failed = 0;
  const gone = [];

  await Promise.all((subscriptions || []).map(async (row) => {
    const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    try {
      await wp.sendNotification(sub, body, { TTL: 60 * 60 });
      sent += 1;
      if (supabaseRequest) {
        await supabaseRequest(
          `reina_push_subscriptions?endpoint=eq.${encodeURIComponent(row.endpoint)}`,
          { method: 'PATCH', body: JSON.stringify({ last_sent_at: now }) }
        ).catch(() => {});
      }
    } catch (e) {
      failed += 1;
      if (isGone(e && e.statusCode)) gone.push({ endpoint: row.endpoint, reason: 'push service says ' + e.statusCode });
    }
  }));

  // Marked, not deleted: a bad deploy that mass-fails should be visible in the
  // table afterwards rather than having quietly emptied it.
  if (supabaseRequest && gone.length) {
    await Promise.all(gone.map((g) => supabaseRequest(
      `reina_push_subscriptions?endpoint=eq.${encodeURIComponent(g.endpoint)}`,
      { method: 'PATCH', body: JSON.stringify({ failed_at: now, failure_reason: g.reason }) }
    ).catch(() => {})));
  }

  return { sent, failed, retired: gone.length };
}
