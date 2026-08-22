// One-shot patch: public/index.html -- Chris: "rename GH Project Updates to
// Project Updates." Renames the user-facing label in three spots: the left
// nav item, the page header (h2), and the generic load-error fallback text.
// Leaves the description line referencing the actual external Google Sheet
// ("...real GH Project Updates Google Sheet...") unchanged, since that is
// the source spreadsheet's real name, not the app's feature label. Also
// leaves internal ids/function names (view-gpux, nav-gpux, mgrGhRefresh,
// resource=manager_gh_updates) untouched -- renaming those is unnecessary
// and adds risk for a pure text-label change.
// Safe to run more than once.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'index.html');
let src = fs.readFileSync(filePath, 'utf8');

const isCRLF = src.includes('\r\n');
const nl = (s) => (isCRLF ? s.replace(/\n/g, '\r\n') : s);
let changes = 0;
function applyOnce(oldRaw, newRaw, label, optional) {
  const oldS = nl(oldRaw);
  const newS = nl(newRaw);
  if (!src.includes(oldS)) {
    if (optional) { console.log('SKIP (already applied or not found): ' + label); return; }
    console.error('ERROR: anchor not found for "' + label + '". Nothing written. Send this output back.');
    process.exit(1);
  }
  src = src.replace(oldS, newS);
  changes++;
}

// 1. Nav item label
applyOnce(
  '<span class="ic" style="font-size:12px;display:flex;align-items:center;justify-content:center">🏗️</span>GH Project Updates</div>',
  '<span class="ic" style="font-size:12px;display:flex;align-items:center;justify-content:center">🏗️</span>Project Updates</div>',
  'nav label'
);

// 2. Page header (h2)
applyOnce(
  '<h2 style="margin:0;font-family:Montserrat;font-size:15px;font-weight:900">GH Project Updates</h2>',
  '<h2 style="margin:0;font-family:Montserrat;font-size:15px;font-weight:900">Project Updates</h2>',
  'page header'
);

// 3. Generic load-error fallback text
applyOnce(
  "if(!data || data.ok===false){ tableEl.textContent = (data&&data.error) || 'Could not load GH Project Updates.'; return; }",
  "if(!data || data.ok===false){ tableEl.textContent = (data&&data.error) || 'Could not load Project Updates.'; return; }",
  'load-error fallback text'
);

fs.writeFileSync(filePath, src, 'utf8');

const check = fs.readFileSync(filePath, 'utf8');
const stillHasNavOld = check.includes('>GH Project Updates</div>');
const hasNewNav = check.includes('>Project Updates</div>');
if (hasNewNav && !stillHasNavOld && changes > 0) {
  console.log('SUCCESS: renamed GH Project Updates -> Project Updates (' + changes + ' edits). New size: ' + check.length + ' chars. Ready to git add/commit/push.');
} else if (changes === 0) {
  console.log('Already applied -- nothing to do.');
} else {
  console.error('WARNING: wrote the file but verification did not fully match. Do not commit -- send this output back.');
  process.exit(1);
}
