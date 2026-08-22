// One-shot patch: public/index.html -- known bug from the master to-do:
// "'Jobs Needing Attention' tile stalls 10-15+s with no loading feedback on
// Command Center." Investigated: there IS a small "Loading..." sub-text,
// but the PRIMARY visual signal -- the big bold number and the status dot
// -- starts as "0" with a GREEN (all-clear) dot before the real fetch ever
// resolves. A manager glancing at the Command Center during that 10-15s
// window sees "0, green dot" (looks like a confirmed all-clear) with only
// small secondary text saying otherwise -- easy to miss, and actively
// misleading in the meantime.
//
// Fix: the tile now starts in an honest neutral/loading state (a muted
// gray dot + "..." instead of a false "0" + green), and the error path
// also flips the dot to the attention color instead of leaving it looking
// clean when the live fetch actually failed.
// Safe to run more than once.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'index.html');
let src = fs.readFileSync(filePath, 'utf8');

if (src.includes('fp mut')) {
  console.log('Already applied -- Jobs Needing Attention loading state already fixed. Nothing to do.');
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

// 1. CSS: neutral/loading dot color, reusing the same var(--mut) the sub-text already uses
applyOnce(
  "  .fp{width:8px;height:8px;border-radius:50%}\n" +
  "  .fp.g{background:var(--green)}.fp.a{background:var(--amber)}",
  "  .fp{width:8px;height:8px;border-radius:50%}\n" +
  "  .fp.g{background:var(--green)}.fp.a{background:var(--amber)}.fp.mut{background:var(--mut)}",
  'neutral dot CSS'
);

// 2. Tile markup: start honest (neutral dot + "..." instead of a false "0, all clear")
applyOnce(
  '<div class="f" style="cursor:default"><div class="k"><span class="fp g" id="rlv-attn-dot"></span>JOBS NEEDING ATTENTION</div><div class="v" id="rlv-attn-v">0 <i class="tr" id="rlv-attn-tr">● live</i></div><div class="s" id="rlv-attn-s">Loading…</div></div>',
  '<div class="f" style="cursor:default"><div class="k"><span class="fp mut" id="rlv-attn-dot"></span>JOBS NEEDING ATTENTION</div><div class="v" id="rlv-attn-v"><span style="color:var(--mut)">···</span> <i class="tr" id="rlv-attn-tr">loading</i></div><div class="s" id="rlv-attn-s">Loading…</div></div>',
  'tile initial-state markup'
);

// 3. Error path: flip the dot to the attention color too, not just the sub-text
applyOnce(
  "  }).catch(function(e){\n" +
  "    var msg = (e && e.message) ? e.message : 'unknown error';\n" +
  "    if(/Failed to fetch|NetworkError|Load failed/i.test(msg)) msg = 'network error reaching the server -- check your internet connection and try again';\n" +
  "    setSub('rlv-attn-s', '⚠️ Could not reach the live data — '+msg);\n" +
  "  });\n" +
  "}\n" +
  "window.loadEstimatesLive = loadEstimatesLive;",
  "  }).catch(function(e){\n" +
  "    var msg = (e && e.message) ? e.message : 'unknown error';\n" +
  "    if(/Failed to fetch|NetworkError|Load failed/i.test(msg)) msg = 'network error reaching the server -- check your internet connection and try again';\n" +
  "    setSub('rlv-attn-s', '⚠️ Could not reach the live data — '+msg);\n" +
  "    setVal('rlv-attn-v', '?');\n" +
  "    var errDotEl = document.getElementById('rlv-attn-dot');\n" +
  "    if(errDotEl) errDotEl.className = 'fp a';\n" +
  "  });\n" +
  "}\n" +
  "window.loadEstimatesLive = loadEstimatesLive;",
  'error path dot + value'
);

fs.writeFileSync(filePath, src, 'utf8');

const check = fs.readFileSync(filePath, 'utf8');
if (check.includes('fp mut') && check.includes("errDotEl.className = 'fp a'") && changes === 3) {
  console.log('SUCCESS: Jobs Needing Attention tile now shows an honest loading state instead of a false 0/all-clear (' + changes + ' edits). New size: ' + check.length + ' chars. Ready to git add/commit/push.');
} else {
  console.error('WARNING: wrote the file but verification did not fully match (changes=' + changes + '). Do not commit -- send this output back.');
  process.exit(1);
}
