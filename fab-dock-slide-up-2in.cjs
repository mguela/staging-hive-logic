// One-shot patch: public/index.html -- Chris asked to "slide all [3 fab
// dock buttons] up about 2 inch." The reorder (Monitor on top) and labels
// on all 3 buttons were already shipped separately (by the automated Reina
// build pipeline working the same repo). This patch only handles the
// remaining "move up 2 inches" part: raises the #hl-fabdock bottom offset
// by 2 real CSS inches (96px/in, fixed regardless of actual screen DPI),
// in both its normal and HiveConnect-open states.
// Safe to run more than once.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'index.html');
let src = fs.readFileSync(filePath, 'utf8');

if (src.includes('calc(20px + 2in)')) {
  console.log('Already applied -- dock is already slid up 2in. Nothing to do.');
  process.exit(0);
}

const isCRLF = src.includes('\r\n');
const nl = (s) => (isCRLF ? s.replace(/\n/g, '\r\n') : s);

const oldS = nl(
  "  #hl-fabdock{position:fixed;right:16px;bottom:20px;z-index:99990;display:flex;flex-direction:column;align-items:center;gap:9px;background:none;border:none;border-radius:0;padding:0;box-shadow:none;transition:bottom .18s ease}\n" +
  "  body.hc-open #hl-fabdock{bottom:110px}"
);
const newS = nl(
  "  #hl-fabdock{position:fixed;right:16px;bottom:calc(20px + 2in);z-index:99990;display:flex;flex-direction:column;align-items:center;gap:9px;background:none;border:none;border-radius:0;padding:0;box-shadow:none;transition:bottom .18s ease}\n" +
  "  body.hc-open #hl-fabdock{bottom:calc(110px + 2in)}"
);

if (!src.includes(oldS)) {
  console.error('ERROR: anchor not found for dock bottom offset. Nothing written. Send this output back.');
  process.exit(1);
}
src = src.replace(oldS, newS);

fs.writeFileSync(filePath, src, 'utf8');

const check = fs.readFileSync(filePath, 'utf8');
if (check.includes('calc(20px + 2in)') && check.includes('calc(110px + 2in)')) {
  console.log('SUCCESS: fab dock (Monitor/Reina/Chirp) moved up 2in in both states. New size: ' + check.length + ' chars. Ready to git add/commit/push.');
} else {
  console.error('WARNING: wrote the file but verification failed. Do not commit -- send this output back.');
  process.exit(1);
}
