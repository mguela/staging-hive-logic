// HiveLogic Phone -- global popup softphone. Loaded on every page (not
// gated behind a nav view) so the top-bar phone icon (#hlphoneicon, next
// to Notifications and Settings -- see index.html) works everywhere.
// Strictly a telephone: no chat/messaging lives here, that's HiveConnect
// (which gets its own read-focused "VoIP" tab -- see
// public/hiveconnect/voip-panel.js -- for the bigger call-log view).
//
// Superseded the Phase-1 full-page "Phone" nav section per Chris's
// direction: "the whole system [should be] a popup primarily... a phone
// icon on the top bar next to settings, notifications". Talks to the
// same /api/voice backend as before -- this is a UI shell change, not a
// backend change.

(function () {
  // sdk.twilio.com stopped hosting the Voice SDK as of v2.0 -- Twilio's own
  // docs now only document npm/ESM install. This URL was 404ing/erroring in
  // every browser (reproduced even in Incognito, so not an ad-blocker), which
  // is why the softphone always said 'Setup failed' and Call always silently
  // did nothing (placeCall() bails out when state.device was never created).
  // Fix: jsdelivr auto-mirrors the same npm package's UMD build -- same
  // pattern already used for the Supabase/LiveKit script tags a few lines
  // below. Confirmed the bundle still exposes window.Twilio.Device, so no
  // other code here needs to change.
  const TWILIO_SDK_URL = 'https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2.18.3/dist/twilio.min.js';

  const state = {
    open: false,
    tab: 'dialer', // dialer | calls | voicemail
    configured: null,
    myExtension: null,
    device: null,
    activeCall: null,
    activeCallId: null,
    activeCallLabel: '',
    muted: false,
    held: false,
    showKeypad: false,
    keypadDigits: '',
    activeCallStartedAt: null,
    voicemails: [],
    calls: [],
    contacts: [],
    contactsExtensions: [],
    contactsQuery: '',
    contactPicker: null,
    waitingCall: null,
    waitingCallLabel: '',
    ringingCall: null,
    ringingCallLabel: '',
    // Who the number belongs to, resolved while it rings. See lookupCaller().
    caller: null,
    heldCall: null,
    heldCallId: null,
    heldCallLabel: '',
  };

  function escapeHtml(v) { return String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
  function fmtDuration(sec) { if (!sec && sec !== 0) return '—'; const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, '0')}`; }
  function fmtWhen(iso) { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function initials(name) { return String(name || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join(''); }

  if (!window.hlToast) window.hlToast = function (msg) { try { console.log('[toast]', msg); } catch (e) {} };

  async function api(path, method, body) {
    const headers = {};
    const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`/api/voice${path}`, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  function loadTwilioSdk() {
    if (window.Twilio && window.Twilio.Device) return Promise.resolve();
    if (window.__hlTwilioSdkPromise) return window.__hlTwilioSdkPromise;
    window.__hlTwilioSdkPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TWILIO_SDK_URL;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Could not load the Twilio Voice SDK'));
      document.head.appendChild(s);
    });
    return window.__hlTwilioSdkPromise;
  }

  // ---------------------------------------------------------------------
  // DOM scaffold -- injected once, anchored under the top-bar icon.
  // ---------------------------------------------------------------------
  function ensureDom() {
    if (document.getElementById('hlphonepopup')) return;
    const el = document.createElement('div');
    el.id = 'hlphonepopup';
    el.style.cssText = 'display:none;flex-direction:column;position:fixed;top:56px;right:170px;width:320px;min-width:280px;min-height:220px;background:#fff;border-radius:16px;box-shadow:0 16px 44px rgba(20,25,40,.28);border:1px solid var(--line,#dadde8);overflow:hidden;font-size:13px;z-index:9999;font-family:inherit';
    el.innerHTML = `
      <div id="hlphone-header" style="background:var(--rail,#161e2e);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px;cursor:move;user-select:none;flex:none">
        <div style="flex:1">
          <div style="font-weight:800;font-size:13px">&#128222; HiveLogic Phone</div>
          <div id="hlphone-idline" style="font-size:10px;color:#8fe0b8;font-weight:700">Connecting&hellip;</div>
        </div>
        <div id="hlphone-close" style="cursor:pointer;color:#8fa0bd;font-size:13px">&#10005;</div>
      </div>
      <div id="hlphone-tabs" style="display:flex;border-bottom:1px solid var(--line,#dadde8);flex:none">
        <button data-t="dialer" class="hlphone-tabbtn on" style="flex:1;background:none;border:none;font-family:inherit;font-weight:700;font-size:10.5px;padding:10px 0;color:#1B7A50;border-bottom:2px solid #1B7A50;cursor:pointer">Dialer</button>
        <button data-t="calls" class="hlphone-tabbtn" style="flex:1;background:none;border:none;font-family:inherit;font-weight:700;font-size:10.5px;padding:10px 0;color:#8892a6;border-bottom:2px solid transparent;cursor:pointer">Calls</button>
        <button data-t="contacts" class="hlphone-tabbtn" style="flex:1;background:none;border:none;font-family:inherit;font-weight:700;font-size:10.5px;padding:10px 0;color:#8892a6;border-bottom:2px solid transparent;cursor:pointer">Contacts</button>
        <button data-t="voicemail" class="hlphone-tabbtn" style="flex:1;background:none;border:none;font-family:inherit;font-weight:700;font-size:10.5px;padding:10px 0;color:#8892a6;border-bottom:2px solid transparent;cursor:pointer">Voicemail<span id="hlphone-vmdot" style="color:#c65b4e;display:none">&nbsp;&bull;</span></button>
      </div>
      <div id="hlphone-body" style="padding:14px 16px 18px;overflow:auto;flex:1 1 auto"></div>
      <div id="hlphone-resize" title="Drag to resize" style="position:absolute;right:3px;bottom:3px;width:14px;height:14px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 0%,transparent 40%,#c7cddb 40%,#c7cddb 52%,transparent 52%,transparent 66%,#c7cddb 66%,#c7cddb 78%,transparent 78%)"></div>`;
    document.body.appendChild(el);
    document.getElementById('hlphone-close').addEventListener('click', () => { if (state.activeCall) return hlToast('End the call first, or it keeps ringing in the background.'); setOpen(false); });
    el.querySelectorAll('.hlphone-tabbtn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.t)));
    document.addEventListener('click', (e) => {
      if (!state.open) return;
      if (state.activeCall) return; // never yank the call UI out from under an active call
      if (el.contains(e.target) || (e.target.closest && e.target.closest('#hlphoneicon'))) return;
      setOpen(false);
    });

    // -----------------------------------------------------------------
    // Drag (by the header) and resize (bottom-right handle). Plain
    // pointer events so mouse and touch both work. The popup starts
    // positioned via top/right; the first drag switches it to an
    // explicit left/top so it can be moved anywhere on screen.
    // -----------------------------------------------------------------
    const header = document.getElementById('hlphone-header');
    let dragState = null;
    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('#hlphone-close')) return;
      const rect = el.getBoundingClientRect();
      dragState = { startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top };
      el.style.left = rect.left + 'px';
      el.style.top = rect.top + 'px';
      el.style.right = 'auto';
      header.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    header.addEventListener('pointermove', (e) => {
      if (!dragState) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      const maxLeft = window.innerWidth - el.offsetWidth;
      const maxTop = window.innerHeight - 40;
      el.style.left = Math.max(0, Math.min(maxLeft, dragState.startLeft + dx)) + 'px';
      el.style.top = Math.max(0, Math.min(maxTop, dragState.startTop + dy)) + 'px';
    });
    const endDrag = (e) => { dragState = null; try { header.releasePointerCapture(e.pointerId); } catch (x) {} };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);

    const resizeHandle = document.getElementById('hlphone-resize');
    let resizeState = null;
    resizeHandle.addEventListener('pointerdown', (e) => {
      resizeState = { startX: e.clientX, startY: e.clientY, startW: el.offsetWidth, startH: el.offsetHeight };
      resizeHandle.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });
    resizeHandle.addEventListener('pointermove', (e) => {
      if (!resizeState) return;
      const dx = e.clientX - resizeState.startX;
      const dy = e.clientY - resizeState.startY;
      const newW = Math.max(280, Math.min(640, resizeState.startW + dx));
      const newH = Math.max(220, Math.min(window.innerHeight - 40, resizeState.startH + dy));
      el.style.width = newW + 'px';
      el.style.height = newH + 'px';
    });
    const endResize = (e) => { resizeState = null; try { resizeHandle.releasePointerCapture(e.pointerId); } catch (x) {} };
    resizeHandle.addEventListener('pointerup', endResize);
    resizeHandle.addEventListener('pointercancel', endResize);

    // Row-level "..." menu (Create Contact / Add to Existing Contact /
    // Block Number) for calls from numbers we don't recognize yet. A
    // single shared, page-level element -- opened and positioned next to
    // whichever kebab button was clicked, rather than one per row.
    const rowMenu = document.createElement('div');
    rowMenu.id = 'hlphone-rowmenu';
    rowMenu.style.cssText = 'display:none;position:fixed;background:#fff;border:1px solid var(--line,#dadde8);border-radius:10px;box-shadow:0 10px 28px rgba(20,25,40,.22);z-index:10000;overflow:hidden;min-width:190px;font-size:12px;font-family:inherit';
    document.body.appendChild(rowMenu);
    rowMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const number = btn.dataset.number;
      hideRowMenu();
      runRowMenuAction(action, number);
    });
    document.addEventListener('click', (e) => {
      if (rowMenu.style.display === 'none') return;
      if (rowMenu.contains(e.target) || (e.target.closest && e.target.closest('.hlphone-kebab'))) return;
      hideRowMenu();
    });
  }

  function setOpen(open) {
    hideRowMenu();
    state.open = open;
    const el = document.getElementById('hlphonepopup');
    if (el) el.style.display = open ? 'flex' : 'none';
    const icon = document.getElementById('hlphoneicon');
    if (icon) icon.style.background = open ? 'var(--gold-bg,#e9eff4)' : '';
    if (open) { refreshCalls(); refreshVoicemails(); refreshContacts(); }
  }

  window.hlPhonePopupToggle = function () { ensureDom(); setOpen(!state.open); };

  // Shared call-control surface for the rest of the app (namely HiveConnect's
  // "VoIP" tab -- see public/hiveconnect/voip-panel.js). The Twilio Voice SDK
  // only supports one healthy registration per identity per browser tab, so
  // a second, independent Device instance elsewhere would fight this one for
  // incoming calls. Everything that wants to place a call routes through
  // THIS Device via window.hlPhone instead of creating its own.
  window.hlPhone = {
    dial: function (to) { ensureDom(); setOpen(true); placeCall(to); },
    open: function () { ensureDom(); setOpen(true); },
    close: function () { setOpen(false); },
    hangup: function () { endCall(); },
    isOnCall: function () { return Boolean(state.activeCall); },
    getActiveCall: function () {
      if (!state.activeCall) return { onCall: false };
      return { onCall: true, label: state.activeCallLabel || '', callId: state.activeCallId || null, startedAt: state.activeCallStartedAt || null };
    },
  };

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.hlphone-tabbtn').forEach(b => {
      const on = b.dataset.t === tab;
      b.style.color = on ? '#1B7A50' : '#8892a6';
      b.style.borderBottomColor = on ? '#1B7A50' : 'transparent';
    });
    renderBody();
  }

  function renderBody() {
    hideRowMenu();
    // Mid-call, the popup always shows the active-call screen regardless
    // of which tab is selected -- matches the approved mockup.
    if (state.ringingCall) return renderRinging();
    if (state.activeCall) return renderActiveCall();
    const body = document.getElementById('hlphone-body');
    if (!body) return;
    if (state.contactPicker) {
      renderContactLinker(body, state.contactPicker);
      document.getElementById('hlphone-tabs').style.display = 'none';
      return;
    }
    if (state.tab === 'dialer') renderDialer(body);
    else if (state.tab === 'calls') renderCalls(body);
    else if (state.tab === 'contacts') renderContacts(body);
    else renderVoicemail(body);
    document.getElementById('hlphone-tabs').style.display = 'flex';
  }

  function renderNotConfigured(missing) {
    const body = document.getElementById('hlphone-body');
    document.getElementById('hlphone-tabs').style.display = 'none';
    body.innerHTML = `
      <div style="text-align:center;padding:12px 4px">
        <div style="font-size:26px;margin-bottom:6px">📞</div>
        <div style="font-weight:800;font-size:13px;margin-bottom:4px">Not connected yet</div>
        <div style="font-size:11.5px;color:#8892a6;line-height:1.5">Real, working code -- just needs a Twilio account connected first. No fake data.</div>
        <div style="text-align:left;background:#f0f1f6;border-radius:8px;padding:8px 10px;margin-top:10px;font-size:10.5px;font-family:var(--mono,monospace)">
          Missing: ${missing && missing.length ? missing.map(escapeHtml).join(', ') : 'TWILIO_* env vars'}
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // Dialer
  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // Row-level "..." menu (unknown numbers only) -- Create Contact, Add to
  // Existing Contact, Block Number -- plus the quick-SMS action available
  // on every call row regardless of whether the number is known.
  // ---------------------------------------------------------------------
  function hidePopupModal() {
    const m = document.getElementById('hlphone-modal');
    if (m) m.remove();
  }

  function showPopupModal(opts) {
    hidePopupModal();
    const popup = document.getElementById('hlphonepopup');
    if (!popup) return;
    const confirmColor = opts.danger ? '#c65b4e' : '#1B7A50';
    const wrap = document.createElement('div');
    wrap.id = 'hlphone-modal';
    wrap.style.cssText = 'position:absolute;inset:0;background:rgba(22,30,46,.55);display:flex;align-items:center;justify-content:center;z-index:50;padding:16px';
    wrap.innerHTML = '<div id="hlphone-modal-card" style="background:#fff;border-radius:14px;box-shadow:0 20px 44px rgba(20,25,40,.35);padding:18px;width:100%;max-width:260px">'
      + '<div style="font-size:13px;font-weight:800;color:#161e2e;margin-bottom:4px">' + escapeHtml(opts.title || '') + '</div>'
      + (opts.subtitle ? '<div style="font-size:11.5px;color:#748a9e;margin-bottom:10px;line-height:1.4">' + escapeHtml(opts.subtitle) + '</div>' : '')
      + (opts.input ? '<input id="hlphone-modal-input" type="text" placeholder="' + escapeHtml(opts.input.placeholder || '') + '" style="width:100%;padding:9px 10px;border-radius:8px;border:1px solid #dadde8;font-family:inherit;font-size:12.5px;margin-top:2px;box-sizing:border-box" />' : '')
      + '<div style="display:flex;gap:8px;margin-top:14px">'
      + '<button id="hlphone-modal-cancel" style="flex:1;padding:9px 0;border-radius:8px;border:1px solid #dadde8;background:#fff;color:#5d657b;font-weight:700;font-size:12px;cursor:pointer;font-family:inherit">Cancel</button>'
      + '<button id="hlphone-modal-confirm" style="flex:1;padding:9px 0;border-radius:8px;border:none;background:' + confirmColor + ';color:#fff;font-weight:700;font-size:12px;cursor:pointer;font-family:inherit">' + escapeHtml(opts.confirmLabel || 'OK') + '</button>'
      + '</div>'
      + '</div>';
    popup.appendChild(wrap);
    document.getElementById('hlphone-modal-card').addEventListener('click', function (e) { e.stopPropagation(); });
    wrap.addEventListener('click', function () { hidePopupModal(); if (opts.onCancel) opts.onCancel(); });
    const input = document.getElementById('hlphone-modal-input');
    function doConfirm() {
      const val = input ? input.value.trim() : true;
      if (input && !val) { input.focus(); return; }
      hidePopupModal();
      if (opts.onConfirm) opts.onConfirm(val);
    }
    document.getElementById('hlphone-modal-confirm').addEventListener('click', doConfirm);
    document.getElementById('hlphone-modal-cancel').addEventListener('click', function () { hidePopupModal(); if (opts.onCancel) opts.onCancel(); });
    if (input) {
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') doConfirm(); if (e.key === 'Escape') { hidePopupModal(); if (opts.onCancel) opts.onCancel(); } });
      setTimeout(function () { input.focus(); }, 10);
    }
  }

function hideRowMenu() {
    const m = document.getElementById('hlphone-rowmenu');
    if (m) m.style.display = 'none';
  }

  function showRowMenu(anchorBtn, number) {
    const m = document.getElementById('hlphone-rowmenu');
    if (!m || !number) return;
    m.innerHTML = [
      ['create_contact', 'Create Contact'],
      ['add_to_contact', 'Add to Existing Contact'],
      ['block_number', 'Block Number'],
    ].map(function (pair) {
      return '<button data-action="' + pair[0] + '" data-number="' + escapeHtml(number) + '" style="display:block;width:100%;text-align:left;padding:9px 12px;border:none;background:none;font-family:inherit;font-size:12px;font-weight:600;color:#1c2433;cursor:pointer">' + pair[1] + '</button>';
    }).join('<div style="height:1px;background:#f0f1f5"></div>');
    const rect = anchorBtn.getBoundingClientRect();
    m.style.display = 'block';
    m.style.top = Math.min(window.innerHeight - 140, rect.bottom + 4) + 'px';
    m.style.left = Math.max(4, Math.min(window.innerWidth - 194, rect.right - 180)) + 'px';
  }

  async function runRowMenuAction(action, number) {
    if (!number) return;
    if (action === 'create_contact') {
      showPopupModal({
        title: 'Save Contact',
        subtitle: 'Contact name for ' + number,
        input: { placeholder: 'e.g. Chris Kendall' },
        confirmLabel: 'Save',
        onConfirm: async function (name) {
          const r = await api('?resource=contact_create', 'POST', { e164: number, name: name });
          if (!r.ok) return hlToast((r.data && r.data.error) || 'Could not save contact.');
          hlToast('Contact saved.');
          refreshCalls();
          refreshContacts();
        },
      });
    } else if (action === 'block_number') {
      showPopupModal({
        title: 'Block this number?',
        subtitle: number + ' will no longer be able to reach you.',
        confirmLabel: 'Block',
        danger: true,
        onConfirm: async function () {
          const r = await api('?resource=blocklist', 'POST', { e164: number, reason: 'Blocked from call log' });
          if (!r.ok) return hlToast((r.data && r.data.error) || 'Could not block number.');
          hlToast('Number blocked.');
        },
      });
    } else if (action === 'add_to_contact') {
      openContactLinker(number);
    }
  }

  function sendQuickSms(number) {
    showPopupModal({
      title: 'Send Text Message',
      subtitle: 'To ' + number,
      input: { placeholder: 'Type your message...' },
      confirmLabel: 'Send',
      onConfirm: function (text) {
        api('?resource=sms', 'POST', { to: number, body: text }).then(function (r) {
          if (!r.ok) return hlToast((r.data && r.data.error) || 'Could not send message.');
          hlToast('Message sent.');
        });
      },
    });
  }

  function openContactLinker(number) {
    state.contactPicker = number;
    renderBody();
  }

  let linkerSearchTimer = null;
  function renderContactLinker(body, e164) {
    body.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">'
      + '<button id="hlphone-linker-back" style="border:none;background:none;color:#748a9e;font-weight:800;font-size:16px;cursor:pointer;padding:0">&#8592;</button>'
      + '<div style="font-size:12px;font-weight:700">Link ' + escapeHtml(e164) + ' to a contact</div>'
      + '</div>'
      + '<input id="hlphone-linker-search" type="text" placeholder="Search contacts by name..." style="width:100%;box-sizing:border-box;font-size:12.5px;padding:8px;border:1px solid var(--line,#dadde8);border-radius:8px;margin-bottom:10px;font-family:inherit" />'
      + '<div id="hlphone-linker-results" style="font-size:12px;color:#8892a6;padding:6px 0">Type at least 2 characters to search.</div>';
    document.getElementById('hlphone-linker-back').addEventListener('click', () => { state.contactPicker = null; renderBody(); });
    const input = document.getElementById('hlphone-linker-search');
    input.focus();
    input.addEventListener('input', () => {
      clearTimeout(linkerSearchTimer);
      const q = input.value.trim();
      linkerSearchTimer = setTimeout(() => runLinkerSearch(e164, q), 300);
    });
  }

  async function runLinkerSearch(e164, q) {
    const results = document.getElementById('hlphone-linker-results');
    if (!results) return;
    if (q.length < 2) { results.innerHTML = 'Type at least 2 characters to search.'; return; }
    results.innerHTML = 'Searching&hellip;';
    const r = await api('?resource=directory&q=' + encodeURIComponent(q));
    if (!r.ok) { results.innerHTML = 'Search failed.'; return; }
    const matches = (r.data && r.data.clients) || [];
    if (!matches.length) { results.innerHTML = 'No matching contacts.'; return; }
    results.innerHTML = matches.slice(0, 8).map(function (c) {
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #f0f1f5">'
        + '<div><div style="font-weight:700;font-size:12px">' + escapeHtml(c.name || 'Unnamed') + '</div><div style="font-size:10.5px;color:#8892a6">' + escapeHtml(c.phone || '') + '</div></div>'
        + '<button class="hlphone-linker-pick" data-id="' + escapeHtml(c.id || '') + '" data-name="' + escapeHtml(c.name || '') + '" style="border:none;background:#e6f2ec;color:#1B7A50;font-weight:800;font-size:10px;padding:4px 9px;border-radius:99px;cursor:pointer">Link</button>'
        + '</div>';
    }).join('');
    results.querySelectorAll('.hlphone-linker-pick').forEach(function (b) {
      b.addEventListener('click', () => confirmLink(e164, b.dataset.id, b.dataset.name));
    });
  }

  function confirmLink(e164, jobberClientId, name) {
    if (!jobberClientId) return;
    showPopupModal({
      title: 'Link Contact',
      subtitle: 'Link ' + e164 + ' to ' + name + '?',
      confirmLabel: 'Link',
      onConfirm: async function () {
        const r = await api('?resource=contact_link', 'POST', { e164, jobberClientId });
        if (!r.ok) return hlToast((r.data && r.data.error) || 'Could not link contact.');
        hlToast('Linked to ' + name + '.');
        state.contactPicker = null;
        refreshCalls();
        renderBody();
      },
    });
  }

  function recentCallsBlock() {
    if (!state.calls.length) return '';
    const rows = state.calls.slice(0, 5).map(function (c) {
      const number = c.direction === 'inbound' ? c.from_number : c.to_number;
      const name = c.clientName || number || '--';
      const dirLabel = c.direction === 'inbound' ? 'In' : 'Out';
      const actions = '<button class="hlphone-callback" data-number="' + escapeHtml(number || '') + '" style="border:none;background:#e6f2ec;color:#1B7A50;font-weight:800;font-size:9.5px;padding:3px 7px;border-radius:99px;cursor:pointer">Call</button>'
        + '<button class="hlphone-sms" data-number="' + escapeHtml(number || '') + '" style="border:none;background:#eef1fb;color:#3a4fb0;font-weight:800;font-size:9.5px;padding:3px 7px;border-radius:99px;cursor:pointer;margin-left:4px">Msg</button>'
        + (c.clientName ? '' : '<button class="hlphone-kebab" data-number="' + escapeHtml(number || '') + '" title="More options" style="border:none;background:#f3f4f8;color:#5b6579;font-weight:900;font-size:11px;padding:3px 6px;border-radius:99px;cursor:pointer;margin-left:4px;line-height:1">&#8942;</button>');
      return '<tr>'
        + '<td style="padding:6px 4px;font-size:10.5px;color:#8892a6;white-space:nowrap">' + dirLabel + '</td>'
        + '<td style="padding:6px 4px;font-size:11.5px;font-weight:700">' + escapeHtml(name) + '</td>'
        + '<td style="padding:6px 4px;font-size:10px;color:#8892a6;white-space:nowrap;text-align:right">' + fmtWhen(c.started_at) + '</td>'
        + '<td style="padding:6px 0 6px 6px;text-align:right;white-space:nowrap">' + actions + '</td>'
        + '</tr>';
    }).join('');
    return '<div style="margin-top:14px;padding-top:12px;border-top:1px solid #f0f1f5">'
      + '<div style="font-size:9.5px;color:#8892a6;text-transform:uppercase;font-weight:700;margin-bottom:6px">Recent calls</div>'
      + '<table style="width:100%;border-collapse:collapse">' + rows + '</table>'
      + '</div>';
  }

  function renderDialer(body) {
    body.innerHTML = `
      <input id="hlphone-dialinput" type="text" placeholder="Extension or phone number" style="width:100%;box-sizing:border-box;font-size:15px;text-align:center;padding:9px;border:1px solid var(--line,#dadde8);border-radius:9px;margin-bottom:10px;font-family:var(--mono,monospace)" />
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
        ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(k => `<button class="hlphone-key" data-key="${k}" style="padding:11px 0;font-size:14px;font-weight:700;border:1px solid var(--line,#dadde8);border-radius:9px;background:#fbfbfd;cursor:pointer">${k}</button>`).join('')}
      </div>
      <button id="hlphone-callbtn" style="width:100%;padding:11px 0;border-radius:10px;border:none;background:#1B7A50;color:#fff;font-weight:800;font-size:13px;cursor:pointer">📞 Call</button>
      <div style="font-size:10.5px;color:#8892a6;text-align:center;margin-top:8px">${state.myExtension ? `Your extension: ${escapeHtml(state.myExtension.extension_number)} (${escapeHtml(state.myExtension.display_name)})` : 'No extension assigned yet — ask an admin.'}</div>
      ${recentCallsBlock()}`;
    const input = document.getElementById('hlphone-dialinput');
    body.querySelectorAll('.hlphone-key').forEach(b => b.addEventListener('click', () => { input.value += b.dataset.key; }));
    document.getElementById('hlphone-callbtn').addEventListener('click', () => placeCall(input.value.trim()));
    body.querySelectorAll('.hlphone-callback').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = b.dataset.number;
      if (n) placeCall(n);
    }));
    body.querySelectorAll('.hlphone-sms').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = b.dataset.number;
      if (n) sendQuickSms(n);
    }));
    body.querySelectorAll('.hlphone-kebab').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      showRowMenu(b, b.dataset.number);
    }));
  }

  function renderActiveCall() {
    document.getElementById('hlphone-tabs').style.display = 'none';
    const body = document.getElementById('hlphone-body');
    body.innerHTML = `
      <div style="text-align:center;padding:4px 0">
        <div style="width:52px;height:52px;border-radius:50%;background:var(--green-bg,#e6f2ec);color:#1B7A50;font-weight:800;font-size:18px;display:flex;align-items:center;justify-content:center;margin:0 auto 8px">${escapeHtml(initials(callerLabel(state.activeCallLabel)))}</div>
        <div style="font-weight:800;font-size:13px">${escapeHtml(callerLabel(state.activeCallLabel || 'On call'))}</div>
        <div id="hlphone-timer" style="font-family:var(--mono,monospace);font-size:11px;color:#1B7A50;font-weight:700;margin-top:4px">00:00</div>
        ${callerStripHtml()}
      </div>
      ${state.waitingCall ? `
      <div style="margin-top:10px;padding:8px 10px;border-radius:9px;background:var(--gold-bg,#e9eff4);border:1px solid #f2ddac;font-size:11px;display:flex;align-items:center;gap:8px">
        <div style="flex:1"><b>Call waiting:</b> ${escapeHtml(state.waitingCallLabel || 'Unknown')}</div>
        <button id="hlphone-waiting-answer" style="padding:6px 10px;border-radius:7px;border:none;background:#1B7A50;color:#fff;font-weight:700;font-size:10.5px;cursor:pointer">Answer</button>
        <button id="hlphone-waiting-decline" style="padding:6px 10px;border-radius:7px;border:none;background:#c65b4e;color:#fff;font-weight:700;font-size:10.5px;cursor:pointer">Decline</button>
      </div>
      ` : ''}
      ${state.heldCall ? `
      <div style="margin-top:10px;padding:8px 10px;border-radius:9px;background:#f0f1f6;border:1px solid #dadde8;font-size:11px;display:flex;align-items:center;gap:8px">
        <div style="flex:1">On hold: ${escapeHtml(state.heldCallLabel || 'Call')}</div>
        <button id="hlphone-swap" style="padding:6px 10px;border-radius:7px;border:1px solid #dadde8;background:#fff;font-weight:700;font-size:10.5px;cursor:pointer">Swap</button>
      </div>
      ` : ''}
      ${state.showKeypad ? `
      <div style="margin-top:12px;padding:10px;border:1px solid var(--line,#dadde8);border-radius:10px;background:#fbfbfd">
        <div style="text-align:center;font-family:var(--mono,monospace);font-size:15px;font-weight:700;min-height:18px;margin-bottom:8px;letter-spacing:1px;color:#1c2433">${escapeHtml(state.keypadDigits || '\u00A0')}</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">
          ${['1','2','3','4','5','6','7','8','9','*','0','#'].map(d => `<button class="hlphone-kp" data-d="${d}" style="padding:9px 0;border-radius:8px;border:1px solid var(--line,#dadde8);background:#fff;font-size:13px;font-weight:700;cursor:pointer">${d}</button>`).join('')}
        </div>
        <button id="hlphone-kp-close" style="width:100%;margin-top:8px;padding:7px 0;border-radius:8px;border:1px solid var(--line,#dadde8);background:#fff;font-size:11px;font-weight:700;color:#748a9e;cursor:pointer">Close keypad</button>
      </div>` : ''}
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:14px">
        <button id="hlphone-hold" style="padding:10px 4px;border-radius:9px;border:1px solid var(--line,#dadde8);background:${state.held ? 'var(--gold-bg,#e9eff4)' : '#fbfbfd'};font-size:10px;font-weight:700;cursor:pointer">⏸ Hold</button>
        <button id="hlphone-transfer" style="padding:10px 4px;border-radius:9px;border:1px solid var(--line,#dadde8);background:#fbfbfd;font-size:10px;font-weight:700;cursor:pointer">↪ Transfer</button>
        <button id="hlphone-keypad" style="padding:10px 4px;border-radius:9px;border:1px solid var(--line,#dadde8);background:${state.showKeypad ? 'var(--gold-bg,#e9eff4)' : '#fbfbfd'};font-size:10px;font-weight:700;cursor:pointer">#⃣ Keypad</button>
        <button id="hlphone-mute" style="padding:10px 4px;border-radius:9px;border:1px solid var(--line,#dadde8);background:${state.muted ? 'var(--gold-bg,#e9eff4)' : '#fbfbfd'};font-size:10px;font-weight:700;cursor:pointer">🎙 Mute</button>
      </div>
      <button id="hlphone-end" style="width:100%;margin-top:10px;padding:11px 0;border-radius:10px;border:none;background:#c65b4e;color:#fff;font-weight:800;font-size:13px;cursor:pointer">☎ End call</button>`;
    wireCallerStrip();
    document.getElementById('hlphone-hold').addEventListener('click', toggleHold);
    document.getElementById('hlphone-transfer').addEventListener('click', promptTransfer);
    document.getElementById('hlphone-mute').addEventListener('click', toggleMute);
    document.getElementById('hlphone-end').addEventListener('click', endCall);
    const waitAnswerBtn = document.getElementById('hlphone-waiting-answer');
    if (waitAnswerBtn) waitAnswerBtn.addEventListener('click', answerWaitingCall);
    const waitDeclineBtn = document.getElementById('hlphone-waiting-decline');
    if (waitDeclineBtn) waitDeclineBtn.addEventListener('click', declineWaitingCall);
    const swapBtn = document.getElementById('hlphone-swap');
    if (swapBtn) swapBtn.addEventListener('click', swapCalls);
    document.getElementById('hlphone-keypad').addEventListener('click', () => {
      state.showKeypad = !state.showKeypad;
      state.keypadDigits = '';
      renderActiveCall();
    });
    document.querySelectorAll('.hlphone-kp').forEach((btn) => btn.addEventListener('click', () => {
      const d = btn.dataset.d;
      if (state.activeCall) state.activeCall.sendDigits(d);
      state.keypadDigits = (state.keypadDigits || '') + d;
      renderActiveCall();
    }));
    const kpClose = document.getElementById('hlphone-kp-close');
    if (kpClose) kpClose.addEventListener('click', () => { state.showKeypad = false; renderActiveCall(); });
    startTimer();
  }

  let timerInterval = null;
  function startTimer() {
    clearInterval(timerInterval);
    const startedAt = Date.now();
    state.activeCallStartedAt = startedAt;
    timerInterval = setInterval(() => {
      const el = document.getElementById('hlphone-timer');
      if (!el) { clearInterval(timerInterval); return; }
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      el.textContent = fmtDuration(secs);
    }, 1000);
  }

  async function placeCall(to) {
    if (!to) return hlToast('Enter an extension or phone number first.');
    if (!state.device) return hlToast('Phone is still connecting — try again in a moment.');
    if (state.activeCall) return hlToast('Already on a call.');
    try {
      const clientCallId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : null;
      const params = clientCallId ? { To: to, ClientCallId: clientCallId } : { To: to };
      state.activeCall = await state.device.connect({ params });
      if (window.hlSfx) hlSfx.startLoop('ringback', 3000);
      state.activeCallId = clientCallId;
      state.activeCallLabel = to;
      wireCallEvents(state.activeCall);
      renderBody();
    } catch (e) {
      hlToast('Could not place call: ' + (e && e.message || e));
    }
  }

  // ---- who is calling (2026-08-23) ----------------------------------------
  //
  // Chris: "Call > existing client phone # > question should be at the
  // inception of the call > 'New Lead?' > clicking yes should open a prefilled
  // New Lead Form by the recognized phone number and pulled existing client's
  // info."
  //
  // The lookup fires the moment the call starts RINGING, not when it is
  // answered, so the name is on screen while deciding whether to pick up --
  // "inception of the call" is the whole point. Everything here degrades to
  // the raw number: a caller lookup that fails must never delay or block
  // answering a phone call.
  //
  // state.caller: null while unknown, then
  //   { e164, matches: [...], knownName, status: 'looking'|'done'|'failed' }
  function resetCaller() { state.caller = null; }

  function lookupCaller(rawFrom) {
    const from = String(rawFrom || '');
    // Extension-to-extension calls arrive as `client:ext-4` and have no
    // customer behind them. Asking about a lead there is noise.
    if (!from || !/^\+?\d[\d\s().-]{6,}$/.test(from)) { resetCaller(); return; }
    state.caller = { e164: from, matches: [], knownName: null, status: 'looking' };
    renderBody();
    api('?resource=caller&e164=' + encodeURIComponent(from)).then((r) => {
      // A newer call may have started ringing while this was in flight.
      if (!state.caller || state.caller.e164 !== from) return;
      if (r.ok && r.data && r.data.ok) {
        state.caller = { e164: from, matches: r.data.matches || [], knownName: r.data.knownName || null, status: 'done' };
      } else {
        state.caller = { e164: from, matches: [], knownName: null, status: 'failed' };
      }
      renderBody();
    }).catch(() => {
      if (!state.caller || state.caller.e164 !== from) return;
      // Never silently show "no match" when the lookup never happened -- that
      // reads as "we don't know them" and sends the office off to make a
      // duplicate client.
      state.caller = { e164: from, matches: [], knownName: null, status: 'failed' };
      renderBody();
    });
  }

  // The name to put on the ringing card, in place of the raw number.
  function callerLabel(fallback) {
    const c = state.caller;
    if (!c || c.status !== 'done') return fallback;
    if (c.matches.length === 1) return c.matches[0].name;
    if (c.matches.length > 1) return c.matches.length + ' clients share this number';
    if (c.knownName) return c.knownName;
    return fallback;
  }

  // The strip under the caller's name: who we think it is, and the button
  // that starts a lead from the call.
  function callerStripHtml() {
    const c = state.caller;
    if (!c) return '';
    if (c.status === 'looking') {
      return '<div style="margin-top:8px;font-size:10.5px;color:var(--mut,#69748a);font-weight:700">Checking who this is…</div>';
    }
    if (c.status === 'failed') {
      // Honest about not knowing, rather than showing "new caller" -- those
      // are different facts and only one of them is true here.
      return '<div style="margin-top:8px;font-size:10.5px;color:#a9772e;font-weight:700">Could not check who this is</div>' +
        newLeadButtonHtml('New lead?');
    }
    let line;
    if (c.matches.length === 1) {
      const m = c.matches[0];
      const bits = [];
      if (m.isArchived) bits.push('archived');
      if (m.isLead) bits.push('still a lead');
      if (m.balance > 0) bits.push('$' + Math.round(m.balance).toLocaleString() + ' owed');
      line = '<div style="margin-top:8px;font-size:10.5px;color:#1B7A50;font-weight:700">✓ Existing client' +
        (bits.length ? ' · ' + escapeHtml(bits.join(' · ')) : '') + '</div>';
    } else if (c.matches.length > 1) {
      line = '<div style="margin-top:8px;font-size:10.5px;color:#a9772e;font-weight:700">' +
        c.matches.length + ' clients share this number — you pick which</div>';
    } else if (c.knownName) {
      line = '<div style="margin-top:8px;font-size:10.5px;color:var(--mut,#69748a);font-weight:700">Known number, not linked to a client</div>';
    } else {
      line = '<div style="margin-top:8px;font-size:10.5px;color:var(--mut,#69748a);font-weight:700">Not a client we have on file</div>';
    }
    return line + newLeadButtonHtml(c.matches.length ? 'New lead for them?' : 'New lead?');
  }

  function newLeadButtonHtml(label) {
    // Only offered where it can actually do something. The New Lead form lives
    // in index.html, and the popup is loaded on pages that do not have it.
    if (typeof window.hlNewLeadFromCall !== 'function') return '';
    return '<button id="hlphone-newlead" style="margin-top:10px;padding:8px 14px;border-radius:9px;border:1px solid #6444B8;background:#6444B8;color:#fff;font-weight:800;font-size:11px;cursor:pointer">✚ ' + escapeHtml(label) + '</button>';
  }

  // Called after any render that may have drawn the strip.
  function wireCallerStrip() {
    const btn = document.getElementById('hlphone-newlead');
    if (btn) btn.onclick = startLeadFromCall;
  }

  function startLeadFromCall() {
    const c = state.caller;
    if (!c || typeof window.hlNewLeadFromCall !== 'function') return;
    // Get out of the way -- the form is the thing to look at now, and the
    // popup floats over it.
    setOpen(false);
    window.hlNewLeadFromCall({ phone: c.e164, matches: c.matches || [], knownName: c.knownName || null });
  }

  // ---- incoming-call ringing (2026-07-26): ring, never auto-answer ----
  let ringCtx = null, ringTimer = null;
  function startRingtone() {
    try {
      stopRingtone();
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ringCtx = new AC();
      const burst = () => {
        if (!ringCtx) return;
        const t = ringCtx.currentTime;
        [0, 0.6].forEach((off) => {
          const o = ringCtx.createOscillator(), g = ringCtx.createGain();
          o.frequency.value = 440; o.type = 'sine';
          g.gain.setValueAtTime(0.0001, t + off);
          g.gain.exponentialRampToValueAtTime(0.18, t + off + 0.03);
          g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.45);
          o.connect(g); g.connect(ringCtx.destination);
          o.start(t + off); o.stop(t + off + 0.5);
        });
      };
      burst();
      ringTimer = setInterval(burst, 2400);
    } catch (e) {}
  }
  function stopRingtone() {
    try { if (ringTimer) clearInterval(ringTimer); ringTimer = null; if (ringCtx) { ringCtx.close(); ringCtx = null; } } catch (e) {}
  }
  function renderRinging() {
    const body = document.getElementById('hlphone-body');
    if (!body) return;
    const tabs = document.getElementById('hlphone-tabs'); if (tabs) tabs.style.display = 'none';
    body.innerHTML = '<div style="text-align:center;padding:14px 0 6px">' +
      '<div style="width:58px;height:58px;border-radius:50%;background:var(--green-bg,#e6f2ec);color:#1B7A50;font-weight:800;font-size:19px;display:flex;align-items:center;justify-content:center;margin:0 auto 10px">' + escapeHtml(initials(callerLabel(state.ringingCallLabel))) + '</div>' +
      '<div style="font-weight:800;font-size:14px">' + escapeHtml(callerLabel(state.ringingCallLabel || 'Incoming call')) + '</div>' +
      '<div style="font-size:11px;color:#1B7A50;font-weight:700;margin-top:4px">\uD83D\uDCDE Incoming call\u2026</div>' +
      // The raw number stays on screen even once a name is over it. The name
      // is a lookup, and a lookup can be wrong about who is holding the phone.
      (state.caller ? '<div style="font-size:10.5px;color:var(--mut,#69748a);font-weight:700;margin-top:2px">' + escapeHtml(state.caller.e164) + '</div>' : '') +
      callerStripHtml() +
      '<div style="display:flex;gap:10px;justify-content:center;margin-top:16px">' +
      '<button id="hlphone-ring-answer" style="flex:1;max-width:130px;padding:12px 0;border-radius:10px;border:none;background:#1B7A50;color:#fff;font-weight:800;font-size:12.5px;cursor:pointer">\u2713 Answer</button>' +
      '<button id="hlphone-ring-decline" style="flex:1;max-width:130px;padding:12px 0;border-radius:10px;border:none;background:#c65b4e;color:#fff;font-weight:800;font-size:12.5px;cursor:pointer">\u2715 Decline</button>' +
      '</div></div>';
    document.getElementById('hlphone-ring-answer').onclick = answerRinging;
    document.getElementById('hlphone-ring-decline').onclick = declineRinging;
    wireCallerStrip();
  }
  function answerRinging() {
    const call = state.ringingCall;
    if (!call) return;
    stopRingtone();
    state.ringingCall = null;
    state.activeCall = call;
    state.activeCallId = (call.customParameters && call.customParameters.get('CallId')) || null;
    state.activeCallLabel = state.ringingCallLabel || 'Incoming call';
    wireCallEvents(call);
    call.accept();
    renderBody();
  }
  function declineRinging() {
    const call = state.ringingCall;
    if (!call) return;
    stopRingtone();
    state.ringingCall = null; state.ringingCallLabel = '';
    resetCaller();
    try { call.reject(); } catch (e) {}
    renderBody();
  }
  function wireCallEvents(call) {
    call.on('accept', () => { if (window.hlSfx) { hlSfx.stopLoop(); hlSfx.play('connect'); } renderBody(); });
    call.on('disconnect', () => {
      if (state.heldCall === call) { state.heldCall = null; state.heldCallId = null; state.heldCallLabel = ''; renderBody(); return; }
      if (window.hlSfx) { hlSfx.stopLoop(); hlSfx.play('hangup'); } clearInterval(timerInterval); state.activeCall = null; state.activeCallId = null; state.held = false; state.muted = false; state.showKeypad = false; state.keypadDigits = ''; state.activeCallStartedAt = null; resetCaller(); renderBody(); refreshCalls(); refreshVoicemails();
    });
    call.on('cancel', () => {
      if (state.waitingCall === call) { state.waitingCall = null; renderBody(); return; }
      if (state.heldCall === call) { state.heldCall = null; state.heldCallId = null; state.heldCallLabel = ''; renderBody(); return; }
      if (window.hlSfx) { hlSfx.stopLoop(); hlSfx.play('hangup'); } clearInterval(timerInterval); state.activeCall = null; state.activeCallId = null; state.showKeypad = false; state.keypadDigits = ''; state.activeCallStartedAt = null; renderBody();
    });
    call.on('error', (e) => hlToast('Call error: ' + (e && e.message || e)));
  }

  function toggleMute() {
    if (!state.activeCall) return;
    state.muted = !state.muted;
    state.activeCall.mute(state.muted);
    renderActiveCall();
  }

  async function toggleHold() {
    if (!state.activeCallId) return hlToast('Still connecting — try again in a moment.');
    const r = await api('?resource=hold', 'POST', { callId: state.activeCallId, hold: !state.held });
    if (!r.ok) return hlToast(r.data.error || 'Could not update hold.');
    state.held = !state.held;
    renderActiveCall();
  }

  async function answerWaitingCall() {
    if (!state.waitingCall) return;
    const incoming = state.waitingCall;
    state.waitingCall = null;
    if (state.activeCall) {
      if (state.activeCallId) await api('?resource=hold', 'POST', { callId: state.activeCallId, hold: true });
      state.heldCall = state.activeCall;
      state.heldCallId = state.activeCallId;
      state.heldCallLabel = state.activeCallLabel;
    }
    state.activeCall = incoming;
    state.activeCallId = (incoming.customParameters && incoming.customParameters.get('CallId')) || null;
    state.activeCallLabel = state.waitingCallLabel || 'Incoming call';
    wireCallEvents(incoming);
    incoming.accept();
    renderBody();
  }

  function declineWaitingCall() {
    if (!state.waitingCall) return;
    state.waitingCall.reject();
    state.waitingCall = null;
    renderBody();
  }

  async function swapCalls() {
    if (!state.heldCall) return;
    if (state.activeCallId) await api('?resource=hold', 'POST', { callId: state.activeCallId, hold: true });
    if (state.heldCallId) await api('?resource=hold', 'POST', { callId: state.heldCallId, hold: false });
    const swapCall = state.activeCall, swapId = state.activeCallId, swapLabel = state.activeCallLabel;
    state.activeCall = state.heldCall;
    state.activeCallId = state.heldCallId;
    state.activeCallLabel = state.heldCallLabel;
    state.heldCall = swapCall;
    state.heldCallId = swapId;
    state.heldCallLabel = swapLabel;
    renderActiveCall();
  }

  function promptTransfer() {
    if (!state.activeCallId) return hlToast('Still connecting — try again in a moment.');
    showPopupModal({
      title: 'Transfer Call',
      subtitle: 'Extension number or phone number',
      input: { placeholder: 'e.g. 103 or +19145551234' },
      confirmLabel: 'Transfer',
      onConfirm: function (target) {
        const isExt = /^\d{2,6}$/.test(target);
        const body = isExt ? { callId: state.activeCallId, toExtensionNumber: target } : { callId: state.activeCallId, toNumber: target };
        runTransfer(body, true);
      },
    });
  }

  // Plain calls stay on a direct <Dial> for call quality and only escalate
  // into a Twilio Conference on-demand (see reina/voip-quality-fix-2026-07-24.md).
  // The first transfer attempt on a not-yet-escalated call triggers that
  // escalation server-side and comes back with escalating:true instead of
  // completing the transfer -- retry once, after giving the conference a
  // moment to spin up.
  function runTransfer(body, allowRetry) {
    api('?resource=transfer', 'POST', body).then(function (r) {
      if (r.ok && r.data.escalating && allowRetry) {
        hlToast('Connecting…');
        setTimeout(function () { runTransfer(body, false); }, 1500);
        return;
      }
      if (!r.ok) hlToast(r.data.error || 'Transfer failed.'); else hlToast('Transferring…');
    });
  }

  function endCall() { if (state.activeCall) state.activeCall.disconnect(); }

  // ---------------------------------------------------------------------
  // Calls / Voicemail lists (compact — full history lives in HiveConnect → VoIP)
  // ---------------------------------------------------------------------
  async function refreshCalls() {
    const r = await api('?resource=calls&limit=8');
    state.calls = r.ok ? r.data.calls : [];
    if ((state.tab === 'calls' || state.tab === 'dialer') && !state.activeCall) renderBody();
  }

  function renderCalls(body) {
    if (!state.calls.length) { body.innerHTML = '<div style="color:#8892a6;font-size:12px;padding:10px 0;text-align:center">No calls logged yet.</div>'; return; }
    const rows = state.calls.map(function (c) {
      const number = c.direction === 'inbound' ? c.from_number : c.to_number;
      const name = c.clientName || number || '--';
      const dirLabel = c.direction === 'inbound' ? 'In' : 'Out';
      const actions = '<button class="hlphone-callback" data-number="' + escapeHtml(number || '') + '" style="border:none;background:#e6f2ec;color:#1B7A50;font-weight:800;font-size:10px;padding:4px 8px;border-radius:99px;cursor:pointer">Call</button>'
        + '<button class="hlphone-sms" data-number="' + escapeHtml(number || '') + '" style="border:none;background:#eef1fb;color:#3a4fb0;font-weight:800;font-size:10px;padding:4px 8px;border-radius:99px;cursor:pointer;margin-left:4px">Msg</button>'
        + (c.clientName ? '' : '<button class="hlphone-kebab" data-number="' + escapeHtml(number || '') + '" title="More options" style="border:none;background:#f3f4f8;color:#5b6579;font-weight:900;font-size:12px;padding:4px 7px;border-radius:99px;cursor:pointer;margin-left:4px;line-height:1">&#8942;</button>');
      return '<tr>'
        + '<td style="padding:7px 4px;font-size:10.5px;color:#8892a6;white-space:nowrap">' + dirLabel + '</td>'
        + '<td style="padding:7px 4px;font-size:12px;font-weight:700">' + escapeHtml(name) + '</td>'
        + '<td style="padding:7px 4px;font-size:10.5px;color:#8892a6;white-space:nowrap;text-align:right">' + fmtWhen(c.started_at) + '</td>'
        + '<td style="padding:7px 4px;font-size:10.5px;color:#8892a6;white-space:nowrap;text-align:right">' + fmtDuration(c.duration_seconds) + '</td>'
        + '<td style="padding:7px 0 7px 6px;text-align:right;white-space:nowrap">' + actions + '</td>'
        + '</tr>';
    }).join('');
    body.innerHTML = '<table style="width:100%;border-collapse:collapse">'
      + '<thead><tr style="border-bottom:1px solid #f0f1f5">'
      + '<th style="text-align:left;font-size:9.5px;color:#8892a6;text-transform:uppercase;padding:0 4px 6px">Dir</th>'
      + '<th style="text-align:left;font-size:9.5px;color:#8892a6;text-transform:uppercase;padding:0 4px 6px">Contact</th>'
      + '<th style="text-align:right;font-size:9.5px;color:#8892a6;text-transform:uppercase;padding:0 4px 6px">When</th>'
      + '<th style="text-align:right;font-size:9.5px;color:#8892a6;text-transform:uppercase;padding:0 4px 6px">Length</th>'
      + '<th></th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>'
      + '<div style="text-align:center;font-size:10.5px;color:#8892a6;margin-top:10px;padding-top:8px;border-top:1px solid #f0f1f5">Full history in HiveConnect &rarr; <a href="#" onclick="showView(\'hiveconnect\');setTimeout(function(){if(window.setNavTab)window.setNavTab(\'voip\')},350)" style="color:#748a9e;font-weight:700;text-decoration:none">VoIP</a></div>';
    body.querySelectorAll('.hlphone-callback').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = b.dataset.number;
      if (n) placeCall(n);
    }));
    body.querySelectorAll('.hlphone-sms').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = b.dataset.number;
      if (n) sendQuickSms(n);
    }));
    body.querySelectorAll('.hlphone-kebab').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      showRowMenu(b, b.dataset.number);
    }));
  }

  async function refreshContacts(q) {
    const query = typeof q === 'string' ? q : state.contactsQuery;
    state.contactsQuery = query;
    const r = await api('?resource=directory&q=' + encodeURIComponent(query || ''));
    state.contactsExtensions = r.ok ? r.data.extensions : [];
    state.contacts = r.ok ? r.data.clients : [];
    if (state.tab === 'contacts' && !state.activeCall) renderContacts(document.getElementById('hlphone-body'));
  }

  function renderContacts(body) {
    if (!body) return;
    const teamRows = state.contactsExtensions.map(x =>
      '<tr><td style="padding:6px 4px;font-size:12px;font-weight:700" colspan="2">' + escapeHtml(x.name) + ' <span style="color:#8892a6;font-weight:600">(ext ' + escapeHtml(x.extensionNumber) + ')</span></td>'
      + '<td style="padding:6px 0;text-align:right"><button class="hlphone-callext" data-ext="' + escapeHtml(x.extensionNumber) + '" style="border:none;background:#e6f2ec;color:#1B7A50;font-weight:800;font-size:10px;padding:4px 8px;border-radius:99px;cursor:pointer">Call</button></td></tr>'
    ).join('');
    const clientRows = state.contacts.map(c =>
      '<tr><td style="padding:6px 4px;font-size:12px;font-weight:700">' + escapeHtml(c.name || 'Unnamed') + '</td>'
      + '<td style="padding:6px 4px;font-size:10.5px;color:#8892a6">' + escapeHtml(c.phone || '') + '</td>'
      + '<td style="padding:6px 0;text-align:right"><button class="hlphone-callback" data-number="' + escapeHtml(c.phone || '') + '" style="border:none;background:#e6f2ec;color:#1B7A50;font-weight:800;font-size:10px;padding:4px 8px;border-radius:99px;cursor:pointer">Call</button></td></tr>'
    ).join('');
    const empty = (!teamRows && !clientRows) ? '<div style="color:#8892a6;font-size:12px;padding:10px 0;text-align:center">No contacts found.</div>' : '';
    body.innerHTML = '<input id="hlphone-contactsearch" type="text" placeholder="Search contacts..." value="' + escapeHtml(state.contactsQuery) + '" style="width:100%;box-sizing:border-box;font-size:12.5px;padding:8px;border:1px solid var(--line,#dadde8);border-radius:8px;margin-bottom:10px;font-family:inherit" />'
      + '<table style="width:100%;border-collapse:collapse">' + teamRows + clientRows + '</table>' + empty;
    const input = document.getElementById('hlphone-contactsearch');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    let searchTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => refreshContacts(input.value.trim()), 300);
    });
    body.querySelectorAll('.hlphone-callback').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = b.dataset.number;
      if (n) placeCall(n);
    }));
    body.querySelectorAll('.hlphone-callext').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const ext = b.dataset.ext;
      if (ext) placeCall(ext);
    }));
  }

  async function refreshVoicemails() {
    const r = await api('?resource=voicemails');
    state.voicemails = r.ok ? r.data.voicemails : [];
    const unread = state.voicemails.filter(v => !v.read).length;
    if (window.hlSfx && typeof state._vmUnreadPrev === 'number' && unread > state._vmUnreadPrev) hlSfx.play('notify');
    state._vmUnreadPrev = unread;
    const badge = document.getElementById('hlphonebadge');
    if (badge) { badge.style.display = unread ? 'flex' : 'none'; badge.textContent = unread; }
    const dot = document.getElementById('hlphone-vmdot');
    if (dot) dot.style.display = unread ? 'inline' : 'none';
    if (state.tab === 'voicemail' && !state.activeCall) renderBody();
  }

  function renderVoicemail(body) {
    if (!state.voicemails.length) { body.innerHTML = '<div style="color:#8892a6;font-size:12px;padding:10px 0;text-align:center">No voicemails.</div>'; return; }
    body.innerHTML = state.voicemails.slice(0, 6).map(v => `
      <div style="padding:8px 0;border-bottom:1px solid #f0f1f5">
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700">
          <span>${v.read ? '' : '<span style="color:#c65b4e">●</span> '}${escapeHtml(v.from_number)}</span>
          <span style="color:#8892a6;font-weight:500;font-size:10.5px">${fmtWhen(v.created_at)}</span>
        </div>
        ${v.ai_summary ? `<div style="font-size:10.5px;color:#8892a6;margin-top:3px">${escapeHtml(v.ai_summary)}</div>` : ''}
      </div>`).join('') + '<div style="text-align:center;font-size:10.5px;color:#8892a6;margin-top:10px;padding-top:8px;border-top:1px solid #f0f1f5">Full history in HiveConnect → <a href="#" onclick="showView(\'hiveconnect\');setTimeout(function(){if(window.setNavTab)window.setNavTab(\'voip\')},350)" style="color:#748a9e;font-weight:700;text-decoration:none">VoIP</a></div>';
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  async function initDevice() {
    try {
      await loadTwilioSdk();
      const tokenRes = await api('?resource=token', 'POST', {});
      if (!tokenRes.ok) {
        const line = document.getElementById('hlphone-idline');
        if (line) line.textContent = tokenRes.data.error || 'Not set up';
        return;
      }
      state.myExtension = tokenRes.data.extension;
      const line = document.getElementById('hlphone-idline');
      if (line) line.textContent = `Ext. ${state.myExtension.extension_number} · ${state.myExtension.display_name}`;
      state.device = new window.Twilio.Device(tokenRes.data.token, { codecPreferences: ['opus', 'pcmu'] });
      state.device.on('incoming', (call) => {
        const from = (call.parameters && call.parameters.From) || 'Incoming call';
        // "at the inception of the call" -- the lookup starts here, before the
        // ring card is even drawn, so the name is on screen while it rings
        // rather than after somebody has already picked up.
        lookupCaller((call.parameters && call.parameters.From) || '');
        if (state.activeCall) {
          // Already on a call -- honor this extension's call waiting
          // setting (Settings > Extensions > Edit) instead of silently
          // dropping the call in progress, which used to happen here
          // unconditionally.
          const waitingAllowed = !state.myExtension || state.myExtension.call_waiting_enabled !== false;
          if (!waitingAllowed) {
            call.reject();
            hlToast('Missed call from ' + from + ' -- call waiting is off for your extension.');
            return;
          }
          state.waitingCall = call;
          state.waitingCallLabel = from;
          call.on('cancel', () => { if (state.waitingCall === call) { state.waitingCall = null; renderBody(); } });
          call.on('error', (e) => hlToast('Call error: ' + (e && e.message || e)));
          ensureDom(); setOpen(true);
          hlToast('Call waiting: ' + from);
          renderBody();
          return;
        }
        // Ring instead of auto-answering (2026-07-26): this used to accept()
        // immediately, silently picking up extension calls.
        state.ringingCall = call;
        state.ringingCallLabel = from;
        call.on('cancel', () => { if (state.ringingCall === call) { state.ringingCall = null; stopRingtone(); resetCaller(); hlToast('Missed call from ' + from); renderBody(); } });
        call.on('disconnect', () => { if (state.ringingCall === call) { state.ringingCall = null; stopRingtone(); renderBody(); } });
        call.on('error', (e) => { if (state.ringingCall === call) { state.ringingCall = null; stopRingtone(); renderBody(); } hlToast('Call error: ' + (e && e.message || e)); });
        ensureDom(); setOpen(true);
        renderBody();
        startRingtone();
      });
      state.device.on('error', (e) => console.error('Twilio Device error:', e));
      state.device.register();
      if (state.tab === 'dialer' && !state.activeCall) renderBody();
    } catch (e) {
      const line = document.getElementById('hlphone-idline');
      if (line) line.textContent = 'Setup failed';
      console.error('HiveLogic Phone setup failed:', e);
    }
  }

  async function boot() {
    if (document.body.dataset.hlPhoneBooted) return;
    document.body.dataset.hlPhoneBooted = '1';
    ensureDom();
    const statusRes = await api('?resource=status');
    state.configured = statusRes.ok ? statusRes.data.configured : false;
    if (!state.configured) {
      renderNotConfigured(statusRes.ok ? statusRes.data.missingEnv : []);
      const icon = document.getElementById('hlphoneicon');
      if (icon) icon.title = 'Phone (not connected yet)';
      return;
    }
    renderDialer(document.getElementById('hlphone-body'));
    initDevice();
    refreshVoicemails();
  }

  function gatedBoot() {
    if (typeof window.hlRequireSession !== 'function') return;
    window.hlRequireSession(boot, function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', gatedBoot);
  else gatedBoot();
  window.addEventListener('hl:signed-in', gatedBoot);
})();
