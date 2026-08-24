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

// A pressed mute that could not be applied yet.
//
// IndexedDB rather than localStorage because a service worker has no
// localStorage at all, and rather than an in-memory array because Chrome
// stops this worker between pushes -- an array would lose the press the
// moment he closed the toast.
var MUTE_DB = 'reina-push';
var MUTE_STORE = 'pending-mutes';

function muteDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(MUTE_DB, 1);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(MUTE_STORE)) db.createObjectStore(MUTE_STORE, { keyPath: 'fromAddress' });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

// keyPath is the address, so pressing it twice on two toasts from the same
// sender is one pending mute, not two.
function queueMute(fromAddress) {
  return muteDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(MUTE_STORE, 'readwrite');
      tx.objectStore(MUTE_STORE).put({ fromAddress: fromAddress, scope: 'sender', at: Date.now() });
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

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
    // Chris, 2026-08-23: "they dont ever go away?"
    //
    // This used to hold the toast open until pressed, on the reasoning that
    // he is mid-something and it should wait for him. What that actually
    // produced was a stack of toasts sitting on top of his work, each one
    // needing a separate press to clear -- and Chrome only allows two action
    // buttons, so there was no room for a Dismiss alongside Open and the mute.
    //
    // Letting it behave like a normal toast IS the dismiss button: it fades
    // after a few seconds and waits in the Action Center, where a notification
    // he has not dealt with belongs. Nothing is lost by not holding the screen
    // hostage -- the mail is on the Team To-Do either way.
  }));
});

self.addEventListener('notificationclick', function (event) {
  var data = (event.notification && event.notification.data) || {};
  event.notification.close();

  /* The mute -- the learning signal, pressed at the one moment he actually
     knows the answer. Asking him to open the app to say a notification was not
     worth opening is the joke that writes itself.

     THIS USED TO POST DIRECTLY, AND IT NEVER ONCE WORKED.

     The call went out with `credentials: 'include'` and no Authorization
     header, because a service worker has no page to read a token from. But
     requireApiAuth only ever reads the Authorization header, nothing in this
     app sets an auth cookie, and /api/reina/push is deliberately NOT on the
     edge guard's public allowlist -- so every mute was 401'd before the
     handler even ran.

     Worse than not working: fetch() RESOLVES on a 401. It rejects only on
     network failure. So the .then() ran anyway and told him "Silenced
     <sender>" while nothing had been written, and the .catch() that was meant
     to say otherwise never fired. He pressed it, was told it worked, and the
     sender kept notifying him. reina_notify_rules was empty the whole time.

     The fix does not weaken that auth boundary, because the boundary is right.
     The page has the token, so the page makes the call: hand it to an open
     HiveLogic if there is one, and otherwise put it in IndexedDB for the next
     one to drain. And say which of those two just happened, rather than
     claiming the stronger one. */
  if (event.action === 'mute' && data.fromAddress) {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
        for (var i = 0; i < list.length; i++) {
          var c = list[i];
          if (c.url && c.url.indexOf(self.location.origin) === 0 && c.postMessage) {
            try {
              c.postMessage({ type: 'reina-mute', data: { fromAddress: data.fromAddress, scope: 'sender' } });
              // An open tab applies it in the next moment, signed in, for real.
              return self.registration.showNotification('Reina', {
                body: 'Silencing ' + data.fromAddress + '. It still shows up in HiveLogic.',
                tag: 'reina-muted',
              });
            } catch (e) { /* fall through to the queue */ }
          }
        }
        return queueMute(data.fromAddress).then(function () {
          // No tab is open, which is the whole reason this notification
          // exists. Promise only what actually happens.
          return self.registration.showNotification('Reina', {
            body: data.fromAddress + ' will be silenced next time you open HiveLogic.',
            tag: 'reina-muted',
          });
        }).catch(function () {
          return self.registration.showNotification('Reina', {
            body: 'Could not silence that from here — open HiveLogic and turn it off there.',
            tag: 'reina-muted',
          });
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
