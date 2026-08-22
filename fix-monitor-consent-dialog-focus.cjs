// One-shot patch: hivelogic-monitor-agent/src/main.js
//
// Real bug found live 2026-07-26 via monitor.log on Chris's machine:
// promptForMonitoringConsent() calls dialog.showMessageBox({...}) with no
// parent BrowserWindow. This app is tray-only (no visible window ever,
// dock hidden) and the prompt is triggered by a background setInterval
// heartbeat, not by anything the user just clicked. On Windows, a
// background process cannot forcibly steal keyboard focus for a new
// window it creates (the OS's foreground-lock protection) -- so the
// dialog gets created (confirmed via the existing DEBUG log lines: "about
// to call dialog.showMessageBox...") but never becomes visible/focused,
// and the returned Promise just sits unresolved forever. Two of these
// piled up on Chris's machine this morning (10:50:42 and 10:59:42 UTC),
// right after a ~5hr network gap (two "Heartbeat error: fetch failed"
// lines at 06:00-06:01, machine likely asleep) -- consistent with a
// background-timer-triggered dialog losing the foreground-steal fight
// after the app resumed from being backgrounded/idle.
//
// Fix: create a small hidden anchor BrowserWindow, explicitly bring IT to
// the foreground first (show + setAlwaysOnTop('screen-saver') + focus +
// app.focus({steal:true})), then attach the dialog to that window instead
// of calling dialog.showMessageBox() unowned. A window that has just
// legitimately taken the foreground itself CAN hand off modal focus to
// its own dialog reliably, which is what was missing.
// Safe to run more than once.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'hivelogic-monitor-agent', 'src', 'main.js');
let src = fs.readFileSync(filePath, 'utf8');

if (src.includes('getConsentAnchorWindow')) {
  console.log('Already applied -- consent dialog focus fix already in place. Nothing to do.');
  process.exit(0);
}

let changes = 0;
function applyOnce(oldS, newS, label) {
  if (!src.includes(oldS)) {
    console.error('ERROR: anchor not found for "' + label + '". Nothing written. Send this output back.');
    process.exit(1);
  }
  src = src.replace(oldS, newS);
  changes++;
}

// 1. Insert the anchor-window helper right before promptForMonitoringConsent.
applyOnce(
  "async function promptForMonitoringConsent(monitorSessionId) {\n" +
  "  logLine(`DEBUG: entering promptForMonitoringConsent for session ${monitorSessionId}. dialog is ${typeof dialog}, dialog.showMessageBox is ${typeof (dialog && dialog.showMessageBox)}.`);\n" +
  "  try {\n" +
  "    logLine('DEBUG: about to call dialog.showMessageBox...');\n" +
  "    const result = await dialog.showMessageBox({\n" +
  "      type: 'info',\n" +
  "      title: 'HiveLogic Monitor',\n" +
  "      message: \"You're clocked in on HiveLogic.\",\n" +
  "      detail: \"HiveLogic Monitor will record activity level and periodic screenshots while you're clocked in, so the office can see work is happening. Allow monitoring for this clock-in?\",\n" +
  "      buttons: ['Allow monitoring', 'Not this time'],\n" +
  "      defaultId: 0,\n" +
  "      cancelId: 1,\n" +
  "      noLink: true,\n" +
  "    });\n" +
  "    logLine(`DEBUG: dialog.showMessageBox resolved. response=${result && result.response}`);\n" +
  "    const allow = result.response === 0;\n" +
  "    await fetch(`${CONFIG.apiBase}/api/track1?resource=monitor_consent`, {\n" +
  "      method: 'POST',\n" +
  "      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.agentToken}` },\n" +
  "      body: JSON.stringify({ monitorSessionId, allow }),\n" +
  "    });\n" +
  "    logLine(`Consent for session ${monitorSessionId}: ${allow ? 'allowed' : 'denied'}.`);\n" +
  "  } catch (e) {\n" +
  "    logLine(`Consent prompt error: ${e.message}`);\n" +
  "  }\n" +
  "}",
  "// Windows blocks a background process from stealing keyboard focus for a\n" +
  "// window it opens on its own timer (foreground-lock protection) -- this\n" +
  "// tray-only app has no visible window to inherit foreground rights from,\n" +
  "// so an unowned dialog.showMessageBox() call can get created but never\n" +
  "// actually become visible/clickable (confirmed live 2026-07-26 via\n" +
  "// monitor.log: dialogs logged as opened, never logged as resolved).\n" +
  "// Anchoring the dialog to a small window we explicitly force to the\n" +
  "// foreground first works around it.\n" +
  "let consentAnchorWindow = null;\n" +
  "function getConsentAnchorWindow() {\n" +
  "  if (consentAnchorWindow && !consentAnchorWindow.isDestroyed()) return consentAnchorWindow;\n" +
  "  consentAnchorWindow = new BrowserWindow({\n" +
  "    width: 1,\n" +
  "    height: 1,\n" +
  "    show: false,\n" +
  "    frame: false,\n" +
  "    skipTaskbar: true,\n" +
  "    resizable: false,\n" +
  "    transparent: true,\n" +
  "  });\n" +
  "  return consentAnchorWindow;\n" +
  "}\n" +
  "\n" +
  "async function promptForMonitoringConsent(monitorSessionId) {\n" +
  "  logLine(`DEBUG: entering promptForMonitoringConsent for session ${monitorSessionId}. dialog is ${typeof dialog}, dialog.showMessageBox is ${typeof (dialog && dialog.showMessageBox)}.`);\n" +
  "  const anchor = getConsentAnchorWindow();\n" +
  "  try {\n" +
  "    anchor.show();\n" +
  "    anchor.setAlwaysOnTop(true, 'screen-saver');\n" +
  "    anchor.focus();\n" +
  "    if (app.focus) app.focus({ steal: true }); // force-steals foreground even though this fires from a background timer, not a user click\n" +
  "    logLine('DEBUG: about to call dialog.showMessageBox...');\n" +
  "    const result = await dialog.showMessageBox(anchor, {\n" +
  "      type: 'info',\n" +
  "      title: 'HiveLogic Monitor',\n" +
  "      message: \"You're clocked in on HiveLogic.\",\n" +
  "      detail: \"HiveLogic Monitor will record activity level and periodic screenshots while you're clocked in, so the office can see work is happening. Allow monitoring for this clock-in?\",\n" +
  "      buttons: ['Allow monitoring', 'Not this time'],\n" +
  "      defaultId: 0,\n" +
  "      cancelId: 1,\n" +
  "      noLink: true,\n" +
  "    });\n" +
  "    logLine(`DEBUG: dialog.showMessageBox resolved. response=${result && result.response}`);\n" +
  "    const allow = result.response === 0;\n" +
  "    await fetch(`${CONFIG.apiBase}/api/track1?resource=monitor_consent`, {\n" +
  "      method: 'POST',\n" +
  "      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.agentToken}` },\n" +
  "      body: JSON.stringify({ monitorSessionId, allow }),\n" +
  "    });\n" +
  "    logLine(`Consent for session ${monitorSessionId}: ${allow ? 'allowed' : 'denied'}.`);\n" +
  "  } catch (e) {\n" +
  "    logLine(`Consent prompt error: ${e.message}`);\n" +
  "  } finally {\n" +
  "    anchor.setAlwaysOnTop(false);\n" +
  "    anchor.hide();\n" +
  "  }\n" +
  "}",
  'promptForMonitoringConsent focus fix'
);

fs.writeFileSync(filePath, src, 'utf8');

const check = fs.readFileSync(filePath, 'utf8');
const need = ['getConsentAnchorWindow', 'consentAnchorWindow', "dialog.showMessageBox(anchor,", 'app.focus({ steal: true })'];
const missing = need.filter((n) => !check.includes(n));
if (!missing.length && changes === 1) {
  console.log('SUCCESS: consent dialog now forces itself to the foreground before showing (' + changes + ' edit). New size: ' + check.length + ' chars. Ready to git add/commit/push.');
} else {
  console.error('WARNING: wrote the file but verification did not fully match (missing: ' + missing.join(', ') + ', changes=' + changes + '). Do not commit -- send this output back.');
  process.exit(1);
}
