// public/hl-shared-auth.js
// Canonical HiveLogic browser auth helper (Marketing Suite Phase 2, 2026-07-30).
//
// hlTokenSync() reads the current Supabase session access token straight out
// of localStorage. Before this file existed, the exact same function body was
// duplicated verbatim in two places:
//   - public/index.html (added 2026-07-29 as part of the P0 auth patch,
//     commit 1e07ce4 -- that file also owns a global window.fetch shim built
//     on top of it; that shim is NOT duplicated here, it stays put in
//     index.html for this slice to avoid touching the main SPA's recently
//     shipped P0 security fix -- see the Marketing Suite master build plan,
//     Phase 2 Progress Log entry, for why that's an intentional, logged scope
//     cut rather than a silent gap)
//   - public/marketing-command-center/index.html (its own separate standalone
//     page, so it could not reach index.html's global function)
//
// This file is the one real source of truth for that token-parsing logic.
// Loaded as a plain <script src="/hl-shared-auth.js"> (no bundler/ES modules
// anywhere else in this repo's frontend), exposing window.HL_AUTH.
(function (global) {
  function hlTokenSync() {
    try {
      var keys = Object.keys(localStorage);
      var pref = keys.filter(function (k) { return k.indexOf('sqhusuuhlmcmkeowdrga') >= 0 && k.indexOf('auth-token') >= 0; });
      var all = pref.length ? pref : keys.filter(function (k) { return k.indexOf('auth-token') >= 0; });
      for (var i = 0; i < all.length; i++) {
        var v = JSON.parse(localStorage.getItem(all[i]));
        if (v && v.access_token) return v.access_token;
        if (v && v.currentSession && v.currentSession.access_token) return v.currentSession.access_token;
      }
    } catch (e) {}
    return null;
  }

  // Generic fetch-and-parse-JSON helper that attaches the current session
  // token as a Bearer Authorization header, unless the caller already set
  // one explicitly (never override an explicit header -- e.g. a cron-secret
  // call, or a deliberately unauthenticated probe). Callers own their own
  // resource base URL (e.g. '/api/marketing?resource=...' vs
  // '/api/track1?resource=...') -- this only owns the token attachment.
  function hlFetchJSON(url, opts) {
    opts = opts || {};
    var headers = opts.headers ? Object.assign({}, opts.headers) : {};
    var hasAuth = !!(headers.Authorization || headers.authorization);
    if (!hasAuth) {
      var token = hlTokenSync();
      if (token) headers.Authorization = 'Bearer ' + token;
    }
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    return fetch(url, Object.assign({}, opts, { headers: headers })).then(function (r) { return r.json(); });
  }

  global.HL_AUTH = { hlTokenSync: hlTokenSync, hlFetchJSON: hlFetchJSON };
})(typeof window !== 'undefined' ? window : globalThis);
