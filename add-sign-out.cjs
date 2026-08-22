// One-shot patch: adds a real Sign Out feature. Chris: "I justed realized
// theres no way to sign out of the app it should live in the settings tab
// and when you click your profile button on the top right."
// Adds:
//   1. window.hlSignOut() -- calls sb.auth.signOut(), clears the modal/
//      top-clock dropdown, toasts, then reloads the page (the existing
//      hlTrySilentLogin() boot logic already shows the login screen
//      whenever there's no active session, so a reload is all that's
//      needed to land back on it cleanly).
//   2. A "Sign out" button inside the profile modal (opened by clicking the
//      avatar in the top right -- hlProfile()).
//   3. A "Sign Out" row inside the sidebar's Settings group (grp-ops),
//      alongside Company Setup / V63 Review.
// Safe to run more than once.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'index.html');
let src = fs.readFileSync(filePath, 'utf8');

if (src.includes('window.hlSignOut')) {
  console.log('Already applied -- Sign Out already exists. Nothing to do.');
  process.exit(0);
}

if (!src.includes(`function hlProfile(){`)) {
  console.error('ERROR: hlProfile() not found. Nothing written. Send this output back.');
  process.exit(1);
}
if (!src.includes(`<div id="grp-ops" style="display:none">`)) {
  console.error('ERROR: sidebar grp-ops Settings group not found. Nothing written. Send this output back.');
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

// --- 1. Sign Out button inside the profile modal (avatar click) ---
applyOnce(
  `Save profile</button>');
}`,
  `Save profile</button><button onclick="hlSignOut()" style="width:100%;margin-top:8px;padding:12px;border:1px solid #c0392b;border-radius:9px;background:#fff;color:#c0392b;font-family:\\'Montserrat\\',sans-serif;font-weight:900;font-size:11px;letter-spacing:.06em;text-transform:uppercase;cursor:pointer">🚪 Sign out</button>');
}`,
  'hlProfile modal body (Save profile button)'
);

// --- 2. Sign Out row in the sidebar Settings group ---
applyOnce(
  `      <div class="nav" id="nav-phx" onclick="showView('phx')" style="padding-left:26px;font-size:12px"><span class="ic" style="font-size:12px;display:flex;align-items:center;justify-content:center">⬡</span>V63 Review</div>`,
  `      <div class="nav" id="nav-phx" onclick="showView('phx')" style="padding-left:26px;font-size:12px"><span class="ic" style="font-size:12px;display:flex;align-items:center;justify-content:center">⬡</span>V63 Review</div>
      <div class="nav" id="nav-signout" onclick="hlSignOut()" style="padding-left:26px;font-size:12px;color:#c0392b"><span class="ic" style="font-size:12px;display:flex;align-items:center;justify-content:center">🚪</span>Sign Out</div>`,
  'sidebar grp-ops (after nav-phx)'
);

// --- 3. window.hlSignOut() itself, right after hlSaveProfile() ---
applyOnce(
  `  hlSyncProfileUI();
  document.getElementById('hlmodal').remove(); hlSay('✓ Profile saved');
}`,
  `  hlSyncProfileUI();
  document.getElementById('hlmodal').remove(); hlSay('✓ Profile saved');
}
window.hlSignOut = async function(){
  try{
    if(window.hlTopClockClose) hlTopClockClose();
    var m=document.getElementById('hlmodal'); if(m) m.remove();
    if(window.chirpToast) chirpToast('👋 Signing out…');
    await sb.auth.signOut();
  }catch(e){ console.error('HiveLogic: sign out failed', e); }
  setTimeout(function(){ location.reload(); }, 300);
};`,
  'hlSaveProfile end (add hlSignOut function)'
);

fs.writeFileSync(filePath, src, 'utf8');

const check = fs.readFileSync(filePath, 'utf8');
const need = ['window.hlSignOut', 'nav-signout', '🚪 Sign out'];
const missing = need.filter((n) => !check.includes(n));
if (!missing.length) {
  console.log('SUCCESS: Sign Out added (profile modal + sidebar Settings) (' + changes + ' edits). New size: ' + check.length + ' chars. Ready to git add/commit/push.');
} else {
  console.error('WARNING: wrote the file but verification did not find: ' + missing.join(', ') + '. Do not commit -- send this output back.');
  process.exit(1);
}
