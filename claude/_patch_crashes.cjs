// Fix two real uncaught-exception paths the crawler found:
//  1) Estimates filter tabs -> efListTable() set innerHTML on a null #efl-tb
//     when the list wasn't currently rendered (e.g. after switching to Quote
//     Buildout mode). Guard it.
//  2) Documents "All documents"/"Templates" -> hlDocBuildTree(folders) called
//     folders.forEach when folders wasn't an array. Coerce to array.
const fs = require('fs');
const P = 'public/index.html';
let s = fs.readFileSync(P, 'utf8');
const report = {};

const oldEfl = "document.getElementById('efl-tb').innerHTML=h;";
const newEfl = "var _eflTb=document.getElementById('efl-tb'); if(_eflTb) _eflTb.innerHTML=h;";
if (s.indexOf(newEfl) !== -1) report.efl = 'already';
else if (s.indexOf(oldEfl) !== -1) { s = s.replace(oldEfl, newEfl); report.efl = 'fixed'; }
else report.efl = 'NOT_FOUND';

const oldDoc = 'function hlDocBuildTree(folders){';
const newDoc = 'function hlDocBuildTree(folders){ if(!Array.isArray(folders)) folders=[];';
if (s.indexOf(newDoc) !== -1) report.doc = 'already';
else if (s.indexOf(oldDoc) !== -1) { s = s.replace(oldDoc, newDoc); report.doc = 'fixed'; }
else report.doc = 'NOT_FOUND';

fs.writeFileSync(P, s);
report.scriptPairs = (s.match(/<script\b/g) || []).length + '/' + (s.match(/<\/script>/g) || []).length;
console.log(JSON.stringify(report));
