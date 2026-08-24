/* Turning desktop notifications on, from the page.
 *
 * Chris, 2026-08-19: "lets add the notifications while hivelogic is closed."
 *
 * Three things have to line up before a Windows toast can ever appear, and all
 * three can fail in ways that look identical from the outside -- a silence.
 * So every one of them is reported by name:
 *   1. the browser supports push          (some do not)
 *   2. HE granted permission              (and a denial is sticky)
 *   3. the server has VAPID keys set      (nothing works without them)
 *
 * Exposed as window.hlReinaPush so the settings UI is the only thing that has
 * to know any of this.
 */
(function () {
  'use strict';

  var SW_URL = '/reina-push-sw.js';
  var registration = null;

  function api(action, body) {
    return new Promise(function (resolve, reject) {
      var send = function (token) {
        var headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = 'Bearer ' + token;
        fetch('/api/reina/push?action=' + action, {
          method: 'POST', headers: headers, credentials: 'include',
          body: JSON.stringify(body || {}),
        }).then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (d) {
            if (!d || d.ok === false) return reject(new Error((d && d.error) || 'request failed'));
            resolve(d);
          }).catch(reject);
      };
      if (typeof window.hlRequireSession === 'function') {
        window.hlRequireSession(function (sess) { send(sess && sess.access_token); },
          function () { reject(new Error('not signed in')); });
      } else { send(null); }
    });
  }

  /* The VAPID public key.
   *
   * This is PUBLIC data -- it is the key browsers subscribe against, and it
   * ships to every visitor by design. It is still fetched WITH his session,
   * because HiveLogic's edge middleware gates /api/* wholesale and does not
   * care what the payload is. Found live: an unauthenticated GET here comes
   * back {"ok":false,"error":"Authentication required."} from the middleware,
   * never reaching the handler -- and since that JSON has no `configured`
   * field, the page read it as "not set up on the server" and told him the
   * keys were missing when they were sitting right there in Vercel.
   *
   * Authenticating the call is the fix rather than adding a public route: the
   * only thing that needs this key is a signed-in page, so opening a hole in
   * the guard would buy nothing and cost surface area. */
  function getKey() {
    return new Promise(function (resolve, reject) {
      var go = function (token) {
        var headers = {};
        if (token) headers.Authorization = 'Bearer ' + token;
        // no-store: a GET with a stable URL is otherwise served from Chrome's
        // memory cache, so the moment the VAPID keys are added in Vercel this
        // page would keep insisting they were missing until a hard refresh
        // nobody knows to do.
        fetch('/api/reina/push?action=key', { headers: headers, credentials: 'include', cache: 'no-store' })
          .then(function (r) { return r.json().catch(function () { return null; }); })
          .then(resolve).catch(reject);
      };
      if (typeof window.hlRequireSession === 'function') {
        window.hlRequireSession(function (sess) { go(sess && sess.access_token); }, function () { go(null); });
      } else { go(null); }
    });
  }

  // The VAPID key arrives base64url and the browser wants raw bytes.
  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = window.atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
    return out;
  }

  function supported() {
    return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
  }

  /* What is true right now, in words that name the actual blocker. "Off" with
     no reason is the state that makes him think the feature is broken when in
     fact he clicked Block three weeks ago. */
  function status() {
    if (!supported()) {
      return Promise.resolve({ supported: false, state: 'unsupported',
        detail: 'This browser cannot show desktop notifications.' });
    }
    return getKey()
      .then(function (d) {
        // An auth failure is NOT "not configured". Saying so would send him to
        // Vercel to re-check keys that were never the problem.
        if (d && d.ok === false) {
          return { supported: true, state: 'unknown',
            detail: 'Could not check with HiveLogic \u2014 ' + (d.error || 'try signing in again') };
        }
        var configured = !!(d && d.configured);
        var permission = Notification.permission;
        if (!configured) {
          return { supported: true, configured: false, state: 'unconfigured',
            detail: 'Desktop notifications are not set up on the server yet.' };
        }
        if (permission === 'denied') {
          return { supported: true, configured: true, permission: permission, state: 'blocked',
            detail: 'You blocked notifications for this site. Chrome only lets you undo that from the padlock in the address bar.' };
        }
        return navigator.serviceWorker.getRegistration(SW_URL).then(function (reg) {
          if (!reg) return { supported: true, configured: true, permission: permission, state: 'off' };
          return reg.pushManager.getSubscription().then(function (sub) {
            return { supported: true, configured: true, permission: permission,
              state: sub ? 'on' : 'off' };
          });
        });
      })
      .catch(function () {
        return { supported: true, state: 'unknown', detail: 'Could not reach HiveLogic to check.' };
      });
  }

  function enable() {
    if (!supported()) return Promise.reject(new Error('This browser cannot show desktop notifications.'));
    return getKey()
      .then(function (d) {
        if (d && d.ok === false) throw new Error(String(d.error || 'HiveLogic refused that request'));
        if (!d || !d.configured || !d.key) {
          throw new Error('Desktop notifications are not set up on the server yet.');
        }
        return navigator.serviceWorker.register(SW_URL).then(function (reg) {
          registration = reg;
          return navigator.serviceWorker.ready.then(function () { return d.key; });
        });
      })
      .then(function (key) {
        return Notification.requestPermission().then(function (permission) {
          if (permission !== 'granted') {
            throw new Error(permission === 'denied'
              ? 'Notifications are blocked for this site — undo it from the padlock in the address bar.'
              : 'Notifications were not allowed.');
          }
          return registration.pushManager.subscribe({
            // Chrome refuses a subscription that is not userVisibleOnly: a push
            // must always produce something he can see. Which is what we want.
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(key),
          });
        });
      })
      .then(function (sub) {
        var json = sub.toJSON();
        return api('subscribe', { subscription: json, userAgent: navigator.userAgent });
      })
      .then(function () { return { ok: true, state: 'on' }; });
  }

  function disable() {
    if (!supported()) return Promise.resolve({ ok: true, state: 'unsupported' });
    return navigator.serviceWorker.getRegistration(SW_URL).then(function (reg) {
      if (!reg) return { ok: true, state: 'off' };
      return reg.pushManager.getSubscription().then(function (sub) {
        if (!sub) return { ok: true, state: 'off' };
        var endpoint = sub.endpoint;
        // Told the server FIRST. Unsubscribing locally first and then failing
        // the call would leave a row we push to forever with nothing listening.
        return api('unsubscribe', { endpoint: endpoint })
          .then(function () { return sub.unsubscribe(); })
          .then(function () { return { ok: true, state: 'off' }; });
      });
    });
  }

  function test() { return api('test', {}); }
  /* Desktop toasts on or off. Deliberately NOT disable(): that deletes the
     subscription, and mail-sweep picks the owners it scans from that table --
     so turning the toast off that way would stop the mailbox read and starve
     the in-app nudge as a side effect. */
  function setDesktop(enabled) { return api('channel', { enabled: enabled !== false }); }
  function rules() { return api('rules', {}); }
  function unmute(value, scope) { return api('unmute', { value: value, scope: scope }); }

  /* The service worker focuses an existing tab rather than opening a second
     one, then tells the page which email it was about. Without this he lands
     on HiveLogic and has to find it himself, which is most of the way back to
     having no notification. */
  /* Applying a mute the worker could not.

     The worker has no token -- that is the point of it, it runs with no page
     open -- and /api/reina/push is deliberately behind the edge guard. So the
     worker hands the press here, and this page, which IS signed in, makes the
     real call. Silence on failure would put us straight back to the bug this
     replaced: a button that reports success it did not have. */
  function applyMute(fromAddress, scope) {
    if (!fromAddress) return Promise.resolve(false);
    return api('mute', { fromAddress: fromAddress, scope: scope || 'sender' })
      .then(function () { return true; })
      .catch(function (e) {
        try { if (typeof window.chirpToast === 'function') window.chirpToast('Could not silence ' + fromAddress + ' — ' + e.message); } catch (_) {}
        return false;
      });
  }

  /* Presses made while every tab was shut. Drained on load and dropped only
     once the server has taken them, so a failed drain is retried next time
     rather than swallowed. */
  var MUTE_DB = 'reina-push';
  var MUTE_STORE = 'pending-mutes';

  function drainQueuedMutes() {
    if (!('indexedDB' in window)) return;
    var req;
    try { req = indexedDB.open(MUTE_DB, 1); } catch (e) { return; }
    // No upgrade handler on purpose: if the store does not exist yet, the
    // worker has never queued anything and there is nothing to drain.
    req.onupgradeneeded = function () { try { req.transaction.abort(); } catch (e) {} };
    req.onsuccess = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(MUTE_STORE)) return;
      var tx = db.transaction(MUTE_STORE, 'readonly');
      var all = tx.objectStore(MUTE_STORE).getAll();
      all.onsuccess = function () {
        (all.result || []).forEach(function (row) {
          applyMute(row.fromAddress, row.scope).then(function (done) {
            if (!done) return;
            try {
              var del = db.transaction(MUTE_STORE, 'readwrite');
              del.objectStore(MUTE_STORE).delete(row.fromAddress);
            } catch (e) {}
          });
        });
      };
    };
  }

  if ('serviceWorker' in navigator && navigator.serviceWorker.addEventListener) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      var msg = event && event.data;
      if (msg && msg.type === 'reina-mute' && msg.data) {
        applyMute(msg.data.fromAddress, msg.data.scope);
        return;
      }
      if (!msg || msg.type !== 'reina-open-mail' || !msg.data) return;
      try {
        if (typeof window.hlRoloHC === 'function') window.hlRoloHC('email');
        if (msg.data.graphId && typeof window.hlOpenEmailMessage === 'function') {
          window.hlOpenEmailMessage(msg.data.graphId, msg.data.homeAccountId);
        }
      } catch (e) {}
    });
  }

  // Registering the worker on every load (once permission exists) is what keeps
  // it alive across Chrome updates -- an unregistered worker receives nothing,
  // silently.
  if (supported() && Notification.permission === 'granted') {
    navigator.serviceWorker.register(SW_URL).then(function (reg) { registration = reg; }).catch(function () {});
    drainQueuedMutes();
  }

  window.hlReinaPush = {
    supported: supported, status: status, enable: enable, disable: disable,
    test: test, rules: rules, unmute: unmute, setDesktop: setDesktop,
  };
})();
