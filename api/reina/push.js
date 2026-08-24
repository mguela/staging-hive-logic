// The browser end of desktop notifications: who is subscribed, and what he
// pressed on a notification.
//
// Chris, 2026-08-19: "lets add the notifications while hivelogic is closed...
// it cant be a windows notification? only on the computer should the
// nitifcations happen."
//
// A Web Push subscription is what makes that possible: the browser hands us an
// endpoint at its own push service, and the OS shows the toast even with no
// HiveLogic tab open. Chrome has to still be running -- a fully quit browser
// receives nothing, and no amount of server code changes that.
//
// Actions:
//   key         the VAPID public key, so the page can subscribe. It is public
//               data -- every subscribing browser gets it -- but it is served
//               behind the session anyway: the edge middleware gates /api/*
//               wholesale, and the only caller is a signed-in page.
//   subscribe   store this browser
//   unsubscribe forget this browser
//   mute        "Mute sender" -- the learning signal, pressed on the toast
//   unmute      undo that, from the settings list
//   channel     desktop toasts on or off, WITHOUT dropping the subscription
//   rules       what she has learned, so it is inspectable and reversible
//   test        send one to prove it works end to end

import { supabaseRequest as defaultSupabaseRequest } from '../_lib/jobber.js';
import { requireApiAuth } from '../_lib/guard.js';
import { muteRuleFor, normalizeAddress, domainOf, desktopPushEnabled, desktopChannelRule } from '../_lib/reina-notify.js';
import { sendPush, vapidPublicKey, vapidConfigured } from '../_lib/reina-push-send.js';

function jsonError(res, status, error) { return res.status(status).json({ ok: false, error }); }
function enc(v) { return encodeURIComponent(String(v)); }

// A push endpoint is a URL we will later POST to on a schedule. Anything that
// is not an https URL is not one, and storing it would be storing a request we
// are willing to make on his behalf to somewhere nobody chose.
function safeEndpoint(value) {
  let u;
  try { u = new URL(String(value || '')); } catch (_) { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.href.length > 2000) return null;
  return u.href;
}

async function handleSubscribe(ownerId, body, deps) {
  const sub = (body && body.subscription) || {};
  const endpoint = safeEndpoint(sub.endpoint);
  const keys = sub.keys || {};
  const p256dh = String(keys.p256dh || '').slice(0, 200);
  const auth = String(keys.auth || '').slice(0, 100);
  if (!endpoint) { const e = new Error('a push endpoint is required'); e.status = 400; throw e; }
  if (!p256dh || !auth) { const e = new Error('that subscription is missing its keys'); e.status = 400; throw e; }

  // on_conflict on endpoint: the same browser re-subscribing (which Chrome does
  // on its own when a key rotates) is the SAME device, not a second one.
  // Inserting it twice would ping him twice for one email.
  const r = await deps.supabaseRequest('reina_push_subscriptions?on_conflict=endpoint', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{
      owner_id: ownerId,
      endpoint,
      p256dh,
      auth,
      user_agent: String((body && body.userAgent) || '').slice(0, 300) || null,
      failed_at: null,
      failure_reason: null,
    }]),
  });
  if (!r.ok) { const e = new Error('could not save this browser'); e.status = 502; throw e; }
  return { ok: true, subscribed: true };
}

async function handleUnsubscribe(ownerId, body, deps) {
  const endpoint = safeEndpoint(body && body.endpoint);
  if (!endpoint) { const e = new Error('a push endpoint is required'); e.status = 400; throw e; }
  const r = await deps.supabaseRequest(
    `reina_push_subscriptions?owner_id=eq.${enc(ownerId)}&endpoint=eq.${enc(endpoint)}`,
    { method: 'DELETE' }
  );
  if (!r.ok) { const e = new Error('could not forget this browser'); e.status = 502; throw e; }
  return { ok: true, subscribed: false };
}

// The learning signal. He pressed "Not this sender" on a toast, which is the
// one moment he actually knows the answer.
async function handleMute(ownerId, body, deps) {
  const rule = muteRuleFor(ownerId, body && body.fromAddress, body && body.scope);
  if (!rule) { const e = new Error('no sender to silence'); e.status = 400; throw e; }
  const r = await deps.supabaseRequest('reina_notify_rules?on_conflict=owner_id,match_kind,match_value', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([rule]),
  });
  if (!r.ok) { const e = new Error('could not save that'); e.status = 502; throw e; }
  return { ok: true, muted: rule.match_value, scope: rule.match_kind };
}

async function handleUnmute(ownerId, body, deps) {
  const value = normalizeAddress(body && body.value);
  const kind = (body && body.scope) === 'domain' ? 'domain' : 'sender';
  if (!value) { const e = new Error('nothing to un-silence'); e.status = 400; throw e; }
  const r = await deps.supabaseRequest(
    `reina_notify_rules?owner_id=eq.${enc(ownerId)}&match_kind=eq.${enc(kind)}&match_value=eq.${enc(value)}`,
    { method: 'DELETE' }
  );
  if (!r.ok) { const e = new Error('could not undo that'); e.status = 502; throw e; }
  return { ok: true, unmuted: value };
}

// Desktop toast on or off, without touching the subscription.
//
// Deleting the subscription is what a "turn it off" button naturally does, and
// here it would have been wrong: mail-sweep picks the owners it scans from the
// subscription table, so removing the row stops the mailbox read and starves
// the in-app nudge as a side effect. The browser stays subscribed; only the
// toast is suppressed.
async function handleChannel(ownerId, body, deps) {
  const enabled = !(body && body.enabled === false);
  const r = await deps.supabaseRequest('reina_notify_rules?on_conflict=owner_id,match_kind,match_value', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([desktopChannelRule(ownerId, enabled)]),
  });
  if (!r.ok) { const e = new Error('could not save that preference'); e.status = 502; throw e; }
  return {
    ok: true,
    desktop: enabled,
    note: enabled
      ? 'Desktop notifications are back on.'
      : 'Desktop notifications are off. Mail still arrives in HiveLogic, and Reina still reads it.',
  };
}

// What she has learned, so it is a list he can read and undo -- not a model
// that quietly drifted.
async function handleRules(ownerId, deps) {
  const [rules, subs] = await Promise.all([
    deps.supabaseRequest(
      `reina_notify_rules?owner_id=eq.${enc(ownerId)}&select=match_kind,match_value,notify,source,hits,updated_at` +
      `&order=updated_at.desc&limit=200`
    ).then((r) => (r.ok ? r.json().catch(() => []) : [])),
    deps.supabaseRequest(
      `reina_push_subscriptions?owner_id=eq.${enc(ownerId)}&failed_at=is.null&select=endpoint,user_agent,created_at,last_sent_at`
    ).then((r) => (r.ok ? r.json().catch(() => []) : [])),
  ]);
  return {
    ok: true,
    configured: vapidConfigured(),
    desktop: desktopPushEnabled(rules || []),
    // The channel row lives in this table for storage reasons only. It is a
    // setting, not something Reina learned about a sender, and listing it
    // among the muted senders would invite him to "undo" it and wonder why
    // his toasts came back.
    rules: (rules || []).filter((r) => r.match_kind !== 'channel').map((r) => ({
      scope: r.match_kind, value: r.match_value, notify: r.notify,
      source: r.source, hits: r.hits, updatedAt: r.updated_at,
    })),
    devices: (subs || []).map((s) => ({
      // Never the whole endpoint: it is a live capability to push to his
      // machine, and it does not need to be in a page to identify a browser.
      id: String(s.endpoint || '').slice(-12),
      userAgent: s.user_agent, createdAt: s.created_at, lastSentAt: s.last_sent_at,
    })),
  };
}

// Proof it works, on demand, without waiting for an email to arrive. A feature
// that only reveals itself hours later is one he cannot tell is broken.
async function handleTest(ownerId, deps) {
  // "Nothing subscribed" and "you turned these off" are different answers, and
  // only one of them is something he can act on.
  const rulesRes = await deps.supabaseRequest(
    `reina_notify_rules?owner_id=eq.${enc(ownerId)}&select=match_kind,match_value,notify&limit=500`
  );
  const rules = rulesRes.ok ? ((await rulesRes.json().catch(() => [])) || []) : [];
  if (!desktopPushEnabled(rules)) {
    return { ok: true, sent: 0, desktop: false, note: 'Desktop notifications are off. Turn them on to test one.' };
  }

  const r = await deps.supabaseRequest(
    `reina_push_subscriptions?owner_id=eq.${enc(ownerId)}&failed_at=is.null&select=*`
  );
  const subs = r.ok ? ((await r.json().catch(() => [])) || []) : [];
  if (!subs.length) return { ok: true, sent: 0, note: 'No browser is subscribed yet.' };
  const result = await sendPush(subs, {
    title: 'Reina — desktop notifications are on',
    body: 'This is what a new email will look like. Nothing to do here.',
    tag: 'reina-test',
    data: { url: '/?reina=mail' },
  }, deps);
  return { ok: true, sent: result.sent, failed: result.failed };
}

export default async function handler(req, res, injected = {}) {
  const deps = Object.assign({
    supabaseRequest: defaultSupabaseRequest,
    fetchImpl: (...a) => fetch(...a),
  }, injected);

  const action = String((req.query && req.query.action) || '');

  const auth = await requireApiAuth(req, { fetchImpl: deps.fetchImpl });
  if (!auth.ok || !auth.user || !auth.user.id) {
    return jsonError(res, 401, 'Not signed in — log into HiveLogic first.');
  }
  const ownerId = auth.user.id;
  if (req.method !== 'POST' && !(req.method === 'GET' && action === 'key')) {
    return jsonError(res, 405, 'POST only');
  }
  const body = (typeof req.body === 'object' && req.body) || {};

  try {
    // The VAPID public key. Public data -- it ships to every browser that
    // subscribes -- but served behind the session anyway, because the edge
    // middleware gates /api/* wholesale and the only caller is a signed-in
    // page. It sat above requireApiAuth in the first cut, which was pointless:
    // the middleware refused the request before this file ever ran, and the
    // page read that refusal as "the keys are not set" and sent Chris to
    // Vercel to look for keys that were already there.
    if (action === 'key') {
      return res.status(200).json({ ok: true, key: vapidPublicKey(), configured: vapidConfigured() });
    }
    if (action === 'subscribe') return res.status(200).json(await handleSubscribe(ownerId, body, deps));
    if (action === 'unsubscribe') return res.status(200).json(await handleUnsubscribe(ownerId, body, deps));
    if (action === 'mute') return res.status(200).json(await handleMute(ownerId, body, deps));
    if (action === 'unmute') return res.status(200).json(await handleUnmute(ownerId, body, deps));
    if (action === 'channel') return res.status(200).json(await handleChannel(ownerId, body, deps));
    if (action === 'rules') return res.status(200).json(await handleRules(ownerId, deps));
    if (action === 'test') return res.status(200).json(await handleTest(ownerId, deps));
    return jsonError(res, 400, 'unknown action');
  } catch (e) {
    return jsonError(res, e.status || 500, String(e.message || e).slice(0, 200));
  }
}

export { safeEndpoint, domainOf };
