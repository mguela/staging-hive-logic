// Idempotent patch: replace the dead view-invx iframe mock (fake Create /
// Mark-Paid buttons that saved nothing) with a real, wired Invoicing view, and
// add the showView('invx') loader hook.
const fs = require('fs');
const P = 'public/index.html';
const BLOCK = fs.readFileSync('claude/_invx_view.html', 'utf8');
let s = fs.readFileSync(P, 'utf8');

// 1) validate inline JS
const scriptM = BLOCK.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptM) { console.log('NO_SCRIPT_IN_BLOCK'); process.exit(1); }
try { new Function(scriptM[1]); console.log('inline_js_syntax=OK'); }
catch (e) { console.log('INLINE_JS_SYNTAX_ERROR: ' + e.message); process.exit(1); }

// 2) splice view-invx .. view-expx
const start = s.indexOf('<div id="view-invx"');
const end = s.indexOf('<div id="view-expx"');
if (start === -1 || end === -1 || end <= start) { console.log('MARKERS_NOT_FOUND start=' + start + ' end=' + end); process.exit(1); }
s = s.slice(0, start) + BLOCK.trim() + '\r\n' + s.slice(end);
console.log('view_replaced=true');

// 3) showView hook (idempotent), placed right after the co hook
if (s.indexOf("v==='invx'&&typeof ivxLoad") === -1) {
  const anchor = "if(v==='co'&&typeof coLoadList==='function'){coLoadList();}";
  if (s.indexOf(anchor) !== -1) {
    s = s.replace(anchor, anchor + "\r\n  if(v==='invx'&&typeof ivxLoad==='function'){ivxLoad();}");
    console.log('showview_hook=added');
  } else { console.log('SHOWVIEW_ANCHOR_NOT_FOUND'); }
} else { console.log('showview_hook=already_present'); }

fs.writeFileSync(P, s);
console.log('has_ivx_list=' + (s.indexOf('id="ivx-list"') !== -1));
console.log('has_ivxLoad=' + (s.indexOf('function ivxLoad(') !== -1));
console.log('has_hook=' + (s.indexOf("v==='invx'&&typeof ivxLoad") !== -1));
console.log('old_iframe_gone=' + (s.indexOf('id="if-invx"') === -1));
console.log('view_expx_present=' + (s.indexOf('<div id="view-expx"') !== -1));
