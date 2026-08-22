/* public/reina-login-brief-controller.js
 *
 * UNWIRED, dependency-injected AUTHENTICATED GREETING + ATTENTION SUMMARY for the
 * purple Reina panel. After HiveLogic confirms an authenticated session, Reina
 * presents a personalized WRITTEN greeting, reports the authorized items needing
 * attention, and asks whether the user wants to review them. Pure controller/
 * state-machine — no DOM, network, storage, speech, or navigation of its own.
 *
 * CONFIRMATION-CONTRACT POSTURE (PR #87 -> #88 seam)
 *   - This controller NEVER creates navigation authority. It does not mint a
 *     `reina.ui-intent.v1`, does not choose a destination, and derives NOTHING
 *     navigable from its client-side categories, display text, or counts.
 *   - The review destination and the canonical `reina.ui-intent.v1` originate
 *     from the AUTHENTICATED SERVER response and are registered with the governed
 *     router by the server/host. This controller only holds the server-issued
 *     pending `intentId` (an opaque token) and, on the user's single "yes",
 *     calls a narrow host-injected `confirmIntent(intentId)` seam with the EXACT
 *     server-issued id and nothing else.
 *   - Button "yes" and verbal "yes" both perform exactly ONE confirmation of that
 *     exact pending intentId. The login greeting's question IS the confirmation
 *     prompt; there is no second prompt.
 *   - Categories are DISPLAY-ONLY. They can never choose or expand the
 *     destination, parameters, capability, role, company, or authorization.
 *   - Fail-closed on: missing/malformed pending intentId; a stale/replaced intent
 *     (session/generation superseded) or auth expiry mid-confirm; duplicate
 *     button/verbal confirmation; a throwing / rejecting / promise-shaped /
 *     malformed injected dependency; a navigation failure; and hostile bootstrap
 *     accessors, inherited values, proxies, HTML, or control characters.
 *   - Preserved: server-verified greeting name; bounded attention counts;
 *     explicit unavailable-source disclosure; textContent-only rendering; no mic
 *     and no speech autoplay; structural `executed:false`; no direct navigation
 *     or business action.
 *
 * UMD: window.ReinaLoginBrief in the browser; module.exports in node.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReinaLoginBrief = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EXECUTION_STATEMENT =
    'Nothing was executed. This is a read-only answer; no action was taken and no data was changed.';
  var PREVIEW_NOTICE = 'REINA · READ ONLY';
  var MAX_NAME_CHARS = 120;
  var MAX_CATEGORIES = 24;
  var MAX_EVIDENCE = 20;
  var MAX_STR = 500;
  var MAX_COUNT = 100000;
  var MAX_INTENT_ID = 200;
  var MAX_EVENT_ID = 200;
  // The host must stamp a trusted final-transcript voice event with this exact
  // source marker. Any other source string is untrusted and performs nothing.
  var TRUSTED_VOICE_SOURCE = 'reina.voice.final';
  var ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

  function noop() {}
  function isFn(f) { return typeof f === 'function'; }
  function isStr(s) { return typeof s === 'string'; }
  function isNonEmptyStr(s) { return typeof s === 'string' && s.trim().length > 0; }
  function isPlainObject(o) { return o != null && typeof o === 'object' && !Array.isArray(o); }
  function isNonNegInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n >= 0; }
  function isoValid(s) { return isStr(s) && ISO.test(s) && !isNaN(Date.parse(s)); }

  function looksLikeHtml(s) {
    return typeof s === 'string' && (/<[a-z!/][^>]*>/i.test(s) || /<\s*script/i.test(s) || /on\w+\s*=/i.test(s) || /javascript:/i.test(s));
  }
  function hasControl(s) { return typeof s === 'string' && /[\x00-\x08\x0B-\x1F\x7F]/.test(s); }
  function inert(value) {
    if (value == null) return '';
    var s = String(value).replace(/\r\n?/g, '\n').replace(/<[^>]*>/g, '').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
    return s.trim();
  }
  function safeStr(v, max) {
    if (!isStr(v)) return null;
    if (v.length > (max || MAX_STR)) return null;
    if (looksLikeHtml(v) || hasControl(v)) return null;
    return v;
  }
  // Read an OWN DATA property only. Rejects accessors (getters), inherited
  // properties, and neutralizes proxy/accessor smuggling (never invokes a getter).
  // A hostile Proxy's getOwnPropertyDescriptor trap that THROWS is contained here
  // — no raw exception escapes; the read simply fails closed.
  function ownData(obj, key) {
    if (obj == null || typeof obj !== 'object') return { ok: false, reason: 'not_object' };
    var d;
    try { d = Object.getOwnPropertyDescriptor(obj, key); } catch (e) { return { ok: false, reason: 'descriptor_trap' }; }
    if (!d) return { ok: false, reason: 'missing' };
    if (!('value' in d)) return { ok: false, reason: 'accessor' };
    return { ok: true, value: d.value };
  }

  // A valid transcript eventId: bounded, nonempty PRIMITIVE (string or finite
  // number). Booleans/objects/arrays/null/undefined are rejected.
  function normalizeEventId(raw) {
    if (typeof raw === 'string') { var s = raw.trim(); return (s && s.length <= MAX_EVENT_ID) ? s : null; }
    if (typeof raw === 'number' && isFinite(raw)) { var n = String(raw); return n.length <= MAX_EVENT_ID ? n : null; }
    return null;
  }

  // Read sessionId EXACTLY ONCE into a bounded primitive snapshot. Hostile
  // session objects/proxies are read a single time; the snapshot is never reread.
  function readSessionId(session) {
    var raw;
    if (isPlainObject(session)) { var r = ownData(session, 'sessionId'); if (!r.ok) return null; raw = r.value; }
    else raw = session;
    var s = safeStr(raw, 200);
    return isNonEmptyStr(s) ? s : null;
  }

  // Deeply validate the server bootstrap. Returns { ok:true, data } (a sanitized
  // plain snapshot including the server-issued pendingIntentId) or { ok:false, reason }.
  function validateBootstrap(boot, expectedSessionId) {
    if (!isPlainObject(boot)) return { ok: false, reason: 'malformed_bootstrap' };
    if (ownData(boot, 'ok').value !== true) return { ok: false, reason: 'not_ok' };
    var ex = ownData(boot, 'executed');
    if (!ex.ok || ex.value !== false) return { ok: false, reason: 'forged_execution' };
    var sid = ownData(boot, 'sessionId');
    if (sid.ok && expectedSessionId != null && sid.value !== expectedSessionId) return { ok: false, reason: 'session_mismatch' };

    var userR = ownData(boot, 'user');
    if (!userR.ok || !isPlainObject(userR.value)) return { ok: false, reason: 'missing_user' };
    var nameR = ownData(userR.value, 'displayName');
    if (!nameR.ok) return { ok: false, reason: 'missing_displayName' };
    var displayName = safeStr(nameR.value, MAX_NAME_CHARS);
    if (!isNonEmptyStr(displayName)) return { ok: false, reason: 'invalid_displayName' };

    var attR = ownData(boot, 'attention');
    if (!attR.ok || !isPlainObject(attR.value)) return { ok: false, reason: 'missing_attention' };
    var att = attR.value;
    var totalR = ownData(att, 'total');
    if (!totalR.ok || !isNonNegInt(totalR.value) || totalR.value > MAX_COUNT) return { ok: false, reason: 'malformed_total' };
    var total = totalR.value;
    var asOfR = ownData(att, 'asOf');
    var attAsOf = null;
    if (asOfR.ok && asOfR.value != null) { if (!isoValid(asOfR.value)) return { ok: false, reason: 'invalid_asOf' }; attAsOf = asOfR.value; }

    var catsR = ownData(att, 'categories');
    if (!catsR.ok || !Array.isArray(catsR.value)) return { ok: false, reason: 'missing_categories' };
    if (catsR.value.length > MAX_CATEGORIES) return { ok: false, reason: 'oversized_categories' };
    var seenKeys = Object.create(null);
    var categories = [];
    var availableSum = 0;
    for (var i = 0; i < catsR.value.length; i++) {
      var cR = ownData(catsR.value, String(i));
      if (!cR.ok || !isPlainObject(cR.value)) return { ok: false, reason: 'malformed_category' };
      var c = cR.value;
      var keyR = ownData(c, 'key'); var key = keyR.ok ? safeStr(keyR.value, 80) : null;
      if (!isNonEmptyStr(key)) return { ok: false, reason: 'malformed_category_key' };
      if (seenKeys[key]) return { ok: false, reason: 'duplicate_category_key' };
      seenKeys[key] = true;
      var labelR = ownData(c, 'label'); var label = labelR.ok ? safeStr(labelR.value, 120) : null;
      if (!isNonEmptyStr(label)) return { ok: false, reason: 'malformed_category_label' };
      var countR = ownData(c, 'count');
      var availR = ownData(c, 'available');
      if (!availR.ok || typeof availR.value !== 'boolean') return { ok: false, reason: 'malformed_category_available' };
      var available = availR.value;
      // An unavailable source has nothing to count, and the route says so with
      // count:null (mail, finance and weather are all unavailable in the pilot) --
      // exactly as the asOf check just below already allows null. Requiring an
      // integer here regardless of `available` rejected every bootstrap the route
      // actually sends, and the panel then reported the whole pilot as
      // unavailable. That is what took Reina's voice down with it: no bootstrap
      // means no session, and installVoice() will not start without one.
      // A count is still mandatory where the source IS available, and an explicit
      // 0 stays legal for an unavailable one -- callers already send it, and the
      // total below counts only available sources either way.
      if (!countR.ok) return { ok: false, reason: 'malformed_category_count' };
      if (available || countR.value !== null) {
        if (!isNonNegInt(countR.value) || countR.value > MAX_COUNT) return { ok: false, reason: 'malformed_category_count' };
      }
      var cAsOfR = ownData(c, 'asOf'); var cAsOf = null;
      if (available) {
        if (!cAsOfR.ok || !isoValid(cAsOfR.value)) return { ok: false, reason: 'invalid_category_asOf' };
        cAsOf = cAsOfR.value;
      }
      var evR = ownData(c, 'evidence'); var evidence = [];
      if (evR.ok && evR.value != null) {
        if (!Array.isArray(evR.value) || evR.value.length > MAX_EVIDENCE) return { ok: false, reason: 'malformed_evidence' };
        for (var j = 0; j < evR.value.length; j++) {
          var eR = ownData(evR.value, String(j));
          var e = eR.ok ? safeStr(eR.value, MAX_STR) : null;
          if (!isNonEmptyStr(e)) return { ok: false, reason: 'malformed_evidence_item' };
          evidence.push(e);
        }
      }
      if (available) availableSum += countR.value;
      categories.push({ key: key, label: label, count: countR.value, available: available, asOf: cAsOf, evidence: evidence });
    }
    if (total !== availableSum) return { ok: false, reason: 'inconsistent_total' };

    var unavR = ownData(att, 'unavailableSources'); var unavailableSources = [];
    if (unavR.ok && unavR.value != null) {
      if (!Array.isArray(unavR.value) || unavR.value.length > MAX_CATEGORIES) return { ok: false, reason: 'malformed_unavailableSources' };
      for (var k = 0; k < unavR.value.length; k++) {
        var uR = ownData(unavR.value, String(k));
        var u = uR.ok ? safeStr(uR.value, 120) : null;
        if (!isNonEmptyStr(u)) return { ok: false, reason: 'malformed_unavailable_item' };
        unavailableSources.push(u);
      }
    }

    // Server-issued pending review intent. The controller holds ONLY the opaque
    // intentId; the canonical reina.ui-intent.v1 + destination live server-side
    // and are registered with the governed router by the host. Absence is valid
    // (no reviewable destination); a PRESENT-but-malformed review is hostile.
    var pendingIntentId = null;
    var revR = ownData(boot, 'review');
    if (revR.ok && revR.value != null) {
      if (!isPlainObject(revR.value)) return { ok: false, reason: 'malformed_review' };
      var idR = ownData(revR.value, 'intentId');
      if (!idR.ok) return { ok: false, reason: 'malformed_review' };
      var id = safeStr(idR.value, MAX_INTENT_ID);
      if (!isNonEmptyStr(id)) return { ok: false, reason: 'malformed_review_intent_id' };
      var rAvailR = ownData(revR.value, 'available');
      if (rAvailR.ok && typeof rAvailR.value !== 'boolean') return { ok: false, reason: 'malformed_review_available' };
      var expR = ownData(revR.value, 'expiresAt');
      if (expR.ok && expR.value != null && !isoValid(expR.value)) return { ok: false, reason: 'invalid_review_expiry' };
      pendingIntentId = (rAvailR.ok && rAvailR.value === false) ? null : id;
    }

    return { ok: true, data: { displayName: displayName, total: total, asOf: attAsOf, categories: categories, unavailableSources: unavailableSources, pendingIntentId: pendingIntentId } };
  }

  function greetingWord(timeOfDay) {
    var bucket = null;
    try { bucket = isFn(timeOfDay) ? timeOfDay() : timeOfDay; } catch (e) { bucket = null; }
    if (bucket === 'morning') return 'Good morning';
    if (bucket === 'afternoon') return 'Good afternoon';
    if (bucket === 'evening') return 'Good evening';
    return 'Hello';
  }

  function createLoginBrief(deps) {
    deps = deps || {};
    if (!isFn(deps.fetchBootstrap)) throw new Error('createLoginBrief: an injected fetchBootstrap(session) seam is required');
    if (!isFn(deps.confirmIntent)) throw new Error('createLoginBrief: a narrow injected confirmIntent(intentId) seam is required');
    var fetchBootstrap = deps.fetchBootstrap;
    var confirmIntent = deps.confirmIntent;                 // host seam -> governed router confirm-by-id
    var onView = isFn(deps.onView) ? deps.onView : noop;
    var timeOfDay = deps.timeOfDay;

    var state = 'idle';       // idle|loading|greeted|review_requested|review_failed|declined|unavailable|expired
    var generation = 0;
    var sessionId = null;
    var greetedSessions = Object.create(null);
    var brief = null;
    var writtenText = '';
    var pendingIntentId = null; // the EXACT server-issued id (opaque); never client-derived
    var voiceEnabled = false;
    var confirmed = false;
    var consumedVoiceEvents = Object.create(null); // final-transcript replay guard

    // Reset Voice-enabled state + consumed transcript tokens. Called on a new/
    // replaced session and on auth expiry so a different session must re-enable
    // Voice explicitly and cannot reuse a prior session's transcript tokens.
    function resetVoice() { voiceEnabled = false; consumedVoiceEvents = Object.create(null); }

    function composeWritten(b) {
      var greet = greetingWord(timeOfDay) + ', ' + b.displayName + '.';
      var summary = b.total === 0
        ? 'No attention items were found in the connected sources.'
        : 'You have ' + b.total + (b.total === 1 ? ' item' : ' items') + ' needing your attention.';
      var lines = [];
      for (var i = 0; i < b.categories.length; i++) {
        var c = b.categories[i];
        if (c.available) lines.push(c.label + ': ' + c.count + (c.count === 1 ? ' item' : ' items') + (c.asOf ? (' (as of ' + c.asOf + ')') : ''));
      }
      var unavailable = [];
      for (var j = 0; j < b.categories.length; j++) {
        if (!b.categories[j].available) unavailable.push('The ' + b.categories[j].label + ' source is unavailable right now; its items are not included.');
      }
      for (var k = 0; k < b.unavailableSources.length; k++) unavailable.push(b.unavailableSources[k] + ' is unavailable right now; its items are not included.');
      var question = 'Would you like to review them?';
      var parts = [greet, summary].concat(lines).concat(unavailable).concat([question]);
      return { greet: greet, summary: summary, lines: lines, unavailable: unavailable, question: question, text: parts.join(' ') };
    }

    function viewModel(b, composed, extra) {
      var vm = {
        state: state,
        previewNotice: PREVIEW_NOTICE,
        executionNotice: EXECUTION_STATEMENT,
        greeting: composed ? composed.greet : '',
        attentionSummary: composed ? composed.summary : '',
        // DISPLAY-ONLY categories: labels/counts/evidence only. They carry no
        // destination, params, capability, role, company, or authorization.
        categories: b ? b.categories.filter(function (c) { return c.available; }).map(function (c) { return { label: inert(c.label), count: c.count, asOf: c.asOf, evidence: c.evidence.map(inert) }; }) : [],
        unavailableDisclosures: composed ? composed.unavailable.map(inert) : [],
        total: b ? b.total : null,
        // The greeting question is the ONE confirmation prompt (shown while
        // 'greeted'; never re-shown as a second prompt after a decision).
        question: (composed && state === 'greeted') ? composed.question : '',
        speechSafe: (voiceEnabled && composed) ? composed.text : null,
      };
      return Object.assign(vm, extra || {});
    }

    function emit(vm) { onView(vm); }

    // Confirm the EXACT pending server-issued intentId through the host seam,
    // tolerating a sync value, a promise, a throw, a rejection, or a malformed
    // return — all resolved to a normalized { ok, reason }.
    function callConfirm(intentId) {
      var r;
      try { r = confirmIntent(intentId); } catch (e) { return Promise.resolve({ ok: false, reason: 'confirm_threw' }); }
      return Promise.resolve(r).then(function (v) {
        if (v === true) return { ok: true };
        if (isPlainObject(v) && v.ok === true) return { ok: true };
        if (isPlainObject(v) && v.ok === false) return { ok: false, reason: safeStr(v.reason, 80) || 'navigation_failed' };
        return { ok: false, reason: 'malformed_confirm_result' };
      }, function () { return { ok: false, reason: 'confirm_rejected' }; });
    }

    return {
      onAuthenticated: function (session) {
        // Read sessionId EXACTLY ONCE into a bounded primitive; never reread the
        // hostile session object again.
        var sid = readSessionId(session);
        if (!isNonEmptyStr(sid)) return { accepted: false, reason: 'invalid_session' };
        if (greetedSessions[sid]) return { accepted: false, reason: 'already_greeted' };
        sessionId = sid; confirmed = false; brief = null; writtenText = ''; pendingIntentId = null;
        resetVoice(); // new/replaced session: Voice off + fresh transcript tokens
        var myGen = ++generation;
        state = 'loading'; emit(viewModel(null, null, { loading: true }));
        var p;
        try { p = fetchBootstrap({ sessionId: sid }); } catch (e) { p = Promise.reject(e); }
        Promise.resolve(p).then(function (boot) {
          if (myGen !== generation) return;
          var v = validateBootstrap(boot, sid);
          if (!v.ok) { state = 'unavailable'; return emit(viewModel(null, null, { reason: v.reason })); }
          brief = v.data;
          pendingIntentId = v.data.pendingIntentId; // server-issued opaque id (or null)
          var composed = composeWritten(brief);
          writtenText = composed.text;
          greetedSessions[sid] = true;
          state = 'greeted';
          // `generation` is echoed so the host can stamp trusted voice-transcript
          // events that this controller correlates back to the current greeting.
          emit(viewModel(brief, composed, { sessionId: sid, generation: myGen, reviewAvailable: isNonEmptyStr(pendingIntentId) }));
        }).catch(function () {
          if (myGen !== generation) return;
          state = 'unavailable'; emit(viewModel(null, null, { reason: 'bootstrap_failed' }));
        });
        return { accepted: true, sessionId: sid };
      },

      // The SINGLE confirmation: button "yes" and verbal "yes" both call this. It
      // confirms EXACTLY the server-issued pending intentId (nothing else) via the
      // host seam, at most once. It never builds an intent and never navigates.
      confirmReview: function (source) {
        if (state !== 'greeted') return Promise.resolve({ accepted: false, reason: 'not_greeting' });
        if (confirmed) return Promise.resolve({ accepted: false, reason: 'already_confirmed' });
        confirmed = true; // synchronous latch: duplicate button/verbal is suppressed
        if (!isNonEmptyStr(pendingIntentId)) { state = 'review_failed'; emit(viewModel(brief, composeWritten(brief), { reviewFailed: true, reason: 'no_pending_intent' })); return Promise.resolve({ accepted: false, reason: 'no_pending_intent' }); }
        var mySid = sessionId; var myGen = generation; var intentId = pendingIntentId;
        return callConfirm(intentId).then(function (res) {
          // A session change / auth expiry / replacement during the await means the
          // pending intent is stale; never claim success.
          if (myGen !== generation || mySid !== sessionId) return { accepted: false, reason: 'stale_intent' };
          if (!res.ok) { state = 'review_failed'; emit(viewModel(brief, composeWritten(brief), { reviewFailed: true, reason: res.reason })); return { accepted: false, reason: res.reason }; }
          state = 'review_requested';
          emit(viewModel(brief, composeWritten(brief), { reviewRequested: true, source: (source === 'voice' ? 'voice' : 'button') }));
          return { accepted: true, intentId: intentId };
        });
      },

      // Trusted VOICE confirmation. A verbal "yes" may confirm ONLY through a
      // trusted, unique, FINAL-transcript event supplied by the host, while Voice
      // is enabled, whose generation matches the current greeting, and which has
      // not already been consumed. Anything else performs nothing.
      submitVoiceConfirmation: function (event) {
        if (state !== 'greeted') return { accepted: false, reason: 'not_greeting' };
        if (!voiceEnabled) return { accepted: false, reason: 'voice_disabled' };
        if (!isPlainObject(event)) return { accepted: false, reason: 'untrusted_event' };
        var srcR = ownData(event, 'source');
        if (!srcR.ok || srcR.value !== TRUSTED_VOICE_SOURCE) return { accepted: false, reason: 'untrusted_source' };
        var finalR = ownData(event, 'final');
        if (!finalR.ok || finalR.value !== true) return { accepted: false, reason: 'not_final' };
        var genR = ownData(event, 'generation');
        if (!genR.ok || genR.value !== generation) return { accepted: false, reason: 'stale_generation' };
        var idR = ownData(event, 'eventId');
        var eid = idR.ok ? normalizeEventId(idR.value) : null;
        if (!eid) return { accepted: false, reason: 'invalid_event_id' };
        if (consumedVoiceEvents[eid]) return { accepted: false, reason: 'duplicate_transcript' };
        consumedVoiceEvents[eid] = true; // consume once: a duplicate final transcript cannot re-fire
        var textR = ownData(event, 'text');
        var t = textR.ok && isStr(textR.value) ? textR.value.trim().toLowerCase() : '';
        if (/^(yes|yep|yeah|sure|please do|ok|okay|go ahead)\b/.test(t)) return this.confirmReview('voice');
        if (/^(no|nope|not now|cancel|dismiss|later)\b/.test(t)) return this.decline('voice');
        return { accepted: false, reason: 'unrelated' };
      },

      // A PLAIN verbal string is NOT a trusted confirmation: "no" declines, but a
      // plain "yes" performs nothing (a trusted final-transcript event via
      // submitVoiceConfirmation is required).
      respond: function (text, source) {
        if (state !== 'greeted') return { accepted: false, reason: 'not_greeting' };
        var t = isStr(text) ? text.trim().toLowerCase() : '';
        if (/^(no|nope|not now|cancel|dismiss|later)\b/.test(t)) return this.decline(source || 'voice');
        if (/^(yes|yep|yeah|sure|please do|ok|okay|go ahead)\b/.test(t)) return { accepted: false, reason: 'voice_requires_trusted_event' };
        return { accepted: false, reason: 'unrelated' };
      },

      decline: function () {
        if (state !== 'greeted') return { accepted: false, reason: 'not_greeting' };
        confirmed = true; state = 'declined';
        emit(viewModel(brief, composeWritten(brief), { declined: true }));
        return { accepted: true };
      },

      onVoiceEnabled: function () {
        voiceEnabled = true;
        // Re-emit the complete greeting contract. The panel host validates these
        // correlation and review fields on every greeted view, including the
        // Voice-enabled refresh.
        if (state === 'greeted' && brief) emit(viewModel(brief, composeWritten(brief), {
          voiceEnabled: true,
          sessionId: sessionId,
          generation: generation,
          reviewAvailable: isNonEmptyStr(pendingIntentId),
        }));
        return { voiceEnabled: true };
      },

      onAuthExpired: function () {
        generation++; state = 'expired'; brief = null; writtenText = ''; confirmed = false; sessionId = null; pendingIntentId = null;
        resetVoice(); // clear Voice-enabled + consumed transcript tokens
        emit(viewModel(null, null, { expired: true }));
      },

      getState: function () { return state; },
      getSessionId: function () { return sessionId; },
      getGeneration: function () { return generation; },
      getPendingIntentId: function () { return pendingIntentId; },
      getSpeechSafe: function () { return voiceEnabled ? writtenText : null; },
      getWrittenText: function () { return writtenText; },
    };
  }

  return {
    createLoginBrief: createLoginBrief,
    validateBootstrap: validateBootstrap,
    EXECUTION_STATEMENT: EXECUTION_STATEMENT,
    PREVIEW_NOTICE: PREVIEW_NOTICE,
    TRUSTED_VOICE_SOURCE: TRUSTED_VOICE_SOURCE,
  };
});
