/* Reina's desktop notifications, the part that runs with no page open.
 *
 * Chris, 2026-08-19: "it cant be a windows notification? only on the computer
 * should the nitifcations happen."
 *
 * This is the only code in HiveLogic that runs when HiveLogic is closed. Chrome
 * wakes it for a push, it draws the Windows toast, and it handles what he
 * presses. Keep it small and keep it dumb -- there is no console to watch and
 * nothing here can prompt him for anything.
 *
 * DELIBERATELY NOT A CACHING SERVICE WORKER. It never intercepts fetch. The
 * other three (field, clientportal, subportal) cache their app shells; doing
 * that here would mean the main HiveLogic page could be served stale from a
 * worker nobody remembers registering, and a stale HiveLogic is a much worse
 * bug than a missed toast.
 */

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = {}; }
  var title = payload.title || 'Reina';
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body || '',
    // One notification per message: a re-send replaces the toast instead of
    // stacking a second copy of the same email.
    tag: payload.tag || 'reina',
    renotify: false,
    data: payload.data || {},
    // No icon/badge: this repo ships no favicon, and pointing at one that 404s
    // buys a broken-image request per toast for exactly the same result as
    // letting Chrome use its own.
    actions: payload.actions || [],
    // He is mid-something. It waits in the Action Center until he looks --
    // it does not evaporate after four seconds like a chat ping.
    requireInteraction: true,
  }));
});

self.addEventListener('notificationclick', function (event) {
  var data = (event.notification && event.notification.data) || {};
  event.notification.close();

  /* "Not this sender" -- the learning signal, pressed at the one moment he
     actually knows the answer. Asking him to open the app to say a
     notification was not worth opening is the joke that writes itself. */
  if (event.action === 'mute' && data.fromAddress) {
    event.waitUntil(
      fetch('/api/reina/push?action=mute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The session cookie is what authorises this; there is no page to read
        // a token from.
        credentials: 'include',
        body: JSON.stringify({ fromAddress: data.fromAddress, scope: 'sender' }),
      }).then(function () {
        return self.registration.showNotification('Reina', {
          body: 'Silenced ' + data.fromAddress + '. It still shows up in HiveLogic.',
          tag: 'reina-muted',
        });
      }).catch(function () {
        // He is offline or the session lapsed. Say so rather than leaving him
        // believing a sender is silenced when nothing was written.
        return self.registration.showNotification('Reina', {
          body: 'Could not silence that from here — open HiveLogic and try again.',
          tag: 'reina-muted',
        });
      })
    );
    return;
  }

  /* Otherwise: bring HiveLogic forward. Focusing a tab he already has open
     beats opening a second one -- he may have an estimate half-built in it. */
  var url = data.url || '/?reina=mail';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.url && c.url.indexOf(self.location.origin) === 0 && 'focus' in c) {
          if (data.messageId && c.postMessage) {
            try { c.postMessage({ type: 'reina-open-mail', data: data }); } catch (e) {}
          }
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
