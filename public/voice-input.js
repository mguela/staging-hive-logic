// public/voice-input.js
// HiveLogic global field helpers, rendered as small floating buttons that
// follow whichever text field has focus (delegated focusin/focusout — covers
// every input/textarea, including ones app JS renders later, without touching
// any field's markup):
//   1. Reina mic — click, talk, it dictates into the focused field.
//   2. Show-password eye — on password fields ONLY, toggles the text visible.
// On a password field the two sit RIGHT NEXT TO EACH OTHER at the field's
// right edge (eye outermost, mic just inside it); on any other field only the
// mic shows, at the right edge as before.
(function () {
  'use strict';

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  var TEXT_INPUT_TYPES = ['text', 'search', 'email', 'tel', 'url', 'number', 'password'];

  function isTextField(el) {
    if (!el || el.disabled || el.readOnly) return false;
    // Note: data-hl-voice-input="off" only disables the MIC (see voiceAllowed),
    // not the field itself — a password field still gets the eye.
    var tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      return TEXT_INPUT_TYPES.indexOf(type) !== -1;
    }
    if (el.isContentEditable) return true;
    return false;
  }
  // A field is a "password field" by its ORIGINAL type. Once revealed we flip
  // the live type to 'text', so remember it with a data flag.
  function isPasswordEl(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    if (el.getAttribute('data-hl-no-eye') != null) return false; // has its own toggle
    var t = (el.getAttribute('type') || '').toLowerCase();
    return t === 'password' || el.getAttribute('data-hl-pw') === '1';
  }
  function voiceAllowed(el) {
    return SR && !(el.getAttribute && el.getAttribute('data-hl-voice-input') === 'off');
  }

  var css = '' +
    '.hl-voice-btn,.hl-eye-btn{position:fixed;z-index:999999;width:26px;height:26px;border-radius:50%;' +
    'border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;' +
    'box-shadow:0 2px 6px rgba(0,0,0,.25);opacity:0;transform:scale(.7);pointer-events:none;' +
    'transition:opacity .12s ease,transform .12s ease;}' +
    '.hl-voice-btn{background:#4a3b8f;color:#fff;}' +
    '.hl-eye-btn{background:#5a6473;color:#fff;}' +
    '.hl-voice-btn.hl-show,.hl-eye-btn.hl-show{opacity:1;transform:scale(1);pointer-events:auto;}' +
    '.hl-eye-btn.hl-on{background:#3b566f;}' +
    '.hl-voice-btn.hl-listening{background:#e0473c;animation:hlVoicePulse 1.1s ease-in-out infinite;}' +
    '.hl-voice-btn.hl-error{background:#c0392b;animation:none;}' +
    '.hl-voice-btn svg{width:14px;height:14px;fill:#fff;pointer-events:none;}' +
    '.hl-eye-btn svg{width:15px;height:15px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none;}' +
    '@keyframes hlVoicePulse{0%,100%{box-shadow:0 0 0 0 rgba(224,71,60,.55);}50%{box-shadow:0 0 0 6px rgba(224,71,60,0);}}';
  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  var MIC_SVG = '<svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2z"/></svg>';
  var EYE_SVG = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF_SVG = '<svg viewBox="0 0 24 24"><path d="M3 3l18 18"/><path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3 3.6M6.3 6.3A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.4-1"/><path d="M9.5 9.5a3 3 0 0 0 4.2 4.2"/></svg>';

  var micBtn = document.createElement('button');
  micBtn.type = 'button'; micBtn.className = 'hl-voice-btn';
  micBtn.title = 'Click to talk to Reina (dictate into this field)';
  micBtn.innerHTML = MIC_SVG; micBtn.setAttribute('aria-label', 'Dictate with voice');

  var eyeBtn = document.createElement('button');
  eyeBtn.type = 'button'; eyeBtn.className = 'hl-eye-btn';
  eyeBtn.title = 'Show password'; eyeBtn.innerHTML = EYE_SVG;
  eyeBtn.setAttribute('aria-label', 'Show or hide password');

  function mount() { document.body.appendChild(micBtn); document.body.appendChild(eyeBtn); }
  document.addEventListener('DOMContentLoaded', mount);
  if (document.body) mount();

  var activeField = null;
  var activeIsPw = false;
  var recognition = null;
  var listening = false;
  var hideTimer = null;
  var errorTimer = null;
  var gotResult = false;
  var errorShown = false;

  function positionButtons() {
    if (!activeField) return;
    var r = activeField.getBoundingClientRect();
    var size = 26, margin = 6, gap = 5;
    var top = Math.max(4, r.top + (r.height - size) / 2);
    var showEye = activeIsPw;
    var showMicHere = voiceAllowed(activeField);
    // Eye is outermost (right), mic sits just to its left. If there's no eye,
    // the mic takes the right-edge spot.
    var eyeLeft = r.right - margin - size;
    var micLeft = showEye ? (eyeLeft - gap - size) : (r.right - margin - size);
    var floor = r.left + 2;
    if (showEye) {
      eyeBtn.style.top = top + 'px';
      eyeBtn.style.left = Math.max(floor, eyeLeft) + 'px';
    }
    if (showMicHere) {
      micBtn.style.top = top + 'px';
      micBtn.style.left = Math.max(floor, micLeft) + 'px';
    }
  }

  function showButtons(el) {
    activeField = el;
    activeIsPw = isPasswordEl(el);
    positionButtons();
    if (voiceAllowed(el)) micBtn.classList.add('hl-show'); else micBtn.classList.remove('hl-show');
    if (activeIsPw) { eyeBtn.classList.add('hl-show'); syncEyeIcon(); } else eyeBtn.classList.remove('hl-show');
  }

  function syncEyeIcon() {
    var revealed = activeField && activeField.type === 'text';
    eyeBtn.innerHTML = revealed ? EYE_OFF_SVG : EYE_SVG;
    eyeBtn.title = revealed ? 'Hide password' : 'Show password';
    eyeBtn.classList.toggle('hl-on', !!revealed);
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      if (listening) return;
      if (document.activeElement === activeField) return;
      micBtn.classList.remove('hl-show');
      eyeBtn.classList.remove('hl-show', 'hl-on');
      // Re-hide a revealed password when the field loses focus (safety).
      if (activeField && activeIsPw && activeField.type === 'text') {
        activeField.type = 'password';
      }
      activeField = null; activeIsPw = false;
    }, 150);
  }

  document.addEventListener('focusin', function (e) {
    if (isTextField(e.target)) { clearTimeout(hideTimer); showButtons(e.target); }
  });
  document.addEventListener('focusout', function (e) {
    if (e.target === activeField) scheduleHide();
  });
  window.addEventListener('scroll', function () {
    if (activeField && (micBtn.classList.contains('hl-show') || eyeBtn.classList.contains('hl-show'))) positionButtons();
  }, true);
  window.addEventListener('resize', function () {
    if (activeField && (micBtn.classList.contains('hl-show') || eyeBtn.classList.contains('hl-show'))) positionButtons();
  });

  // ---- eye: toggle password visibility ----
  eyeBtn.addEventListener('mousedown', function (e) { e.preventDefault(); }); // fire before blur
  eyeBtn.onclick = function () {
    if (!activeField) return;
    activeField.setAttribute('data-hl-pw', '1'); // remember it's a password field even as 'text'
    activeField.type = activeField.type === 'password' ? 'text' : 'password';
    syncEyeIcon();
    try { activeField.focus(); } catch (e) {}
  };

  // ---- mic: dictation ----
  function insertText(el, text) {
    if (!text) return;
    if (el.isContentEditable) { el.focus(); document.execCommand('insertText', false, text); }
    else {
      var start = el.selectionStart, end = el.selectionEnd;
      var hasSel = typeof start === 'number' && typeof end === 'number';
      var existing = el.value || '';
      if (hasSel) {
        var before = existing.slice(0, start), after = existing.slice(end);
        var needsSpace = before && !/\s$/.test(before);
        var ins = (needsSpace ? ' ' : '') + text;
        el.value = before + ins + after;
        var pos = (before + ins).length; el.setSelectionRange(pos, pos);
      } else { el.value = existing + (existing && !/\s$/.test(existing) ? ' ' : '') + text; }
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function flashError(msg) {
    clearTimeout(errorTimer);
    micBtn.classList.add('hl-error'); micBtn.title = msg;
    errorTimer = setTimeout(function () { micBtn.classList.remove('hl-error'); micBtn.title = 'Click to talk to Reina (dictate into this field)'; }, 1800);
  }
  function stopListening() {
    listening = false; micBtn.classList.remove('hl-listening');
    if (recognition) { try { recognition.stop(); } catch (e) {} }
    scheduleHide();
  }
  function startListening(field) {
    // Hard opt-out gate. Fields marked data-hl-voice-input="off" -- Reina's own
    // composer (#rnaIn) above all -- must never get this global recognizer
    // attached, or a second microphone races Reina's own transcription for the
    // same utterance. Until now the ONLY thing stopping that was the button
    // being CSS-hidden (pointer-events:none, via the absent .hl-show class),
    // which is a presentation detail rather than an enforcement point: anything
    // reaching startListening by another route bypassed the opt-out entirely.
    // Check the field itself, here, where the recognizer is actually created.
    if (!voiceAllowed(field)) return;
    if (listening) { stopListening(); return; }
    recognition = new SR(); recognition.lang = 'en-US'; recognition.interimResults = false; recognition.continuous = false;
    listening = true; gotResult = false; errorShown = false;
    micBtn.classList.remove('hl-error'); micBtn.classList.add('hl-listening');
    recognition.onresult = function (ev) {
      var transcript = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) { if (ev.results[i].isFinal) transcript += ev.results[i][0].transcript; }
      transcript = transcript.trim();
      if (transcript) { gotResult = true; insertText(field, transcript); }
    };
    recognition.onerror = function (ev) {
      listening = false; micBtn.classList.remove('hl-listening');
      var err = ev && ev.error;
      if (err && err !== 'aborted') { errorShown = true; flashError(err === 'no-speech' ? "Didn't hear anything -- try again" : 'Voice input error -- try again'); }
    };
    recognition.onend = function () {
      listening = false; micBtn.classList.remove('hl-listening');
      if (!gotResult && !errorShown) flashError("Didn't catch that -- try again");
      scheduleHide();
    };
    try { recognition.start(); } catch (e) { listening = false; micBtn.classList.remove('hl-listening'); }
  }
  micBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
  micBtn.onclick = function () { if (!activeField) return; startListening(activeField); };

  window.HL_VOICE_INPUT = { supported: !!SR, isListening: function () { return listening; } };
})();
