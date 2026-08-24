/* Where a preference lives.
 *
 * Chris, 2026-08-23: "as a full HiveLogic Rule, settings changed should follow
 * the user not the device. for every part of Hivelogic"
 *
 * THE SERVER IS THE RECORD. localStorage IS A CACHE.
 *
 * Both halves matter. Writing only to localStorage is the bug this replaces:
 * theme set on the office desktop, still light on the laptop; email templates
 * written once and gone on the next machine. Nobody reports that, because it
 * does not look broken -- it looks like the app forgot, so they set it again.
 *
 * But reading only from the server means a page that paints the wrong theme
 * for as long as the round trip takes, which is a flash of white at 6am. So
 * the cache is read FIRST and painted immediately, the server answers a moment
 * later, and if they disagree the server wins.
 *
 * The two tests that decide whether this is done right:
 *   1. clearing site data must not lose a setting
 *   2. a second browser must show the same settings
 *
 * NOT FOR: which microphone (the devices differ per machine), push
 * subscriptions (a capability to reach one browser, not a preference), or
 * unsent drafts. Those three are honestly about the device. See CLAUDE.md.
 */
(function () {
  var CACHE_KEY = 'hl_user_settings_cache';
  var cache = {};
  var loaded = false;
  var waiters = [];

  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (e) {}
    return {};
  }

  function writeCache(obj) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(obj)); } catch (e) {}
  }

  cache = readCache();

  function withToken(fn) {
    if (typeof window.hlRequireSession === 'function') {
      window.hlRequireSession(
        function (sess) { fn(sess && sess.access_token); },
        function () { fn(null); }
      );
    } else { fn(null); }
  }

  function request(method, body) {
    return new Promise(function (resolve, reject) {
      withToken(function (token) {
        if (!token) { reject(new Error('not signed in')); return; }
        fetch('/api/user-settings', {
          method: method,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: method === 'GET' ? undefined : JSON.stringify(body || {}),
        }).then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (d) {
            if (!d || d.ok === false) { reject(new Error((d && d.error) || 'request failed')); return; }
            resolve(d);
          }).catch(reject);
      });
    });
  }

  /* Pull the record. Everything cached is provisional until this lands. */
  function load() {
    return request('GET').then(function (d) {
      cache = (d && d.settings) || {};
      writeCache(cache);
      loaded = true;
      var list = waiters; waiters = [];
      list.forEach(function (fn) { try { fn(cache); } catch (e) {} });
      return cache;
    }).catch(function (e) {
      // Offline, or the session lapsed. The cache is what we have; say nothing
      // and keep the last known state rather than reverting his preferences to
      // defaults in front of him.
      loaded = true;
      var list = waiters; waiters = [];
      list.forEach(function (fn) { try { fn(cache); } catch (e2) {} });
      throw e;
    });
  }

  /* Synchronous, cache-only. For the first paint, before the server answers.
     Use ready() when the answer has to be right rather than immediate. */
  function get(key, fallback) {
    return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : fallback;
  }

  function ready(fn) {
    if (loaded) { try { fn(cache); } catch (e) {} return; }
    waiters.push(fn);
  }

  /* Write one preference. The cache updates immediately so the UI does not
     wait on a round trip, and the server call is what makes it real -- a
     failure here must not be silent, or we are back to a setting that looks
     saved and is not. Pass null to clear. */
  function set(key, value) {
    if (value === null) delete cache[key]; else cache[key] = value;
    writeCache(cache);
    var patch = {}; patch[key] = value;
    return request('POST', { settings: patch }).then(function (d) {
      cache = (d && d.settings) || cache;
      writeCache(cache);
      return cache;
    });
  }

  window.hlUserSettings = {
    get: get, set: set, load: load, ready: ready,
    all: function () { return Object.assign({}, cache); },
    CACHE_KEY: CACHE_KEY,
  };

  // Load as soon as there is a session to load it with.
  try { load().catch(function () {}); } catch (e) {}
})();
