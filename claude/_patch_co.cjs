// Idempotent patch: replace the dead view-co iframe mock with a real, wired
// Change Orders view, and add the showView('co') loader hook.
const fs = require('fs');
const P = 'public/index.html';
const BLOCK = fs.readFileSync('claude/_co_view.html', 'utf8');
let s = fs.readFileSync(P, 'utf8');

// --- 1) validate the inline JS in the new block before touching anything ---
const scriptM = BLOCK.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptM) { console.log('NO_SCRIPT_IN_BLOCK'); process.exit(1); }
try { new Function(scriptM[1]); console.log('inline_js_syntax=OK'); }
catch (e) { console.log('INLINE_JS_SYNTAX_ERROR: ' + e.message); process.exit(1); }

// --- 2) splice the view region: from <div id="view-co" ... up to <div id="view-invx" ---
const start = s.indexOf('<div id="view-co"');
const end = s.indexOf('<div id="view-invx"');
if (start === -1 || end === -1 || end <= start) { console.log('MARKERS_NOT_FOUND start=' + start + ' end=' + end); process.exit(1); }
const before = s.slice(0, start);
const after = s.slice(end);
s = before + BLOCK.trim() + '\r\n' + after;
console.log('view_replaced=true');

// --- 3) add the showView loader hook (idempotent) ---
if (s.indexOf("v==='co'&&typeof coLoadList") === -1) {
  const anchor = "if(typeof loadEstimatesLive==='function')loadEstimatesLive();}";
  if (s.indexOf(anchor) !== -1) {
    s = s.replace(anchor, anchor + "\r\n  if(v==='co'&&typeof coLoadList==='function'){coLoadList();}");
    console.log('showview_hook=added');
  } else { console.log('SHOWVIEW_ANCHOR_NOT_FOUND'); }
} else { console.log('showview_hook=already_present'); }

fs.writeFileSync(P, s);
console.log('has_co_list=' + (s.indexOf('id="co-list"') !== -1));
console.log('has_coLoadList=' + (s.indexOf('function coLoadList(') !== -1));
console.log('has_hook=' + (s.indexOf("v==='co'&&typeof coLoadList") !== -1));
console.log('old_iframe_gone=' + (s.indexOf('id="if-co"') === -1));
console.log('view_invx_present=' + (s.indexOf('<div id="view-invx"') !== -1));
