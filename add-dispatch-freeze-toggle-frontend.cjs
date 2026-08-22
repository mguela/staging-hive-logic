// One-shot patch: public/index.html -- Dispatch tab polish item #3:
// persistent freeze-window toggle. Adds a dispatcher-facing button next to
// "Simulate live day" that shows/toggles the real, persistent freeze-window
// guardrail (backend half shipped separately in
// add-dispatch-freeze-toggle-backend.cjs -- new dispatch_settings resource).
// Safe to run more than once.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'index.html');
let src = fs.readFileSync(filePath, 'utf8');

if (src.includes('DISPATCH_FREEZE')) {
  console.log('Already applied -- dispatch freeze toggle already in place. Nothing to do.');
  process.exit(0);
}

if (!src.includes('function dispatchTechs(){')) {
  console.error('ERROR: anchor not found for dispatchTechs(). Nothing written. Send this output back.');
  process.exit(1);
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

// 1. CSS: freeze button styling, matching the existing .simbtn pattern
applyOnce(
  "  .simbtn{padding:7px 13px;font-size:11px;font-weight:800}\n" +
  "  .simbtn.live{background:#fbe9e6;border-color:#eec6bf;color:#a83b2c;font-family:var(--mono)}",
  "  .simbtn{padding:7px 13px;font-size:11px;font-weight:800}\n" +
  "  .simbtn.live{background:#fbe9e6;border-color:#eec6bf;color:#a83b2c;font-family:var(--mono)}\n" +
  "  .freezebtn{padding:7px 13px;font-size:11px;font-weight:800}\n" +
  "  .freezebtn.on{background:#e9f5ef;border-color:#bfe3d1;color:#1B7A50}\n" +
  "  .freezebtn.off{background:#fbe9e6;border-color:#eec6bf;color:#a83b2c}",
  'freeze button CSS'
);

// 2. Global state + load/toggle functions, right before dispatchTechs()
applyOnce(
  "function dispatchTechs(){",
  "// Dispatch tab polish: persistent freeze-window toggle. Real, persistent\n" +
  "// setting (workforce_settings.dispatch_freeze_window_enabled/_minutes) --\n" +
  "// api/schedule/move-visit.js re-checks this live against Jobber on every\n" +
  "// write, this UI is just the dispatcher-facing view/control of it.\n" +
  "var DISPATCH_FREEZE = {enabled:true, minutes:60, loaded:false, loading:false};\n" +
  "function dispatchFreezeLoad(){\n" +
  "  if(DISPATCH_FREEZE.loading) return;\n" +
  "  DISPATCH_FREEZE.loading = true;\n" +
  "  return hlRequireSession(async function(sess){\n" +
  "    try{\n" +
  "      var r = await fetch('/api/track1?resource=dispatch_settings', { headers:{ Authorization:'Bearer '+sess.access_token } });\n" +
  "      var data = await r.json().catch(function(){return null;});\n" +
  "      if(data && data.ok!==false){ DISPATCH_FREEZE={enabled:data.enabled, minutes:data.minutes, loaded:true, loading:false}; if(typeof renderCal==='function') renderCal(); }\n" +
  "      else { DISPATCH_FREEZE.loading=false; }\n" +
  "    }catch(e){ DISPATCH_FREEZE.loading=false; }\n" +
  "  }, function(){ DISPATCH_FREEZE.loading=false; });\n" +
  "}\n" +
  "window.dispatchFreezeToggle = function(){\n" +
  "  var next = !DISPATCH_FREEZE.enabled;\n" +
  "  var prev = DISPATCH_FREEZE.enabled;\n" +
  "  DISPATCH_FREEZE.enabled = next;\n" +
  "  if(typeof renderCal==='function') renderCal();\n" +
  "  return hlRequireSession(async function(sess){\n" +
  "    var r = await fetch('/api/track1?resource=dispatch_settings', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+sess.access_token }, body: JSON.stringify({ enabled: next }) });\n" +
  "    var data = await r.json().catch(function(){return null;});\n" +
  "    if(!data || data.ok===false){\n" +
  "      DISPATCH_FREEZE.enabled = prev; if(typeof renderCal==='function') renderCal();\n" +
  "      if(window.chirpToast) chirpToast('&#9888;&#65039; ' + ((data&&data.error)||'Could not update the freeze-window setting.'));\n" +
  "      return;\n" +
  "    }\n" +
  "    DISPATCH_FREEZE = {enabled:data.enabled, minutes:data.minutes, loaded:true, loading:false};\n" +
  "    if(window.chirpToast) chirpToast(data.enabled ? ('&#9989; Freeze window ON &#8212; visits starting in the next '+data.minutes+'m are protected from accidental drags.') : '&#9940; Freeze window OFF &#8212; visits can be rescheduled any time, including last-minute.');\n" +
  "    if(typeof renderCal==='function') renderCal();\n" +
  "  }, function(){ DISPATCH_FREEZE.enabled = prev; });\n" +
  "};\n" +
  "function dispatchTechs(){",
  'freeze state + load/toggle functions'
);

// 3. Kick off the load once per page (guarded), from inside renderDay()
applyOnce(
  "function renderDay(){\n" +
  "  var techs=dispatchTechs();",
  "function renderDay(){\n" +
  "  if(!DISPATCH_FREEZE.loaded && !DISPATCH_FREEZE.loading) dispatchFreezeLoad();\n" +
  "  var techs=dispatchTechs();",
  'renderDay() freeze-load kickoff'
);

// 4. The toggle button itself, next to "Simulate live day"
applyOnce(
  "+'<button class=\"btn-ghost simbtn'+(SIM.on?' live':'')+'\" onclick=\"simToggle()\">'+(SIM.on?'<span class=\"reddot\"></span> LIVE &#183; '+simLbl(SIM.t)+' &#183; stop':'&#9654; Simulate live day &#8212; GPS drives the board')+'</button></div>';",
  "+'<button class=\"btn-ghost simbtn'+(SIM.on?' live':'')+'\" onclick=\"simToggle()\">'+(SIM.on?'<span class=\"reddot\"></span> LIVE &#183; '+simLbl(SIM.t)+' &#183; stop':'&#9654; Simulate live day &#8212; GPS drives the board')+'</button>'\n" +
  "    +'<button class=\"btn-ghost freezebtn '+(DISPATCH_FREEZE.enabled?'on':'off')+'\" onclick=\"dispatchFreezeToggle()\" title=\"Blocks last-minute reschedules of visits starting soon. Click to toggle.\">'+(DISPATCH_FREEZE.enabled?'&#10003; Freeze next '+DISPATCH_FREEZE.minutes+'m: ON':'&#9711; Freeze window: OFF')+'</button></div>';",
  'freeze toggle button in dpctl bar'
);

fs.writeFileSync(filePath, src, 'utf8');

const check = fs.readFileSync(filePath, 'utf8');
const need = ['DISPATCH_FREEZE', 'dispatchFreezeLoad', 'window.dispatchFreezeToggle', 'freezebtn'];
const missing = need.filter((n) => !check.includes(n));
if (!missing.length && changes === 4) {
  console.log('SUCCESS: persistent freeze-window toggle added to Dispatch board (' + changes + ' edits). New size: ' + check.length + ' chars. Ready to git add/commit/push.');
} else {
  console.error('WARNING: wrote the file but verification did not fully match (missing: ' + missing.join(', ') + ', changes=' + changes + '). Do not commit -- send this output back.');
  process.exit(1);
}
