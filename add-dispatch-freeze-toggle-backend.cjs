// One-shot patch: api/schedule/move-visit.js + api/track1.js -- Dispatch
// tab polish item #3: "persistent freeze-window toggle" (item #2, live
// tech-header status, is a much bigger lift -- the whole Day board runs on
// front-end demo/simulated data today, not real GPS/clock-in, so it needs
// its own scoping session rather than a quick patch).
//
// The freeze-window guardrail itself already exists and is real (move-visit
// re-verifies against live Jobber data before blocking a reschedule inside
// the next 60 minutes) -- it just wasn't a *persistent, dispatcher-facing
// toggle*: FREEZE_WINDOW_MINUTES was a hardcoded constant with no way to
// turn it off or adjust it without a code change.
//
// This patch:
//  1. move-visit.js: reads dispatch_freeze_window_enabled/_minutes from the
//     workforce_settings row (added via migration
//     dispatch_freeze_window_settings) at request time instead of using a
//     hardcoded constant. Falls back to the old default (enabled, 60min) if
//     the settings row/columns are missing so this can't fail closed in a
//     way that silently disables the guardrail.
//  2. api/track1.js: new resource `dispatch_settings` -- GET (any signed-in
//     user) returns the current enabled/minutes; POST (same dispatch-capable
//     roles move-visit.js already trusts: owner/partner/office_manager/
//     systems_pm/dispatch/project_manager/admin) updates it.
// Safe to run more than once.
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------
// PART 1: api/schedule/move-visit.js
// ---------------------------------------------------------------------
const mvPath = path.join(__dirname, 'api', 'schedule', 'move-visit.js');
let mv = fs.readFileSync(mvPath, 'utf8');
const mvIsCRLF = mv.includes('\r\n');
const mvNl = (s) => (mvIsCRLF ? s.replace(/\n/g, '\r\n') : s);

if (mv.includes('getFreezeWindowSettings')) {
  console.log('move-visit.js: already applied -- nothing to do.');
} else {
  const oldConst = mvNl("const FREEZE_WINDOW_MINUTES = 60;");
  if (!mv.includes(oldConst)) {
    console.error('ERROR (move-visit.js): anchor not found for FREEZE_WINDOW_MINUTES constant. Nothing written. Send this output back.');
    process.exit(1);
  }
  const newConst = mvNl(
    "const FREEZE_WINDOW_MINUTES = 60; // fallback default if workforce_settings has no row/columns yet\n" +
    "\n" +
    "// Persistent, dispatcher-facing version of the guardrail above: reads the\n" +
    "// live toggle + duration from workforce_settings (added via migration\n" +
    "// dispatch_freeze_window_settings) instead of trusting the hardcoded\n" +
    "// constant. Any read failure falls back to the safe default (ON, 60min)\n" +
    "// rather than silently disabling the guardrail.\n" +
    "async function getFreezeWindowSettings() {\n" +
    "  try {\n" +
    "    const r = await supabaseRequest('workforce_settings?select=dispatch_freeze_window_enabled,dispatch_freeze_window_minutes&limit=1');\n" +
    "    const rows = r.ok ? await r.json() : [];\n" +
    "    const row = rows && rows[0];\n" +
    "    if (!row) return { enabled: true, minutes: FREEZE_WINDOW_MINUTES };\n" +
    "    return {\n" +
    "      enabled: row.dispatch_freeze_window_enabled !== false,\n" +
    "      minutes: Number.isFinite(row.dispatch_freeze_window_minutes) ? row.dispatch_freeze_window_minutes : FREEZE_WINDOW_MINUTES,\n" +
    "    };\n" +
    "  } catch (e) {\n" +
    "    return { enabled: true, minutes: FREEZE_WINDOW_MINUTES };\n" +
    "  }\n" +
    "}"
  );
  mv = mv.replace(oldConst, newConst);

  const oldCheck = mvNl(
    "  const now = new Date();\n" +
    "  const currentStart = current.startAt ? new Date(current.startAt) : null;\n" +
    "  const minutesUntilStart = currentStart ? (currentStart.getTime() - now.getTime()) / 60000 : null;\n" +
    "  const freezeBlocked = minutesUntilStart != null && minutesUntilStart >= 0 && minutesUntilStart < FREEZE_WINDOW_MINUTES;\n" +
    "\n" +
    "  if (freezeBlocked && !overrideFreeze) {\n" +
    "    return res.status(409).json({\n" +
    "      ok: false,\n" +
    "      code: 'FREEZE_WINDOW',\n" +
    "      error: 'This visit starts in ' + Math.max(0, Math.round(minutesUntilStart)) + ' minutes -- inside the freeze-next-60-minutes guardrail. Confirm again to override.',\n" +
    "      minutesUntilStart: Math.round(minutesUntilStart),\n" +
    "    });\n" +
    "  }"
  );
  if (!mv.includes(oldCheck)) {
    console.error('ERROR (move-visit.js): anchor not found for freezeBlocked check. Nothing written. Send this output back.');
    process.exit(1);
  }
  const newCheck = mvNl(
    "  const now = new Date();\n" +
    "  const currentStart = current.startAt ? new Date(current.startAt) : null;\n" +
    "  const minutesUntilStart = currentStart ? (currentStart.getTime() - now.getTime()) / 60000 : null;\n" +
    "  const freezeSettings = await getFreezeWindowSettings();\n" +
    "  const freezeBlocked = freezeSettings.enabled && minutesUntilStart != null && minutesUntilStart >= 0 && minutesUntilStart < freezeSettings.minutes;\n" +
    "\n" +
    "  if (freezeBlocked && !overrideFreeze) {\n" +
    "    return res.status(409).json({\n" +
    "      ok: false,\n" +
    "      code: 'FREEZE_WINDOW',\n" +
    "      error: 'This visit starts in ' + Math.max(0, Math.round(minutesUntilStart)) + ' minutes -- inside the freeze-next-' + freezeSettings.minutes + '-minutes guardrail. Confirm again to override.',\n" +
    "      minutesUntilStart: Math.round(minutesUntilStart),\n" +
    "    });\n" +
    "  }"
  );
  mv = mv.replace(oldCheck, newCheck);

  fs.writeFileSync(mvPath, mv, 'utf8');
  const mvCheck = fs.readFileSync(mvPath, 'utf8');
  if (mvCheck.includes('getFreezeWindowSettings') && mvCheck.includes('freezeSettings.enabled')) {
    console.log('move-visit.js: SUCCESS -- freeze window now reads from workforce_settings. New size: ' + mvCheck.length + ' chars.');
  } else {
    console.error('WARNING (move-visit.js): wrote the file but verification failed. Do not commit -- send this output back.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------
// PART 2: api/track1.js -- new dispatch_settings resource
// ---------------------------------------------------------------------
const t1Path = path.join(__dirname, 'api', 'track1.js');
let t1 = fs.readFileSync(t1Path, 'utf8');
const t1IsCRLF = t1.includes('\r\n');
const t1Nl = (s) => (t1IsCRLF ? s.replace(/\n/g, '\r\n') : s);

if (t1.includes('handleDispatchSettings')) {
  console.log('track1.js: already applied -- nothing to do.');
  process.exit(0);
}

const t1Anchor = t1Nl("async function handleTeam(req, res) {");
if (!t1.includes(t1Anchor)) {
  console.error('ERROR (track1.js): anchor not found for handleTeam(). Nothing written. Send this output back.');
  process.exit(1);
}

const t1Insert = t1Nl(
  "// Dispatch tab polish: persistent freeze-window toggle (item 3 of 4 on\n" +
  "// \"Dispatch tab polish remaining\"). Same dispatch-capable role check\n" +
  "// api/schedule/move-visit.js already trusts for actually moving visits --\n" +
  "// mirrored here (not imported) since this file's own getRequestingProfile\n" +
  "// doesn't carry permissionRoles.\n" +
  "const DISPATCH_ALLOWED_ROLES = ['owner', 'partner', 'office_manager', 'systems_pm', 'dispatch', 'project_manager'];\n" +
  "async function getDispatchPermissionRoles(profile) {\n" +
  "  if (!profile || !profile.email) return [];\n" +
  "  try {\n" +
  "    const userRow = await supabaseRequest(`users?email=eq.${encodeURIComponent(profile.email)}&select=jobber_id&limit=1`);\n" +
  "    const userRows = userRow.ok ? await userRow.json() : [];\n" +
  "    const jobberId = userRows && userRows[0] && userRows[0].jobber_id;\n" +
  "    if (!jobberId) return [];\n" +
  "    const roleRes = await supabaseRequest(`employee_roles?jobber_id=eq.${encodeURIComponent(jobberId)}&select=permission_roles,permission_role`);\n" +
  "    const roleRows = roleRes.ok ? await roleRes.json() : [];\n" +
  "    const roleRow = roleRows && roleRows[0];\n" +
  "    return (roleRow && roleRow.permission_roles) || (roleRow && roleRow.permission_role ? [roleRow.permission_role] : []);\n" +
  "  } catch (e) {\n" +
  "    return [];\n" +
  "  }\n" +
  "}\n" +
  "async function canManageDispatchSettings(requester) {\n" +
  "  if (!requester) return false;\n" +
  "  if (requester.role === 'admin') return true;\n" +
  "  const roles = await getDispatchPermissionRoles(requester);\n" +
  "  return roles.some((r) => DISPATCH_ALLOWED_ROLES.indexOf(r) !== -1);\n" +
  "}\n" +
  "async function handleDispatchSettings(req, res) {\n" +
  "  const requester = await getRequestingProfile(req);\n" +
  "  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in.' });\n" +
  "\n" +
  "  if (req.method === 'POST') {\n" +
  "    const allowed = await canManageDispatchSettings(requester);\n" +
  "    if (!allowed) return res.status(403).json({ ok: false, error: 'Your account is not set up for schedule changes -- ask an admin to add Owner, Dispatch, Office Manager, PM, or Partner to your Crew Roster roles.' });\n" +
  "    const { enabled, minutes } = req.body || {};\n" +
  "    const patch = {};\n" +
  "    if (enabled !== undefined) patch.dispatch_freeze_window_enabled = !!enabled;\n" +
  "    if (minutes !== undefined) {\n" +
  "      const n = Number(minutes);\n" +
  "      if (!Number.isFinite(n) || n < 0 || n > 240) return res.status(400).json({ ok: false, error: 'minutes must be between 0 and 240.' });\n" +
  "      patch.dispatch_freeze_window_minutes = Math.round(n);\n" +
  "    }\n" +
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
  "  const settingsRes = await supabaseRequest('workforce_settings?select=dispatch_freeze_window_enabled,dispatch_freeze_window_minutes&limit=1');\n" +
  "  const settingsRows = settingsRes.ok ? await settingsRes.json() : [];\n" +
  "  const row = (settingsRows && settingsRows[0]) || {};\n" +
  "  return res.status(200).json({\n" +
  "    ok: true,\n" +
  "    enabled: row.dispatch_freeze_window_enabled !== false,\n" +
  "    minutes: Number.isFinite(row.dispatch_freeze_window_minutes) ? row.dispatch_freeze_window_minutes : 60,\n" +
  "  });\n" +
  "}\n" +
  "\n" +
  "async function handleTeam(req, res) {"
);
t1 = t1.replace(t1Anchor, t1Insert);

const t1DispatchAnchor = t1Nl(
  "  if (resource === 'monitor_my_status') {\n" +
  "    try { return await handleMonitorMyStatus(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }\n" +
  "  }"
);
if (!t1.includes(t1DispatchAnchor)) {
  console.error('ERROR (track1.js): anchor not found for dispatcher registration. Nothing written. Send this output back.');
  process.exit(1);
}
const t1DispatchInsert = t1Nl(
  "  if (resource === 'monitor_my_status') {\n" +
  "    try { return await handleMonitorMyStatus(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }\n" +
  "  }\n" +
  "  if (resource === 'dispatch_settings') {\n" +
  "    try { return await handleDispatchSettings(req, res); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }\n" +
  "  }"
);
t1 = t1.replace(t1DispatchAnchor, t1DispatchInsert);

fs.writeFileSync(t1Path, t1, 'utf8');
const t1Check = fs.readFileSync(t1Path, 'utf8');
if (t1Check.includes('handleDispatchSettings') && t1Check.includes("resource === 'dispatch_settings'")) {
  console.log('track1.js: SUCCESS -- dispatch_settings resource added. New size: ' + t1Check.length + ' chars.');
} else {
  console.error('WARNING (track1.js): wrote the file but verification failed. Do not commit -- send this output back.');
  process.exit(1);
}
