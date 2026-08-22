/* public/hiveconnect/cowork-markup.js
 * Cowork markup layer for HiveVideo — ADDITIVE, full kit. When a screen is
 * shared: a pulsing/glowing border round the WHOLE screen + a transparent
 * annotation layer over the ENTIRE viewport (not the call dock). Everyone can
 * point/draw anywhere; click-through in cursor mode so the presenter keeps
 * driving. Moveable + resizable tool panel with tabs: Draw / Files / Fun.
 *
 * Features: 18 draw tools, colors/fill/dash/weight/opacity, undo/redo/duplicate/
 * delete/front/back/clear/export, emoji stamps + reactions + celebration effects
 * + soundboard, file drop, control-handoff (request→grant "driver"), camera blur.
 * Syncs over the SAME LiveKit data channel HiveVideo uses ({t:'cw:*'}).
 *
 * Note on "control": this hands off the annotation-driver role + permission and
 * replays the driver's clicks/keys as synthetic input in this tab (Tier 1). If
 * the presenter pairs the local Cowork Agent, the same actions are forwarded to
 * it over loopback and injected as real OS input for whole-desktop control
 * (Tier 2). Both are gated by the request→grant→revoke handoff.
 */
(function () {
  'use strict';
  var D = window.CoworkDraw, DZ = window.CoworkDropZone;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function color(id) { var h = 0, s = String(id); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return 'hsl(' + h + ' 42% 46%)'; }
  function svg(d) { return '<svg viewBox="0 0 24 24">' + d + '</svg>'; }
  function W() { return window.innerWidth; } function H() { return window.innerHeight; }
  var IC = {
    cursor: '<path d="M4 3v18l4-5h6z"/>', pointer: '<circle cx="12" cy="12" r="2.6"/><circle cx="12" cy="12" r="7"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>', select: '<path d="M5 3l6 15 2-6 6-2z"/>',
    pen: '<path d="M4 20l3.5-1 10-10-2.5-2.5-10 10z"/><path d="M14 7l3 3"/>', marker: '<path d="M4 20l3-1 9-9-2-2-9 9z"/><path d="M14 7l2 2"/><path d="M4 20h5"/>',
    line: '<path d="M5 19L19 5"/>', arrow: '<path d="M5 19L19 5M19 5h-6M19 5v6"/>', darrow: '<path d="M5 19L19 5M5 19h6M5 19v-6M19 5h-6M19 5v6"/>',
    rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>', rrect: '<rect x="4" y="6" width="16" height="12" rx="4"/>', ellipse: '<ellipse cx="12" cy="12" rx="9" ry="6.5"/>', diamond: '<path d="M12 3l9 9-9 9-9-9z"/>', triangle: '<path d="M12 4l8 15H4z"/>', star: '<path d="M12 3l2.4 5.9 6.3.5-4.8 4.1 1.5 6.1L12 16.8 6.6 19.7l1.5-6.1L3.3 9.4l6.3-.5z"/>',
    text: '<path d="M5 6V5h14v1M12 5v14M9 19h6"/>', sticky: '<path d="M5 4h14v10l-5 5H5z"/><path d="M14 19v-5h5"/>', callout: '<path d="M4 5h16v10H9l-3 3v-3H4z"/>', stamp: '<circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8.5 14a4.5 4.5 0 007 0"/>',
    undo: '<path d="M9 8L5 12l4 4M5 12h9a5 5 0 010 10"/>', redo: '<path d="M15 8l4 4-4 4M19 12h-9a5 5 0 000 10"/>', dup: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4V4h11v1"/>', del: '<path d="M5 7h14M9 7V5h6v2M6 7l1 13h10l1-13"/>', front: '<rect x="8" y="8" width="12" height="12" rx="1"/><path d="M4 4h12v2M4 4v12h2"/>', back: '<rect x="4" y="4" width="12" height="12" rx="1"/><path d="M20 20H8v-2M20 20V8h-2"/>', clear: '<path d="M4 4l16 16M20 4L4 20"/>', exportpng: '<path d="M12 3v12M8 11l4 4 4-4M5 20h14"/>',
    blur: '<circle cx="12" cy="12" r="9"/><path d="M8 12h.01M12 12h.01M16 12h.01M12 8h.01M12 16h.01"/>', control: '<path d="M12 3l2 4 4 .5-3 3 .8 4-3.8-2-3.8 2 .8-4-3-3 4-.5z"/>', desktop: '<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8M12 16v4"/>', annot: '<path d="M4 20l4-1L20 7l-3-3L5 16z"/><path d="M14 6l3 3"/>', min: '<path d="M5 12h14"/>', drag: '<circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/>'
  };

  var room = null, meName = 'You', meId = 'me', tool = 'cursor', style = { color: (D && D.PALETTE[0]) || '#c65b4e', width: 3, fill: null, dash: 'solid', opacity: 1 };
  var board = null, files = null, drawing = null, seq = 0, lastSel = null, cursors = {}, lastCur = 0;
  var root = null, cv = null, ctx = null, fx = null, curLayer = null, border = null, panel = null, dataHandler = null, blurOn = false, driver = null, driving = false, keyHandler = null, pasteHandler = null, wheelHandler = null, clipRx = {};
  // Annotation permission — SEPARATE from control. Viewers can't draw/point until
  // the screen-sharer grants it; the sharer always may (amSharing). mayAnnotate is
  // my own grant as a viewer; annotGranted tracks who I (as sharer) have allowed.
  var mayAnnotate = false, annotReqPending = false, shareWasOn = false, annotGranted = {}, pendingAnnot = {};
  var RE = null, Track = null, dockRz = null, actx = null;
  // Optional loopback link to the local Cowork Agent. When the presenter pairs
  // it, relayed driver actions are forwarded to 127.0.0.1 as JSON instead of
  // being replayed inside this tab, extending control to the whole desktop.
  // Dormant (armed=false) unless paired; nothing here runs without the agent.
  var NB = { ws: null, ready: false, armed: false, autoTried: false };

  function attach(lkRoom, opts) {
    try {
      if (!D) return; detach(); room = lkRoom; opts = opts || {};
      RE = window.LivekitClient && window.LivekitClient.RoomEvent; Track = window.LivekitClient && window.LivekitClient.Track;
      meId = (room.localParticipant && room.localParticipant.identity) || 'me';
      meName = opts.name || (room.localParticipant && room.localParticipant.name) || meId;
      board = D.createBoard(); files = DZ ? DZ.createDropSession() : null; injectStyles();
      root = document.createElement('div'); root.className = 'cwm-root';
      root.innerHTML = '<div class="cwm-border"></div><canvas class="cwm-cv"></canvas><div class="cwm-fx"></div><div class="cwm-cursors"></div>';
      document.body.appendChild(root);
      cv = root.querySelector('.cwm-cv'); ctx = cv.getContext('2d'); fx = root.querySelector('.cwm-fx'); curLayer = root.querySelector('.cwm-cursors'); border = root.querySelector('.cwm-border');
      buildPanel();
      fit(); window.addEventListener('resize', fit);
      cv.addEventListener('pointerdown', onDown); cv.addEventListener('pointermove', onMove); cv.addEventListener('pointerup', onUp);
      dataHandler = function (payload, participant) { try { var env = JSON.parse(new TextDecoder().decode(payload)); if (env && String(env.t).indexOf('cw:') === 0) route(env, participant); } catch (e) {} };
      if (RE) room.on(RE.DataReceived, dataHandler);
      applyToolMode();
      root.style.display = 'none'; panel.style.display = 'none';
      shareEvents(true); addDockResize(); updateShare();
    } catch (e) { try { console.warn('[cowork-markup] attach failed', e); } catch (_) {} }
  }
  function detach() {
    try {
      if (room && dataHandler && RE) { try { room.off(RE.DataReceived, dataHandler); } catch (e) {} }
      window.removeEventListener('resize', fit); try { shareEvents(false); } catch (e) {} removeDockResize(); try { nbDisconnect(); } catch (e) {}
      if (root) root.remove(); if (panel) panel.remove();
      root = cv = ctx = fx = curLayer = border = panel = dataHandler = null; cursors = {}; board = files = null; room = null; driver = null;
      mayAnnotate = false; annotReqPending = false; shareWasOn = false; annotGranted = {}; pendingAnnot = {};
    } catch (e) {}
  }
  function pub(t, payload) { try { if (room && room.localParticipant && room.localParticipant.publishData) room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ t: t, uid: meId, name: meName, payload: payload })), { reliable: true }); } catch (e) {} }
  function route(env, participant) {
    var uid = env.uid || (participant && participant.identity) || 'peer', t = env.t, p = env.payload;
    if (t === 'cw:draw') { board.applyRemote({ t: 'draw:add', payload: denormShape(p) }); repaint(); }
    else if (t === 'cw:undo') { board.removeById(p && p.id); repaint(); }
    else if (t === 'cw:update') { board.applyRemote({ t: 'draw:update', payload: denormShape(p) }); repaint(); }
    else if (t === 'cw:clear') { board.applyRemote({ t: 'draw:clear' }); repaint(); }
    else if (t === 'cw:cursor') moveCursor(uid, p, env.name);
    else if (t === 'cw:ping') showPing(p, uid, env.name);
    else if (t === 'cw:react') floatReaction(p && p.emoji, p && p.x);
    else if (t === 'cw:rain') rain(p && p.kind);
    else if (t === 'cw:sound') playSound(p && p.name);
    else if (t === 'cw:file') { if (files && files.applyRemote({ t: 'drop:add', payload: p })) renderFiles(); }
    else if (t === 'cw:control') onControl(env);
    else if (t === 'cw:clip') onClip(env);
    else if (t === 'cw:annot') onAnnot(env);
  }
  /* ---- annotation permission (separate gate from control) ---- */
  function canAnnotate() { return amSharing() || mayAnnotate; }
  function requestAnnotate() {
    if (annotReqPending) { toast('Still waiting — the presenter hasn’t responded yet.'); return; }
    annotReqPending = true; setAnnotBtn(); pub('cw:annot', { kind: 'request' });
    toast('Requested permission to annotate — waiting for the presenter…');
    // Self-heal: if no grant arrives, clear the pending latch so the viewer can ask again.
    setTimeout(function () { if (annotReqPending && !mayAnnotate) { annotReqPending = false; setAnnotBtn(); toast('No response yet — click “Ask to annotate” to try again.'); } }, 18000);
  }
  function grantAnnot(uid, name) { annotGranted[uid] = name || 'guest'; delete pendingAnnot[uid]; setAnnotBtn(); pub('cw:annot', { kind: 'grant', to: uid, name: name }); }
  function onAnnot(env) {
    var p = env.payload || {};
    if (p.kind === 'request' && env.uid !== meId) {
      if (!amSharing()) return; // only the screen sharer grants annotation on their screen
      // Queue the request persistently (the annot button badges it) so a missed
      // toast doesn't strand the requester; also raise a longer-lived toast.
      pendingAnnot[env.uid] = env.name || 'guest'; setAnnotBtn();
      toastAction(esc(env.name || 'Someone') + ' wants to annotate your screen', 'Allow', function () { grantAnnot(env.uid, env.name); }, 30000);
    } else if (p.kind === 'grant' && p.to === meId) { annotReqPending = false; mayAnnotate = true; if (cv) applyToolMode(); setAnnotBtn(); toast('You can now annotate the shared screen.'); }
    else if (p.kind === 'revoke' && p.to === meId) { mayAnnotate = false; annotReqPending = false; if (cv) applyToolMode(); setAnnotBtn(); toast('Your annotation permission was turned off.'); }
  }
  function annotBtnClick() {
    if (amSharing()) {
      var ids = Object.keys(pendingAnnot);
      if (ids.length) { ids.forEach(function (u) { grantAnnot(u, pendingAnnot[u]); }); toast('Allowed ' + ids.length + (ids.length > 1 ? ' people' : ' person') + ' to annotate.'); return; }
      toast('You own the shared screen — you can annotate freely. Viewers must ask.'); return;
    }
    if (mayAnnotate) { toast('You already have permission to annotate.'); return; }
    requestAnnotate();
  }
  function setAnnotBtn() { var b = panel && panel.querySelector('[data-a="annot"]'); if (!b) return; var pend = amSharing() ? Object.keys(pendingAnnot).length : 0; b.classList.toggle('on', canAnnotate()); b.classList.toggle('cwm-pending', pend > 0); b.setAttribute('title', pend > 0 ? (pend + ' waiting to annotate — click to allow') : (canAnnotate() ? 'You can annotate' : 'Ask to annotate')); }

  /* ---- canvas (full viewport) ---- */
  function fit() { if (!cv) return; cv.width = W(); cv.height = H(); repaint(); }
  function repaint() { if (!ctx) return; ctx.clearRect(0, 0, cv.width, cv.height); D.render(ctx, board.list()); if (lastSel) outline(lastSel); }
  function outline(s) { var b = D.bbox(s); ctx.save(); ctx.strokeStyle = '#2f6bff'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.strokeRect(b.x - 5, b.y - 5, b.w + 10, b.h + 10); ctx.restore(); }
  function paintLive() { repaint(); if (drawing) D.renderShape(ctx, drawing); }
  function applyToolMode() { if (!cv) return; var may = canAnnotate(); cv.style.pointerEvents = driving ? 'auto' : ((tool === 'cursor' || !may) ? 'none' : 'auto'); cv.style.cursor = (tool === 'pointer' || driving) ? 'crosshair' : 'default'; if (border) border.classList.toggle('armed', driving || (may && tool !== 'cursor')); }
  function pt(e) { return { x: e.clientX, y: e.clientY }; }
  // Every annotation coordinate travels normalized to the SHARED-CONTENT rect so
  // marks line up across participants: the presenter's rect is their whole
  // viewport (they share their screen); a viewer's rect is the shared video's
  // letterboxed box. The local board stays in pixels — we normalize on send and
  // denormalize on receive/render.
  function contentRect() { if (amSharing()) return { x: 0, y: 0, w: W(), h: H() }; var vr = shareVideoRect(); return vr ? { x: vr.x, y: vr.y, w: vr.w, h: vr.h } : { x: 0, y: 0, w: W(), h: H() }; }
  function norm(p) { var c = contentRect(); return { x: (p.x - c.x) / (c.w || 1), y: (p.y - c.y) / (c.h || 1) }; }
  function denorm(n) { var c = contentRect(); return { x: c.x + (n.x || 0) * c.w, y: c.y + (n.y || 0) * c.h }; }
  function normShape(s) { var c = JSON.parse(JSON.stringify(s)); c.points = (c.points || []).map(function (q) { return norm(q); }); return c; }
  function denormShape(s) { var c = JSON.parse(JSON.stringify(s)); c.points = (c.points || []).map(function (q) { return denorm(q); }); return c; }
  function mk(t) { return D.makeShape(meId, ++seq, t, { color: style.color, width: style.width, fill: style.fill, dash: style.dash, opacity: style.opacity }); }
  function onDown(e) {
    var p = pt(e);
    if (driving) {
      // Map the click to the shared-VIDEO content (not the whole viewport), so it
      // lands where you actually clicked on the presenter's shared screen.
      var vr = shareVideoRect();
      if (vr && p.x >= vr.x && p.x <= vr.x + vr.w && p.y >= vr.y && p.y <= vr.y + vr.h) {
        var nx = (p.x - vr.x) / vr.w, ny = (p.y - vr.y) / vr.h;
        pub('cw:control', { kind: 'input', sub: 'click', x: nx, y: ny });
        pub('cw:ping', { x: nx, y: ny }); // so the presenter sees where the driver is acting
        showPing({ x: nx, y: ny }, meId, meName);
      } else if (!vr) { toast('Waiting for the shared screen to appear before you can drive…'); }
      return;
    }
    if (tool === 'pan') return;
    if (tool === 'select') { lastSel = board.hitTest(p.x, p.y); repaint(); return; }
    if (tool === 'pointer') { pub('cw:ping', norm(p)); showPing(norm(p), meId, meName); return; }
    if (tool === 'stamp') { var em = prompt('Emoji / sticker:', '⭐'); if (em) { var s = mk('stamp'); s.emoji = em; s.fontSize = Math.max(20, style.width * 6); s.points = [p]; board.add(s); pub('cw:draw', normShape(s)); repaint(); } return; }
    if (tool === 'text') { var txt = prompt('Text:'); if (txt) { var s2 = mk('text'); s2.text = txt; s2.fontSize = Math.max(16, style.width * 5); s2.points = [p]; board.add(s2); pub('cw:draw', normShape(s2)); repaint(); } return; }
    cv.setPointerCapture(e.pointerId); drawing = mk(tool); drawing.points = [p]; if (D.TWO_POINT[tool]) drawing.points.push(p); paintLive();
  }
  function onMove(e) {
    if (driving) { var dp = pt(e), vr = shareVideoRect(); if (vr && dp.x >= vr.x && dp.x <= vr.x + vr.w && dp.y >= vr.y && dp.y <= vr.y + vr.h) { var dn = Date.now(); if (dn - lastCur > 40) { lastCur = dn; pub('cw:control', { kind: 'input', sub: 'move', x: (dp.x - vr.x) / vr.w, y: (dp.y - vr.y) / vr.h }); } } return; }
    if (!canAnnotate()) return; var p = pt(e), now = Date.now(); if (now - lastCur > 60) { lastCur = now; pub('cw:cursor', norm(p)); } if (!drawing) return; if (D.FREEHAND[tool]) drawing.points.push(p); else drawing.points[1] = p; paintLive();
  }
  function onUp() { if (!drawing) return; var t = drawing.tool; if (t === 'sticky' || t === 'callout') { var txt = prompt(t === 'sticky' ? 'Note:' : 'Callout:'); drawing.text = txt || ''; } board.add(drawing); pub('cw:draw', normShape(drawing)); drawing = null; repaint(); }
  function doAction(a) {
    if (a !== 'exportpng' && !canAnnotate()) { requestAnnotate(); return; } // board edits need annotate permission
    if (a === 'undo') { var s = board.undoOwn(meId); if (s) pub('cw:undo', { id: s.id }); lastSel = null; repaint(); }
    else if (a === 'redo') { var r = board.redoOwn(meId); if (r) pub('cw:draw', normShape(r)); repaint(); }
    else if (a === 'clear') { try { board.clearAll({ isPresenter: true }); pub('cw:clear', {}); lastSel = null; repaint(); } catch (e) {} }
    else if (a === 'exportpng') { var l = document.createElement('a'); l.href = cv.toDataURL('image/png'); l.download = 'annotations.png'; l.click(); }
    else if (a === 'del' && lastSel) { pub('cw:undo', { id: lastSel.id }); board.removeById(lastSel.id); lastSel = null; repaint(); }
    else if (a === 'dup' && lastSel) { var c = board.duplicate(lastSel.id, meId, ++seq); if (c) { pub('cw:draw', normShape(c)); lastSel = c; repaint(); } }
    else if (a === 'front' && lastSel) { board.bringToFront(lastSel.id); pub('cw:update', normShape(board.list().filter(function (s) { return s.id === lastSel.id; })[0])); repaint(); }
    else if (a === 'back' && lastSel) { board.sendToBack(lastSel.id); pub('cw:update', normShape(board.list().filter(function (s) { return s.id === lastSel.id; })[0])); repaint(); }
  }

  /* ---- cursors / ping / reactions ---- */
  function moveCursor(uid, p, name) { if (uid === meId || !p || !curLayer) return; var q = denorm(p); var el = cursors[uid]; if (!el) { el = document.createElement('div'); el.className = 'cwm-cur'; el.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="' + color(uid) + '"><path d="M5 3l6 15 2-6 6-2z"/></svg><span style="background:' + color(uid) + '">' + esc(name || 'guest') + '</span>'; curLayer.appendChild(el); cursors[uid] = el; } el.style.left = q.x + 'px'; el.style.top = q.y + 'px'; }
  function showPing(p, uid, name) { if (!p || !fx) return; var q = denorm(p); var c = color(uid || meId); var d = document.createElement('div'); d.className = 'cwm-ping'; d.style.color = c; d.style.left = q.x + 'px'; d.style.top = q.y + 'px'; d.innerHTML = '<i></i><i style="animation-delay:.5s"></i><i style="animation-delay:1s"></i><b></b><span style="background:' + c + '">' + esc(uid === meId ? 'You' : (name || 'Someone')) + '</span>'; fx.appendChild(d); setTimeout(function () { d.remove(); }, 3000); }
  function floatReaction(e, x) { if (!e || !fx) return; var d = document.createElement('div'); d.className = 'cwm-rxf'; d.textContent = e; d.style.left = ((x == null ? 0.5 : x) * W()) + 'px'; fx.appendChild(d); setTimeout(function () { d.remove(); }, 2400); }
  function rain(kind) { if (!fx) return; var g = { confetti: ['🎉', '🎊', '🥳', '🔴', '🟡', '🟢', '🔵'], hearts: ['❤️', '💖', '💜'], fire: ['🔥', '🧨', '💥'], stars: ['✨', '⭐', '🌟'] }[kind] || ['🎉']; for (var i = 0; i < 42; i++) { (function (i) { var d = document.createElement('div'); d.className = 'cwm-drop'; d.textContent = g[i % g.length]; d.style.left = (Math.random() * 100) + 'vw'; d.style.fontSize = (16 + Math.random() * 22) + 'px'; d.style.animationDuration = (2.2 + Math.random() * 1.8) + 's'; d.style.animationDelay = (Math.random() * 0.4) + 's'; fx.appendChild(d); setTimeout(function () { d.remove(); }, 4600); })(i); } }
  function audio() { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } if (actx && actx.state === 'suspended') actx.resume(); return actx; }
  function tone(f, s, dur, ty, g) { var a = audio(); if (!a) return; var o = a.createOscillator(), gn = a.createGain(); o.type = ty || 'sine'; o.frequency.setValueAtTime(f, a.currentTime + s); gn.gain.setValueAtTime(0.0001, a.currentTime + s); gn.gain.exponentialRampToValueAtTime(g || 0.25, a.currentTime + s + 0.02); gn.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + s + dur); o.connect(gn).connect(a.destination); o.start(a.currentTime + s); o.stop(a.currentTime + s + dur + 0.05); }
  function playSound(n) { if (n === 'tada') [523, 659, 784, 1047].forEach(function (f, i) { tone(f, i * 0.09, 0.3, 'triangle', 0.22); }); else if (n === 'airhorn') { var a = audio(); if (a) { var o = a.createOscillator(), g = a.createGain(); o.type = 'sawtooth'; o.frequency.setValueAtTime(180, a.currentTime); o.frequency.linearRampToValueAtTime(300, a.currentTime + 0.5); g.gain.setValueAtTime(0.25, a.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.5); o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + 0.55); } } else if (n === 'ding') tone(1320, 0, 0.5, 'sine', 0.3); else if (n === 'drum') { for (var i = 0; i < 9; i++) tone(140 + i * 4, i * 0.06, 0.08, 'square', 0.14); tone(90, 0.6, 0.35, 'sine', 0.3); } }

  /* ---- control handoff (permission to be the driver) ---- */
  // The screen-sharer is the "presenter" who can be controlled.
  function amSharing() { if (!room || !Track || !Track.Source) return false; var lp = room.localParticipant, hit = false; var pubs = lp && (lp.trackPublications || lp.videoTrackPublications); if (pubs && pubs.forEach) pubs.forEach(function (pub) { if (pub && pub.source === Track.Source.ScreenShare && (pub.track || pub.isEnabled)) hit = true; }); else if (lp && lp.getTrackPublication) { var pub = lp.getTrackPublication(Track.Source.ScreenShare); if (pub && pub.track) hit = true; } return hit; }
  // The largest playing <video> in the dock is the shared screen; return its
  // object-fit:contain content rect so clicks map to the actual pixels.
  function shareVideoRect() {
    var best = null, area = 0;
    try { document.querySelectorAll('video').forEach(function (v) { if (!v.videoWidth) return; var r = v.getBoundingClientRect(); var a = r.width * r.height; if (a > area) { area = a; best = v; } }); } catch (e) {}
    if (!best) return null;
    var r = best.getBoundingClientRect(), vw = best.videoWidth || 16, vh = best.videoHeight || 9;
    var scale = Math.min(r.width / vw, r.height / vh), cw = vw * scale, ch = vh * scale;
    return { x: r.left + (r.width - cw) / 2, y: r.top + (r.height - ch) / 2, w: cw, h: ch };
  }
  function controlBtnClick() {
    if (driver === meId) { pub('cw:control', { kind: 'revoke' }); stopDriving(); setDriver(null); toast('You released control.'); return; } // driver can stop anytime
    if (amSharing() && driver && driver !== meId) { pub('cw:control', { kind: 'revoke' }); setDriver(null); toast('Control revoked'); return; }
    if (!amSharing()) { requestControl(); return; }
    toast('Share your screen first, then others can request control.');
  }
  function requestControl() { pub('cw:control', { kind: 'request' }); toast('Requested control — waiting for the presenter…'); }
  function onControl(env) {
    var p = env.payload || {};
    if (p.kind === 'request' && env.uid !== meId) {
      if (!amSharing()) return; // only the person sharing their screen grants control of it
      toastAction(esc(env.name || 'Someone') + ' wants to control your screen', 'Allow', function () { pub('cw:control', { kind: 'grant', to: env.uid, name: env.name }); setDriver(env.uid, env.name); if (!NB.armed) toast('Note: for full-desktop control, launch the Cowork Agent and click the monitor icon — otherwise control only reaches the HiveLogic app, not your whole screen.'); }, 30000);
    } else if (p.kind === 'grant') { setDriver(p.to, p.name); if (p.to === meId) startDriving(); }
    else if (p.kind === 'revoke') { if (driver === meId) stopDriving(); setDriver(null); }
    else if (p.kind === 'input') { if (amSharing() && env.uid === driver) applyRemoteInput(p); }
  }
  function startDriving() {
    driving = true; if (cv) applyToolMode();
    keyHandler = function (e) {
      if (e.target && e.target.closest && e.target.closest('.cwm-panel')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return; // shortcuts (incl. paste) are handled separately, not typed
      pub('cw:control', { kind: 'input', sub: 'key', key: e.key });
    };
    window.addEventListener('keydown', keyHandler, true);
    pasteHandler = function (e) { onViewerPaste(e); };
    window.addEventListener('paste', pasteHandler, true);
    wheelHandler = function (e) { var vr = shareVideoRect(); if (!vr) return; var x = e.clientX, y = e.clientY; if (x >= vr.x && x <= vr.x + vr.w && y >= vr.y && y <= vr.y + vr.h) { pub('cw:control', { kind: 'input', sub: 'scroll', x: (x - vr.x) / vr.w, y: (y - vr.y) / vr.h, dy: e.deltaY }); try { e.preventDefault(); } catch (er) {} } };
    window.addEventListener('wheel', wheelHandler, { passive: false, capture: true });
    toast('You are driving — move and click to control the presenter’s screen, scroll to scroll. Paste (Ctrl+V) to send an image or text to their computer.');
  }
  function stopDriving() {
    driving = false; if (cv) applyToolMode();
    if (keyHandler) { try { window.removeEventListener('keydown', keyHandler, true); } catch (e) {} keyHandler = null; }
    if (pasteHandler) { try { window.removeEventListener('paste', pasteHandler, true); } catch (e) {} pasteHandler = null; }
    if (wheelHandler) { try { window.removeEventListener('wheel', wheelHandler, true); } catch (e) {} wheelHandler = null; }
  }
  /* ---- clipboard push: viewer pastes an image/text INTO the presenter's PC ---- */
  // Driver side: capture a paste over the shared view and relay it (chunked for
  // images, since LiveKit data messages are small) to the presenter.
  function onViewerPaste(e) {
    try {
      if (e.target && e.target.closest && e.target.closest('.cwm-panel')) return; // local paste into our own inputs
      var dt = e.clipboardData; if (!dt) return;
      var items = dt.items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && /^image\//.test(items[i].type || '')) {
          var blob = items[i].getAsFile(); if (blob) { e.preventDefault(); sendClipImage(blob); return; }
        }
      }
      var text = dt.getData && dt.getData('text/plain');
      if (text) { e.preventDefault(); pub('cw:clip', { sub: 'text', s: text }); toast('📋 Sent text to the presenter’s clipboard'); }
    } catch (err) {}
  }
  function sendClipImage(blob) {
    if (blob.size > 12 * 1024 * 1024) { toast('Image too large to send (max 12 MB).'); return; }
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var res = String(fr.result || ''), comma = res.indexOf(',');
        var b64 = comma >= 0 ? res.slice(comma + 1) : res;
        var id = meId + '-' + (++seq) + '-' + b64.length, CH = 12000, total = Math.ceil(b64.length / CH);
        pub('cw:clip', { sub: 'begin', id: id, mime: blob.type || 'image/png', total: total });
        for (var i = 0; i < total; i++) pub('cw:clip', { sub: 'chunk', id: id, i: i, data: b64.substr(i * CH, CH) });
        pub('cw:clip', { sub: 'end', id: id });
        toast('🖼 Sent image to the presenter’s clipboard (' + Math.round(blob.size / 1024) + ' KB)');
      } catch (err) {}
    };
    fr.readAsDataURL(blob);
  }
  // Presenter side: reassemble the driver's clipboard push and hand it to the agent.
  function onClip(env) {
    if (!amSharing() || env.uid !== driver) return; // only the active driver can push clipboard
    var p = env.payload || {};
    if (p.sub === 'text') { if (NB.armed) { nbSend({ t: 'clip-text', s: p.s || '', paste: true }); toast('📋 ' + esc(env.name || 'Driver') + ' pasted text to your screen'); } else toast('Pair the desktop agent to receive pasted content.'); return; }
    if (p.sub === 'begin') { clipRx[p.id] = { mime: p.mime || 'image/png', parts: [], total: p.total || 0 }; return; }
    if (p.sub === 'chunk') { var r = clipRx[p.id]; if (r) r.parts[p.i] = p.data || ''; return; }
    if (p.sub === 'end') {
      var r2 = clipRx[p.id]; delete clipRx[p.id]; if (!r2) return;
      var b64 = r2.parts.join('');
      if (NB.armed) { nbSend({ t: 'clip-image', mime: r2.mime, b64: b64, paste: true }); toast('🖼 ' + esc(env.name || 'Driver') + ' pasted an image to your screen'); }
      else toast('Pair the desktop agent to receive pasted images.');
    }
  }
  // Tell the agent whether the presenter is sharing a whole screen or one window,
  // so injected clicks map to the right surface.
  function shareSurface() {
    try {
      if (!room || !Track || !Track.Source) return null;
      var lp = room.localParticipant, found = null;
      var pubs = lp && (lp.trackPublications || lp.videoTrackPublications);
      if (pubs && pubs.forEach) pubs.forEach(function (pub) { if (pub && pub.source === Track.Source.ScreenShare && pub.track) found = pub; });
      else if (lp && lp.getTrackPublication) found = lp.getTrackPublication(Track.Source.ScreenShare);
      if (!found || !found.track) return null;
      var mst = found.track.mediaStreamTrack; if (!mst || !mst.getSettings) return null;
      var ds = mst.getSettings().displaySurface; return (ds === 'window' || ds === 'browser') ? 'window' : 'screen'; // a shared tab maps to the foreground window
    } catch (e) { return null; }
  }
  function nbSendTarget() { var m = shareSurface(); if (m) nbSend({ t: 'target', mode: m }); }
  // Presenter side: turn a relayed control event into synthetic input on the real app.
  function applyRemoteInput(p) {
    if (NB.armed) { nbForward(p); return; } // paired agent drives the whole screen
    try {
      if (p.sub === 'click') { var el = document.elementFromPoint(p.x * W(), p.y * H()); if (!el || (el.closest && el.closest('.cwm-panel, .cwm-root, #huddle-dock'))) return; if (el.focus) el.focus(); if (el.click) el.click(); }
      else if (p.sub === 'key') { var a = document.activeElement; if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) { if (p.key === 'Backspace') a.value = (a.value || '').slice(0, -1); else if (p.key && p.key.length === 1) a.value = (a.value || '') + p.key; a.dispatchEvent(new Event('input', { bubbles: true })); } }
      else if (p.sub === 'scroll') { var t = document.elementFromPoint(p.x * W(), p.y * H()); while (t && t !== document.body && t.scrollHeight <= t.clientHeight) t = t.parentElement; if (t && t.scrollBy) t.scrollBy(0, p.dy || 0); else window.scrollBy(0, p.dy || 0); }
    } catch (e) {}
  }
  /* ---- native bridge (loopback link to the local Cowork Agent) ---- */
  // Translate a relayed driver action into an agent frame. Normalized coords
  // already span the shared surface, so for a whole-screen share they map 1:1
  // onto the desktop; the agent turns them into physical pixels.
  function nbForward(p) {
    if (p.sub === 'click') nbSend({ t: 'click', x: p.x, y: p.y, button: p.button || 'left', double: !!p.double });
    else if (p.sub === 'move') nbSend({ t: 'move', x: p.x, y: p.y });
    else if (p.sub === 'key') nbSend({ t: 'key', key: p.key });
    else if (p.sub === 'text') nbSend({ t: 'text', s: p.s });
    else if (p.sub === 'scroll') { var n = Math.round((p.dy || 0) / 120); if (!n) n = p.dy > 0 ? 1 : (p.dy < 0 ? -1 : 0); nbSend({ t: 'scroll', x: p.x == null ? 0.5 : p.x, y: p.y == null ? 0.5 : p.y, dy: Math.max(-10, Math.min(10, n)) }); }
  }
  function nbSend(o) { try { if (NB.ws && NB.ready) NB.ws.send(JSON.stringify(o)); } catch (e) {} }
  function nbConnect(code, name, onState) {
    try { if (NB.ws) { try { NB.ws.close(); } catch (e) {} } } catch (e) {}
    NB.ready = false; NB.armed = false;
    var ws; try { ws = new WebSocket('ws://127.0.0.1:8766'); } catch (e) { onState && onState('error'); return; }
    NB.ws = ws;
    ws.onopen = function () { if (onState) onState('open'); try { ws.send(JSON.stringify({ t: 'hello', name: name || meName })); } catch (e) {} };
    ws.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.t === 'ready') { NB.ready = true; NB.armed = true; try { nbSendTarget(); } catch (e) {} onState && onState('ready'); } else if (m.t === 'denied') { NB.armed = false; onState && onState('denied', m.reason); try { ws.close(); } catch (e) {} } };
    ws.onclose = function () { NB.ready = false; NB.armed = false; NB.ws = null; onState && onState('closed'); };
    ws.onerror = function () { onState && onState('error'); };
  }
  function nbDisconnect() { try { if (NB.ws) { try { NB.ws.send(JSON.stringify({ t: 'stop' })); } catch (e) {} NB.ws.close(); } } catch (e) {} NB.ws = null; NB.ready = false; NB.armed = false; }
  function setDesktopBtn(on) { var b = panel && panel.querySelector('[data-a="desktop"]'); if (b) b.classList.toggle('on', !!on); }
  function desktopBtnClick() {
    if (NB.armed) { nbDisconnect(); setDesktopBtn(false); toast('Full desktop control disabled — back to in-app control.'); return; }
    if (!amSharing()) { toast('Share your screen first, then enable desktop control.'); return; }
    toast('Connecting to the desktop agent — approve the Allow prompt on your screen…');
    nbConnect(null, meName, function (state, reason) {
      if (state === 'ready') { setDesktopBtn(true); toast('Full desktop control ON — the driver now controls your whole screen.'); }
      else if (state === 'denied') { setDesktopBtn(false); toast(reason === 'busy' ? 'The desktop agent is already in another session.' : 'The desktop-control prompt was declined.'); }
      else if (state === 'error') { setDesktopBtn(false); toast('Cowork Agent not found on this computer — launch it, then try again.'); }
      else if (state === 'closed') { setDesktopBtn(false); }
    });
  }
  // Auto-connect the local agent the moment you start sharing, so desktop control
  // is just "share -> click Yes". Stays silent if no agent is running (only reacts
  // once the socket actually opens), so presenters without the agent aren't nagged.
  function autoPairAgent() {
    nbConnect(null, meName, function (state, reason) {
      if (state === 'open') { toast('Enabling desktop control — click “Yes” on the Allow popup to let a driver control your whole screen…'); }
      else if (state === 'ready') { setDesktopBtn(true); toast('Full desktop control is ON.'); }
      else if (state === 'denied') { setDesktopBtn(false); if (reason !== 'busy') toast('Desktop control left off — you can turn it on later with the monitor icon.'); }
      // error/closed = no agent running: stay silent.
    });
  }
  function setDriver(uid, name) { driver = uid; var b = panel && panel.querySelector('[data-a="control"]'); if (b) { b.classList.toggle('on', !!uid); b.setAttribute('title', uid === meId ? 'Stop controlling' : (uid ? 'Revoke control' : 'Request control')); } var d = panel && panel.querySelector('.cwm-driver'); if (d) d.textContent = uid ? ('🖱 ' + (uid === meId ? 'You are driving — click the ✦ to stop' : esc(name || 'peer') + ' is driving')) : ''; }
  function toast(msg) { var t = document.createElement('div'); t.className = 'cwm-toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3200); }
  function toastAction(msg, label, fn, ms) { var t = document.createElement('div'); t.className = 'cwm-toast'; t.innerHTML = '<span>' + msg + '</span>'; var b = document.createElement('button'); b.textContent = label; b.onclick = function () { fn(); t.remove(); }; t.appendChild(b); document.body.appendChild(t); setTimeout(function () { t.remove(); }, ms || 8000); }

  /* ---- files ---- */
  function renderFiles() { var el = panel && panel.querySelector('#cwm-filelist'); if (!el || !files) return; el.innerHTML = files.list().map(function (e) { return '<div class="cwm-file"><b>' + esc(e.name) + '</b><small>' + DZ.humanSize(e.size) + ' · ' + esc(e.uploader) + '</small></div>'; }).join('') || '<div class="cwm-dim">No files yet.</div>'; }
  async function handleFiles(list) { if (!files) return; for (var i = 0; i < list.length; i++) { var f = list[i]; var res = await files.addFile({ name: f.name, size: f.size, blob: f }, meName, 0); if (res.ok) { pub('cw:file', res.entry); renderFiles(); } else { var m = panel && panel.querySelector('#cwm-dropmsg'); if (m) m.textContent = f.name + ': ' + res.reason; } } }

  /* ---- moveable + resizable panel (tabs: Draw / Files / Fun) ---- */
  function buildPanel() {
    var tools = [['cursor', 'Off — drive'], ['select', 'Select'], ['pointer', 'Pointer (ping)'], ['pen', 'Pen'], ['marker', 'Highlighter'], ['line', 'Line'], ['arrow', 'Arrow'], ['darrow', 'Double arrow'], ['rect', 'Rectangle'], ['rrect', 'Rounded'], ['ellipse', 'Ellipse'], ['diamond', 'Diamond'], ['triangle', 'Triangle'], ['star', 'Star'], ['text', 'Text'], ['sticky', 'Sticky'], ['callout', 'Callout'], ['stamp', 'Sticker']];
    var toolTitles = {}; tools.forEach(function (t) { toolTitles[t[0]] = t[1]; });
    // grouped + labeled so the toolset is scannable, not one dense icon wall
    var toolGroups = [['Draw', ['cursor', 'select', 'pointer', 'pen', 'marker', 'line', 'arrow', 'darrow']], ['Shapes', ['rect', 'rrect', 'ellipse', 'diamond', 'triangle', 'star']], ['Text & media', ['text', 'sticky', 'callout', 'stamp']]];
    var toolHtml = toolGroups.map(function (g) { var btns = g[1].map(function (k) { return '<button class="cwm-tool' + (k === tool ? ' on' : '') + '" data-t="' + k + '" title="' + (toolTitles[k] || k) + '">' + svg(IC[k]) + '</button>'; }).join(''); return '<div class="cwm-tg"><div class="cwm-lab">' + g[0] + '</div><div class="cwm-tools">' + btns + '</div></div>'; }).join('');
    var sw = D.PALETTE.map(function (c, i) { return '<span class="cwm-sw' + (i === 0 ? ' on' : '') + '" data-c="' + c + '" style="background:' + c + '"></span>'; }).join('');
    var acts = [['undo', 'Undo'], ['redo', 'Redo'], ['dup', 'Duplicate'], ['del', 'Delete'], ['front', 'Front'], ['back', 'Back'], ['clear', 'Clear'], ['exportpng', 'Export']];
    var actHtml = acts.map(function (a) { return '<button class="cwm-ib" data-a="' + a[0] + '" title="' + a[1] + '">' + svg(IC[a[0]]) + '</button>'; }).join('');
    var rx = ['👍', '🎉', '❤️', '🔥', '✅', '👀', '🙌', '💯'].map(function (e) { return '<span class="cwm-rx" data-e="' + e + '">' + e + '</span>'; }).join('');
    panel = document.createElement('div'); panel.className = 'cwm-panel'; panel.style.left = (W() - 300) + 'px'; panel.style.top = '96px'; panel.style.width = '280px';
    panel.innerHTML =
      '<div class="cwm-head"><span class="cwm-grip">' + svg(IC.drag) + '</span><span class="cwm-title">Cowork</span><span class="cwm-driver"></span><button class="cwm-ib cwm-mini" data-a="annot" title="Ask to annotate">' + svg(IC.annot) + '</button><button class="cwm-ib cwm-mini" data-a="control" title="Request control">' + svg(IC.control) + '</button><button class="cwm-ib cwm-mini" data-a="desktop" title="Full desktop control (pair local agent)">' + svg(IC.desktop) + '</button><button class="cwm-ib cwm-mini" data-a="min" title="Dock">' + svg(IC.min) + '</button></div>' +
      '<div class="cwm-tabs"><button data-tab="draw" class="on">Draw</button><button data-tab="files">Files</button><button data-tab="fun">Fun</button></div>' +
      '<div class="cwm-body">' +
        '<div class="cwm-tab" data-tab="draw">' + toolHtml +
          '<div class="cwm-lab">Color</div><div class="cwm-sws">' + sw + '</div>' +
          '<div class="cwm-row2"><span class="cwm-seg" id="cwm-fill"><button data-f="none" class="on" title="No fill">' + svg('<rect x="5" y="5" width="14" height="14" rx="3"/>') + '</button><button data-f="on" title="Fill">' + svg('<rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor"/>') + '</button></span>' +
          '<span class="cwm-seg" id="cwm-dash"><button data-d="solid" class="on">' + svg('<path d="M4 12h16"/>') + '</button><button data-d="dashed">' + svg('<path d="M4 12h4M10 12h4M16 12h4"/>') + '</button><button data-d="dotted">' + svg('<path d="M5 12h.01M9 12h.01M13 12h.01M17 12h.01M21 12h.01"/>') + '</button></span></div>' +
          '<div class="cwm-row2"><span class="cwm-wl">Weight</span><input type="range" id="cwm-w" min="1" max="16" value="3"><span class="cwm-wl">Opacity</span><input type="range" id="cwm-o" min="10" max="100" value="100"></div>' +
          '<div class="cwm-acts">' + actHtml + '</div><div class="cwm-lab">React</div><div class="cwm-rxs">' + rx + '</div></div>' +
        '<div class="cwm-tab hidden" data-tab="files"><div class="cwm-drop" id="cwm-drop">Drop files here · <a id="cwm-pick">browse</a><input id="cwm-fileinp" type="file" multiple style="display:none"><div class="cwm-dim" style="font-size:10.5px;margin-top:5px">pdf/png/jpg/heic/docx/xlsx · 25MB</div></div><div id="cwm-dropmsg" style="color:#e08;font-size:11px;min-height:14px"></div><div id="cwm-filelist"></div></div>' +
        '<div class="cwm-tab hidden" data-tab="fun"><div class="cwm-lab">Celebrate</div><div class="cwm-funrow" id="cwm-fxrow"><button class="cwm-fbtn" data-fx="confetti">🎉</button><button class="cwm-fbtn" data-fx="hearts">❤️</button><button class="cwm-fbtn" data-fx="fire">🔥</button><button class="cwm-fbtn" data-fx="stars">✨</button></div>' +
          '<div class="cwm-lab">Soundboard</div><div class="cwm-funrow" id="cwm-sndrow"><button class="cwm-fbtn" data-snd="tada">🎺 Tada</button><button class="cwm-fbtn" data-snd="airhorn">📣 Horn</button><button class="cwm-fbtn" data-snd="ding">🔔 Ding</button><button class="cwm-fbtn" data-snd="drum">🥁 Drum</button></div>' +
          '<div class="cwm-lab">Camera</div><div class="cwm-funrow"><button class="cwm-fbtn" data-a="blur">' + svg(IC.blur) + ' Background blur</button></div></div>' +
      '</div><div class="cwm-rz"></div>';
    document.body.appendChild(panel);
    // tabs
    panel.querySelector('.cwm-tabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; var t = b.getAttribute('data-tab'); [].forEach.call(this.children, function (x) { x.classList.toggle('on', x === b); }); [].forEach.call(panel.querySelectorAll('.cwm-tab'), function (s) { s.classList.toggle('hidden', s.getAttribute('data-tab') !== t); }); });
    // tools + style
    panel.querySelector('[data-tab="draw"]').addEventListener('click', function (e) { var b = e.target.closest('.cwm-tool'); if (!b) return; var nt = b.getAttribute('data-t'); if (!canAnnotate() && nt !== 'cursor') { requestAnnotate(); return; } tool = nt; if (tool !== 'select') lastSel = null; [].forEach.call(panel.querySelectorAll('.cwm-tool'), function (x) { x.classList.toggle('on', x === b); }); applyToolMode(); repaint(); });
    panel.querySelector('.cwm-sws').addEventListener('click', function (e) { var s = e.target.closest('.cwm-sw'); if (!s) return; style.color = s.getAttribute('data-c'); [].forEach.call(this.children, function (x) { x.classList.remove('on'); }); s.classList.add('on'); });
    panel.querySelector('#cwm-fill').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; style.fill = b.getAttribute('data-f') === 'on' ? style.color : null; [].forEach.call(this.children, function (x) { x.classList.remove('on'); }); b.classList.add('on'); });
    panel.querySelector('#cwm-dash').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; style.dash = b.getAttribute('data-d'); [].forEach.call(this.children, function (x) { x.classList.remove('on'); }); b.classList.add('on'); });
    panel.querySelector('#cwm-w').addEventListener('input', function () { style.width = +this.value; });
    panel.querySelector('#cwm-o').addEventListener('input', function () { style.opacity = this.value / 100; });
    panel.querySelector('.cwm-acts').addEventListener('click', function (e) { var b = e.target.closest('[data-a]'); if (b) doAction(b.getAttribute('data-a')); });
    panel.querySelector('.cwm-rxs').addEventListener('click', function (e) { var s = e.target.closest('.cwm-rx'); if (!s) return; var em = s.getAttribute('data-e'), x = 0.2 + Math.random() * 0.6; pub('cw:react', { emoji: em, x: x }); floatReaction(em, x); });
    // header buttons (control + minimize)
    panel.querySelector('.cwm-head').addEventListener('click', function (e) { var b = e.target.closest('[data-a]'); if (!b) return; var a = b.getAttribute('data-a'); if (a === 'min') panel.classList.toggle('cwm-min'); else if (a === 'control') controlBtnClick(); else if (a === 'desktop') desktopBtnClick(); else if (a === 'annot') annotBtnClick(); });
    // files
    var drop = panel.querySelector('#cwm-drop');
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('hot'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('hot'); }); });
    drop.addEventListener('drop', function (e) { handleFiles(e.dataTransfer.files); });
    panel.querySelector('#cwm-pick').addEventListener('click', function () { panel.querySelector('#cwm-fileinp').click(); });
    panel.querySelector('#cwm-fileinp').addEventListener('change', function (e) { handleFiles(e.target.files); e.target.value = ''; });
    // fun
    panel.querySelector('#cwm-fxrow').addEventListener('click', function (e) { var b = e.target.closest('[data-fx]'); if (!b) return; var k = b.getAttribute('data-fx'); rain(k); pub('cw:rain', { kind: k }); });
    panel.querySelector('#cwm-sndrow').addEventListener('click', function (e) { var b = e.target.closest('[data-snd]'); if (!b) return; var n = b.getAttribute('data-snd'); playSound(n); pub('cw:sound', { name: n }); });
    panel.querySelector('[data-tab="fun"]').addEventListener('click', function (e) { var b = e.target.closest('[data-a="blur"]'); if (b) toggleBlur(b); });
    // drag (header) + resize (corner)
    var head = panel.querySelector('.cwm-head'), drag = false, ox = 0, oy = 0;
    head.addEventListener('pointerdown', function (e) { if (e.target.closest('.cwm-ib')) return; drag = true; ox = e.clientX - panel.offsetLeft; oy = e.clientY - panel.offsetTop; head.setPointerCapture(e.pointerId); });
    head.addEventListener('pointermove', function (e) { if (!drag) return; panel.style.left = Math.max(0, Math.min(W() - 60, e.clientX - ox)) + 'px'; panel.style.top = Math.max(0, Math.min(H() - 40, e.clientY - oy)) + 'px'; });
    head.addEventListener('pointerup', function () { drag = false; });
    var rz = panel.querySelector('.cwm-rz'), rzon = false, sw2 = 0, sh2 = 0, sx = 0, sy = 0;
    rz.addEventListener('pointerdown', function (e) { rzon = true; sw2 = panel.offsetWidth; sh2 = panel.offsetHeight; sx = e.clientX; sy = e.clientY; rz.setPointerCapture(e.pointerId); e.stopPropagation(); });
    rz.addEventListener('pointermove', function (e) { if (!rzon) return; panel.style.width = Math.max(240, sw2 + (e.clientX - sx)) + 'px'; panel.style.height = Math.max(180, sh2 + (e.clientY - sy)) + 'px'; });
    rz.addEventListener('pointerup', function () { rzon = false; });
  }

  /* ---- share gating / dock resize / blur ---- */
  var shareEvs = ['TrackSubscribed', 'TrackUnsubscribed', 'LocalTrackPublished', 'LocalTrackUnpublished', 'TrackPublished', 'TrackUnpublished'];
  function shareEvents(on) { if (!RE || !room) return; shareEvs.forEach(function (n) { if (RE[n]) { try { on ? room.on(RE[n], updateShare) : room.off(RE[n], updateShare); } catch (e) {} } }); }
  function anyShare() { if (!room || !Track || !Track.Source) return false; var list = [room.localParticipant]; try { if (room.remoteParticipants) room.remoteParticipants.forEach(function (p) { list.push(p); }); } catch (e) {} return list.some(function (p) { if (!p) return false; var hit = false; var pubs = p.trackPublications || p.videoTrackPublications; if (pubs && pubs.forEach) { pubs.forEach(function (pub) { if (pub && pub.source === Track.Source.ScreenShare && (pub.track || pub.isSubscribed || pub.isEnabled)) hit = true; }); } else if (p.getTrackPublication) { var pub = p.getTrackPublication(Track.Source.ScreenShare); if (pub && (pub.track || pub.isSubscribed)) hit = true; } return hit; }); }
  function updateShare() { var on = anyShare(); if (on && !shareWasOn && !amSharing()) { mayAnnotate = false; annotReqPending = false; } if (!on && shareWasOn) { mayAnnotate = false; annotReqPending = false; pendingAnnot = {}; if (driver) { if (driver === meId) stopDriving(); else pub('cw:control', { kind: 'revoke' }); setDriver(null); } } shareWasOn = on; if (root) root.style.display = on ? 'block' : 'none'; if (panel) panel.style.display = on ? 'flex' : 'none'; if (cv) applyToolMode(); setAnnotBtn(); if (on) fit(); if (NB.armed) nbSendTarget();
    if (!on) NB.autoTried = false; // reset so the next share re-attempts
    if (on && amSharing() && !NB.armed && !NB.ws && !NB.autoTried) { NB.autoTried = true; autoPairAgent(); } // auto-connect the agent on share
  }
  function addDockResize() { var dock = document.getElementById('huddle-dock'); if (!dock || dock.querySelector('.cwm-dock-rz')) return; if (getComputedStyle(dock).position === 'static') dock.style.position = 'fixed'; var h = document.createElement('div'); h.className = 'cwm-dock-rz'; h.title = 'Drag to resize'; dock.appendChild(h); dockRz = h; var on = false, sw = 0, sh = 0, sx = 0, sy = 0; h.addEventListener('pointerdown', function (e) { on = true; sw = dock.offsetWidth; sh = dock.offsetHeight; sx = e.clientX; sy = e.clientY; h.setPointerCapture(e.pointerId); e.stopPropagation(); e.preventDefault(); }); h.addEventListener('pointermove', function (e) { if (!on) return; dock.style.width = Math.max(340, sw + (e.clientX - sx)) + 'px'; dock.style.height = Math.max(240, sh + (e.clientY - sy)) + 'px'; }); h.addEventListener('pointerup', function () { on = false; }); }
  function removeDockResize() { if (dockRz) { try { dockRz.remove(); } catch (e) {} dockRz = null; } }
  function trackProcessors() { return window.LivekitTrackProcessors || window.LiveKitTrackProcessors || null; }
  // Retry the ESM load on demand instead of relying on the fire-and-forget import
  // in index.html/mount (which swallowed its error, making blur fail silently).
  async function loadTrackProcessors() {
    var TP = trackProcessors(); if (TP) return TP;
    try { var m = await import('https://cdn.jsdelivr.net/npm/@livekit/track-processors@0.3.2/+esm'); window.LivekitTrackProcessors = m; return m; }
    catch (e) { window.__blurLoadErr = e; try { console.warn('[cowork] track-processors load failed', e); } catch (_) {} return null; }
  }
  async function toggleBlur(btn) {
    var TP = await loadTrackProcessors();
    if (!TP || !TP.BackgroundBlur) { toast('Background blur unavailable' + (window.__blurLoadErr ? ' (' + (window.__blurLoadErr.message || 'load error') + ')' : '')); return; }
    try {
      var pub2 = room.localParticipant.getTrackPublication ? room.localParticipant.getTrackPublication(Track.Source.Camera) : null;
      var track = pub2 && pub2.track;
      if (!track && room.localParticipant.videoTrackPublications) { room.localParticipant.videoTrackPublications.forEach(function (v) { if (v.track && !track) track = v.track; }); }
      if (!track) { toast('Turn your camera on first'); return; }
      // 0.3.2 signature is BackgroundBlur(blurRadius, segmenterOptions?) — the old
      // { delegate:'GPU' } was the wrong shape for this version and got ignored.
      if (!blurOn) { await track.setProcessor(TP.BackgroundBlur(15)); blurOn = true; if (btn) btn.classList.add('on'); toast('Background blur on'); }
      else { await track.stopProcessor(); blurOn = false; if (btn) btn.classList.remove('on'); }
    } catch (e) { toast('Blur failed: ' + (e && e.message ? e.message : 'unknown error')); }
  }

  function injectStyles() {
    if (document.getElementById('cwm-css')) return;
    var css = document.createElement('style'); css.id = 'cwm-css';
    css.textContent = [
      '.cwm-root{position:fixed;inset:0;z-index:2147483000;pointer-events:none;font-family:"Montserrat",system-ui,sans-serif}',
      '.cwm-border{position:absolute;inset:0;pointer-events:none;animation:cwmglow 3.6s ease-in-out infinite}',
      '.cwm-border.armed{animation:cwmglowA 2.6s ease-in-out infinite}',
      '@keyframes cwmglow{0%,100%{box-shadow:inset 0 0 0 2px rgba(95,131,166,.32)}50%{box-shadow:inset 0 0 0 2px rgba(95,131,166,.62),inset 0 0 30px rgba(95,131,166,.16)}}',
      '@keyframes cwmglowA{0%,100%{box-shadow:inset 0 0 0 2px rgba(27,122,80,.45)}50%{box-shadow:inset 0 0 0 3px rgba(27,122,80,.78),inset 0 0 34px rgba(27,122,80,.2)}}',
      '.cwm-cv{position:absolute;inset:0;width:100%;height:100%}.cwm-fx,.cwm-cursors{position:absolute;inset:0;pointer-events:none;overflow:hidden}',
      '.cwm-cur{position:absolute;transition:left .06s,top .06s}.cwm-cur span{position:absolute;left:15px;top:11px;font:600 11px "Montserrat",sans-serif;color:#fff;padding:1px 7px;border-radius:6px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.3)}',
      '.cwm-ping{position:absolute;transform:translate(-50%,-50%)}.cwm-ping i{position:absolute;left:-16px;top:-16px;width:32px;height:32px;border-radius:50%;border:2px solid currentColor;animation:cwmp 2s cubic-bezier(.15,.6,.3,1) infinite}.cwm-ping b{position:absolute;left:-7px;top:-7px;width:14px;height:14px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px rgba(255,255,255,.85)}.cwm-ping span{position:absolute;left:15px;top:-9px;color:#fff;font:600 11px "Montserrat",sans-serif;padding:2px 8px;border-radius:6px}',
      '@keyframes cwmp{0%{transform:scale(.4);opacity:.85}100%{transform:scale(2.8);opacity:0}}',
      '.cwm-rxf{position:absolute;bottom:14px;font-size:24px;pointer-events:none;filter:drop-shadow(0 2px 4px rgba(0,0,0,.3));animation:cwmr 2.4s ease-out forwards}@keyframes cwmr{0%{transform:translateY(6px);opacity:0}14%{opacity:1}100%{transform:translateY(-200px);opacity:0}}',
      '@keyframes cwmfall{0%{transform:translateY(-40px) rotate(0);opacity:0}10%{opacity:1}100%{transform:translateY(102vh) rotate(320deg);opacity:.9}}',
      '.cwm-panel .cwm-drop{border:1.5px dashed rgba(255,255,255,.18);border-radius:10px;padding:16px;text-align:center;color:#9aa6b8;font-size:12px}.cwm-panel .cwm-drop.hot{border-color:#748a9e;background:rgba(116,138,158,.14)}.cwm-panel .cwm-drop a{color:#b7c6d4;cursor:pointer}',
      // celebration drop particles use a distinct class to avoid clashing with the file-drop area
      '.cwm-fx .cwm-drop{position:fixed;top:-40px;z-index:5;pointer-events:none;border:0;padding:0;animation:cwmfall linear forwards}',
      '.cwm-panel{position:fixed;z-index:2147483600;display:flex;flex-direction:column;background:linear-gradient(180deg,#181f2c,#131923);border:1px solid #283245;border-radius:16px;pointer-events:auto;box-shadow:0 1px 0 rgba(255,255,255,.06) inset,0 24px 64px -14px rgba(0,0,0,.65);overflow:hidden;min-width:240px;max-height:88vh;font-family:"Montserrat",system-ui,sans-serif}',
      '.cwm-panel.cwm-min{height:auto!important}.cwm-panel.cwm-min .cwm-tabs,.cwm-panel.cwm-min .cwm-body,.cwm-panel.cwm-min .cwm-rz{display:none}',
      '.cwm-head{display:flex;align-items:center;gap:8px;padding:12px 13px 11px;cursor:move;border-bottom:1px solid rgba(255,255,255,.06)}',
      '.cwm-grip{color:#3f4a5e;display:flex}.cwm-grip svg{width:15px;height:15px;fill:currentColor;stroke:none}',
      '.cwm-title{font:700 13px "Montserrat",sans-serif;letter-spacing:-.01em;color:#eef4f8}.cwm-driver{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:99px;background:rgba(95,131,166,.16);border:1px solid rgba(95,131,166,.42);color:#b7c9dc;font:600 10px "Montserrat",sans-serif}.cwm-driver:empty{display:none}',
      '.cwm-head .cwm-mini{margin-left:auto}.cwm-head .cwm-mini+.cwm-mini{margin-left:0}',
      '.cwm-tabs{display:flex;gap:2px;padding:8px 10px 0}.cwm-tabs button{flex:1;border:0;background:rgba(255,255,255,.04);color:#9aa6b8;font:600 11.5px "Montserrat",sans-serif;padding:8px;border-radius:9px 9px 0 0;cursor:pointer}.cwm-tabs button.on{background:rgba(95,131,166,.24);color:#eaf1f7}',
      '.cwm-body{padding:12px 13px 14px;display:flex;flex-direction:column;gap:13px;overflow:auto}',
      '.cwm-tab{display:flex;flex-direction:column;gap:13px}',
      '.cwm-tab.hidden{display:none}',
      '.cwm-tg{display:flex;flex-direction:column;gap:7px}',
      '.cwm-lab{font:700 9px "JetBrains Mono",ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:#6f7c90;display:flex;align-items:center;gap:9px}.cwm-lab::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.06)}',
      '.cwm-tools{display:grid;grid-template-columns:repeat(6,1fr);gap:5px}',
      '.cwm-tool,.cwm-ib{border-radius:11px;border:1px solid transparent;background:rgba(255,255,255,.04);color:#aab6c6;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .14s}',
      '.cwm-tool{aspect-ratio:1}.cwm-ib{width:30px;height:30px;border-radius:9px}',
      '.cwm-tool:hover,.cwm-ib:hover{background:rgba(255,255,255,.09);color:#eef3f9}.cwm-tool.on,.cwm-ib.on{background:linear-gradient(180deg,#6c90b4,#5f83a6);color:#fff;border-color:rgba(255,255,255,.12);box-shadow:0 4px 14px -4px rgba(95,131,166,.7),0 1px 0 rgba(255,255,255,.18) inset}.cwm-tool svg,.cwm-ib svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}',
      '.cwm-sws{display:flex;gap:7px;flex-wrap:wrap;align-items:center}.cwm-sw{width:22px;height:22px;border-radius:7px;cursor:pointer;box-shadow:0 0 0 1px rgba(255,255,255,.14)}.cwm-sw.on{box-shadow:0 0 0 2px #131923,0 0 0 4px #5f83a6}',
      '.cwm-row2{display:flex;align-items:center;gap:9px}.cwm-wl{font:700 9px "JetBrains Mono",ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:#6f7c90}.cwm-row2 input[type=range]{flex:1;min-width:40px;accent-color:#5f83a6}',
      '.cwm-seg{display:flex;border-radius:9px;overflow:hidden;background:rgba(255,255,255,.04)}.cwm-seg button{border:0;background:transparent;color:#9aa6b8;padding:6px 7px;cursor:pointer}.cwm-seg button.on{background:#5f83a6;color:#fff}.cwm-seg svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2}',
      '.cwm-acts{display:grid;grid-template-columns:repeat(8,1fr);gap:4px}',
      '.cwm-rxs{display:flex;gap:2px;flex-wrap:wrap}.cwm-rx{font-size:18px;cursor:pointer;padding:3px;border-radius:8px}.cwm-rx:hover{background:rgba(255,255,255,.08)}',
      '.cwm-funrow{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}.cwm-fbtn{border:1px solid transparent;background:rgba(255,255,255,.04);color:#eef4f8;border-radius:10px;padding:10px;font:600 12px "Montserrat",sans-serif;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;transition:all .14s}.cwm-fbtn:hover{background:rgba(255,255,255,.09)}.cwm-fbtn.on{background:#5f83a6}.cwm-fbtn svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2}',
      '.cwm-file{padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)}.cwm-file b{color:#eef4f8;font:600 12px "Montserrat",sans-serif}.cwm-file small{display:block;color:#8b94a3;font-size:10.5px}.cwm-dim{color:#6f7c90;font-size:11px}',
      '.cwm-rz{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,rgba(255,255,255,.28) 50%,rgba(255,255,255,.28) 60%,transparent 60%,transparent 70%,rgba(255,255,255,.28) 70%,rgba(255,255,255,.28) 80%,transparent 80%)}',
      '.cwm-toast{position:fixed;left:50%;top:20px;transform:translateX(-50%);z-index:2147483600;background:linear-gradient(180deg,#181f2c,#131923);border:1px solid #283245;color:#eef4f8;font:600 12.5px "Montserrat",sans-serif;padding:11px 16px;border-radius:12px;box-shadow:0 16px 40px -8px rgba(0,0,0,.6);display:flex;gap:11px;align-items:center;pointer-events:auto}.cwm-toast button{border:0;background:#5f83a6;color:#fff;border-radius:8px;padding:6px 12px;font:600 12px "Montserrat",sans-serif;cursor:pointer}',
      '.cwm-ib.cwm-pending{color:#b7c9dc;box-shadow:0 0 0 2px #5f83a6 inset;animation:cwmpulse 1.4s infinite}@keyframes cwmpulse{0%,100%{opacity:1}50%{opacity:.55}}',
      '.cwm-dock-rz{position:absolute;right:2px;bottom:2px;width:18px;height:18px;cursor:nwse-resize;z-index:40;background:linear-gradient(135deg,transparent 45%,rgba(255,255,255,.3) 45%,rgba(255,255,255,.3) 55%,transparent 55%,transparent 65%,rgba(255,255,255,.3) 65%,rgba(255,255,255,.3) 75%,transparent 75%)}'
    ].join('');
    document.head.appendChild(css);
  }

  window.CoworkMarkup = { attach: attach, detach: detach };
  // Test/automation hook for the native bridge (pair/unpair the local agent
  // and inspect state) without going through the panel prompt.
  window.CoworkNative = { pair: function (code, name, cb) { nbConnect(code, name, cb); }, unpair: nbDisconnect, forward: nbForward, status: function () { return { armed: NB.armed, ready: NB.ready }; } };
  // Test harness hook — exposes internal logic (coordinate math + handoff) so an
  // automated harness can drive the real code and assert on it. Inert in prod.
  window.CoworkMarkup._test = {
    norm: function (p) { return norm(p); }, denorm: function (n) { return denorm(n); }, contentRect: contentRect,
    normShape: function (s) { return normShape(s); }, denormShape: function (s) { return denormShape(s); },
    requestAnnotate: requestAnnotate, requestControl: requestControl, grantAnnot: grantAnnot, controlBtnClick: controlBtnClick, annotBtnClick: annotBtnClick,
    setTool: function (t) { tool = t; if (cv) applyToolMode(); }, canAnnotate: canAnnotate, amSharing: amSharing, shareVideoRect: shareVideoRect, updateShare: updateShare,
    state: function () { return { meId: meId, driver: driver, driving: driving, mayAnnotate: mayAnnotate, annotReqPending: annotReqPending, pendingAnnot: Object.keys(pendingAnnot), annotGranted: Object.keys(annotGranted), shapes: board ? board.list().length : 0 }; },
    board: function () { return board; }
  };
})();
