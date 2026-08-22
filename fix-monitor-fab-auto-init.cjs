// One-shot patch: public/index.html -- the recording-indicator fab
// (hlMonFab) only turned itself on via two hooks inside the login flow
// (lgSubmit success + hlTrySilentLogin success). Chris found via DevTools
// that the button element and hlMonitorFabInit() both work fine when
// called manually -- it just never gets auto-called on some routes (he was
// on the #/hiveconnect view, which apparently doesn't run through the
// normal top-level login flow on that particular page load). Fix: also
// fire it once, unconditionally, ~2s after the script itself loads,
// regardless of which route/flow got the page there. hlMonitorFabPoll()
// already safely no-ops via hlRequireSession() if there's no session yet,
// so this is safe to call even before sign-in.
// Safe to run more than once.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'index.html');
let src = fs.readFileSync(filePath, 'utf8');

if (src.includes('hlMonitorFabInit unconditional fallback')) {
  console.log('Already applied -- hlMonFab auto-init fallback already in place. Nothing to do.');
  process.exit(0);
}

if (!src.includes("window.hlMonitorUserToggle = function(employeeId, enabled, checkboxEl){")) {
  console.error('ERROR: hlMonitorUserToggle() not found -- run add-monitor-settings-frontend.cjs first. Nothing written.');
  process.exit(1);
}

const isCRLF = src.includes('\r\n');
const nl = (s) => (isCRLF ? s.replace(/\n/g, '\r\n') : s);

const oldS = nl(
  "window.hlMonitorUserToggle = function(employeeId, enabled, checkboxEl){\n" +
  "  return hlRequireSession(async function(sess){\n" +
  "    var r = await fetch('/api/track1?resource=monitor_user_toggle', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+sess.access_token }, body: JSON.stringify({ employeeId: employeeId, monitoringEnabled: enabled }) });\n" +
  "    var data = await r.json().catch(function(){return null;});\n" +
  "    if(!data || data.ok===false){ if(checkboxEl) checkboxEl.checked = !enabled; if(window.chirpToast) chirpToast('⚠️ ' + ((data&&data.error)||'Could not update.')); return; }\n" +
  "    if(window.chirpToast) chirpToast(enabled ? '✅ Monitoring turned on.' : '⛔ Monitoring turned off.');\n" +
  "  });\n" +
  "};"
);
const newS = nl(
  "window.hlMonitorUserToggle = function(employeeId, enabled, checkboxEl){\n" +
  "  return hlRequireSession(async function(sess){\n" +
  "    var r = await fetch('/api/track1?resource=monitor_user_toggle', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+sess.access_token }, body: JSON.stringify({ employeeId: employeeId, monitoringEnabled: enabled }) });\n" +
  "    var data = await r.json().catch(function(){return null;});\n" +
  "    if(!data || data.ok===false){ if(checkboxEl) checkboxEl.checked = !enabled; if(window.chirpToast) chirpToast('⚠️ ' + ((data&&data.error)||'Could not update.')); return; }\n" +
  "    if(window.chirpToast) chirpToast(enabled ? '✅ Monitoring turned on.' : '⛔ Monitoring turned off.');\n" +
  "  });\n" +
  "};\n" +
  "// hlMonitorFabInit unconditional fallback -- some routes (e.g. the\n" +
  "// #/hiveconnect view) don't run through the normal top-level login flow\n" +
  "// where this is otherwise hooked, so it never got auto-called there.\n" +
  "// hlMonitorFabPoll() safely no-ops with no session yet, so firing this\n" +
  "// unconditionally on every page load is safe.\n" +
  "setTimeout(function(){ if(window.hlMonitorFabInit) hlMonitorFabInit(); }, 2000);"
);

if (!src.includes(oldS)) {
  console.error('ERROR: anchor not found for hlMonitorUserToggle end. Nothing written. Send this output back.');
  process.exit(1);
}
src = src.replace(oldS, newS);

fs.writeFileSync(filePath, src, 'utf8');

const check = fs.readFileSync(filePath, 'utf8');
if (check.includes('hlMonitorFabInit unconditional fallback')) {
  console.log('SUCCESS: hlMonFab now auto-initializes on every page load, not just the login flow. New size: ' + check.length + ' chars. Ready to git add/commit/push.');
} else {
  console.error('WARNING: wrote the file but verification failed. Do not commit -- send this output back.');
  process.exit(1);
}
