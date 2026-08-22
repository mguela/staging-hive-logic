// Cowork end-to-end harness: two jsdom "participants" running the REAL
// cowork-markup.js + draw.js, wired by a simulated LiveKit data channel, so the
// whole annotation/permission/control pipeline can be driven and asserted here.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { TextEncoder, TextDecoder } = require('util');

const SRC = process.argv[2] || 'C:/Users/Chris/Desktop/hlv_harness/public/hiveconnect';
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const DRAW = read('draw.js'), DROP = read('dropzone.js'), MARKUP = read('cowork-markup.js');

let PASS = 0, FAIL = 0;
function ok(name, cond, extra) { if (cond) { PASS++; console.log('  PASS  ' + name); } else { FAIL++; console.log('  FAIL  ' + name + (extra ? '   -> ' + extra : '')); } }
function near(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 1 : tol); }

// ---- simulated world (data bus + cross-participant visibility) ----
const world = { parts: {}, log: [], deliver(fromId, bytes) { try { world.log.push({ from: fromId, env: JSON.parse(new TextDecoder().decode(bytes)) }); } catch (e) {} for (const id in world.parts) { if (id === fromId) continue; const p = world.parts[id]; p.room.emit('DataReceived', bytes, { identity: fromId }); } } };

function makeParticipant(id, name, w, h) {
  const vc = new VirtualConsole(); // swallow jsdom "Not implemented: canvas" noise
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', virtualConsole: vc });
  const win = dom.window;
  Object.defineProperty(win, 'innerWidth', { value: w, configurable: true });
  Object.defineProperty(win, 'innerHeight', { value: h, configurable: true });
  win.TextEncoder = TextEncoder; win.TextDecoder = TextDecoder;
  win.LivekitClient = {
    RoomEvent: { DataReceived: 'DataReceived', TrackSubscribed: 'TrackSubscribed', TrackUnsubscribed: 'TrackUnsubscribed', LocalTrackPublished: 'LocalTrackPublished', LocalTrackUnpublished: 'LocalTrackUnpublished', TrackPublished: 'TrackPublished', TrackUnpublished: 'TrackUnpublished' },
    Track: { Source: { ScreenShare: 'screen_share', Camera: 'camera' } }
  };
  win.getComputedStyle = win.getComputedStyle || (() => ({ position: 'static' }));

  const H = {};
  const room = {
    localParticipant: {
      identity: id, name,
      trackPublications: new Map(),
      videoTrackPublications: new Map(),
      publishData: (bytes) => world.deliver(id, bytes),
      getTrackPublication: (src) => { for (const p of room.localParticipant.trackPublications.values()) if (p.source === src) return p; return null; },
    },
    remoteParticipants: new Map(),
    on: (ev, fn) => { (H[ev] = H[ev] || []).push(fn); return room; },
    off: (ev, fn) => { if (H[ev]) H[ev] = H[ev].filter(f => f !== fn); return room; },
    emit: (ev, ...a) => { (H[ev] || []).slice().forEach(f => { try { f(...a); } catch (e) { console.error('handler err', e); } }); },
  };

  // load real code into the window
  win.eval(DRAW); win.eval(DROP); win.eval(MARKUP);

  const P = { id, name, win, room, doc: win.document,
    CM: win.CoworkMarkup, t: null,
    attach() { win.CoworkMarkup.attach(room, { name }); this.t = win.CoworkMarkup._test; },
    state() { return this.t.state(); },
  };
  world.parts[id] = P;
  return P;
}

function addSharedVideo(P, rect, vw, vh) {
  const v = P.doc.createElement('video');
  Object.defineProperty(v, 'videoWidth', { value: vw, configurable: true });
  Object.defineProperty(v, 'videoHeight', { value: vh, configurable: true });
  v.getBoundingClientRect = () => ({ left: rect.x, top: rect.y, right: rect.x + rect.w, bottom: rect.y + rect.h, width: rect.w, height: rect.h, x: rect.x, y: rect.y });
  P.doc.body.appendChild(v);
  return v;
}
// A shares: give A a local screenshare pub, and mirror it into everyone else's
// remoteParticipants so anyShare() sees it; fire track events so updateShare runs.
function setSharing(P, on) {
  const lp = P.room.localParticipant;
  if (on) {
    const pub = { source: 'screen_share', track: {}, isEnabled: true, isSubscribed: true, kind: 'video', isMuted: false, trackSid: P.id + '-ss' };
    lp.trackPublications.set('ss', pub);
    const remote = { sid: P.id, identity: P.id, name: P.name, trackPublications: new Map([['ss', pub]]), getTrackPublication: (s) => s === 'screen_share' ? pub : null };
    for (const id in world.parts) { if (id === P.id) continue; world.parts[id].room.remoteParticipants.set(P.id, remote); world.parts[id].room.emit('TrackSubscribed', pub.track); }
    P.room.emit('LocalTrackPublished', pub);
  } else {
    lp.trackPublications.delete('ss');
    for (const id in world.parts) { if (id === P.id) continue; world.parts[id].room.remoteParticipants.delete(P.id); world.parts[id].room.emit('TrackUnsubscribed', {}); }
    P.room.emit('LocalTrackUnpublished', {});
  }
}
function clickToast(P, label) {
  const btns = [].slice.call(P.doc.querySelectorAll('.cwm-toast button'));
  const b = btns.find((x) => !label || (x.textContent || '').indexOf(label) >= 0) || btns[btns.length - 1];
  if (b) b.click();
  return !!b;
}

// =====================================================================
console.log('\n=== Cowork harness ===');

// ---------- Scenario 1: coordinate round-trip ----------
console.log('\n[1] Coordinate alignment (presenter viewport <-> viewer video rect)');
{
  const A = makeParticipant('A', 'Presenter', 1920, 1080);
  const B = makeParticipant('B', 'Viewer', 1366, 768);
  addSharedVideo(B, { x: 100, y: 50, w: 640, h: 360 }, 1920, 1080);
  setSharing(A, true);
  A.attach(); B.attach();

  const nA = A.t.norm({ x: 960, y: 540 });               // center of A's 1920x1080
  ok('presenter center normalizes to (0.5,0.5)', near(nA.x, 0.5, 0.001) && near(nA.y, 0.5, 0.001), JSON.stringify(nA));
  const pB = B.t.denorm({ x: 0.5, y: 0.5 });             // -> center of B's video rect
  ok('viewer denorm(0.5,0.5) lands at video center (420,230)', near(pB.x, 420) && near(pB.y, 230), JSON.stringify(pB));
  const pB0 = B.t.denorm({ x: 0, y: 0 });
  ok('viewer denorm(0,0) lands at video top-left (100,50)', near(pB0.x, 100) && near(pB0.y, 50), JSON.stringify(pB0));

  // Full shape transform: presenter draws at its pixels -> viewer receives at its video rect
  const shapeAtA = { id: 'A:1', uid: 'A', tool: 'rect', points: [{ x: 960, y: 540 }, { x: 1920, y: 1080 }] };
  const wire = A.t.normShape(shapeAtA);
  ok('shape wire coords are normalized 0..1', wire.points[0].x === 0.5 && wire.points[1].x === 1 && wire.points[1].y === 1, JSON.stringify(wire.points));
  const atB = B.t.denormShape(wire);
  ok('shape denormalizes onto viewer video rect', near(atB.points[0].x, 420) && near(atB.points[0].y, 230) && near(atB.points[1].x, 740) && near(atB.points[1].y, 410), JSON.stringify(atB.points));
}

// ---------- Scenario 2: annotate permission handshake ----------
console.log('\n[2] Annotate permission handshake (request -> grant over the wire)');
{
  const A = makeParticipant('A', 'Presenter', 1600, 900);
  const B = makeParticipant('B', 'Viewer', 1440, 900);
  addSharedVideo(B, { x: 0, y: 0, w: 1280, h: 720 }, 1280, 720);
  setSharing(A, true);
  A.attach(); B.attach();

  ok('viewer starts without annotate permission', B.state().mayAnnotate === false);
  B.t.requestAnnotate();
  ok('presenter received the request (pending)', A.state().pendingAnnot.indexOf('B') >= 0, JSON.stringify(A.state().pendingAnnot));
  ok('viewer is marked waiting', B.state().annotReqPending === true);
  // presenter clicks Allow on the persistent toast
  const clicked = clickToast(A, 'Allow');
  ok('presenter Allow toast present + clicked', clicked);
  ok('viewer now may annotate', B.state().mayAnnotate === true);
  ok('viewer waiting flag cleared', B.state().annotReqPending === false);
  ok('presenter pending cleared', A.state().pendingAnnot.length === 0);
}

// ---------- Scenario 3: control grant, driver release, revoke-on-share-stop ----------
console.log('\n[3] Control: grant -> drive -> release / revoke-on-share-stop');
{
  const A = makeParticipant('A', 'Presenter', 1600, 900);
  const B = makeParticipant('B', 'Viewer', 1440, 900);
  addSharedVideo(B, { x: 0, y: 0, w: 1280, h: 720 }, 1280, 720);
  setSharing(A, true);
  A.attach(); B.attach();

  B.t.requestControl();
  clickToast(A, 'Allow');
  ok('viewer becomes the driver', B.state().driver === 'B' && B.state().driving === true, JSON.stringify(B.state()));
  ok('presenter shows viewer as driver', A.state().driver === 'B');

  // driver releases control themselves
  B.t.controlBtnClick();
  ok('driver can stop controlling (self-release)', B.state().driving === false && B.state().driver === null, JSON.stringify(B.state()));
  ok('presenter sees control released', A.state().driver === null, JSON.stringify(A.state()));

  // re-grant, then presenter stops sharing -> auto revoke
  B.t.requestControl(); clickToast(A, 'Allow');
  ok('re-granted control', B.state().driving === true);
  setSharing(A, false); A.t.updateShare();
  ok('stopping share revokes the driver (presenter side)', A.state().driver === null, JSON.stringify(A.state()));
  ok('stopping share stops the driver (viewer side)', B.state().driving === false && B.state().driver === null, JSON.stringify(B.state()));
}

// ---------- Scenario 4: control RELAY (driver's click -> control frame) ----------
console.log('\n[4] Control relay (driving click emits a control input + ping)');
{
  const A = makeParticipant('A', 'Presenter', 1600, 900);
  const B = makeParticipant('B', 'Viewer', 1440, 900);
  addSharedVideo(B, { x: 0, y: 0, w: 1280, h: 720 }, 1280, 720);
  setSharing(A, true);
  A.attach(); B.attach();
  B.t.requestControl(); clickToast(A, 'Allow');
  ok('viewer is driving before relay test', B.state().driving === true);

  world.log.length = 0;
  // simulate the driver clicking at (640,360) = center of the 1280x720 video
  const cv = B.doc.querySelector('.cwm-cv');
  const ev = new B.win.Event('pointerdown'); ev.clientX = 640; ev.clientY = 360; ev.pointerId = 1;
  cv.dispatchEvent(ev);
  const ctl = world.log.find((m) => m.env.t === 'cw:control' && m.env.payload && m.env.payload.sub === 'click');
  ok('driving click emits a cw:control click frame', !!ctl, JSON.stringify(world.log.map((m) => m.env.t)));
  ok('control click coords are centered (0.5,0.5)', ctl && near(ctl.env.payload.x, 0.5, 0.01) && near(ctl.env.payload.y, 0.5, 0.01), ctl && JSON.stringify(ctl.env.payload));
  const ping = world.log.find((m) => m.env.t === 'cw:ping');
  ok('driving click also emits a ping so presenter sees it (#165)', !!ping, JSON.stringify(world.log.map((m) => m.env.t)));
}

// ---------- Scenario 5: shareVideoRect picks the screen share, not a camera tile ----------
console.log('\n[5] shareVideoRect chooses the largest (shared screen) among multiple videos');
{
  const B = makeParticipant('B', 'Viewer', 1440, 900);
  // a small camera tile AND a big shared-screen video
  const cam = B.doc.createElement('video');
  Object.defineProperty(cam, 'videoWidth', { value: 640, configurable: true });
  Object.defineProperty(cam, 'videoHeight', { value: 480, configurable: true });
  cam.getBoundingClientRect = () => ({ left: 20, top: 20, width: 180, height: 135, right: 200, bottom: 155, x: 20, y: 20 });
  B.doc.body.appendChild(cam);
  addSharedVideo(B, { x: 200, y: 60, w: 1000, h: 562 }, 1920, 1080);
  setSharing(makeParticipant('A', 'Presenter', 1600, 900), true); // A shares so B sees a share
  B.attach();
  const r = B.t.shareVideoRect();
  ok('shareVideoRect returns a rect', !!r, JSON.stringify(r));
  ok('shareVideoRect picks the big shared screen (x~200,w~1000), not the camera', r && r.x >= 190 && r.w >= 900, JSON.stringify(r));
}

console.log('\n=== ' + PASS + ' passed, ' + FAIL + ' failed ===\n');
process.exit(FAIL ? 1 : 0);
