// Pause background POLLERS when the browser tab is hidden (Chris 2026-07-28:
// app feels sluggish; audit found a poller storm — 153 calls/15min idle).
//
// SAFETY (this is the whole point — "don't break anything"):
// - Gates ONLY on document.hidden. When the tab is visible, behavior is
//   byte-identical to today. When hidden, these timers skip their work.
// - The Command Center already has a `visibilitychange` handler
//   (index.html:23122) that reloads ALL of these the moment the tab returns to
//   visible, so gating them on hidden introduces ZERO staleness.
// - Deliberately DOES NOT touch the workforce idle-timer, EOD prompt, clock-in
//   prompt, or monitor timers — those SHOULD keep running when the user steps
//   away (e.g. idle auto-clock-out). Only pure data-refresh pollers are gated.
//
// Scope of change:
//   1. The 11 Command Center data pollers (loadMapLive/…/loadTodaySchedule).
//   2. hlTmLiveFetch (the unconditional /api/track1?resource=tm_live every 15s).
// Idempotent, exact-count-verified.
const fs = require('fs');
const p = 'public/index.html';
let s = fs.readFileSync(p, 'utf8');
if (s.includes('/*hidden-gate*/')) { console.log('ALREADY PATCHED'); process.exit(0); }

// ---- 1) the 11 CC pollers: setInterval(function(){ loadX(); ccMarkSynced(); }, N); ----
const ccRe = /setInterval\(function\(\)\{ (load\w+\(\); ccMarkSynced\(\);) \}, (\d+)\);/g;
const ccMatches = s.match(ccRe) || [];
if (ccMatches.length !== 11) { console.error('EXPECTED 11 CC pollers, found ' + ccMatches.length + ' -- aborting'); process.exit(1); }
s = s.replace(ccRe, 'setInterval(function(){ /*hidden-gate*/if(document.hidden)return; $1 }, $2);');

// ---- 2) hlTmLiveFetch: unconditional 15s fetch ----
const tmAnchor = 'function hlTmLiveFetch(){';
const tmCount = s.split(tmAnchor).length - 1;
if (tmCount !== 1) { console.error('hlTmLiveFetch anchor count ' + tmCount); process.exit(1); }
s = s.replace(tmAnchor, tmAnchor + ' /*hidden-gate*/if(document.hidden)return;');

fs.writeFileSync(p, s);
console.log('PATCHED: 11 CC pollers + hlTmLiveFetch gated on document.hidden');
