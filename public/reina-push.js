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
    // no-store, deliberately. This is a GET with a stable URL, so Chrome will
    // happily serve it from memory cache -- and then the moment the VAPID keys
    // are added in Vercel, this page keeps insisting notifications are "not set
    // up" until a hard refresh nobody knows to do. Found in the browser.
    return fetch('/api/reina/push?action=key', { cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (d) {
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
    return fetch('/api/reina/push?action=key', { cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (d) {
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
  function rules() { return api('rules', {}); }
  function unmute(value, scope) { return api('unmute', { value: value, scope: scope }); }

  /* The service worker focuses an existing tab rather than opening a second
     one, then tells the page which email it was about. Without this he lands
     on HiveLogic and has to find it himself, which is most of the way back to
     having no notification. */
  if ('serviceWorker' in navigator && navigator.serviceWorker.addEventListener) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      var msg = event && event.data;
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
  }

  window.hlReinaPush = {
    supported: supported, status: status, enable: enable, disable: disable,
    test: test, rules: rules, unmute: unmute,
  };
})();
