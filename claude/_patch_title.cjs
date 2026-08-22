// Fix the browser tab title: drop the internal "— v64" codename.
const fs = require('fs');
const P = 'public/index.html';
let s = fs.readFileSync(P, 'utf8');
const m = s.match(/<title>[^<]*<\/title>/i);
const had = m ? m[0] : '(none)';
s = s.replace(/<title>[^<]*<\/title>/i, '<title>HiveLogic</title>');
fs.writeFileSync(P, s);
console.log('was: ' + had);
console.log('now: ' + (s.match(/<title>[^<]*<\/title>/i) || ['(none)'])[0]);
