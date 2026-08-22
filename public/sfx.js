/* HiveLogic sound effects engine (2026-07-26)
   Punchy, synthesized WebAudio sounds — no audio files, no network.
   Self-wiring: soft-thock on interactive clicks, chime/buzz on toasts
   (success vs error detected from the message), ding on notifications,
   pop when modals appear. Everything degrades silently if WebAudio is
   unavailable.

   Public API:
     hlSfx.play('click'|'success'|'error'|'notify'|'pop'|'swoosh')
     hlSfx.muted            -> boolean
     hlSfx.toggle()         -> flips mute, persists in localStorage
*/
(function () {
  'use strict';
  if (window.hlSfx) return;

  var ctx = null;
  var master = null;
  var MUTE_KEY = 'hlSfxMuted';

  function muted() {
    try { return localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { return false; }
  }

  function ensureCtx() {
    if (ctx) {
      if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
      return ctx;
    }
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.6;
      master.connect(ctx.destination);
    } catch (e) { ctx = null; }
    return ctx;
  }

  // ---- building blocks -------------------------------------------------
  function tone(opts) {
    // opts: {type, f0, f1, t, dur, vol, curve}
    var c = ctx; if (!c) return;
    var o = c.createOscillator();
    var g = c.createGain();
    var t0 = c.currentTime + (opts.t || 0);
    o.type = opts.type || 'sine';
    o.frequency.setValueAtTime(opts.f0, t0);
    if (opts.f1) o.frequency.exponentialRampToValueAtTime(Math.max(1, opts.f1), t0 + opts.dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opts.vol || 0.2, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + opts.dur + 0.02);
  }

  function noise(opts) {
    // opts: {t, dur, vol, hp, lp}
    var c = ctx; if (!c) return;
    var t0 = c.currentTime + (opts.t || 0);
    var len = Math.max(1, Math.floor(c.sampleRate * opts.dur));
    var buf = c.createBuffer(1, len, c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = c.createBufferSource();
    src.buffer = buf;
    var g = c.createGain();
    g.gain.setValueAtTime(opts.vol || 0.1, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    var node = src;
    if (opts.hp) { var hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = opts.hp; node.connect(hp); node = hp; }
    if (opts.lp) { var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = opts.lp; node.connect(lp); node = lp; }
    node.connect(g); g.connect(master);
    src.start(t0);
  }

  // ---- the sound set (punchy & satisfying) -----------------------------
  var SOUNDS = {
    // Mechanical keyboard-style thock: pitch-dropping triangle + tiny noise tick
    click: function () {
      tone({ type: 'triangle', f0: 1900, f1: 750, dur: 0.045, vol: 0.22 });
      noise({ dur: 0.02, vol: 0.10, hp: 2500 });
    },
    // Two-note rising chime with a sparkle octave on top
    success: function () {
      tone({ type: 'sine', f0: 660, dur: 0.10, vol: 0.22 });
      tone({ type: 'sine', f0: 990, t: 0.09, dur: 0.16, vol: 0.22 });
      tone({ type: 'sine', f0: 1980, t: 0.09, dur: 0.12, vol: 0.07 });
    },
    // Firm descending double-buzz — unmistakably "nope"
    error: function () {
      tone({ type: 'sawtooth', f0: 320, f1: 190, dur: 0.11, vol: 0.16 });
      tone({ type: 'sawtooth', f0: 260, f1: 130, t: 0.12, dur: 0.16, vol: 0.16 });
    },
    // Bright message ding (bell-ish: fundamental + detuned partial)
    notify: function () {
      tone({ type: 'sine', f0: 1318, dur: 0.28, vol: 0.20 });
      tone({ type: 'sine', f0: 1980, dur: 0.18, vol: 0.08 });
      tone({ type: 'sine', f0: 880, t: 0.02, dur: 0.22, vol: 0.10 });
    },
    // Bubble pop for dialogs
    pop: function () {
      tone({ type: 'sine', f0: 520, f1: 180, dur: 0.07, vol: 0.25 });
      noise({ dur: 0.03, vol: 0.08, hp: 900, lp: 4000 });
    },
    // Send swoosh: rising filtered noise
    swoosh: function () {
      noise({ dur: 0.18, vol: 0.14, hp: 600 });
      tone({ type: 'sine', f0: 500, f1: 1400, dur: 0.16, vol: 0.06 });
    },
    // Outgoing-call ringback (US dual tone 440+480, one burst per loop tick)
    ringback: function () {
      tone({ type: 'sine', f0: 440, dur: 1.0, vol: 0.10 });
      tone({ type: 'sine', f0: 480, dur: 1.0, vol: 0.10 });
    },
    // Incoming video-call ring: bright FaceTime-ish double chime per loop tick
    ring: function () {
      tone({ type: 'sine', f0: 880, dur: 0.14, vol: 0.20 });
      tone({ type: 'sine', f0: 1108, t: 0.16, dur: 0.20, vol: 0.20 });
      tone({ type: 'sine', f0: 1760, t: 0.16, dur: 0.14, vol: 0.06 });
    },
    // Call connected: quick rising blip
    connect: function () {
      tone({ type: 'sine', f0: 600, f1: 950, dur: 0.09, vol: 0.20 });
      tone({ type: 'sine', f0: 1200, t: 0.07, dur: 0.08, vol: 0.08 });
    },
    // Call ended: low descending thunk
    hangup: function () {
      tone({ type: 'sine', f0: 300, f1: 130, dur: 0.14, vol: 0.22 });
      tone({ type: 'sine', f0: 150, t: 0.10, dur: 0.12, vol: 0.12 });
    },
  };

  var last = {};
  function play(name) {
    if (muted()) return;
    var fn = SOUNDS[name];
    if (!fn) return;
    var now = Date.now();
    if (last[name] && now - last[name] < 60) return; // debounce double-fires
    last[name] = now;
    if (!ensureCtx()) return;
    try { fn(); } catch (e) {}
  }

  // Looping sounds (phone ringback, incoming call ring). One loop at a time —
  // starting a new loop replaces the old one; stopLoop() always safe to call.
  var loopTimer = null;
  function startLoop(name, periodMs) {
    stopLoop();
    play(name);
    loopTimer = setInterval(function () { play(name); }, periodMs || 3000);
  }
  function stopLoop() {
    if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  }

  window.hlSfx = {
    play: play,
    startLoop: startLoop,
    stopLoop: stopLoop,
    get muted() { return muted(); },
    toggle: function () {
      try { localStorage.setItem(MUTE_KEY, muted() ? '0' : '1'); } catch (e) {}
      stopLoop();
      if (!muted()) play('click');
      return muted();
    },
  };

  // ---- auto-wiring -----------------------------------------------------

  // Unlock audio on the first user gesture (browser autoplay policy)
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (evt) {
    document.addEventListener(evt, function unlock() { ensureCtx(); }, { passive: true, capture: true });
  });

  // 1) Clicks & taps: soft thock on anything interactive
  var CLICKABLE = 'button,a,select,option,input[type="checkbox"],input[type="radio"],input[type="button"],input[type="submit"],[onclick],[role="button"],.tab,.ptab,.tf,.mf,.chip,.achip,.navbtn,.sidebar-item,.rb-stat,.rb-p,.thread,.lnk,.job-card,.board-card,.cat-card,.rcard,.qrow,.meas-btn,.finish-card,.image-card,.pres-card,.payment-option';
  document.addEventListener('click', function (e) {
    try {
      if (!e.isTrusted) return;                      // only real user clicks
      if (e.target.closest('input[type="text"],input[type="search"],input[type="email"],input[type="number"],input[type="password"],textarea,[contenteditable="true"]')) return;
      var el = e.target.closest(CLICKABLE);
      if (!el) return;
      play('click');
    } catch (x) {}
  }, true);

  // 2) Toasts: success chime vs error buzz vs neutral ding, based on message
  var ERR_RE = /fail|error|could\s*not|couldn|can[' ]?t|unable|invalid|wrong|denied|missing|not\s+found|try\s+again|offline|expired/i;
  var OK_RE = /sent|saved|done|success|copied|shipped|added|created|updated|complete|clocked|connected|uploaded|scheduled|assigned|approved|paid|delivered/i;
  function classify(msg) {
    var m = String(msg == null ? '' : msg);
    if (ERR_RE.test(m)) return 'error';
    if (OK_RE.test(m)) return 'success';
    return 'notify';
  }
  function wrapToast(name) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__hlSfxWrapped) return false;
    var wrapped = function (msg) {
      try { play(classify(msg)); } catch (x) {}
      return orig.apply(this, arguments);
    };
    wrapped.__hlSfxWrapped = true;
    window[name] = wrapped;
    return true;
  }
  var toastNames = ['hlToast', 'chirpToast', 'evToast', 'hcToast'];
  var tries = 0;
  var poll = setInterval(function () {
    toastNames = toastNames.filter(function (n) { return !wrapToast(n); });
    if (!toastNames.length || ++tries > 120) clearInterval(poll); // give up after ~60s
  }, 500);

  // 3) Popups & modals: pop when a dialog appears (workforce modals, dev
  //    popup, generic .modal elements added near body level)
  function looksLikeModal(n) {
    if (!n || n.nodeType !== 1) return false;
    if (n.id === 'hldevpop' || n.id === 'hldevpop2') return true;
    if (n.classList && n.classList.contains('modal')) return true;
    var st = n.getAttribute && (n.getAttribute('style') || '');
    return st.indexOf('z-index: 10050') >= 0 || st.indexOf('z-index:10050') >= 0;
  }
  try {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          if (looksLikeModal(added[j])) { play('pop'); return; }
        }
      }
    }).observe(document.body, { childList: true });
  } catch (e) {}
})();
