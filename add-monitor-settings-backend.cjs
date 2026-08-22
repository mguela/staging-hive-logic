// One-shot patch: api/track1.js -- Monitor Settings feature. Chris: "the
// monitor needs settings -- how often the screenshots are, if they get
// blurred, toggle the monitoring on/off for users."
// Adds:
//   1. getRequestingProfile() now also selects monitoring_enabled, so every
//      endpoint that resolves "requester" can see it.
//   2. handleMonitorHeartbeat() now looks up the employee's monitoring_enabled
//      flag + the company's screenshot interval / blur setting, and returns
//      them to the agent (monitoringEnabled, screenshotIntervalMinutes,
//      blurScreenshots) alongside a shouldCapture that respects the toggle.
//   3. New handleMonitorSettings() -- admin GET/POST for the screenshot
//      interval + blur toggle, plus the paired-employee roster with each
//      person's monitoring_enabled state.
//   4. New handleMonitorUserToggle() -- admin POST to flip monitoring on/off
//      for one employee.
//   5. New handleMonitorMyStatus() -- any signed-in employee can ask "am I
//      being recorded right now?" (drives the top-bar recording indicator).
//   6. Dispatcher entries for monitor_settings, monitor_user_toggle,
//      monitor_my_status.
// Safe to run more than once.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'api', 'track1.js');
let src = fs.readFileSync(filePath, 'utf8');

if (src.includes('async function handleMonitorSettings(')) {
  console.log('Already applied -- Monitor Settings backend already exists. Nothing to do.');
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

// --- 1. getRequestingProfile(): also select monitoring_enabled ---
applyOnce(
  "const profRes = await supabaseRequest(`profiles?id=eq.${user.id}&select=id,email,full_name,role`);\n" +
  "  if (!profRes.ok) return { id: user.id, email: user.email, full_name: null, role: null };\n" +
  "  const rows = await profRes.json();\n" +
  "  return (rows && rows[0]) || { id: user.id, email: user.email, full_name: null, role: null };",

  "const profRes = await supabaseRequest(`profiles?id=eq.${user.id}&select=id,email,full_name,role,monitoring_enabled`);\n" +
  "  if (!profRes.ok) return { id: user.id, email: user.email, full_name: null, role: null, monitoring_enabled: true };\n" +
  "  const rows = await profRes.json();\n" +
  "  return (rows && rows[0]) || { id: user.id, email: user.email, full_name: null, role: null, monitoring_enabled: true };",
  'getRequestingProfile select list'
);

// --- 2. handleMonitorHeartbeat: respect the per-user toggle + settings ---
applyOnce(
  "  const consent = monitorSession.consent || 'pending';\n" +
  "  return res.status(200).json({ ok: true, clockedIn: true, shouldCapture: consent === 'allowed', consent: consent, monitorSessionId: monitorSession.id });\n" +
  "}",

  "  const consent = monitorSession.consent || 'pending';\n" +
  "\n" +
  "  // Admin can exempt a specific employee from monitoring entirely (Monitor\n" +
  "  // Settings, per-user toggle) -- when that's off, capture never happens\n" +
  "  // and the agent skips the consent prompt too, regardless of what they'd\n" +
  "  // otherwise answer.\n" +
  "  const empRes = await supabaseRequest(`profiles?id=eq.${agent.employee_id}&select=monitoring_enabled`);\n" +
  "  const empRows = empRes.ok ? await empRes.json() : [];\n" +
  "  const monitoringEnabled = !empRows[0] || empRows[0].monitoring_enabled !== false;\n" +
  "\n" +
  "  const mSettingsRes = await supabaseRequest('workforce_settings?limit=1');\n" +
  "  const mSettingsRows = mSettingsRes.ok ? await mSettingsRes.json() : [];\n" +
  "  const mSettingsRow = mSettingsRows[0] || {};\n" +
  "  const screenshotIntervalMinutes = Number.isFinite(mSettingsRow.monitor_screenshot_interval_minutes) ? mSettingsRow.monitor_screenshot_interval_minutes : 5;\n" +
  "  const blurScreenshots = mSettingsRow.monitor_blur_screenshots === true;\n" +
  "\n" +
  "  return res.status(200).json({\n" +
  "    ok: true,\n" +
  "    clockedIn: true,\n" +
  "    shouldCapture: monitoringEnabled && consent === 'allowed',\n" +
  "    consent: consent,\n" +
  "    monitorSessionId: monitorSession.id,\n" +
  "    monitoringEnabled: monitoringEnabled,\n" +
  "    screenshotIntervalMinutes: screenshotIntervalMinutes,\n" +
  "    blurScreenshots: blurScreenshots,\n" +
  "  });\n" +
  "}",
  'handleMonitorHeartbeat response'
);

// --- 3, 4, 5. New handler functions, inserted before handleMonitorScreenshotUpload ---
applyOnce(
  "async function handleMonitorScreenshotUpload(req, res) {",

  "// Admin-only: Monitor settings (screenshot interval, blur) + per-employee\n" +
  "// monitoring on/off roster. Chris: \"the monitor needs settings -- how often\n" +
  "// the screenshots are, if they get blurred, toggle monitoring on/off for\n" +
  "// users.\"\n" +
  "async function handleMonitorSettings(req, res) {\n" +
  "  const requester = await getRequestingProfile(req);\n" +
  "  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in.' });\n" +
  "  if (requester.role !== 'admin') return res.status(403).json({ ok: false, error: 'Only an admin/manager can manage Monitor settings.' });\n" +
  "\n" +
  "  if (req.method === 'POST') {\n" +
  "    const { screenshotIntervalMinutes, blurScreenshots } = req.body || {};\n" +
  "    const patch = {};\n" +
  "    if (screenshotIntervalMinutes !== undefined) {\n" +
  "      const n = Number(screenshotIntervalMinutes);\n" +
  "      if (!Number.isFinite(n) || n < 1 || n > 120) return res.status(400).json({ ok: false, error: 'screenshotIntervalMinutes must be between 1 and 120.' });\n" +
  "      patch.monitor_screenshot_interval_minutes = Math.round(n);\n" +
  "    }\n" +
  "    if (blurScreenshots !== undefined) patch.monitor_blur_screenshots = !!blurScreenshots;\n" +
  "    if (Object.keys(patch).length) {\n" +
  "      const existingRes = await supabaseRequest('workforce_settings?select=id&limit=1');\n" +
  "      const existingRows = existingRes.ok ? await existingRes.json() : [];\n" +
  "      if (existingRows && existingRows[0]) {\n" +
  "        await supabaseRequest(`workforce_settings?id=eq.${existingRows[0].id}`, { method: 'PATCH', body: JSON.stringify(patch) });\n" +
  "      } else {\n" +
  "        await supabaseRequest('workforce_settings', { method: 'POST', body: JSON.stringify(patch) });\n" +
  "      }\n" +
  "    }\n" +
  "  }\n" +
  "\n" +
  "  const settingsRes = await supabaseRequest('workforce_settings?limit=1');\n" +
  "  const settingsRows = settingsRes.ok ? await settingsRes.json() : [];\n" +
  "  const row = (settingsRows && settingsRows[0]) || {};\n" +
  "\n" +
  "  const agentsRes = await supabaseRequest('monitor_agents?select=id,employee_id,device_name,platform,status,last_seen_at&order=last_seen_at.desc');\n" +
  "  const agents = agentsRes.ok ? await agentsRes.json() : [];\n" +
  "  const empIds = [...new Set((agents || []).map((a) => a.employee_id))];\n" +
  "  let profiles = [];\n" +
  "  if (empIds.length) {\n" +
  "    const profRes = await supabaseRequest(`profiles?id=in.(${empIds.join(',')})&select=id,full_name,email,monitoring_enabled`);\n" +
  "    profiles = profRes.ok ? await profRes.json() : [];\n" +
  "  }\n" +
  "  const byId = Object.fromEntries((profiles || []).map((p) => [p.id, p]));\n" +
  "  const roster = (agents || []).map((a) => ({\n" +
  "    employeeId: a.employee_id,\n" +
  "    name: (byId[a.employee_id] && byId[a.employee_id].full_name) || (byId[a.employee_id] && byId[a.employee_id].email) || 'Unknown',\n" +
  "    deviceName: a.device_name,\n" +
  "    platform: a.platform,\n" +
  "    status: a.status,\n" +
  "    lastSeenAt: a.last_seen_at,\n" +
  "    monitoringEnabled: !byId[a.employee_id] || byId[a.employee_id].monitoring_enabled !== false,\n" +
  "  }));\n" +
  "\n" +
  "  return res.status(200).json({\n" +
  "    ok: true,\n" +
  "    screenshotIntervalMinutes: Number.isFinite(row.monitor_screenshot_interval_minutes) ? row.monitor_screenshot_interval_minutes : 5,\n" +
  "    blurScreenshots: row.monitor_blur_screenshots === true,\n" +
  "    roster,\n" +
  "  });\n" +
  "}\n" +
  "\n" +
  "// Admin-only: flip monitoring on/off for one employee. Takes effect on\n" +
  "// their agent's next heartbeat (within ~60s) -- it stops/starts capture\n" +
  "// and, when turned back on, the consent prompt fires fresh next clock-in.\n" +
  "async function handleMonitorUserToggle(req, res) {\n" +
  "  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });\n" +
  "  const requester = await getRequestingProfile(req);\n" +
  "  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in.' });\n" +
  "  if (requester.role !== 'admin') return res.status(403).json({ ok: false, error: 'Only an admin/manager can change this.' });\n" +
  "  const { employeeId, monitoringEnabled } = req.body || {};\n" +
  "  if (!employeeId) return res.status(400).json({ ok: false, error: 'employeeId is required.' });\n" +
  "  const updRes = await supabaseRequest(`profiles?id=eq.${employeeId}`, { method: 'PATCH', body: JSON.stringify({ monitoring_enabled: !!monitoringEnabled }) });\n" +
  "  if (!updRes.ok) return res.status(500).json({ ok: false, error: 'Could not update that employee: ' + (await updRes.text()) });\n" +
  "  return res.status(200).json({ ok: true, monitoringEnabled: !!monitoringEnabled });\n" +
  "}\n" +
  "\n" +
  "// Any signed-in employee: \"am I being recorded right now?\" -- drives the\n" +
  "// small recording-indicator button next to the Reina/Chirp buttons.\n" +
  "async function handleMonitorMyStatus(req, res) {\n" +
  "  const requester = await getRequestingProfile(req);\n" +
  "  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in.' });\n" +
  "  const sessRes = await supabaseRequest(`monitor_sessions?employee_id=eq.${requester.id}&ended_at=is.null&order=started_at.desc&limit=1`);\n" +
  "  const sessRows = sessRes.ok ? await sessRes.json() : [];\n" +
  "  const session = (sessRows && sessRows[0]) || null;\n" +
  "  const monitoringEnabled = requester.monitoring_enabled !== false;\n" +
  "  const recording = !!(session && session.consent === 'allowed' && monitoringEnabled);\n" +
  "  return res.status(200).json({ ok: true, clockedIn: !!session, recording });\n" +
  "}\n" +
  "\n" +
  "async function handleMonitorScreenshotUpload(req, res) {",
  'insert new Monitor Settings handlers before handleMonitorScreenshotUpload'
);

// --- 6. Dispatcher entries ---
applyOnce(
  "  if (resource === 'monitor_review') {\n" +
  "    try { return await handleMonitorReview(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }\n" +
  "  }",

  "  if (resource === 'monitor_review') {\n" +
  "    try { return await handleMonitorReview(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }\n" +
  "  }\n" +
  "  if (resource === 'monitor_settings') {\n" +
  "    try { return await handleMonitorSettings(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }\n" +
  "  }\n" +
  "  if (resource === 'monitor_user_toggle') {\n" +
  "    try { return await handleMonitorUserToggle(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }\n" +
  "  }\n" +
  "  if (resource === 'monitor_my_status') {\n" +
  "    try { return await handleMonitorMyStatus(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }\n" +
  "  }",
  'dispatcher entries for monitor_settings / monitor_user_toggle / monitor_my_status'
);

fs.writeFileSync(filePath, src, 'utf8');

const check = fs.readFileSync(filePath, 'utf8');
const need = ['handleMonitorSettings', 'handleMonitorUserToggle', 'handleMonitorMyStatus', "resource === 'monitor_settings'", "resource === 'monitor_user_toggle'", "resource === 'monitor_my_status'"];
const missing = need.filter((n) => !check.includes(n));
if (!missing.length) {
  console.log('SUCCESS: Monitor Settings backend added (' + changes + ' edits). New size: ' + check.length + ' chars. Ready to git add/commit/push.');
} else {
  console.error('WARNING: wrote the file but verification did not find: ' + missing.join(', ') + '. Do not commit -- send this output back.');
  process.exit(1);
}
