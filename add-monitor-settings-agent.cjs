// One-shot patch: hivelogic-monitor-agent/src/main.js -- makes the agent
// obey the new Monitor Settings from the server instead of its own fixed
// local config:
//   1. Screenshot interval is now server-driven (Monitor Settings ->
//      screenshotIntervalMinutes) instead of a fixed "every 5 heartbeats."
//      Timed off real elapsed minutes, resets to "capture right away" on a
//      fresh clock-in.
//   2. If an admin turns monitoring off for this person (Monitor Settings,
//      per-user toggle), the agent stops capturing AND stops showing the
//      consent prompt -- no point asking if it's off.
//   3. Blur: when the admin turns blurring on, screenshots are blurred
//      on-device (a hidden, never-shown window doing canvas work) BEFORE
//      upload, so an unblurred image never leaves the machine. If blurring
//      fails for some reason, that screenshot is skipped rather than
//      uploaded unblurred.
// Safe to run more than once.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'hivelogic-monitor-agent', 'src', 'main.js');
if (!fs.existsSync(filePath)) {
  console.error('ERROR: ' + filePath + ' not found. Nothing written.');
  process.exit(1);
}
let src = fs.readFileSync(filePath, 'utf8');

if (src.includes('lastScreenshotSessionId')) {
  console.log('Already applied -- Monitor Settings agent logic already in place. Nothing to do.');
  process.exit(0);
}

const isCRLF = src.includes('\r\n');
const nl = (s) => (isCRLF ? s.replace(/\n/g, '\r\n') : s);
let changes = 0;
function applyOnce(oldRaw, newRaw, label) {
  const oldS = nl(oldRaw);
  const newS = nl(newRaw);
  if (!src.includes(oldS)) {
    console.error('ERROR: anchor not found for "' + label + '". Nothing written. Send this output back.');
    process.exit(1);
  }
  src = src.replace(oldS, newS);
  changes++;
}

// --- 1. New state vars, next to lastConsentPromptSessionId ---
applyOnce(
  "let lastConsentPromptSessionId = null; // which monitor session we've already asked about -- reset to null on every clock-out so the next clock-in always gets a fresh prompt",
  "let lastConsentPromptSessionId = null; // which monitor session we've already asked about -- reset to null on every clock-out so the next clock-in always gets a fresh prompt\n" +
  "let lastScreenshotAt = 0; // ms epoch of the last screenshot capture -- drives the admin-configurable interval instead of a fixed heartbeat count\n" +
  "let lastScreenshotSessionId = null; // forces an immediate first screenshot whenever the monitor session changes",
  'state vars'
);

// --- 2. sendHeartbeat(): monitoring-off short-circuit + interval-based capture ---
applyOnce(
  "    // Chris: \"when you clock in it HAS to notify you and you should also\n" +
  "    // be allowed to deny it access each time.\" The server opens a brand\n" +
  "    // new monitor session (starting 'pending') on every fresh clock-in, so\n" +
  "    // this fires again each time -- never just once ever.\n" +
  "    if (data.consent === 'pending' && data.monitorSessionId && data.monitorSessionId !== lastConsentPromptSessionId) {\n" +
  "      lastConsentPromptSessionId = data.monitorSessionId;\n" +
  "      promptForMonitoringConsent(data.monitorSessionId); // fire-and-forget -- doesn't block this heartbeat tick\n" +
  "    }\n" +
  "\n" +
  "    if (data.consent === 'denied') {\n" +
  "      lastStatus = 'Clocked in — monitoring declined';\n" +
  "      refreshTrayMenu();\n" +
  "      return;\n" +
  "    }\n" +
  "\n" +
  "    lastStatus = withinBusinessHours(CONFIG) ? 'Recording' : 'Clocked in — outside monitoring hours';\n" +
  "    refreshTrayMenu();\n" +
  "    heartbeatCount += 1;\n" +
  "    if (data.shouldCapture && withinBusinessHours(CONFIG) && heartbeatCount % CONFIG.screenshotEveryNHeartbeats === 0) {\n" +
  "      await captureAndUploadScreenshots(data.monitorSessionId);\n" +
  "    }\n" +
  "  } catch (e) {",

  "    // Admin can turn monitoring off for a specific person (Monitor\n" +
  "    // Settings, per-user toggle) -- when that's the case, skip the consent\n" +
  "    // prompt entirely and never capture, regardless of their past answer.\n" +
  "    if (data.monitoringEnabled === false) {\n" +
  "      lastConsentPromptSessionId = null; // fresh prompt if it's turned back on later this same clock-in\n" +
  "      lastStatus = 'Clocked in — monitoring turned off for your account';\n" +
  "      refreshTrayMenu();\n" +
  "      return;\n" +
  "    }\n" +
  "\n" +
  "    // Chris: \"when you clock in it HAS to notify you and you should also\n" +
  "    // be allowed to deny it access each time.\" The server opens a brand\n" +
  "    // new monitor session (starting 'pending') on every fresh clock-in, so\n" +
  "    // this fires again each time -- never just once ever.\n" +
  "    if (data.consent === 'pending' && data.monitorSessionId && data.monitorSessionId !== lastConsentPromptSessionId) {\n" +
  "      lastConsentPromptSessionId = data.monitorSessionId;\n" +
  "      promptForMonitoringConsent(data.monitorSessionId); // fire-and-forget -- doesn't block this heartbeat tick\n" +
  "    }\n" +
  "\n" +
  "    if (data.consent === 'denied') {\n" +
  "      lastStatus = 'Clocked in — monitoring declined';\n" +
  "      refreshTrayMenu();\n" +
  "      return;\n" +
  "    }\n" +
  "\n" +
  "    lastStatus = withinBusinessHours(CONFIG) ? 'Recording' : 'Clocked in — outside monitoring hours';\n" +
  "    refreshTrayMenu();\n" +
  "\n" +
  "    if (data.monitorSessionId !== lastScreenshotSessionId) {\n" +
  "      lastScreenshotSessionId = data.monitorSessionId;\n" +
  "      lastScreenshotAt = 0; // new clock-in / new session -- capture right away instead of waiting a full interval\n" +
  "    }\n" +
  "    const intervalMs = Math.max(1, Number(data.screenshotIntervalMinutes) || 5) * 60 * 1000;\n" +
  "    if (data.shouldCapture && withinBusinessHours(CONFIG) && (Date.now() - lastScreenshotAt) >= intervalMs) {\n" +
  "      lastScreenshotAt = Date.now();\n" +
  "      await captureAndUploadScreenshots(data.monitorSessionId, !!data.blurScreenshots);\n" +
  "    }\n" +
  "  } catch (e) {",
  'sendHeartbeat monitoring-off + interval-based capture'
);

// --- 3. captureAndUploadScreenshots(): accept blur flag, add blur helpers ---
applyOnce(
  "async function captureAndUploadScreenshots(monitorSessionId) {\n" +
  "  if (!monitorSessionId) return;\n" +
  "  try {\n" +
  "    const displays = screen.getAllDisplays();\n" +
  "    const sources = await desktopCapturer.getSources({\n" +
  "      types: ['screen'],\n" +
  "      thumbnailSize: { width: 1920, height: 1080 },\n" +
  "    });\n" +
  "    for (let i = 0; i < sources.length; i++) {\n" +
  "      const source = sources[i];\n" +
  "      const jpeg = source.thumbnail.toJPEG(80);\n" +
  "      if (!jpeg || !jpeg.length) continue;\n" +
  "      const display = displays[i] || {};\n" +
  "      await fetch(`${CONFIG.apiBase}/api/track1?resource=monitor_screenshot_upload`, {\n" +
  "        method: 'POST',\n" +
  "        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.agentToken}` },\n" +
  "        body: JSON.stringify({\n" +
  "          monitorSessionId,\n" +
  "          displayIndex: i,\n" +
  "          imageBase64: jpeg.toString('base64'),\n" +
  "          width: display.bounds ? display.bounds.width : source.thumbnail.getSize().width,\n" +
  "          height: display.bounds ? display.bounds.height : source.thumbnail.getSize().height,\n" +
  "        }),\n" +
  "      });\n" +
  "    }\n" +
  "    logLine(`Uploaded ${sources.length} screenshot(s) for session ${monitorSessionId}.`);\n" +
  "  } catch (e) {\n" +
  "    logLine(`Screenshot capture/upload error: ${e.message}`);\n" +
  "  }\n" +
  "}",

  "// Renders blurred copies of screenshots entirely on-device (a hidden,\n" +
  "// never-shown BrowserWindow doing canvas work) so an unblurred image never\n" +
  "// leaves the machine when Monitor Settings has blurring turned on.\n" +
  "let blurWindow = null;\n" +
  "async function getBlurWindow() {\n" +
  "  if (blurWindow && !blurWindow.isDestroyed()) return blurWindow;\n" +
  "  blurWindow = new BrowserWindow({ show: false, width: 50, height: 50 });\n" +
  "  await blurWindow.loadURL('about:blank');\n" +
  "  return blurWindow;\n" +
  "}\n" +
  "async function blurJpegBase64(base64Jpeg) {\n" +
  "  const win = await getBlurWindow();\n" +
  "  const script = `\n" +
  "    new Promise(function(resolve, reject){\n" +
  "      var img = new Image();\n" +
  "      img.onload = function(){\n" +
  "        try {\n" +
  "          var c = document.createElement('canvas');\n" +
  "          c.width = img.naturalWidth; c.height = img.naturalHeight;\n" +
  "          var ctx = c.getContext('2d');\n" +
  "          ctx.filter = 'blur(16px)';\n" +
  "          ctx.drawImage(img, 0, 0);\n" +
  "          resolve(c.toDataURL('image/jpeg', 0.82));\n" +
  "        } catch (e) { reject(String(e)); }\n" +
  "      };\n" +
  "      img.onerror = function(){ reject('image failed to load'); };\n" +
  "      img.src = 'data:image/jpeg;base64,${base64Jpeg}';\n" +
  "    })\n" +
  "  `;\n" +
  "  const dataUrl = await win.webContents.executeJavaScript(script);\n" +
  "  return String(dataUrl).replace(/^data:image\\/jpeg;base64,/, '');\n" +
  "}\n" +
  "\n" +
  "async function captureAndUploadScreenshots(monitorSessionId, blur) {\n" +
  "  if (!monitorSessionId) return;\n" +
  "  try {\n" +
  "    const displays = screen.getAllDisplays();\n" +
  "    const sources = await desktopCapturer.getSources({\n" +
  "      types: ['screen'],\n" +
  "      thumbnailSize: { width: 1920, height: 1080 },\n" +
  "    });\n" +
  "    let uploaded = 0;\n" +
  "    for (let i = 0; i < sources.length; i++) {\n" +
  "      const source = sources[i];\n" +
  "      const jpeg = source.thumbnail.toJPEG(80);\n" +
  "      if (!jpeg || !jpeg.length) continue;\n" +
  "      const display = displays[i] || {};\n" +
  "      let imageBase64 = jpeg.toString('base64');\n" +
  "      if (blur) {\n" +
  "        try {\n" +
  "          imageBase64 = await blurJpegBase64(imageBase64);\n" +
  "        } catch (e) {\n" +
  "          logLine(`Blur failed for display ${i}, skipping upload for this screenshot (privacy setting is on): ${e.message}`);\n" +
  "          continue; // never upload unblurred when blurring was requested\n" +
  "        }\n" +
  "      }\n" +
  "      await fetch(`${CONFIG.apiBase}/api/track1?resource=monitor_screenshot_upload`, {\n" +
  "        method: 'POST',\n" +
  "        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.agentToken}` },\n" +
  "        body: JSON.stringify({\n" +
  "          monitorSessionId,\n" +
  "          displayIndex: i,\n" +
  "          imageBase64,\n" +
  "          width: display.bounds ? display.bounds.width : source.thumbnail.getSize().width,\n" +
  "          height: display.bounds ? display.bounds.height : source.thumbnail.getSize().height,\n" +
  "        }),\n" +
  "      });\n" +
  "      uploaded += 1;\n" +
  "    }\n" +
  "    logLine(`Uploaded ${uploaded} screenshot(s) for session ${monitorSessionId}${blur ? ' (blurred)' : ''}.`);\n" +
  "  } catch (e) {\n" +
  "    logLine(`Screenshot capture/upload error: ${e.message}`);\n" +
  "  }\n" +
  "}",
  'captureAndUploadScreenshots + blur helpers'
);

fs.writeFileSync(filePath, src, 'utf8');

// Best-effort version bump so the rebuilt installer is obviously a new build.
try {
  const pkgPath = path.join(__dirname, 'hivelogic-monitor-agent', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.version === '1.1.0') {
    pkg.version = '1.2.0';
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    console.log('Bumped hivelogic-monitor-agent version to 1.2.0.');
  }
} catch (e) {
  console.log('(Could not auto-bump package.json version -- not a problem, just cosmetic. ' + e.message + ')');
}

const check = fs.readFileSync(filePath, 'utf8');
const need = ['lastScreenshotSessionId', 'blurJpegBase64', 'monitoringEnabled === false', 'getBlurWindow'];
const missing = need.filter((n) => !check.includes(n));
if (!missing.length) {
  console.log('SUCCESS: agent now obeys Monitor Settings (' + changes + ' edits). New size: ' + check.length + ' chars. Now rebuild: cd hivelogic-monitor-agent && npm run build:win');
} else {
  console.error('WARNING: wrote the file but verification did not find: ' + missing.join(', ') + '. Do not rebuild -- send this output back.');
  process.exit(1);
}
