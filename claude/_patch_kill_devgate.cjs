// Kill the false "STILL IN DEVELOPMENT" popup app-wide (Chris 2026-07-28:
// "I continue to get popups that things are under construction but they're not").
//
// ROOT CAUSE: a dev-era "no-dead-buttons" gate ships in production. A document
// click listener runs window.hlDev() (which builds the #hldevpop "STILL IN
// DEVELOPMENT" modal) for any clicked button that has no INLINE onclick
// attribute. Buttons wired the correct modern way (addEventListener) have no
// onclick attribute, so the gate fires the fake popup on WORKING buttons. The
// gate cannot detect addEventListener handlers, so it is unreliable by design.
//
// FIX: neutralize hlDev to an immediate no-op. All 24 copies (one per v63
// iframe payload embedded in index.html) are byte-identical:
//   window.hlDev=function(lb){
// We insert `return;` right after the brace. The surrounding click listener,
// tab-toggle visual logic, and every real handler are left untouched -- only
// the popup is suppressed. Idempotent, exact-count-verified.
const fs = require('fs');
const p = 'public/index.html';
let s = fs.readFileSync(p, 'utf8');

const FIND = 'window.hlDev=function(lb){';
const DONE = 'window.hlDev=function(lb){return;';

const already = s.split(DONE).length - 1;
const total = s.split(FIND).length - 1; // includes already-patched (DONE contains FIND)
const remaining = total - already;

if (remaining === 0) { console.log('ALREADY PATCHED (' + already + ' copies)'); process.exit(0); }
if (total !== 24) { console.error('EXPECTED 24 hlDev copies, found ' + total + ' -- aborting'); process.exit(1); }

// Replace only the un-patched openers. Because DONE starts with FIND, guard by
// replacing FIND not already followed by "return;".
let count = 0;
s = s.replace(/window\.hlDev=function\(lb\)\{(?!return;)/g, function () { count++; return DONE; });

if (count !== remaining) { console.error('replaced ' + count + ', expected ' + remaining); process.exit(1); }

fs.writeFileSync(p, s);
console.log('PATCHED ' + count + ' hlDev copies to no-op (total ' + total + ')');
