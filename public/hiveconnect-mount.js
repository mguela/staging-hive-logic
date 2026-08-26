/**
 * HIVECONNECT MERGE — mounting + auth-bridge client glue.
 * Spec: hiveconnect-hivelogic-merge-spec.md §3 items 4, 5, 8 and §9.
 *
 * ISOLATION APPROACH (v2 — light DOM + scoped CSS):
 * The first version mounted HiveConnect inside a Shadow DOM root. That turned
 * out to be fundamentally incompatible with the transplanted app.js, which was
 * written for a standalone page: it looks elements up via
 * document.getElementById (43 call sites + the `$` helper), attaches
 * click/paste delegation on `document`, and appends modals, toasts, incoming
 * call cards and context menus directly to document.body. None of that can
 * see into (or out of) a shadow root, so the app could authenticate but never
 * render or respond.
 *
 * v2 mounts HiveConnect's markup directly into #hiveconnect-root in the light
 * DOM. Isolation is preserved a different way:
 *   - IDs: verified ZERO collisions between HiveConnect's 283 element ids and
 *     HiveLogic's index.html, so document.getElementById is unambiguous.
 *   - CSS: styles-scoped.css is a build artifact (see scope-css.mjs in the
 *     work notes) in which every rule from HiveConnect's byte-identical
 *     styles.css has been rewritten to only match inside #hiveconnect-root or
 *     on elements tagged .hc-embed. HiveLogic's UI cannot be styled by it.
 *   - body-appended elements (modals/toasts/menus from app.js): a
 *     MutationObserver tags them with .hc-embed the instant they're added, so
 *     the scoped CSS reaches them. The observer only tags elements matching
 *     HiveConnect's known root ids/classes — nothing HiveLogic appends.
 *
 * The auth bridge behavior is unchanged: read HiveLogic's signed-in user
 * (window.HL_PROFILE), exchange it server-side for a bridged HiveConnect
 * session, hand that to app.js via window.__hiveconnectBridgedSession. On any
 * failure show an inline error; never touch HiveLogic's own session.
 */
(function () {
  var MOUNTED = false;
  var MOUNTING = false;

  // Roots that HiveConnect's app.js appends directly to document.body.
  // (Derived from every document.body.appendChild call site in app.js.)
  var HC_BODY_ROOTS =
    '#recovery-overlay,#contact-card,#help-overlay,#incoming-calls,#rail-toast,' +
    '#ev-toast,#hd-err,#chirp-incoming,#chirp-audio,#ev-move-menu,#ev-cat-menu,' +
    '#ev-flag-menu,#ev-ai-menu,#ev-tpl-menu,#hv-picker,' +
    '.modal-backdrop,.incoming-calls,.rail-toast,.hd-err,.ev-move-menu,.chirp-incoming';

  function currentHiveLogicUser() {
    // Read-only lookup of the signed-in user HiveLogic already exposes as
    // window.HL_PROFILE ({ id, email, ... }). Never modified here.
    try {
      if (window.HL_PROFILE && window.HL_PROFILE.id && window.HL_PROFILE.email) {
        return { id: window.HL_PROFILE.id, email: window.HL_PROFILE.email };
      }
    } catch (e) {}
    return null;
  }

  function showError(root, message) {
    root.innerHTML =
      '<div style="padding:24px;font-family:Inter,sans-serif;color:#b42318;' +
      'background:#fef3f2;border:1px solid #fda29b;border-radius:10px;max-width:520px">' +
      '<b>HiveConnect couldn\'t open.</b><br>' + message +
      '<br><br><button onclick="window.__mountHiveConnect(true)" ' +
      'style="cursor:pointer;padding:8px 14px;border-radius:8px;border:1px solid #b42318;' +
      'background:#fff;color:#b42318;font-weight:700">Try again</button>' +
      '</div>';
  }

  async function fetchBridgedSession(hivelogicUserId, hivelogicEmail) {
    // ONE MINT AT A TIME PER PAGE. See the matching note in index.html.
    //
    // Chris, 2026-08-18, on production: "HiveConnect couldn't open. Session
    // mint failed at verify step: ...otp_expired". The magic-link token is
    // single-use and each new one invalidates the last, so this mount and
    // HiveLogic's own unread-message bridge could cancel each other out.
    // Sharing the in-flight request means the page cannot race itself.
    var res = await (window.__hlHcMint || (window.__hlHcMint = fetch('/api/hiveconnect-bridge?action=session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hivelogicUserId: hivelogicUserId, hivelogicEmail: hivelogicEmail }),
    }).finally(function () { setTimeout(function () { window.__hlHcMint = null; }, 0); })));
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok || !body.ok) {
      throw new Error(body.error || ('Auth bridge returned HTTP ' + res.status));
    }
    return body.session; // { access_token, refresh_token, expires_at }
  }

  function ensureHeadAssets() {
    if (!document.getElementById('hc-scoped-css')) {
      var link = document.createElement('link');
      link.id = 'hc-scoped-css';
      link.rel = 'stylesheet';
      link.href = '/hiveconnect/styles-scoped.css';
      document.head.appendChild(link);
    }
    if (!document.getElementById('hc-fonts')) {
      var fonts = document.createElement('link');
      fonts.id = 'hc-fonts';
      fonts.rel = 'stylesheet';
      fonts.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@200;400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700;800&display=swap';
      document.head.appendChild(fonts);
    }
  }

  function tagBodyRoots() {
    // Tag any HiveConnect element app.js appends to document.body with
    // .hc-embed so the scoped stylesheet reaches it. Only known HiveConnect
    // roots are tagged — HiveLogic's own body children are never touched.
    function tag(el) {
      try {
        if (el && el.nodeType === 1 && el.matches && el.matches(HC_BODY_ROOTS)) {
          el.classList.add('hc-embed');
        }
      } catch (e) {}
    }
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) tag(added[j]);
      }
    });
    mo.observe(document.body, { childList: true });
    // Tag anything already there (e.g. on a retry after partial mount).
    var kids = document.body.children;
    for (var k = 0; k < kids.length; k++) tag(kids[k]);
  }

  function applyStoredTheme() {
    // Mirrors the inline <script> in HiveConnect's own index.html <head>.
    // data-theme on <html> only affects the scoped stylesheet's rules.
    try {
      if (localStorage.getItem('hive_theme') === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    } catch (e) {}
  }

  function loadScript(src, asModule) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      if (asModule) s.type = 'module';
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.body.appendChild(s);
    });
  }

  async function injectMarkup(root) {
    var htmlRes = await fetch('/hiveconnect/index.html');
    if (!htmlRes.ok) throw new Error('Could not load the HiveConnect module (HTTP ' + htmlRes.status + ').');
    var html = await htmlRes.text();
    var parser = new DOMParser();
    var doc = parser.parseFromString(html, 'text/html');
    // Strip HiveConnect's own <script> tags — this mount loads the same
    // scripts itself, in the same order, so nothing double-executes.
    var scripts = doc.body.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) scripts[i].remove();
    // Chris's product direction (2026-07-19): Calendar is a scheduling
    // function and lives in HiveLogic Schedule, not HiveConnect. Remove the
    // Calendar tab, its panel, and its view before the markup ever renders.
    // Calendar DATA sync is unaffected — this only removes the page/nav.
    var calBtn = doc.body.querySelector('.rail-btn[data-tab="calendar"]');
    if (calBtn) calBtn.remove();
    var calPanel = doc.body.querySelector('#panel-calendar');
    if (calPanel) calPanel.remove();
    var calView = doc.body.querySelector('#calendar-view');
    if (calView) calView.remove();
    root.innerHTML = doc.body.innerHTML;
    // Back button beside HiveConnect's notification bell (Chris's request —
    // the old floating pill covered the profile avatar). Calls the global
    // hlGoBack() that the HiveLogic shell defines.
    try {
      var hdr = root.querySelector('.sidebar-header');
      var bell = root.querySelector('#bell-btn');
      if (hdr && bell && !root.querySelector('#hc-back-btn')) {
        var bk = document.createElement('button');
        bk.id = 'hc-back-btn';
        bk.className = 'icon-btn';
        bk.title = 'Back to previous page';
        bk.textContent = '←';
        bk.style.display = 'flex';
        bk.onclick = function () { if (window.hlGoBack) window.hlGoBack(); };
        bell.parentNode.insertBefore(bk, bell);
        if (window.__hlUpdateBackBtns) window.__hlUpdateBackBtns();
      }
    } catch (e) {}
  }

  window.__mountHiveConnect = async function (isRetry) {
    var root = document.getElementById('hiveconnect-root');
    if (!root) return;
    if (MOUNTED && !isRetry) return;
    if (MOUNTING) return;
    MOUNTING = true;

    try {
      // On a fresh page load that lands directly on #/hiveconnect, this can
      // run before HiveLogic's own async startup has populated HL_PROFILE.
      // Wait for it (up to 15s) instead of failing on a startup race.
      var hlUser = currentHiveLogicUser();
      for (var waited = 0; !hlUser && waited < 15000; waited += 300) {
        await new Promise(function (r) { setTimeout(r, 300); });
        hlUser = currentHiveLogicUser();
      }
      if (!hlUser) {
        throw new Error('No signed-in HiveLogic user was found — this should never happen once ' +
          'you\'re looking at the Command Center, so if you see this, something upstream broke ' +
          'before the bridge even ran. Your HiveLogic session is untouched.');
      }

      var session = await fetchBridgedSession(hlUser.id, hlUser.email);

      applyStoredTheme();
      ensureHeadAssets();
      await injectMarkup(root);
      tagBodyRoots();

      // Hand the bridged session to HiveConnect's transplanted app.js via a
      // global flag it reads right before boot() runs (the one intentional
      // 1-line change in that file) — so no second login screen ever appears.
      window.__hiveconnectBridgedSession = session;

      // Same load order as HiveConnect's own index.html (lines 740–744):
      // supabase UMD → config.js → livekit UMD → msal UMD → app.js.
      // HiveLogic's page already ships the supabase UMD global; load it only
      // if missing so nothing is redefined underneath HiveLogic.
      if (!window.supabase || typeof window.supabase.createClient !== 'function') {
        await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
      }
      await loadScript('/hiveconnect/config.js');
      if (!window.LivekitClient) {
        await loadScript('https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js');
      }
      if (!window.msal) {
        await loadScript('https://cdn.jsdelivr.net/npm/@azure/msal-browser@2.38.4/lib/msal-browser.min.js');
      }
      await loadScript('/hiveconnect/mail-engine.js');
      // tasks.js and voip-panel.js were added to hiveconnect/index.html after
      // this mount's manual reload list was written (2026-07-19 Tasks extraction,
      // 2026-07-23/24 VoIP tab) -- both got stripped by the script-removal loop
      // above and never re-loaded here, so window.openTasksTabNative /
      // window.openVoipTab never existed and clicking those tabs threw
      // 'ReferenceError: ... is not defined'. Load them, same order as the
      // standalone page, right before app.js which calls both.
      await loadScript('/hiveconnect/tasks.js');
      await loadScript('/hiveconnect/voip-panel.js');
      // voip-callflow.js (the Call Flow drag-and-drop editor) was added to the
      // standalone hiveconnect/index.html but, like voip-panel.js before it,
      // never added to this mounted script list -- so window.voipOpenCallFlowModal
      // never existed in the embedded app and the "Open Call Flow Editor" button
      // threw 'voipOpenCallFlowModal is not defined'. Load it right after
      // voip-panel.js (it reads VOIP_UI from there), same order as the standalone page.
      await loadScript('/hiveconnect/voip-callflow.js');
      // Cowork markup layer (annotation/pointer/cursors + camera blur over the
      // live call). The standalone index.html loads these; the mounted path has
      // its own script list, so they must be added here too — otherwise
      // window.CoworkMarkup never exists and app.js's attach hook silently no-ops.
      try { await loadScript('/hiveconnect/draw.js'); } catch (e) {}
      try { await loadScript('/hiveconnect/dropzone.js'); } catch (e) {}
      if (!window.LivekitTrackProcessors) {
        // ESM-only package — dynamic-import it and expose the namespace as a global.
        try { window.LivekitTrackProcessors = await import('https://cdn.jsdelivr.net/npm/@livekit/track-processors@0.3.2/+esm'); } catch (e) {}
      }
      try { await loadScript('/hiveconnect/cowork-markup.js'); } catch (e) {}
      // app.js MUST load as a module: HiveLogic's page already declares a
      // global `var sb` (its own Supabase client) and app.js's top-level
      // `const sb` collides fatally in classic-script global scope
      // (SyntaxError before a single line runs). A module gets its own
      // top-level scope, so the byte-identical file runs untouched.
      // (Verified: hiveconnect/index.html has zero inline on*= handlers, so
      // nothing needs app.js's declarations to be global.)
      await loadScript('/hiveconnect/app.js', true);

      // Chris's request: every folder/section group starts COLLAPSED when the
      // page opens, on every tab, so the sidebar isn't a wall of open lists.
      // The transplanted app renders each tab's groups lazily and expanded by
      // default; clicking a group head both collapses it and records the state
      // in the app's own stores. Watch for newly rendered expanded groups for
      // the first 20s after mount and collapse each exactly once.
      (function autoCollapse(rootEl){
        var done = new WeakSet();
        function sweep(){
          rootEl.querySelectorAll('.division:not(.collapsed) > .div-head, .ct-folder:not(.collapsed) > .ct-head, .chirp-fold:not(.collapsed)')
            .forEach(function(head){
              if (done.has(head)) return;
              done.add(head);
              try { head.click(); } catch (e) {}
            });
        }
        var mo = new MutationObserver(sweep);
        mo.observe(rootEl, { childList: true, subtree: true });
        sweep();
        setTimeout(function(){ mo.disconnect(); }, 20000);
      })(root);

      MOUNTED = true;
    } catch (err) {
      showError(root, (err && err.message) || 'Unknown error.');
      // Do NOT set MOUNTED = true — next click retries from scratch.
    } finally {
      MOUNTING = false;
    }
  };
})();
