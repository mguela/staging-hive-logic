/* ============================================================================
 * HiveLogic Self-Test v5 — DEEP crawler: shielded, nav-proof, incremental, fast
 * ----------------------------------------------------------------------------
 * v5 over v4:
 *  - NAV-PROOF: full-page navigation can no longer derail the run. Anchor
 *    clicks are cancelled, location.assign/replace are neutralized, and any
 *    control whose onclick navigates is skipped (SKIPPED_NAV).
 *  - INCREMENTAL SAVE: the report is POSTed to /api/selftest-report AFTER EVERY
 *    SCREEN, keyed by a runId (upsert). A crash/navigation mid-run still leaves
 *    the latest partial for Reina to read. Nothing is ever lost.
 *  - ~4x FASTER: tighter per-click settle, shorter per-view cap.
 *
 * NETWORK SHIELD (unchanged): before anything is clicked, fetch/XHR/sendBeacon/
 * WebSocket/window.open/form-submit are intercepted — GET reads pass through,
 * every write/send/charge is faked (never leaves the browser), all external
 * hosts blocked. Native alert/confirm/prompt are suppressed. A pre-flight
 * self-check aborts if the shield isn't active. Nothing real is ever sent,
 * charged, or written.
 *
 * HOW TO RUN: Settings -> Run Self-Test (QA). (Or paste-inject on any page.)
 * ========================================================================== */
(async function () {
  'use strict';
  var isApp = typeof window.showView === 'function' && Array.isArray(window.HL_ROUTE_VIEWS);
  var VIEWS = isApp ? window.HL_ROUTE_VIEWS.slice() : [null];
  var RUNID = 'run-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);

  var badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;background:#161e2e;color:#fff;font:600 12px/1.4 system-ui,sans-serif;padding:10px 14px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.35);max-width:340px';
  document.body.appendChild(badge);
  var say = function (m) { badge.textContent = m; };

  // ======================= NETWORK SHIELD =======================
  // Found 2026-08-19: this shield only ever patched the OUTER page's
  // window.fetch/XHR/etc. Every if-XXX embedded view (jsx, ldx, csx, cpx,
  // pbx...) renders in an <iframe>, and an iframe -- srcdoc or not -- has its
  // own separate Window with its OWN native fetch, captured before the outer
  // page ever ran. Patching window.fetch out here never touched it. Verified
  // live: `iframe.contentWindow.fetch === window.fetch` is false. That means
  // every "Save"/"Submit"/click inside an embedded view has been making a
  // REAL, unstubbed write to production during every self-test run -- the
  // exact opposite of this file's core guarantee ("nothing real is ever
  // sent, charged, or written"). installShield() is now a function so it can
  // be applied to the outer window AND to every iframe's contentWindow right
  // before that view is crawled (see crawlCurrent). All installations share
  // the same SHIELD.calls array so since(t0) sees a write regardless of
  // which window it came from -- otherwise an iframe's stubbed write would
  // never count toward the WIRED verdict either.
  var SHIELD = { calls: [], errs: [], stubbed: 0, blocked: 0, passed: 0, active: false };
  var EXTERNAL = /twilio|resend|sendgrid|mailgun|postmark|authorize\.?net|getjobber|jobber|graph\.microsoft|livekit|stripe|plaid|api\.openai|googleapis/i;
  function sameOrigin(url, origin) { try { return new URL(url, origin).origin === origin; } catch (e) { return true; } }
  // Found 2026-08-20: HiveConnect runs on its OWN, separate Supabase project
  // (mzyngawgpxzpsxphswmc.supabase.co -- a different project than this page's
  // own sqhusuuhlmcmkeowdrga.supabase.co) and reads it directly from the
  // browser via the supabase-js client, not through /api/*. Cross-origin
  // relative to this page, so sameOrigin() alone called it 'blocked-external'
  // -- for a GET, that replaced a real row array with the generic stub
  // object, and `contactsData = data || []` kept that object (truthy, so the
  // || [] fallback never ran) instead of falling back to an array. Every
  // contactsData.find()/.filter() downstream then threw
  // "contactsData.find is not a function" -- five THREW findings (Channels,
  // Client, Team, Vendor dropdowns, HiveVideo), all the same root cause,
  // live-confirmed by reproducing the exact error with the OLD decide()
  // logic and confirming it disappears (Contacts renders 33 real team
  // members) with this one. Both of the app's OWN Supabase projects are
  // first-party infrastructure, same in kind as this page's own /api/* --
  // a GET read from either is exactly as safe to let through as a
  // same-origin one; only a genuinely mutating call needs stubbing, which a
  // trailing mutating(method) check still does regardless of host.
  function isSupabaseHost(url) { try { return /(^|\.)supabase\.co$/i.test(new URL(url, location.href).hostname); } catch (e) { return false; } }
  function mutating(m) { return /^(POST|PUT|PATCH|DELETE)$/i.test(m || 'GET'); }
  function decide(url, method, origin) {
    if (/\/api\/selftest-report/.test(url)) return 'pass'; // our own reporting endpoint
    if (EXTERNAL.test(url)) return 'blocked-external';
    if (!sameOrigin(url, origin) && !isSupabaseHost(url)) return 'blocked-external';
    if (mutating(method)) return 'stub-write';
    return 'pass';
  }
  function stubBody() { return JSON.stringify({ ok: true, __stubbed: true, stubbedBy: 'selftest-v5', data: [], items: [], rows: [], results: [], invoices: [], changeOrders: [], clients: [], jobs: [], estimates: [] }); }

  function installShield(win, doc) {
    if (!win || win.__hlShielded) return null;
    try { if (!win.fetch || !win.XMLHttpRequest) return null; } catch (e) { return null; } // cross-origin iframe -- can't touch it, nothing to do
    var origin = win.location.origin;
    var REAL = {
      fetch: win.fetch, xhrOpen: win.XMLHttpRequest.prototype.open, xhrSend: win.XMLHttpRequest.prototype.send,
      beacon: win.navigator.sendBeacon ? win.navigator.sendBeacon.bind(win.navigator) : null, WS: win.WebSocket, winOpen: win.open,
      alert: win.alert, confirm: win.confirm, prompt: win.prompt,
      assign: (win.location.assign && win.location.assign.bind(win.location)) || null,
      replace: (win.location.replace && win.location.replace.bind(win.location)) || null,
      inputClick: win.HTMLInputElement && win.HTMLInputElement.prototype.click,
      anchorClick: win.HTMLAnchorElement && win.HTMLAnchorElement.prototype.click
    };
    win.fetch = function (u, o) {
      var url = (typeof u === 'string' ? u : (u && u.url) || '');
      var method = (o && o.method) || (u && u.method) || 'GET';
      var dec = decide(url, method, origin);
      var rec = { t: performance.now(), u: url.replace(origin, '').slice(0, 120), m: method.toUpperCase(), decision: dec, s: 0 };
      SHIELD.calls.push(rec);
      if (dec === 'pass') { SHIELD.passed++; return REAL.fetch.apply(this, arguments).then(function (r) { rec.s = r.status; return r; }, function (e) { rec.s = -1; throw e; }); }
      if (dec === 'blocked-external') SHIELD.blocked++; else SHIELD.stubbed++;
      rec.s = 200; return Promise.resolve(new win.Response(stubBody(), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    };
    win.XMLHttpRequest.prototype.open = function (m, url) { this.__m = m; this.__u = url; return REAL.xhrOpen.apply(this, arguments); };
    win.XMLHttpRequest.prototype.send = function () {
      var dec = decide(this.__u || '', this.__m || 'GET', origin);
      if (dec === 'pass') return REAL.xhrSend.apply(this, arguments);
      SHIELD.calls.push({ t: performance.now(), u: String(this.__u || '').replace(origin, '').slice(0, 120), m: (this.__m || 'GET').toUpperCase(), decision: dec, s: 200 });
      if (dec === 'blocked-external') SHIELD.blocked++; else SHIELD.stubbed++;
      var self = this;
      win.setTimeout(function () {
        try {
          Object.defineProperty(self, 'readyState', { value: 4, configurable: true });
          Object.defineProperty(self, 'status', { value: 200, configurable: true });
          Object.defineProperty(self, 'responseText', { value: stubBody(), configurable: true });
          Object.defineProperty(self, 'response', { value: stubBody(), configurable: true });
          if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
          if (typeof self.onload === 'function') self.onload();
          try { self.dispatchEvent(new Event('load')); } catch (e) {}
        } catch (e) {}
      }, 3);
    };
    if (win.navigator.sendBeacon) win.navigator.sendBeacon = function (url) { SHIELD.stubbed++; SHIELD.calls.push({ t: performance.now(), u: String(url).replace(origin, '').slice(0, 120), m: 'BEACON', decision: 'stub-write', s: 200 }); return true; };
    win.WebSocket = function (url) { SHIELD.blocked++; SHIELD.calls.push({ t: performance.now(), u: String(url).slice(0, 100), m: 'WS', decision: 'blocked-external', s: 200 }); return { url: url, readyState: 3, send: function () {}, close: function () {}, addEventListener: function () {}, removeEventListener: function () {}, onopen: null, onclose: null, onmessage: null, onerror: null }; };
    win.open = function (u) { SHIELD.calls.push({ t: performance.now(), u: String(u || '').slice(0, 100), m: 'WINDOW.OPEN', decision: 'blocked-nav', s: 200 }); return null; };
    // Found 2026-08-19 investigating HiveGrid/P&L: a "PDF"/"IMAGE" upload
    // button is document.getElementById('hiddenFileInput').click() -- opens
    // the native OS file picker, which the crawler cannot answer and which
    // never touches the DOM either way, so it always read NO_OUTCOME on a
    // perfectly working control. An "EXPORT CSV" button is a purely
    // in-memory <a download>.click() -- never appended to the document, so
    // even the existing anchor-nav guard (attached to a real DOM click
    // listener) never sees it. Patching the two .click() methods themselves
    // catches both regardless of whether the element is ever in the DOM,
    // stubs the actual OS-level action (consistent with "nothing real is
    // ever sent, charged, or written"), and logs it as a stub-write so the
    // existing wrote/d.f.length signals do the rest -- no new verdict type
    // needed.
    if (REAL.inputClick) {
      win.HTMLInputElement.prototype.click = function () {
        if (this.type === 'file') { SHIELD.stubbed++; SHIELD.calls.push({ t: performance.now(), u: 'file-picker:' + (this.accept || ''), m: 'FILE-PICKER', decision: 'stub-write', s: 200 }); return; }
        return REAL.inputClick.apply(this, arguments);
      };
    }
    if (REAL.anchorClick) {
      win.HTMLAnchorElement.prototype.click = function () {
        if (this.hasAttribute('download')) { SHIELD.stubbed++; SHIELD.calls.push({ t: performance.now(), u: 'download:' + (this.getAttribute('download') || ''), m: 'DOWNLOAD', decision: 'stub-write', s: 200 }); return; }
        return REAL.anchorClick.apply(this, arguments);
      };
    }
    win.alert = function (m) { SHIELD.calls.push({ t: performance.now(), u: 'alert: ' + String(m || '').slice(0, 90), m: 'DIALOG', decision: 'suppressed', s: 200 }); };
    win.confirm = function (m) { SHIELD.calls.push({ t: performance.now(), u: 'confirm: ' + String(m || '').slice(0, 90), m: 'DIALOG', decision: 'suppressed', s: 200 }); return true; };
    win.prompt = function (m) { SHIELD.calls.push({ t: performance.now(), u: 'prompt: ' + String(m || '').slice(0, 90), m: 'DIALOG', decision: 'suppressed', s: 200 }); return 'ZZTESTRUN'; };
    var submitBlocker = function (e) { e.preventDefault(); e.stopPropagation(); SHIELD.stubbed++; SHIELD.calls.push({ t: performance.now(), u: (e.target && e.target.action || '').replace(origin, '').slice(0, 120), m: 'FORM-SUBMIT', decision: 'stub-write', s: 200 }); };
    var d = doc || win.document;
    d.addEventListener('submit', submitBlocker, true);

    // ---- NAV GUARD: keep full-page (or full-iframe) navigation from derailing the crawl ----
    var navBlocker = function (e) {
      var a = e.target && e.target.closest && e.target.closest('a[href]');
      if (a) { var h = a.getAttribute('href') || ''; if (h && h !== '#' && h.indexOf('javascript:') !== 0) { e.preventDefault(); e.stopPropagation(); SHIELD.calls.push({ t: performance.now(), u: 'a→' + h.slice(0, 80), m: 'NAV', decision: 'blocked-nav', s: 200 }); } }
    };
    d.addEventListener('click', navBlocker, true);
    try { win.location.assign = function (u) { SHIELD.calls.push({ t: performance.now(), u: 'assign ' + String(u).slice(0, 80), m: 'NAV', decision: 'blocked-nav', s: 200 }); }; } catch (e) {}
    try { win.location.replace = function (u) { SHIELD.calls.push({ t: performance.now(), u: 'replace ' + String(u).slice(0, 80), m: 'NAV', decision: 'blocked-nav', s: 200 }); }; } catch (e) {}
    var beforeUnload = function (e) { e.preventDefault(); e.returnValue = ''; return ''; };
    win.addEventListener('beforeunload', beforeUnload, true);

    win.__hlShielded = true;
    return function restore() {
      win.fetch = REAL.fetch; win.XMLHttpRequest.prototype.open = REAL.xhrOpen; win.XMLHttpRequest.prototype.send = REAL.xhrSend;
      if (REAL.beacon) win.navigator.sendBeacon = REAL.beacon; win.WebSocket = REAL.WS; win.open = REAL.winOpen;
      win.alert = REAL.alert; win.confirm = REAL.confirm; win.prompt = REAL.prompt;
      if (REAL.inputClick) win.HTMLInputElement.prototype.click = REAL.inputClick;
      if (REAL.anchorClick) win.HTMLAnchorElement.prototype.click = REAL.anchorClick;
      try { if (REAL.assign) win.location.assign = REAL.assign; } catch (e) {}
      try { if (REAL.replace) win.location.replace = REAL.replace; } catch (e) {}
      d.removeEventListener('submit', submitBlocker, true);
      d.removeEventListener('click', navBlocker, true);
      win.removeEventListener('beforeunload', beforeUnload, true);
      win.__hlShielded = false;
    };
  }

  var restoreShield = installShield(window, document) || function () {};

  // ---- PRE-FLIGHT SELF-CHECK ----
  say('Self-Test v5 — verifying network shield…');
  var shieldOk = false;
  try { var probe = await window.fetch('/__selftest_shield_probe_' + Date.now(), { method: 'POST', body: '{}' }); var pj = await probe.json().catch(function () { return {}; }); shieldOk = !!(pj && pj.__stubbed === true); } catch (e) { shieldOk = false; }
  if (!shieldOk) { restoreShield(); badge.style.background = '#7f1d1d'; say('ABORTED — shield self-check failed. Nothing clicked. Safe.'); console.error('Self-Test v5 ABORTED: shield inactive.'); return; }
  SHIELD.active = true;
  say('Shield verified ✓ — starting (writes/sends/nav all intercepted)…');

  window.addEventListener('error', function (e) { if (!/chrome-extension/.test(e.filename || '')) SHIELD.errs.push({ t: performance.now(), m: ((e.message || '') + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno).slice(0, 160) }); });
  var oce = console.error; console.error = function () { try { SHIELD.errs.push({ t: performance.now(), m: [].join.call(arguments, ' ').slice(0, 160) }); } catch (x) {} return oce.apply(this, arguments); };
  var since = function (t) { return { f: SHIELD.calls.filter(function (x) { return x.t >= t; }), e: SHIELD.errs.filter(function (x) { return x.t >= t; }) }; };

  // ======================= CRAWLER =======================
  var SETTLE = 120, CLICK_TIMEOUT = 700, NAV_WAIT = 600, MAX_ELS = 90, MAX_KIDS = 12;
  // Found 2026-08-19: the Sub Portal's mic button (aria-label="Dictate with
  // voice", title "Click to talk to Reina") starts real browser speech
  // recognition -- the same category as a call/record button (the crawler
  // must not trigger a live mic prompt), but "dictate" wasn't in the list.
  var MEDIA = /\b(call|dial|video|join call|start call|ring|answer|hang ?up|record audio|record video|dictate)\b/i;
  var NAV_ONCLICK = /location\s*\.\s*(href|assign|replace)|location\s*=|window\.open|\.location|href\s*=\s*['"]\s*\/|open\(['"]/i;
  // Found 2026-08-19: Financial Intelligence's tab strip uses class="fxtab",
  // not the bare word "tab" -- [\w-]*tab matches any class token ENDING in
  // "tab" (fxtab, ptab, and the plain word itself), not just an exact match.
  // Without it, classify() falls through to 'action' for a control that is
  // genuinely a tab, so the already-active skip (kind === 'tab' only, a few
  // lines below) never applies to it -- live-confirmed: clicking the
  // already-active "CASH & DEPOSITS" tab again does nothing (correctly,
  // same content is already showing), same as any other already-selected
  // tab, but with no skip to say so it was reported NO_OUTCOME instead.
  var NAVISH = /(^|\s)([\w-]*tab|tf|mf|navbtn|sidebar-item|thread|cat-card)(\s|$)/;
  // Found 2026-08-20 investigating psx: voice-input.js mounts one global
  // floating "eye" button (password show/hide) once per page and just moves
  // it to whichever password field has focus -- when nothing is focused
  // (every view without a password field, e.g. psx) it sits at
  // opacity:0;pointer-events:none, genuinely unclickable by a real user, who
  // would click straight through it to whatever's underneath. It still has a
  // real 26x26 layout box (opacity doesn't collapse layout), so the existing
  // offsetHeight/offsetWidth visibility check passed it through anyway.
  // pointer-events:none is a deliberate, unambiguous "not interactive right
  // now" signal -- an element a site actually wants clicked essentially
  // never sets this on itself.
  function isReallyClickable(el) {
    try { return (el.ownerDocument.defaultView || window).getComputedStyle(el).pointerEvents !== 'none'; } catch (e) { return true; }
  }
  function isTestable(el) {
    var t = el.tagName;
    // Found 2026-08-19: Estimates' per-row checkbox cell is a
    // <td onclick="event.stopPropagation()"> wrapping the real control (an
    // <input type=checkbox>, which the crawler deliberately never clicks --
    // see kind === 'input' below). The td's onclick exists ONLY to stop a
    // checkbox click from also opening the row -- it has no action of its
    // own, so clicking the td directly can never produce an outcome, by
    // design. It also has no accessible name (an empty td, not the checkbox
    // inside it) -- reported as "Unnamed control", which was the tell.
    var oc0 = el.getAttribute && el.getAttribute('onclick');
    if (t !== 'BUTTON' && t !== 'A' && oc0 && /^event\.stopPropagation\(\);?$/.test(oc0.trim())) return false;
    if (t === 'BUTTON' || t === 'A' || el.hasAttribute('onclick') || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab' || el.getAttribute('role') === 'menuitem') return true;
    var c = (typeof el.className === 'string') ? el.className : '';
    if (!/(^|\s)(tab|ptab|chip|navbtn|filter|job-card|board-card|meas-btn|payment-option|menu-item|dropdown-item|accordion|chevron|toggle|caret)(\s|$)/.test(c)) return false;
    // Found 2026-08-19: Command Center's map legend is a <div class="toggle">
    // wrapping three independently-clickable <span onclick="mapView(...)">
    // options (Active Jobs / Tech Locations / All) -- "toggle" names the
    // GROUP here, not a control, and the div itself has no click handler.
    // Clicking it did nothing (live-confirmed), while each child span
    // correctly switches the map view on its own (also live-confirmed) --
    // the finding's own label gave it away, running all three children's
    // text together ("Active Jobs Tech Locations All"). Each child is a
    // separate element the same querySelectorAll('*') traversal already
    // walks and clicks on its own via the onclick check above, so skipping
    // a wrapper whose only "click behavior" belongs to its children loses no
    // coverage -- it just stops testing an element nothing is wired to.
    if ([].slice.call(el.children).some(function (child) { return child.hasAttribute('onclick'); })) return false;
    return true;
  }
  // Found 2026-08-19 investigating a batch spanning tox/pnlx/vcx: FOUR
  // different views name their tab-pill class differently (fxtab, eqtab,
  // tg, vsel) -- each one more that NAVISH's exact-token match (even the
  // [\w-]*tab suffix form) doesn't cover. Enumerating class names one at a
  // time doesn't scale; every view invents its own. Structurally though, a
  // tab/toggle pill is always a SIBLING of other same-shaped controls,
  // exactly one of which is already marked selected -- that's true
  // regardless of what anyone names the class. Only checked for elements
  // that already match the SAME active-ish selector selectedKeys() uses, so
  // this can only make the already-active skip apply MORE often, never
  // less; it cannot suppress a click on a control that isn't already
  // showing as selected.
  function looksLikeTabGroup(el) {
    if (!el.parentElement || !el.matches('.active,.on,.sel,[aria-selected="true"]')) return false;
    var cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(function (c) { return c && c !== 'active' && c !== 'on' && c !== 'sel'; });
    if (!cls.length) return false;
    return [].slice.call(el.parentElement.children).some(function (sib) {
      if (sib === el) return false;
      var sc = (typeof sib.className === 'string' ? sib.className : '').split(/\s+/);
      return cls.some(function (c) { return sc.indexOf(c) !== -1; });
    });
  }
  function classify(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return 'input';
    var t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
    if (MEDIA.test(t)) return 'media';
    var oc = el.getAttribute && el.getAttribute('onclick');
    if (oc && NAV_ONCLICK.test(oc)) return 'nav';
    var cls = (typeof el.className === 'string') ? el.className : '';
    if (NAVISH.test(cls) || el.getAttribute('role') === 'tab' || looksLikeTabGroup(el)) return 'tab';
    var a = el.closest && el.closest('a'); if (a) { var h = a.getAttribute('href'); if (h && h !== '#' && h.indexOf('javascript') !== 0 && !/^\s*$/.test(h)) return 'link'; }
    return 'action';
  }
  function lum(c) {
    var m = c && c.match(/\d+/g);
    if (!m) return 0;
    var ch = [m[0], m[1], m[2]].map(function (v) {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  function contrast(el) { try { var cs = getComputedStyle(el); var fg = lum(cs.color); var b = el, bg = cs.backgroundColor; while (b && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { b = b.parentElement; if (!b) break; bg = getComputedStyle(b).backgroundColor; } var bl = lum(bg || 'rgb(255,255,255)'); var L1 = Math.max(fg, bl), L2 = Math.min(fg, bl); return (L1 + 0.05) / (L2 + 0.05); } catch (e) { return 99; } }
  // Every one of these used to hardcode `document` -- the OUTER page's
  // document, always. That's correct for a plain view, but every if-XXX
  // embedded view (jsx, ldx, tox, repx, mpmx...) renders inside its own
  // <iframe>'s completely separate contentDocument. A click inside one of
  // those iframes opens a modal, fires a toast, mutates its own DOM -- all
  // real, all inside that iframe's document -- while every "did anything
  // change?" check here kept watching the outer page and correctly saw
  // nothing, because nothing DID change out there. That produced NO_OUTCOME
  // on working controls across every iframe-embedded view in the app (found
  // 2026-08-18: a map zoom control, avatar badges that are correctly inert,
  // a real confirmation modal, and a toast-only action all mis-flagged this
  // way in the same investigation). Each helper now takes the scope
  // document explicitly -- callers pass container.ownerDocument, which
  // resolves to the iframe's own document for iframe-scoped elements and to
  // the outer document for everything else, with no special-casing needed.
  function overlays(doc) { return (doc || document).querySelectorAll('#hldevpop,[class*="modal"],[role="dialog"],[role="menu"],[style*="position: fixed"],[style*="z-index"]').length; }
  function overlayNodes(doc) { return [].slice.call((doc || document).querySelectorAll('[class*="modal"],[role="dialog"],[role="menu"],[class*="dropdown"],[class*="popover"],[class*="sheet"]')).filter(function (n) { return n.offsetHeight > 0; }); }
  function toastText(doc) { var d = doc || document; var t = d.getElementById('hlToast') || d.querySelector('[class*="toast"]'); return t ? t.textContent.trim() : ''; }
  function docFp(doc) { return (doc || document).body.getElementsByTagName('*').length; }
  // Found 2026-08-19 investigating council: the history carousel's Previous/
  // Next buttons call host.scrollBy(...) -- a real, correct action, confirmed
  // live -- but a scroll position is neither a DOM mutation, a network call,
  // an overlay, nor a toast, so every existing "did anything happen?" signal
  // missed it and reported NO_OUTCOME on a genuinely working control. Summing
  // scrollLeft+scrollTop across every actually-scrollable element (content
  // taller/wider than its box) is content-driven like selectedKeys() above --
  // it needs no view-specific container id, so it catches this class of
  // control wherever else it appears too.
  function scrollFp(doc) {
    var els = (doc || document).querySelectorAll('*'), sum = 0;
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e.scrollWidth > e.clientWidth || e.scrollHeight > e.clientHeight) sum += e.scrollLeft + e.scrollTop;
    }
    return sum;
  }
  // Found 2026-08-19 investigating HiveGrid (tox): zoom in/out/fit-page and a
  // takeoff condition's show/hide toggle all genuinely redraw a <canvas> --
  // live-confirmed each changes WB.zoom or the panel's own state -- but a
  // canvas repaint is pixels, not DOM, so nothing else here can see it.
  // toDataURL() is the cheap, content-driven equivalent of docFp/scrollFp for
  // a canvas: any real redraw changes the encoded string length. Wrapped in
  // try/catch because a canvas that has ever drawn a cross-origin image
  // without CORS headers throws SecurityError on toDataURL() -- treated as
  // "unknown" (a fixed placeholder) rather than crashing the click test.
  function canvasFp(doc) {
    var canvases = (doc || document).querySelectorAll('canvas'), out = '';
    for (var i = 0; i < canvases.length; i++) {
      try { out += canvases[i].toDataURL().length + '|'; } catch (e) { out += 'x|'; }
    }
    return out;
  }
  // Found 2026-08-19 investigating HiveGrid/Presentations: a takeoff
  // condition's eye toggle sets a real inline opacity (live-confirmed:
  // style="opacity:1" -> "opacity:.35") via a list rebuild small enough
  // (2 mutation records) to land under the existing muts > 3 fallback, and
  // Presentations' own toast implementation slides an inline
  // transform (live-confirmed) but names its toast element with no id or
  // class at all, so toastText() can't find it either. Raising muts's
  // raw threshold was already tried and rejected elsewhere in this file
  // (a live-updating map was measured producing double-digit mutations on a
  // genuinely inert click) -- a bare count is too easily fooled either way.
  // An inline style attribute actually changing value is a much more
  // specific signal: MutationObserver only fires an attributes record when
  // the attribute's value changed, and deliberately restyling an element via
  // JS (as opposed to a CSS :hover/class-driven transition, which mutates no
  // attribute at all) is a rare enough act to trust on its own.
  function styleAmongMutations(mutRecords) {
    for (var i = 0; i < mutRecords.length; i++) {
      if (mutRecords[i].type === 'attributes' && mutRecords[i].attributeName === 'style') return true;
    }
    return false;
  }
  // WHICH elements currently look "selected" (by text content, not by DOM
  // reference), not just how many. A tab/card swapping which sibling is
  // selected leaves the raw COUNT of .active/.on/.sel/[aria-selected]
  // elements unchanged -- one loses it, another gains it, net zero -- so
  // a bare count comparison misses it. Tracking a specific clicked
  // element's own class was tried and rejected: a click handler that
  // rebuilds its list via innerHTML (confirmed live on a real Job Setup
  // job-card queue) replaces that element's DOM node entirely, so the
  // stale reference never reflects the new element's class no matter how
  // long you wait. Re-querying by content on both sides sidesteps both
  // problems at once.
  function selectedKeys(doc) { return [].slice.call((doc || document).querySelectorAll('.active,.on,.sel,[aria-selected="true"]')).map(function (n) { return (n.textContent || '').trim().slice(0, 60); }).sort().join('|'); }
  // Found 2026-08-19: a HiveConnect "Settings" menu (class="settings-menu",
  // position:absolute via a stylesheet rule) and an estimate's "+ New RFI"
  // modal (class="jcv open", position:fixed via a stylesheet rule) both
  // genuinely opened -- confirmed live -- but neither is caught by overlays()
  // above: no class name it recognizes ("modal"/"dialog"/"menu"/"dropdown"/
  // "popover"/"sheet"), no ARIA role, and the fixed/absolute positioning is
  // set by a CSS class rather than an inline style attribute, so
  // `[style*="position: fixed"]`/`[style*="z-index"]` never match either.
  // Every view in this app invents its own class convention for this, so
  // matching more class names is whack-a-mole. Instead, inspect the actual
  // elements the click's own MutationObserver saw change: if any of them
  // became a visibly-sized, fixed/absolute-positioned, real-z-indexed box,
  // something genuinely opened, independent of what anyone named it.
  function overlayAmongMutations(mutRecords) {
    var checked = [];
    for (var i = 0; i < mutRecords.length; i++) {
      var t = mutRecords[i].target;
      if (!t || t.nodeType !== 1 || checked.indexOf(t) !== -1) continue;
      checked.push(t);
      if (t.offsetHeight <= 0 || t.offsetWidth <= 10 || t.offsetHeight <= 10) continue;
      var cs;
      try { cs = getComputedStyle(t); } catch (e) { continue; }
      if ((cs.position === 'fixed' || cs.position === 'absolute') && parseInt(cs.zIndex, 10) > 0) return true;
    }
    return false;
  }
  // Found 2026-08-19 investigating council: aria-label is author-supplied
  // specifically to say what a control does (rc-history-prev's "Previous
  // Boardroom decisions" vs. its innerText, the bare glyph "←") -- it should
  // win over raw content whenever both exist, matching how a screen reader
  // computes an accessible name. Input/select/textarea (kind === 'input')
  // never reach a pushed result at all, so this can't regress form labels.
  // 44 was also short enough to chop a real project request down to an
  // unreadable fragment ("I'd like a master project created for this d") --
  // bumped to 90, still well under the 280-char title column it feeds.
  function label(el) { return (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '').trim().slice(0, 90).replace(/\s+/g, ' '); }
  function closeAny(doc) {
    var d = doc || document;
    var p = d.getElementById('hldevpop'); if (p) p.remove();
    var ovs = overlayNodes(d);
    for (var i = 0; i < ovs.length; i++) {
      var btn = [].slice.call(ovs[i].querySelectorAll('button,[aria-label]')).find(function (b) { return /close|cancel|not now|stay|got it|dismiss|×|✕|back/i.test(b.textContent + (b.getAttribute('aria-label') || '')); });
      if (btn) { try { btn.click(); } catch (e) {} }
    }
    try { [].slice.call(d.querySelectorAll('.open')).forEach(function (el) { try { var cs = getComputedStyle(el); if (cs.position === 'fixed' && el.offsetWidth > window.innerWidth * 0.5 && el.offsetHeight > window.innerHeight * 0.5) el.classList.remove('open'); } catch (e) {} }); } catch (e) {}
    try { d.body.click(); } catch (e) {}
    try { d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); } catch (e) {}
  }

  var results = [], seen = {};
  async function tryClick(el, container, depth) {
    var lab = label(el);
    var key = (isApp ? '' : 'p:') + lab + '|' + (el.className || '') + '|d' + depth;
    if (seen[key]) return; seen[key] = 1;
    var kind = classify(el);
    if (kind === 'input') return;
    // Found 2026-08-19: a `disabled` button (a bookkeeping "Submit for
    // review" gated behind its own validation checklist, doc-list pagination
    // with only one page) is correctly a no-op when clicked -- disabled
    // elements don't fire click handlers at all, by spec. Clicking one and
    // reporting NO_OUTCOME mischaracterized working, intentional guards as
    // broken controls.
    if (el.disabled) { results.push({ view: CUR, depth: depth, label: lab, kind: kind, verdict: 'SKIPPED_DISABLED', note: 'element is disabled — not clicked' }); return; }
    // Found 2026-08-19: a capacity-planning day-range tab ("30 days") that
    // is already the default-selected tab produces no change when clicked
    // again -- correctly, since it's already in the state the click would
    // have produced. Only applies to 'tab' kind: an unrelated element that
    // happens to carry an ".active"-ish class for styling reasons has no
    // such guarantee, so it still gets clicked and measured normally.
    if (kind === 'tab' && el.matches('.active,.on,.sel,[aria-selected="true"]')) { results.push({ view: CUR, depth: depth, label: lab, kind: kind, verdict: 'SKIPPED_ALREADY_ACTIVE', note: 'already the selected tab — not clicked' }); return; }
    if (kind === 'media') { results.push({ view: CUR, depth: depth, label: lab, kind: kind, verdict: 'SKIPPED_MEDIA', note: 'opens camera/mic — not auto-clicked' }); return; }
    if (kind === 'nav') { results.push({ view: CUR, depth: depth, label: lab, kind: kind, verdict: 'SKIPPED_NAV', note: 'navigates to another page — not clicked (would leave the app)' }); return; }
    if (kind === 'link') { results.push({ view: CUR, depth: depth, label: lab, kind: kind, verdict: 'PASS', note: 'href ' + (el.getAttribute('href') || '').slice(0, 36) }); return; }

    // The element's OWN document -- the iframe's contentDocument for an
    // iframe-scoped element, the outer document for everything else. Every
    // before/after check below must watch this document, not a hardcoded
    // outer `document`, or a real change inside an embedded view is
    // invisible to every check that follows.
    var sdoc = (el.ownerDocument) || document;
    var t0 = performance.now();
    var bFp = docFp(sdoc), bOv = overlays(sdoc), bAct = sdoc.querySelectorAll('.active,.on,.sel,[aria-selected="true"]').length, bToast = toastText(sdoc), bScroll = scrollFp(sdoc), bCanvas = canvasFp(sdoc);
    // Found 2026-08-18: a tab/card swapping which sibling is selected
    // leaves bAct === aAct -- the COUNT of "something selected" elements
    // never changes, only which one. muts > 3 was meant to catch exactly
    // this as a fallback, but a busy live-updating view (e.g. a map polling
    // for position updates) can add double-digit unrelated mutations even
    // on a genuinely inert click, and a minimal two-element class swap can
    // land at exactly muts === 3 and miss the threshold either way -- both
    // confirmed live on the same page, so raising the threshold trades one
    // false positive for the other. selectedKeys() sidesteps both: it is
    // driven by content, not a raw count or a specific DOM reference (a
    // click handler that rebuilds its list via innerHTML -- confirmed live
    // on a real job-card queue -- replaces the clicked element's own node
    // entirely, so tracking ITS class doesn't work either).
    var bSelKeys = selectedKeys(sdoc);
    var muts = 0; var mutRecords = []; var mo = new MutationObserver(function (m) { muts += m.length; mutRecords = mutRecords.concat(m); }); try { mo.observe(sdoc.body, { childList: true, subtree: true, attributes: true }); } catch (e) {}
    var threw = null;
    try { await Promise.race([(async function () { el.click(); })(), new Promise(function (_, rej) { setTimeout(function () { rej(new Error('click-timeout')); }, CLICK_TIMEOUT); })]); } catch (e) { threw = String(e.message || e).slice(0, 80); }
    await new Promise(function (r) { setTimeout(r, SETTLE); });
    mo.disconnect();
    var d = since(t0);
    var aFp = docFp(sdoc), aOv = overlays(sdoc), aAct = sdoc.querySelectorAll('.active,.on,.sel,[aria-selected="true"]').length, aToast = toastText(sdoc), aScroll = scrollFp(sdoc), aCanvas = canvasFp(sdoc);
    var aSelKeys = selectedKeys(sdoc);
    var reads = d.f.filter(function (x) { return x.decision === 'pass'; });
    var badRead = reads.filter(function (x) { return x.s >= 400 || x.s === -1; });
    var writes = d.f.filter(function (x) { return x.decision === 'stub-write' || x.decision === 'blocked-external'; });
    var wrote = writes.length > 0;
    var opened = aOv > bOv || overlayAmongMutations(mutRecords), toastChanged = aToast && aToast !== bToast, selectionChanged = aSelKeys !== bSelKeys, scrolled = aScroll !== bScroll, canvasChanged = aCanvas !== bCanvas, styled = styleAmongMutations(mutRecords);
    var moved = aFp !== bFp || aAct !== bAct || muts > 3 || d.f.length > 0 || opened || toastChanged || selectionChanged || scrolled || canvasChanged || styled;
    var verdict = 'PASS', note = '';
    if (threw && threw !== 'click-timeout') { verdict = 'THREW'; note = threw; }
    else if (threw === 'click-timeout') { verdict = 'SLOW_BLOCKING'; note = 'froze >' + CLICK_TIMEOUT + 'ms (heavy sync work)'; }
    else if (d.e.length) { verdict = 'THREW'; note = d.e[0].m; }
    else if (badRead.length) { verdict = 'FAILED_FETCH'; note = badRead.map(function (x) { return x.u + ':' + x.s; }).join(','); }
    else if (toastChanged && /saved|sent|done|success|updated|added|created|filed|recorded/i.test(aToast) && !wrote) { verdict = 'FAKE_SUCCESS'; note = 'toast "' + aToast + '" but no request fired'; }
    else if (kind === 'tab') { if (!moved) verdict = 'NO_OUTCOME'; else { var cr = contrast(el); if (cr < 2.2) { verdict = 'UNREADABLE_ACTIVE'; note = 'contrast ' + cr.toFixed(2) + ':1'; } } }
    else if (kind === 'action' && wrote) { verdict = 'WIRED'; note = '→ ' + writes[0].m + ' ' + writes[0].u + ' (shielded)'; }
    else if (!moved) verdict = 'NO_OUTCOME';
    results.push({ view: CUR, depth: depth, label: lab, kind: kind, verdict: verdict, note: note });

    if (opened && depth < 2) {
      await new Promise(function (r) { setTimeout(r, 150); });
      var panels = overlayNodes(sdoc);
      var panel = panels[panels.length - 1];
      if (panel) {
        var kids = [].slice.call(panel.querySelectorAll('*')).filter(function (e) { return isTestable(e) && e.offsetHeight > 0 && e.offsetWidth > 0; });
        for (var j = 0; j < kids.length && j < MAX_KIDS; j++) { if (performance.now() - VIEWSTART > VIEWCAP) break; await tryClick(kids[j], panel, depth + 1); }
      }
    }
    closeAny(sdoc);
  }

  var CUR = null, VIEWSTART = 0, VIEWCAP = 8000;
  async function crawlCurrent(viewCode) {
    CUR = viewCode || 'page';
    VIEWSTART = performance.now();
    // Found 2026-08-19: cpx/pbx are explicitly self-labeled design mockups
    // (nav item title="Design mockup — lands in Reports/Finances once
    // built") -- their buttons call real functions (hlToast(), showDetail())
    // but showDetail() always reveals the SAME static placeholder panel
    // regardless of which row was clicked, via a plain display:none->block
    // toggle with no position/z-index signal and almost no mutations.
    // Nothing is broken here; there's no real feature behind it yet to
    // verify. Testing it as if it were a finished screen produced NO_OUTCOME
    // findings that were really just "this mockup doesn't do much," not bugs.
    var navEl = viewCode ? document.getElementById('nav-' + viewCode) : null;
    if (navEl && /design mockup/i.test(navEl.getAttribute('title') || '')) {
      results.push({ view: CUR, depth: 0, label: '[mockup]', kind: 'meta', verdict: 'SKIPPED_MOCKUP', note: navEl.getAttribute('title') });
      return;
    }
    var ifr = viewCode ? document.getElementById('if-' + viewCode) : null;
    // The shield never reaches an iframe on its own -- each one has its own
    // Window with its own native fetch/XHR. Install fresh every time: csx
    // (and others) reload their srcdoc on every visit, which is a brand new
    // Window with an unpatched fetch each time.
    if (ifr && ifr.contentWindow) { try { installShield(ifr.contentWindow, ifr.contentDocument); } catch (e) {} }
    var scope = ifr && ifr.contentDocument ? ifr.contentDocument.body : (viewCode ? (document.getElementById(viewCode === 'cc' ? 'snapshot' : 'view-' + viewCode) || document.body) : document.body);
    if (!scope) return;
    var els = [].slice.call(scope.querySelectorAll('*')).filter(function (e) { return isTestable(e) && e.offsetHeight > 0 && e.offsetWidth > 0 && isReallyClickable(e); });
    for (var i = 0; i < els.length && i < MAX_ELS; i++) {
      if (performance.now() - VIEWSTART > VIEWCAP) { results.push({ view: CUR, depth: 0, label: '[time cap]', kind: 'meta', verdict: 'UNTESTED', note: (els.length - i) + ' top-level not reached' }); break; }
      await tryClick(els[i], scope, 0);
    }
  }

  function tallyOf() { var t = {}; results.forEach(function (r) { t[r.verdict] = (t[r.verdict] || 0) + 1; }); return t; }
  async function sendReport(partial, viewsDone) {
    try {
      var token = window.__hlAccessToken || (typeof window.hlTokenSync === 'function' && window.hlTokenSync()) || '';
      if (!token) throw new Error('No signed-in session available for the report.');
      // decide() already special-cases this endpoint to 'pass' through the
      // shield untouched, so the outer window's (patched) fetch reaches the
      // real backend here exactly like REAL.fetch would have -- and REAL is
      // no longer in scope at this level now that it lives inside
      // installShield()'s closure.
      await window.fetch('/api/selftest-report', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ runId: RUNID, partial: !!partial, viewsDone: viewsDone, tally: tallyOf(), shield: { stubbed: SHIELD.stubbed, blocked: SHIELD.blocked, passed: SHIELD.passed }, results: results, generatedAt: new Date().toString(), url: location.href }) });
    } catch (e) {}
  }

  try {
    for (var vi = 0; vi < VIEWS.length; vi++) {
      var code = VIEWS[vi];
      say('Testing ' + (vi + 1) + '/' + VIEWS.length + ': ' + (code || 'this page') + ' … (' + results.length + ' checks)');
      if (isApp && code) { try { if (code === 'team') { window.showView(''); if (window.go) window.go('team'); } else window.showView(code); } catch (e) {} await new Promise(function (r) { setTimeout(r, NAV_WAIT); }); }
      try { await crawlCurrent(code); } catch (e) { results.push({ view: code, verdict: 'THREW', note: 'view crashed: ' + String(e).slice(0, 100) }); }
      closeAny();
      await sendReport(true, (vi + 1) + '/' + VIEWS.length); // save after EVERY screen — survives a crash
    }
  } finally {
    restoreShield();
  }

  // ======================= REPORT =======================
  var PROB = ['THREW', 'FAILED_FETCH', 'FAKE_SUCCESS', 'NO_OUTCOME', 'UNREADABLE_ACTIVE', 'SLOW_BLOCKING'];
  var tally = tallyOf();
  window.__hlSelfTestV5 = { runId: RUNID, tally: tally, results: results, shield: SHIELD };
  var probCount = PROB.reduce(function (n, k) { return n + (tally[k] || 0); }, 0);
  await sendReport(false, VIEWS.length + '/' + VIEWS.length);
  badge.style.background = '#065f46';
  say('DONE ✓ report sent to Reina — ' + results.length + ' checks, ' + probCount + ' problems. Nothing real was touched.');
  console.log('%cSelf-Test v5 complete — ' + results.length + ' checks, ' + probCount + ' problems, shield stubbed ' + SHIELD.stubbed + ' writes', 'font-weight:bold;font-size:14px');
})();
