// HiveLogic Monitor -- desktop agent (Electron, Windows + Mac).
// This is the WebWork replacement's screen/activity tracker. It:
//   1. Pairs itself to one HiveLogic employee account via a short-lived
//      6-digit code generated from the HiveLogic web app.
//   2. After pairing, runs quietly in the system tray and, on a timer,
//      asks the HiveLogic backend "is this employee clocked in right now?"
//      -- the SERVER decides whether to capture, never this app alone.
//   3. Only when clocked in AND inside the configured business-hours
//      window does it capture activity samples + periodic screenshots
//      (one per physical monitor) and upload them.
//   4. Shows a notification every time it starts, per Chris's requirement:
//      "every time you login it notifies you that it will be turning on."
//
// What this does NOT do (by design, not by omission): read keystroke
// content, read clipboard, or capture anything while the employee is not
// clocked in. See reina/ project docs for the "trust-first tracking"
// philosophy this implements.

const { app, BrowserWindow, Tray, Menu, nativeImage, screen, desktopCapturer, powerMonitor, Notification, ipcMain, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CONFIG = {
  apiBase: 'https://hivelogic-live.vercel.app',
  agentToken: null,
  employeeEmail: null,
  businessHoursStart: 6, // local 24h clock, inclusive
  businessHoursEnd: 20, // local 24h clock, exclusive
  heartbeatIntervalSec: 60,
  screenshotEveryNHeartbeats: 5, // ~5 min at the default 60s heartbeat
};

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH(), 'utf8');
    return Object.assign({}, DEFAULT_CONFIG, JSON.parse(raw));
  } catch (e) {
    return Object.assign({}, DEFAULT_CONFIG);
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2), 'utf8');
}

function logLine(msg) {
  try {
    const logPath = path.join(app.getPath('userData'), 'monitor.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) { /* logging is best-effort */ }
}

let CONFIG = loadConfig();
let tray = null;
let pairingWindow = null;
let heartbeatTimer = null;
let heartbeatCount = 0;
let lastStatus = 'Starting…';
let lastConsentPromptSessionId = null; // which monitor session we've already asked about -- reset to null on every clock-out so the next clock-in always gets a fresh prompt
let lastScreenshotAt = 0; // ms epoch of the last screenshot capture -- drives the admin-configurable interval instead of a fixed heartbeat count
let lastScreenshotSessionId = null; // forces an immediate first screenshot whenever the monitor session changes

// Phase 5 (2026-08-25): app whitelist / productivity classification. The
// rule list is cached and refreshed on its own slower cadence (not every
// 60s heartbeat) -- it changes rarely (an admin editing it in Monitor
// Settings) and this app never blocks/slows the heartbeat loop on a
// second network round trip. lastUnproductiveNoticeApp/At rate-limit the
// notification so switching tabs on the SAME unproductive app for an hour
// shows one notice, not sixty.
let appRulesCache = new Map(); // app_name -> category
let appRulesFetchedAt = 0;
const APP_RULES_REFRESH_MS = 10 * 60 * 1000; // 10 minutes
let lastUnproductiveNoticeApp = null;
let lastUnproductiveNoticeAt = 0;
const UNPRODUCTIVE_NOTICE_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes per distinct app

function detectPlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return null; // unsupported (e.g. Linux) -- pairing will reject this server-side too
}

function withinBusinessHours(cfg) {
  const hour = new Date().getHours();
  return hour >= cfg.businessHoursStart && hour < cfg.businessHoursEnd;
}

// -----------------------------------------------------------------------
// Pairing flow
// -----------------------------------------------------------------------
function createPairingWindow() {
  if (pairingWindow) { pairingWindow.focus(); return; }
  pairingWindow = new BrowserWindow({
    width: 420,
    height: 480,
    resizable: false,
    title: 'Set up HiveLogic Monitor',
    webPreferences: {
      preload: path.join(__dirname, 'pairing-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  pairingWindow.setMenuBarVisibility(false);
  pairingWindow.loadFile(path.join(__dirname, 'pairing.html'));
  pairingWindow.on('closed', () => { pairingWindow = null; });
}

ipcMain.handle('hlm-get-platform', () => detectPlatform());

ipcMain.handle('hlm-submit-pairing', async (event, { email, pairingCode }) => {
  const platform = detectPlatform();
  if (!platform) return { ok: false, error: 'This OS is not supported yet (Windows and Mac only).' };
  try {
    const r = await fetch(`${CONFIG.apiBase}/api/track1?resource=monitor_pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        pairingCode,
        platform,
        deviceName: os.hostname(),
        agentVersion: app.getVersion(),
      }),
    });
    const data = await r.json().catch(() => null);
    if (!data || data.ok === false) {
      return { ok: false, error: (data && data.error) || 'Pairing failed -- check the code and try again.' };
    }
    CONFIG.agentToken = data.agentToken;
    CONFIG.employeeEmail = email;
    saveConfig(CONFIG);
    logLine(`Paired successfully as ${email}.`);
    return { ok: true };
  } catch (e) {
    logLine(`Pairing error: ${e.message}`);
    return { ok: false, error: 'Could not reach HiveLogic. Check your internet connection and try again.' };
  }
});

ipcMain.on('hlm-pairing-complete', () => {
  if (pairingWindow) { pairingWindow.close(); }
  app.setLoginItemSettings({ openAtLogin: true });
  notifyMonitoringStarting();
  startMonitoringLoop();
  buildTray();
});

// -----------------------------------------------------------------------
// Tray
// -----------------------------------------------------------------------
function buildTray() {
  if (tray) return;
  // Branded tray icon (hexagon-H with green pulse). Empty icons render as an
  // invisible blank space on Windows - never ship that again.
  let icon;
  try { icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png')); } catch (e) { icon = nativeImage.createEmpty(); }
  tray = new Tray(icon);
  tray.setToolTip('HiveLogic Monitor');
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    // The version is HERE, on the machine, because that is where the question
    // gets asked. On 2026-08-18 a 1.2.5 installer ran to completion and the
    // roster still said "version unknown", and there was no way to tell from
    // the machine itself whether the new build was the one actually running --
    // the tray showed a status and an email and nothing else. Same principle
    // as the page build marker: what is running should be readable, not
    // inferred from what was installed.
    { label: `HiveLogic Monitor v${app.getVersion()} — ${lastStatus}`, enabled: false },
    { label: `Signed in as ${CONFIG.employeeEmail || 'unknown'}`, enabled: false },
    { type: 'separator' },
    { label: 'Open HiveLogic', click: () => shell.openExternal(CONFIG.apiBase) },
    {
      label: 'Unpair this device',
      click: () => {
        CONFIG.agentToken = null;
        CONFIG.employeeEmail = null;
        saveConfig(CONFIG);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        lastStatus = 'Not paired';
        refreshTrayMenu();
        createPairingWindow();
      },
    },
    { type: 'separator' },
    { label: 'Quit HiveLogic Monitor', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`HiveLogic Monitor v${app.getVersion()} — ${lastStatus}`);
}

function notifyMonitoringStarting() {
  // Chris's explicit requirement: every time this starts, the employee is
  // told monitoring will be active -- never silent.
  if (Notification.isSupported()) {
    new Notification({
      title: 'HiveLogic Monitor',
      body: "Running. Activity + screenshots record only while you're clocked in on HiveLogic -- you can review everything captured about you in the app.",
    }).show();
  }
  logLine('Startup notification shown.');
}

// Foreground app name -- via `get-windows` (the maintained successor to the
// old `active-win` package, same API shape). We send only the owning app's
// name (e.g. "Google Chrome"), never the full window title, which can
// contain a document name, a URL, or other page content. That keeps this
// consistent with the "activity level only, never content" rule the rest
// of Monitor follows. Best-effort: on Mac this needs Screen Recording (or
// Accessibility, depending on OS version) permission granted to the app;
// if it's not granted yet, or the platform doesn't support it, this just
// returns null rather than failing the heartbeat.
async function getActiveAppName() {
  try {
    const mod = await import('get-windows');
    const activeWindow = mod.activeWindow;
    const result = await activeWindow();
    if (!result || !result.owner || !result.owner.name) return null;
    return String(result.owner.name).slice(0, 200);
  } catch (e) {
    return null;
  }
}

// Refreshes appRulesCache from the server on its own slower cadence (see
// APP_RULES_REFRESH_MS). Uses the agent's own bearer token -- the same
// GET-only exemption monitor_heartbeat etc. use (see
// api/track1.js MONITOR_AGENT_RESOURCES / api/_lib/guard.js). Best-effort:
// a failed fetch just keeps whatever was cached before (or an empty map on
// first run), never blocks the heartbeat loop.
async function refreshAppRulesIfStale() {
  if (!CONFIG.agentToken) return;
  if (Date.now() - appRulesFetchedAt < APP_RULES_REFRESH_MS) return;
  try {
    const r = await fetch(`${CONFIG.apiBase}/api/track1?resource=monitor_app_rules`, {
      headers: { Authorization: `Bearer ${CONFIG.agentToken}` },
    });
    const data = await r.json().catch(() => null);
    if (data && data.ok !== false && Array.isArray(data.rules)) {
      appRulesCache = new Map(data.rules.map((rule) => [rule.appName, rule.category]));
      appRulesFetchedAt = Date.now();
    }
  } catch (e) {
    // Keep the stale cache -- classifying against last-known rules is
    // better than not classifying at all.
  }
}

// Chris: "provide a pop up notif that the app currently open is not
// productive." Classifies locally against the cached whitelist and shows
// a real OS notification -- but only for an app explicitly marked
// 'unproductive' (never for 'unclassified', which would be guessing), and
// at most once per distinct app per UNPRODUCTIVE_NOTICE_COOLDOWN_MS so
// switching back to the same app repeatedly doesn't spam. Same
// Notification API the startup notice already uses.
function maybeNotifyUnproductiveApp(activeApp) {
  if (!activeApp) return;
  const category = appRulesCache.get(activeApp);
  if (category !== 'unproductive') return;
  const now = Date.now();
  if (activeApp === lastUnproductiveNoticeApp && (now - lastUnproductiveNoticeAt) < UNPRODUCTIVE_NOTICE_COOLDOWN_MS) return;
  lastUnproductiveNoticeApp = activeApp;
  lastUnproductiveNoticeAt = now;
  try {
    new Notification({
      title: 'HiveLogic Monitor',
      body: `"${activeApp}" is marked unproductive. This does not affect your clock -- just a heads up.`,
      silent: false,
    }).show();
  } catch (e) {
    logLine(`Unproductive-app notification failed: ${e.message}`);
  }
}

// -----------------------------------------------------------------------
// Monitoring loop -- heartbeat decides clocked-in status server-side;
// this app never trusts its own guess about whether someone is working.
// -----------------------------------------------------------------------
async function sendHeartbeat() {
  if (!CONFIG.agentToken) return;
  const idleSeconds = powerMonitor.getSystemIdleTime();
  const activityLevel = Math.max(0, 100 - Math.min(100, Math.round((idleSeconds / 60) * 100)));
  const displayCount = screen.getAllDisplays().length;
  const activeApp = await getActiveAppName();
  try {
    const r = await fetch(`${CONFIG.apiBase}/api/track1?resource=monitor_heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.agentToken}` },
      // agentVersion rides the heartbeat that already runs. Until 2026-08-17
      // nothing recorded which build a machine was on, so after publishing a
      // release there was no way to answer "who actually updated?" -- the same
      // blind spot the page build marker closed for browsers. See
      // api/_lib/agent-version.js.
      body: JSON.stringify({ activityLevel, idleSeconds, displayCount, activeApp, agentVersion: app.getVersion() }),
    });
    const data = await r.json().catch(() => null);
    if (!data || data.ok === false) {
      lastStatus = 'Heartbeat error';
      refreshTrayMenu();
      return;
    }
    // A heartbeat can answer ok:true while the row it was supposed to update
    // did not move -- that is how this agent ran 1.2.5, sent its version every
    // sixty seconds, and still showed as "version unknown" on the roster for an
    // hour. The server now reports that write separately; log it, because a
    // bookkeeping failure nobody can see is the shape of every bug in this
    // area so far.
    if (data.heartbeatWriteError) logLine('Heartbeat accepted but the server could not record it: ' + data.heartbeatWriteError);
    // Sent vs seen, on the same line, once a minute would be noise -- so only
    // when they disagree, which is the only case anyone needs to read. A 1.2.5
    // agent sent its version every sixty seconds while the column stayed NULL,
    // and nothing anywhere could say whether the value left the machine, or
    // arrived, or was written. This says which.
    if (data.agentVersionSeen !== app.getVersion()) {
      logLine(`Version mismatch: this agent sent ${app.getVersion()}, the server saw ${JSON.stringify(data.agentVersionSeen)}.`);
    }
    if (!data.clockedIn) {
      lastConsentPromptSessionId = null; // next clock-in always gets a fresh prompt
      lastStatus = 'Idle — not clocked in';
      refreshTrayMenu();
      return;
    }

    // Admin can turn monitoring off for a specific person (Monitor
    // Settings, per-user toggle) -- when that's the case, skip the consent
    // prompt entirely and never capture, regardless of their past answer.
    if (data.monitoringEnabled === false) {
      lastConsentPromptSessionId = null; // fresh prompt if it's turned back on later this same clock-in
      lastStatus = 'Clocked in — monitoring turned off for your account';
      refreshTrayMenu();
      return;
    }

    // Chris: "when you clock in it HAS to notify you and you should also
    // be allowed to deny it access each time." The server opens a brand
    // new monitor session (starting 'pending') on every fresh clock-in, so
    // this fires again each time -- never just once ever.
    if (data.consent === 'pending' && data.monitorSessionId && data.monitorSessionId !== lastConsentPromptSessionId) {
      lastConsentPromptSessionId = data.monitorSessionId;
      promptForMonitoringConsent(data.monitorSessionId, data.monitoringRequired !== false); // fire-and-forget -- doesn't block this heartbeat tick
    }

    if (data.consent === 'denied') {
      lastStatus = 'Clocked in — monitoring declined';
      refreshTrayMenu();
      return;
    }

    lastStatus = withinBusinessHours(CONFIG) ? 'Recording' : 'Clocked in — outside monitoring hours';
    refreshTrayMenu();

    // Phase 5 (2026-08-25): only while actually recording (clocked in,
    // monitored, consented, within business hours) -- the same condition
    // that gates capture below, so there is never a productivity notice
    // for time that isn't itself being monitored.
    if (withinBusinessHours(CONFIG)) {
      await refreshAppRulesIfStale();
      maybeNotifyUnproductiveApp(activeApp);
    }

    if (data.monitorSessionId !== lastScreenshotSessionId) {
      lastScreenshotSessionId = data.monitorSessionId;
      lastScreenshotAt = 0; // new clock-in / new session -- capture right away instead of waiting a full interval
    }
    const intervalMs = Math.max(1, Number(data.screenshotIntervalMinutes) || 5) * 60 * 1000;
    if (data.shouldCapture && withinBusinessHours(CONFIG) && (Date.now() - lastScreenshotAt) >= intervalMs) {
      lastScreenshotAt = Date.now();
      await captureAndUploadScreenshots(data.monitorSessionId, !!data.blurScreenshots);
    }
  } catch (e) {
    logLine(`Heartbeat error: ${e.message}`);
    lastStatus = 'Offline / retrying';
    refreshTrayMenu();
  }
}

// Shows a real Allow/Deny dialog the moment a fresh clock-in is detected,
// and reports the answer back to the server. Runs fire-and-forget from
// sendHeartbeat() so a slow response doesn't stall the 60s heartbeat loop;
// lastConsentPromptSessionId (set by the caller before this even resolves)
// stops a second dialog popping up on the next tick while this one is
// still on screen.
// Windows blocks a background process from stealing keyboard focus for a
// window it opens on its own timer (foreground-lock protection) -- this
// tray-only app has no visible window to inherit foreground rights from,
// so an unowned dialog.showMessageBox() call can get created but never
// actually become visible/clickable (confirmed live 2026-07-26 via
// monitor.log: dialogs logged as opened, never logged as resolved).
// Anchoring the dialog to a small window we explicitly force to the
// foreground first works around it.
let consentAnchorWindow = null;

/* Auto-update: no more manual installers. Downloads silently from GitHub
   Releases (csk5369/hivelogic-monitor), then shows a one-click "Update
   ready" popup with the same cannot-hide treatment as the consent dialog.
   Also installs on quit even if the popup is dismissed. */
let updatePromptShowing = false;
function setupMonitorAutoUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // EVERY outcome is logged, including the boring ones.
  //
  // This handler used to be `() => {}` with the comment "offline or no release
  // yet - stay quiet", and that one line is why "did the update land?" had no
  // answer. A machine whose update check fails -- bad feed, no network, a
  // release with no latest.yml -- sits on an old build indefinitely, silently,
  // looking exactly like a machine that is up to date. On 2026-08-18, ninety
  // minutes after 1.2.4 was published and verified as reachable, Chris's agent
  // was heartbeating live and reporting no version at all, and there was
  // nothing on the machine to say whether it had even tried.
  //
  // Silence is the thing this project keeps getting burned by. So: the error,
  // the check, the answer, and the download all leave a line in monitor.log.
  autoUpdater.on('error', (err) => {
    logLine('Auto-update: check FAILED -- ' + ((err && err.message) || String(err)));
  });
  autoUpdater.on('checking-for-update', () => logLine('Auto-update: checking ' + app.getVersion() + ' against the feed.'));
  autoUpdater.on('update-not-available', (info) => {
    logLine('Auto-update: already current (running ' + app.getVersion() + ', feed offers ' + ((info && info.version) || 'nothing') + ').');
  });
  autoUpdater.on('update-available', (info) => {
    logLine('Auto-update: ' + ((info && info.version) || '?') + ' available, downloading.');
  });
  autoUpdater.on('update-downloaded', async (info) => {
    if (updatePromptShowing) return;
    updatePromptShowing = true;
    const anchor = getConsentAnchorWindow();
    let keepOnTop = null;
    try {
      anchor.show();
      anchor.setAlwaysOnTop(true, 'screen-saver');
      anchor.focus();
      if (app.focus) app.focus({ steal: true });
      anchor.center();
      anchor.flashFrame(true);
      keepOnTop = setInterval(() => { try { anchor.moveTop(); anchor.setAlwaysOnTop(true, 'screen-saver'); } catch (e) {} }, 2000);
      const r = await dialog.showMessageBox(anchor, {
        type: 'info',
        title: 'HiveLogic Monitor',
        message: 'Update ready',
        detail: `HiveLogic Monitor ${info.version} downloaded itself in the background. Install now? Takes a few seconds and reopens automatically.`,
        buttons: ['Update now', 'On next restart'],
        defaultId: 0, cancelId: 1, noLink: true,
      });
      if (r.response === 0) { logLine(`Auto-update: user accepted ${info.version}, installing.`); autoUpdater.quitAndInstall(true, true); }
      else logLine(`Auto-update: ${info.version} will install on next restart.`);
    } catch (e) { logLine('Auto-update prompt error: ' + e.message); }
    finally {
      if (keepOnTop) clearInterval(keepOnTop);
      try { anchor.flashFrame(false); anchor.hide(); } catch (e) {}
      updatePromptShowing = false;
    }
  });
  const chk = () => autoUpdater.checkForUpdates().catch(() => {});
  chk();
  setInterval(chk, 30 * 60 * 1000);
}

function getConsentAnchorWindow() {
  if (consentAnchorWindow && !consentAnchorWindow.isDestroyed()) return consentAnchorWindow;
  consentAnchorWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    frame: false,
    skipTaskbar: false, // keep a taskbar presence so flashFrame() can flash it orange
    resizable: false,
    transparent: true,
  });
  return consentAnchorWindow;
}

// `required` comes from the server (profiles.monitoring_required). It changes
// what declining COSTS, so the dialog has to say which one it is -- offering
// "Not this time" without mentioning that it ends the shift would be asking for
// a decision while hiding its price.
async function promptForMonitoringConsent(monitorSessionId, required) {
  logLine(`DEBUG: entering promptForMonitoringConsent for session ${monitorSessionId}. dialog is ${typeof dialog}, dialog.showMessageBox is ${typeof (dialog && dialog.showMessageBox)}.`);
  const anchor = getConsentAnchorWindow();
  try {
    anchor.show();
    anchor.setAlwaysOnTop(true, 'screen-saver');
    anchor.focus();
    if (app.focus) app.focus({ steal: true }); // force-steals foreground even though this fires from a background timer, not a user click
    anchor.center();
    anchor.flashFrame(true); // orange taskbar flash - visible even if a window is over us
    try { require('electron').shell.beep(); } catch (e) {}
    // Windows can still shove the dialog behind whatever the user clicks next.
    // Re-assert topmost every 2s until the user answers.
    const keepOnTop = setInterval(() => {
      try { anchor.moveTop(); anchor.setAlwaysOnTop(true, 'screen-saver'); } catch (e) {}
    }, 2000);
    logLine('DEBUG: about to call dialog.showMessageBox...');
    const result = await dialog.showMessageBox(anchor, {
      type: 'info',
      title: 'HiveLogic Monitor',
      message: "You're clocked in on HiveLogic.",
      detail: required
        ? "HiveLogic Monitor will record activity level and periodic screenshots while you're clocked in, so the office can see work is happening. Monitoring is required for your account: if you decline, you'll be clocked out and can clock back in whenever you're ready to allow it. Nothing is recorded unless you allow it."
        : "HiveLogic Monitor will record activity level and periodic screenshots while you're clocked in, so the office can see work is happening. If you decline, nothing is recorded for this clock-in and you stay on the clock. Allow monitoring for this clock-in?",
      buttons: required ? ['Allow monitoring', 'Decline and clock out'] : ['Allow monitoring', 'Not this time'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    clearInterval(keepOnTop);
    try { anchor.flashFrame(false); anchor.hide(); } catch (e) {}
    logLine(`DEBUG: dialog.showMessageBox resolved. response=${result && result.response}`);
    const allow = result.response === 0;
    const consentRes = await fetch(`${CONFIG.apiBase}/api/track1?resource=monitor_consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.agentToken}` },
      body: JSON.stringify({ monitorSessionId, allow }),
    });
    const answer = await consentRes.json().catch(() => ({}));
    logLine(`Consent for session ${monitorSessionId}: ${allow ? 'allowed' : 'denied'}${answer && answer.clockedOut ? ' (clocked out -- monitoring is required for this account)' : ''}.`);
    if (!allow && answer && answer.clockedOut) {
      lastStatus = 'Clocked out — monitoring declined';
      refreshTrayMenu();
      // Said out loud, not just written to a log nobody reads: being silently
      // clocked out is exactly the kind of surprise this whole area keeps
      // producing.
      try {
        await dialog.showMessageBox(anchor, {
          type: 'info',
          title: 'HiveLogic Monitor',
          message: "You've been clocked out.",
          detail: 'Monitoring is required for your account, so declining ends the clock-in. Clock back in on HiveLogic whenever you\'re ready to allow it.',
          buttons: ['OK'],
          noLink: true,
        });
      } catch (e) { /* the tray status and the log still carry it */ }
    }
  } catch (e) {
    logLine(`Consent prompt error: ${e.message}`);
  } finally {
    anchor.setAlwaysOnTop(false);
    anchor.hide();
  }
}

// Renders blurred copies of screenshots entirely on-device (a hidden,
// never-shown BrowserWindow doing canvas work) so an unblurred image never
// leaves the machine when Monitor Settings has blurring turned on.
let blurWindow = null;
async function getBlurWindow() {
  if (blurWindow && !blurWindow.isDestroyed()) return blurWindow;
  blurWindow = new BrowserWindow({ show: false, width: 50, height: 50 });
  await blurWindow.loadURL('about:blank');
  return blurWindow;
}
async function blurJpegBase64(base64Jpeg) {
  const win = await getBlurWindow();
  const script = `
    new Promise(function(resolve, reject){
      var img = new Image();
      img.onload = function(){
        try {
          var c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          var ctx = c.getContext('2d');
          ctx.filter = 'blur(16px)';
          ctx.drawImage(img, 0, 0);
          resolve(c.toDataURL('image/jpeg', 0.82));
        } catch (e) { reject(String(e)); }
      };
      img.onerror = function(){ reject('image failed to load'); };
      img.src = 'data:image/jpeg;base64,${base64Jpeg}';
    })
  `;
  const dataUrl = await win.webContents.executeJavaScript(script);
  return String(dataUrl).replace(/^data:image\/jpeg;base64,/, '');
}

async function captureAndUploadScreenshots(monitorSessionId, blur) {
  if (!monitorSessionId) return;
  try {
    const displays = screen.getAllDisplays();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    let uploaded = 0;
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const jpeg = source.thumbnail.toJPEG(80);
      if (!jpeg || !jpeg.length) continue;
      const display = displays[i] || {};
      let imageBase64 = jpeg.toString('base64');
      if (blur) {
        try {
          imageBase64 = await blurJpegBase64(imageBase64);
        } catch (e) {
          logLine(`Blur failed for display ${i}, skipping upload for this screenshot (privacy setting is on): ${e.message}`);
          continue; // never upload unblurred when blurring was requested
        }
      }
      await fetch(`${CONFIG.apiBase}/api/track1?resource=monitor_screenshot_upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.agentToken}` },
        body: JSON.stringify({
          monitorSessionId,
          displayIndex: i,
          imageBase64,
          width: display.bounds ? display.bounds.width : source.thumbnail.getSize().width,
          height: display.bounds ? display.bounds.height : source.thumbnail.getSize().height,
        }),
      });
      uploaded += 1;
    }
    logLine(`Uploaded ${uploaded} screenshot(s) for session ${monitorSessionId}${blur ? ' (blurred)' : ''}.`);
  } catch (e) {
    logLine(`Screenshot capture/upload error: ${e.message}`);
  }
}

function startMonitoringLoop() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, CONFIG.heartbeatIntervalSec * 1000);
}

// -----------------------------------------------------------------------
// App lifecycle
// -----------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (pairingWindow) { pairingWindow.focus(); }
  });

  app.whenReady().then(() => {
    app.dock && app.dock.hide && app.dock.hide(); // Mac: tray-only app, no dock icon
    CONFIG = loadConfig();
    setupMonitorAutoUpdate();
    if (!CONFIG.agentToken) {
      createPairingWindow();
    } else {
      app.setLoginItemSettings({ openAtLogin: true });
      notifyMonitoringStarting();
      buildTray();
      startMonitoringLoop();
    }
  });

  // Deliberately no 'window-all-closed' handler: Electron only quits on that
  // event if you tell it to. This is a tray-only app -- closing the pairing
  // window (its only BrowserWindow) must never quit the background monitor.
}
