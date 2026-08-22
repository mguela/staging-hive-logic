// Sound effects wiring (Chris 2026-07-26: "we need sound effects, clicks,
// errors ... send message, calls ringing, voicemail etc").
// public/sfx.js (new file, committed separately) provides window.hlSfx and
// already self-wires clicks, toast success/error/notify, and modal pops.
// This patch wires the app-specific events:
//   index.html            -> load /sfx.js
//   app-phone-popup.js    -> outgoing ringback loop, connected blip, hangup
//                            thunk, new-voicemail ding
//   hiveconnect/app.js    -> send-message swoosh, incoming-message ding,
//                            incoming video-call ring loop (stops on clear)
// All hooks are guarded with `window.hlSfx &&` so nothing breaks if sfx.js
// is absent (e.g. the standalone guest call page). Idempotent.
const fs = require('fs');

function patch(file, label, edits) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes('hlSfx')) { console.log(label + ': ALREADY PATCHED'); return; }
  for (const e of edits) {
    if (e.re) {
      const m = s.match(new RegExp(e.re, 'g'));
      if (!m || m.length !== 1) { console.error(label + ' regex anchor "' + e.name + '" count ' + (m ? m.length : 0)); process.exit(1); }
      s = s.replace(new RegExp(e.re), e.to);
    } else {
      const c = s.split(e.find).length - 1;
      const want = e.all || 1;
      if (c !== want) { console.error(label + ' anchor "' + e.name + '" count ' + c + ' (want ' + want + ')'); process.exit(1); }
      s = e.all ? s.split(e.find).join(e.to) : s.replace(e.find, e.to);
    }
  }
  fs.writeFileSync(file, s);
  console.log(label + ': PATCHED OK');
}

// ---- 1) index.html: load the engine ----
{
  const f = 'public/index.html';
  let s = fs.readFileSync(f, 'utf8');
  if (s.includes('src="/sfx.js"')) { console.log('index.html: ALREADY PATCHED'); }
  else {
    const A = '<title>HiveLogic — v64</title>';
    const c = s.split(A).length - 1;
    if (c !== 1) { console.error('index.html title anchor count ' + c); process.exit(1); }
    s = s.replace(A, A + '\n<script defer src="/sfx.js"></script>');
    fs.writeFileSync(f, s);
    console.log('index.html: PATCHED OK');
  }
}

// ---- 2) phone popup ----
patch('public/app-phone-popup.js', 'app-phone-popup.js', [
  {
    name: 'outgoing ringback',
    find: 'state.activeCall = await state.device.connect({ params });',
    to: "state.activeCall = await state.device.connect({ params });\n      if (window.hlSfx) hlSfx.startLoop('ringback', 3000);",
  },
  {
    name: 'accept -> connect blip',
    find: "call.on('accept', () => { renderBody(); });",
    to: "call.on('accept', () => { if (window.hlSfx) { hlSfx.stopLoop(); hlSfx.play('connect'); } renderBody(); });",
  },
  {
    name: 'disconnect -> hangup thunk',
    find: 'clearInterval(timerInterval); state.activeCall = null;',
    to: "if (window.hlSfx) { hlSfx.stopLoop(); hlSfx.play('hangup'); } clearInterval(timerInterval); state.activeCall = null;",
    all: 2, // fires in both teardown paths: disconnect AND call error
  },
  {
    name: 'new voicemail ding',
    find: 'const unread = state.voicemails.filter(v => !v.read).length;',
    to: "const unread = state.voicemails.filter(v => !v.read).length;\n    if (window.hlSfx && typeof state._vmUnreadPrev === 'number' && unread > state._vmUnreadPrev) hlSfx.play('notify');\n    state._vmUnreadPrev = unread;",
  },
]);

// ---- 3) HiveConnect ----
patch('public/hiveconnect/app.js', 'hiveconnect/app.js', [
  {
    name: 'send message swoosh',
    find: 'async function sendMessage(content, threadParentId = null, attachment = null) {',
    to: "async function sendMessage(content, threadParentId = null, attachment = null) {\n  if (window.hlSfx) hlSfx.play('swoosh');",
  },
  {
    name: 'incoming message ding',
    find: ".on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, ({ new: m }) => {",
    to: ".on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, ({ new: m }) => {\n      if (window.hlSfx && m.user_id !== me.id) hlSfx.play('notify');",
  },
  {
    name: 'incoming call ring loop',
    find: 'showIncomingCall(cid, others[0], c);',
    to: "if (window.hlSfx) hlSfx.startLoop('ring', 3200);\n    showIncomingCall(cid, others[0], c);",
  },
  {
    name: 'ring stops on clear',
    find: 'function clearRing(cid) {',
    to: "function clearRing(cid) {\n  if (window.hlSfx) hlSfx.stopLoop();",
  },
]);

console.log('ALL DONE');
