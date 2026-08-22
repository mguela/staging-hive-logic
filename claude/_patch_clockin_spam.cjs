// Stop the repeating "Clock in?" popup (Chris 2026-07-28: "If I'm not clocked
// in, it keeps popping up a window repeatedly, not just once every hour").
//
// CAUSE: hlWorkforceArmClockInPrompt() re-arms on every page load AND every
// hlWorkforceInitGlobalWidgets re-entry (index.html:23292), and its guard
// var hlWfClockInPromptShown resets to false on each load -> the modal fires
// 2.5s after every navigation/refresh.
//
// FIX (mirrors the EOD-prompt fix already shipped): after the user clicks
// "Not now", remember it in localStorage for the rest of the day, and skip the
// prompt when that flag is set. Clocking in stops it via the existing
// isClockedIn guard. Idempotent, exact-count-verified.
const fs = require('fs');
const p = 'public/index.html';
let s = fs.readFileSync(p, 'utf8');
if (s.includes('hlWfClockInDismissed')) { console.log('ALREADY PATCHED'); process.exit(0); }

function must(name, sub) { const c = s.split(sub).length - 1; if (c !== 1) { console.error('anchor ' + name + ' count ' + c); process.exit(1); } }

const A = "    if (hlWfClockInPromptShown) return;";
const B = "        { label: 'Not now', onClick: function(){} },";
must('A', A); must('B', B);

s = s.replace(A, A + "\n    try { if (localStorage.getItem('hlWfClockInDismissed') === new Date().toDateString()) return; } catch (e) {}");
s = s.replace(B, "        { label: 'Not now', onClick: function(){ try { localStorage.setItem('hlWfClockInDismissed', new Date().toDateString()); } catch (e) {} } },");

fs.writeFileSync(p, s);
console.log('PATCHED OK');
