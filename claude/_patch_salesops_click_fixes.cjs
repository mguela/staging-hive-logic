// Follow-up fixes (Chris 2026-07-26: "i cant open any of them"):
// 1) The two crew tiles pointed at showView('crew') -- no view-crew exists, so
//    clicking them hid every view (blank screen). Point them at 'schedule'.
// 2) The workforce "End of the business day" modal re-arms on EVERY page load
//    after 3:30 PM while clocked in, and its full-screen backdrop swallows all
//    clicks -- this is what made the tiles (and everything else) unclickable.
//    a) Clicking the dark backdrop now dismisses any workforce modal.
//    b) "Stay clocked in" now remembers the choice for the rest of the day
//       (localStorage), so refreshes stop re-prompting.
// Idempotent.
const fs = require('fs');
const p = 'public/index.html';
let s = fs.readFileSync(p, 'utf8');
if (s.includes('hlWfEodDismissed')) { console.log('ALREADY PATCHED'); process.exit(0); }

function must(name, sub) {
  const c = s.split(sub).length - 1;
  if (c !== 1) { console.error('anchor ' + name + ' count ' + c); process.exit(1); }
}

// ---- 1) tile view names: 'crew' -> 'schedule' ----
const D = String.raw`view:'crew', tone:'info', title:'Today\'s scheduled visits -- click for the crew board'`;
const E = String.raw`view:'crew', tone: opsOpenVal > 0 ? 'bad' : 'good', title:'Visits today with no tech assigned -- click to assign'`;
must('D', D); must('E', E);
s = s.replace(D, String.raw`view:'schedule', tone:'info', title:'Today\'s scheduled visits -- click to open the schedule'`);
s = s.replace(E, String.raw`view:'schedule', tone: opsOpenVal > 0 ? 'bad' : 'good', title:'Visits today with no tech assigned -- click to open the schedule'`);

// ---- 2a) backdrop click dismisses workforce modals ----
const A = "modal.style.cssText = 'position:fixed;inset:0;background:rgba(10,14,22,.55);z-index:10050;display:flex;align-items:center;justify-content:center';";
must('A', A);
s = s.replace(A, A + "\n  modal.addEventListener('click', function(ev){ if (ev.target === modal) modal.remove(); });");

// ---- 2b) EOD prompt: once per day after "Stay clocked in" ----
const B = '    if (!hlWfSettings || hlWfEodPromptShown) return;';
must('B', B);
s = s.replace(B, B + "\n    try { if (localStorage.getItem('hlWfEodDismissed') === new Date().toDateString()) return; } catch (e) {}");

const C = "          { label: 'Stay clocked in', onClick: function(){} },";
must('C', C);
s = s.replace(C, "          { label: 'Stay clocked in', onClick: function(){ try { localStorage.setItem('hlWfEodDismissed', new Date().toDateString()); } catch (e) {} } },");

fs.writeFileSync(p, s);
console.log('PATCHED OK');
