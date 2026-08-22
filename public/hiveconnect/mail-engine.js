// mail-engine.js — HiveConnect server-side mail engine (loads right after the
// MSAL CDN script and replaces window.msal with an MSAL-shaped shim).
//
// WHY: browser-only MSAL logins expire after ~24h (Microsoft caps SPA refresh
// tokens), so mailboxes kept asking to reconnect. The real tokens now live
// server-side (/api/msmail, ~90-day rolling refresh, renewed on use — same
// stay-connected model as QBO/Jobber). This shim keeps the exact MSAL API
// surface app.js already uses (getAllAccounts / acquireTokenSilent /
// acquireTokenPopup / loginPopup / logoutPopup / ssoSilent), so app.js needed
// no changes. If the server engine isn't configured yet (health check),
// everything transparently falls back to the real MSAL library.
(function () {
  if (window.msal && window.msal.__hcServerShim) return; // don't double-wrap
  var RealMsal = window.msal; // may be undefined if CDN failed; shim still works server-side
  var API = '/api/msmail';

  var configuredPromise = null;
  function serverOn() {
    if (!configuredPromise) {
      configuredPromise = fetch(API + '?action=health')
        .then(function (r) { return r.json(); })
        .then(function (j) { return !!j.configured; })
        .catch(function () { return false; });
    }
    return configuredPromise;
  }

  async function hcJwt() {
    try {
      var c = window.sb || window.hcSb || null;
      if (!c || !c.auth) return null;
      var s = await c.auth.getSession();
      return (s && s.data && s.data.session && s.data.session.access_token) || null;
    } catch (e) { return null; }
  }

  async function call(action, body) {
    var t = await hcJwt();
    var r = await fetch(API + '?action=' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify(body || {}),
    });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(j.error || ('msmail ' + r.status)); e.status = r.status; throw e; }
    return j;
  }

  function HcMsal(config) {
    var self = this;
    this._real = RealMsal && RealMsal.PublicClientApplication ? new RealMsal.PublicClientApplication(config) : null;
    this._accounts = [];
    this._server = null;
    this._boot = serverOn().then(function (on) {
      self._server = on;
      if (!on) return;
      return call('accounts').then(function (j) {
        self._accounts = j.accounts || [];
        // Re-render the email tab now that server accounts are known.
        try { if (window.openEmailTab) window.openEmailTab(); } catch (e) {}
      }).catch(function () {});
    });
  }

  HcMsal.prototype.getAllAccounts = function () {
    if (this._server === false && this._real) return this._real.getAllAccounts();
    return this._accounts.slice();
  };

  HcMsal.prototype.acquireTokenSilent = async function (reqObj) {
    await this._boot;
    if (!this._server) { if (this._real) return this._real.acquireTokenSilent(reqObj); throw new Error('mail engine unavailable'); }
    var id = reqObj && reqObj.account && reqObj.account.homeAccountId;
    var j = await call('token', { homeAccountId: id });
    return { accessToken: j.accessToken, account: j.account, expiresOn: j.expiresAt ? new Date(j.expiresAt) : null };
  };

  HcMsal.prototype.ssoSilent = function (reqObj) { return this.acquireTokenSilent(reqObj); };

  HcMsal.prototype.acquireTokenPopup = async function (reqObj) {
    await this._boot;
    if (!this._server) { if (this._real) return this._real.acquireTokenPopup(reqObj); throw new Error('mail engine unavailable'); }
    try { return await this.acquireTokenSilent(reqObj); }
    catch (e) { return this.loginPopup(reqObj); } // server says reauth -> one interactive pass
  };

  HcMsal.prototype.loginPopup = function (reqObj) {
    var self = this;
    // Open the window SYNCHRONOUSLY so the popup blocker sees the user click
    // (any await first would void the gesture and the popup gets blocked).
    var pop = window.open('', 'hcmsauth', 'width=480,height=680');
    return (async function () {
      await self._boot;
      if (!self._server) {
        try { if (pop) pop.close(); } catch (e) {}
        if (self._real) return self._real.loginPopup(reqObj);
        throw new Error('mail engine unavailable');
      }
      if (!pop) throw new Error('Popup blocked - allow popups for this site and try again.');
      var j;
      try { j = await call('start'); } catch (e) { try { pop.close(); } catch (e2) {} throw e; }
      pop.location.href = j.url;
      var before = {};
      self._accounts.forEach(function (a) { before[a.homeAccountId] = 1; });
      return new Promise(function (resolve, reject) {
        var done = false, busy = false, bc = null;
        function finish(acc) {
          if (done) return; done = true; cleanup();
          if (acc) {
            if (!self._accounts.some(function (a) { return a.homeAccountId === acc.homeAccountId; })) self._accounts.push(acc);
            resolve({ account: acc });
          } else reject(new Error('Sign-in window closed.'));
        }
        function onMsg(ev) {
          var d = ev && ev.data;
          if (!d || d.type !== 'hc-ms-connected' || !d.account) return;
          try { pop.close(); } catch (e) {}
          finish(d.account);
        }
        // Channel 1: BroadcastChannel — works even when Microsoft's login page
        // severs the popup/opener link (COOP), which made sign-ins "not take"
        // until the 2nd or 3rd try.
        try { bc = new BroadcastChannel('hc-ms-auth'); bc.onmessage = onMsg; } catch (e) {}
        // Channel 2: classic opener postMessage.
        window.addEventListener('message', onMsg);
        // Channel 3: popup closed with no word — ask the server whether the
        // mailbox landed anyway before calling it a failure.
        var iv = setInterval(function () {
          if (done || busy || !pop.closed) return;
          busy = true;
          call('accounts').then(function (jj) {
            var accs = jj.accounts || [];
            if (accs.length) {
              self._accounts = accs;
              var fresh = null;
              for (var i = 0; i < accs.length; i++) if (!before[accs[i].homeAccountId]) fresh = accs[i];
              finish(fresh || accs[0]);
            } else finish(null);
          }).catch(function () { finish(null); }).then(function () { busy = false; });
        }, 700);
        function cleanup() { clearInterval(iv); window.removeEventListener('message', onMsg); try { bc && bc.close(); } catch (e) {} }
      });
    })();
  };

  HcMsal.prototype.logoutPopup = async function (reqObj) {
    await this._boot;
    if (!this._server) { if (this._real) return this._real.logoutPopup(reqObj); return; }
    var id = reqObj && reqObj.account && reqObj.account.homeAccountId;
    if (id) await call('disconnect', { homeAccountId: id });
    this._accounts = this._accounts.filter(function (a) { return a.homeAccountId !== id; });
  };

  window.msal = { PublicClientApplication: HcMsal, __hcServerShim: true };
})();
