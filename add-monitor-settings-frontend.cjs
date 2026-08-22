// One-shot patch: public/index.html -- Monitor Settings UI. Chris: "the
// monitor needs settings -- how often the screenshots are, if they get
// blurred, toggle the monitoring on/off for users. next to the pulsing
// reina button and chirp button should be a similar shaped button that
// looks like a recording button to indicate to the use that tracking is
// on. when its off the button turns gray and dormant."
// Adds:
//   1. A "Settings" button on the Monitor Review page (Manager's > Monitor)
//      that opens a modal: screenshot interval, blur toggle, and a switch
//      per paired employee to turn their monitoring on/off.
//   2. A round "recording" indicator button (#hlMonFab) that joins the
//      Reina/Chirp button dock -- red + pulsing while Monitor is actively
//      recording for the signed-in user, gray/dormant otherwise. Polls
//      monitor_my_status every 30s once signed in.
// Safe to run more than once.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'index.html');
let src = fs.readFileSync(filePath, 'utf8');

if (src.includes('hlMonFab')) {
  console.log('Already applied -- Monitor Settings frontend already exists. Nothing to do.');
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

// --- 1. CSS: dock sizing override for the new fab, next to rnaFab's ---
applyOnce(
  "  #hl-fabdock #rnaFab{position:relative;right:auto;bottom:auto;width:46px;height:46px;box-shadow:none;font-size:19px} /* relative (not static) so its pulse ring hugs the button, not the whole dock */",
  "  #hl-fabdock #rnaFab{position:relative;right:auto;bottom:auto;width:46px;height:46px;box-shadow:none;font-size:19px} /* relative (not static) so its pulse ring hugs the button, not the whole dock */\n" +
  "  #hl-fabdock #hlMonFab{position:relative;right:auto;bottom:auto;width:46px;height:46px;box-shadow:none;font-size:17px}",
  'dock CSS override for hlMonFab'
);

// --- 2. CSS: base hlMonFab look, right after the rnaPulse keyframes ---
applyOnce(
  "@keyframes rnaPulse{0%{transform:scale(.9);opacity:.7}70%{transform:scale(1.25);opacity:0}100%{opacity:0}}",
  "@keyframes rnaPulse{0%{transform:scale(.9);opacity:.7}70%{transform:scale(1.25);opacity:0}100%{opacity:0}}\n" +
  "#hlMonFab{position:fixed;right:26px;bottom:222px;z-index:99990;width:58px;height:58px;border-radius:50%;background:#6b7280;color:#fff;border:none;cursor:pointer;font-size:20px;box-shadow:0 10px 26px rgba(0,0,0,.3);display:none;align-items:center;justify-content:center;transition:background .2s,transform .15s}\n" +
  "#hlMonFab:hover{transform:scale(1.08)}\n" +
  "#hlMonFab .pulse{position:absolute;inset:-4px;border-radius:50%;border:2px solid #c0392b;opacity:0}\n" +
  "#hlMonFab.hlmon-on{background:#c0392b;box-shadow:0 10px 26px rgba(192,57,43,.5)}\n" +
  "#hlMonFab.hlmon-on .pulse{animation:rnaPulse 2.6s infinite}",
  'hlMonFab base CSS'
);

// --- 3. Markup: the button itself, right after rnaFab's button tag ---
applyOnce(
  '<button id="rnaFab" title="Talk to Reina (⌘J)" style="display:none"><span class="pulse"></span>⬡</button>',
  '<button id="rnaFab" title="Talk to Reina (⌘J)" style="display:none"><span class="pulse"></span>⬡</button>\n' +
  '<button id="hlMonFab" title="Tracking status" style="display:none"><span class="pulse"></span>⏺</button>',
  'hlMonFab button markup'
);

// --- 4. Dock-merge script: also move hlMonFab into the dock ---
applyOnce(
  "    var rf=document.getElementById('rnaFab');\n" +
  "    var pt=document.getElementById('pttfab')||document.querySelector('.pttfab');\n" +
  "    if(!rf&&!pt)return;\n" +
  "    var dock=document.createElement('div');dock.id='hl-fabdock';\n" +
  "    document.body.appendChild(dock);\n" +
  "    if(rf)dock.appendChild(rf);\n" +
  "    if(pt)dock.appendChild(pt);",

  "    var rf=document.getElementById('rnaFab');\n" +
  "    var pt=document.getElementById('pttfab')||document.querySelector('.pttfab');\n" +
  "    var mf=document.getElementById('hlMonFab');\n" +
  "    if(!rf&&!pt&&!mf)return;\n" +
  "    var dock=document.createElement('div');dock.id='hl-fabdock';\n" +
  "    document.body.appendChild(dock);\n" +
  "    if(rf)dock.appendChild(rf);\n" +
  "    if(pt)dock.appendChild(pt);\n" +
  "    if(mf)dock.appendChild(mf);",
  'dock-merge script include hlMonFab'
);

// --- 5. Hook hlMonitorFabInit() into the same two post-login points as hlWorkforceInitGlobalWidgets ---
applyOnce(
  "if(window.hlWorkforceInitGlobalWidgets) setTimeout(hlWorkforceInitGlobalWidgets, 1400);",
  "if(window.hlWorkforceInitGlobalWidgets) setTimeout(hlWorkforceInitGlobalWidgets, 1400);\n" +
  "    if(window.hlMonitorFabInit) setTimeout(hlMonitorFabInit, 1500);",
  'hook hlMonitorFabInit at post-login points',
);
// (the anchor above appears twice in the file at the two login-success sites -- replace both)
{
  const anchor = nl("if(window.hlWorkforceInitGlobalWidgets) setTimeout(hlWorkforceInitGlobalWidgets, 1400);");
  const replacement = nl(
    "if(window.hlWorkforceInitGlobalWidgets) setTimeout(hlWorkforceInitGlobalWidgets, 1400);\n" +
    "    if(window.hlMonitorFabInit) setTimeout(hlMonitorFabInit, 1500);"
  );
  // The first occurrence was already replaced by applyOnce above (String.replace only
  // touches the first match). Replace the SECOND remaining original occurrence too.
  if (src.includes(anchor)) {
    src = src.replace(anchor, replacement);
    changes++;
  }
}

// --- 6. Settings button on the Monitor Review page header ---
applyOnce(
  '<button onclick="mgrMonRefresh()" style="font-size:10px;font-weight:800;padding:7px 14px;border-radius:99px;background:#fff;border:1px solid var(--line);color:#5d657b;cursor:pointer;font-family:Montserrat">Refresh</button>',
  '<button onclick="hlMonitorSettingsOpen()" style="font-size:10px;font-weight:800;padding:7px 14px;border-radius:99px;background:#fff;border:1px solid var(--line);color:#5d657b;cursor:pointer;font-family:Montserrat;margin-right:6px">⚙ Settings</button>\n' +
  '      <button onclick="mgrMonRefresh()" style="font-size:10px;font-weight:800;padding:7px 14px;border-radius:99px;background:#fff;border:1px solid var(--line);color:#5d657b;cursor:pointer;font-family:Montserrat">Refresh</button>',
  'Settings button on Monitor Review header'
);

// --- 7. All the new JS: fab polling + settings modal + per-user toggle. Anchored to end of hlSaveProfile() (same spot Sign Out hooked into). ---
applyOnce(
  "  hlSyncProfileUI();\n" +
  "  document.getElementById('hlmodal').remove(); hlSay('✓ Profile saved');\n" +
  "}",

  "  hlSyncProfileUI();\n" +
  "  document.getElementById('hlmodal').remove(); hlSay('✓ Profile saved');\n" +
  "}\n" +
  "\n" +
  "// --- HiveLogic Monitor: recording indicator (top-bar fab) + Monitor Settings ---\n" +
  "window.hlMonitorFabInit = function(){\n" +
  "  var btn = document.getElementById('hlMonFab');\n" +
  "  if(!btn) return;\n" +
  "  if(!btn.dataset.wired){\n" +
  "    btn.dataset.wired = '1';\n" +
  "    btn.style.display = 'flex';\n" +
  "    btn.onclick = function(){\n" +
  "      if(window.chirpToast) chirpToast(btn.classList.contains('hlmon-on') ? '⏺ HiveLogic Monitor is actively recording your screen activity right now.' : '⚪ HiveLogic Monitor is not recording right now.');\n" +
  "    };\n" +
  "    setInterval(hlMonitorFabPoll, 30000);\n" +
  "  }\n" +
  "  hlMonitorFabPoll();\n" +
  "};\n" +
  "window.hlMonitorFabPoll = function(){\n" +
  "  var btn = document.getElementById('hlMonFab');\n" +
  "  if(!btn) return;\n" +
  "  return hlRequireSession(async function(sess){\n" +
  "    try{\n" +
  "      var r = await fetch('/api/track1?resource=monitor_my_status', { headers:{ Authorization:'Bearer '+sess.access_token } });\n" +
  "      var data = await r.json().catch(function(){return null;});\n" +
  "      if(data && data.recording){\n" +
  "        btn.classList.add('hlmon-on');\n" +
  "        btn.title = 'HiveLogic Monitor is recording activity + screenshots right now';\n" +
  "      } else {\n" +
  "        btn.classList.remove('hlmon-on');\n" +
  "        btn.title = (data && data.clockedIn) ? 'Clocked in — monitoring not active' : 'Not being tracked right now';\n" +
  "      }\n" +
  "    }catch(e){}\n" +
  "  }, function(){});\n" +
  "};\n" +
  "window.hlMonitorSettingsOpen = function(){\n" +
  "  return hlRequireSession(async function(sess){\n" +
  "    var r = await fetch('/api/track1?resource=monitor_settings', { headers:{ Authorization:'Bearer '+sess.access_token } });\n" +
  "    var data = await r.json().catch(function(){return null;});\n" +
  "    if(!data || data.ok===false){ if(window.chirpToast) chirpToast('⚠️ ' + ((data&&data.error)||'Could not load Monitor settings.')); return; }\n" +
  "    var mins=[1,2,3,5,10,15,20,30];\n" +
  "    var opts = mins.map(function(m){ return '<option value=\"'+m+'\"'+(m===data.screenshotIntervalMinutes?' selected':'')+'>Every '+m+' minute'+(m===1?'':'s')+'</option>'; }).join('');\n" +
  "    var roster = data.roster || [];\n" +
  "    var rosterHtml = roster.length ? roster.map(function(p){\n" +
  "      return '<div style=\"'+_row+'\">'+p.name+'<span style=\"font-size:9px;color:#8b92a8;font-weight:700;margin-left:6px\">'+(p.status==='active'?'paired':'not paired')+'</span><input type=\"checkbox\" '+(p.monitoringEnabled?'checked':'')+' onchange=\"hlMonitorUserToggle(\\''+p.employeeId+'\\', this.checked, this)\" style=\"'+_sw+'\"></div>';\n" +
  "    }).join('') : '<div style=\"font-size:11px;color:#8b92a8;font-weight:600;padding:6px 0\">No one has paired HiveLogic Monitor yet.</div>';\n" +
  "    hlModal('🖥️ Monitor Settings', '<span style=\"'+_lbl+'\">Screenshot frequency</span><select id=\"hlmon-interval\" style=\"'+_inp+'\">'+opts+'</select><span style=\"'+_lbl+'\">Privacy</span><div style=\"'+_row+'\">Blur screenshots<input type=\"checkbox\" id=\"hlmon-blur\" '+(data.blurScreenshots?'checked':'')+' style=\"'+_sw+'\"></div><span style=\"'+_lbl+'\">Monitoring on/off per person</span>'+rosterHtml+'<button onclick=\"hlMonitorSettingsSave()\" style=\"width:100%;margin-top:14px;padding:12px;border:none;border-radius:9px;background:#59718a;color:#fff;font-family:\\'Montserrat\\',sans-serif;font-weight:900;font-size:11px;letter-spacing:.06em;text-transform:uppercase;cursor:pointer\">Save settings</button>');\n" +
  "  }, function(){ if(window.chirpToast) chirpToast('Sign in to view this.'); });\n" +
  "};\n" +
  "window.hlMonitorSettingsSave = function(){\n" +
  "  return hlRequireSession(async function(sess){\n" +
  "    var intervalEl = document.getElementById('hlmon-interval');\n" +
  "    var blurEl = document.getElementById('hlmon-blur');\n" +
  "    var r = await fetch('/api/track1?resource=monitor_settings', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+sess.access_token }, body: JSON.stringify({ screenshotIntervalMinutes: Number(intervalEl.value), blurScreenshots: blurEl.checked }) });\n" +
  "    var data = await r.json().catch(function(){return null;});\n" +
  "    if(!data || data.ok===false){ if(window.chirpToast) chirpToast('⚠️ ' + ((data&&data.error)||'Could not save.')); return; }\n" +
  "    var m=document.getElementById('hlmodal'); if(m) m.remove();\n" +
  "    if(window.chirpToast) chirpToast('✅ Monitor settings saved.');\n" +
  "  });\n" +
  "};\n" +
  "window.hlMonitorUserToggle = function(employeeId, enabled, checkboxEl){\n" +
  "  return hlRequireSession(async function(sess){\n" +
  "    var r = await fetch('/api/track1?resource=monitor_user_toggle', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+sess.access_token }, body: JSON.stringify({ employeeId: employeeId, monitoringEnabled: enabled }) });\n" +
  "    var data = await r.json().catch(function(){return null;});\n" +
  "    if(!data || data.ok===false){ if(checkboxEl) checkboxEl.checked = !enabled; if(window.chirpToast) chirpToast('⚠️ ' + ((data&&data.error)||'Could not update.')); return; }\n" +
  "    if(window.chirpToast) chirpToast(enabled ? '✅ Monitoring turned on.' : '⛔ Monitoring turned off.');\n" +
  "  });\n" +
  "};",
  'Monitor Settings JS (fab polling + settings modal + per-user toggle)'
);

fs.writeFileSync(filePath, src, 'utf8');

const check = fs.readFileSync(filePath, 'utf8');
const need = ['hlMonFab', 'hlMonitorFabInit', 'hlMonitorSettingsOpen', 'hlMonitorSettingsSave', 'hlMonitorUserToggle', 'monitor_my_status', 'monitor_settings', 'monitor_user_toggle'];
const missing = need.filter((n) => !check.includes(n));
const stillOneHook = (check.match(/hlMonitorFabInit, 1500/g) || []).length;
if (!missing.length && stillOneHook >= 2) {
  console.log('SUCCESS: Monitor Settings frontend added (' + changes + ' edits, ' + stillOneHook + ' login hooks). New size: ' + check.length + ' chars. Ready to git add/commit/push.');
} else {
  console.error('WARNING: wrote the file but verification failed -- missing: ' + missing.join(', ') + '; login hooks found: ' + stillOneHook + ' (expected 2). Do not commit -- send this output back.');
  process.exit(1);
}
