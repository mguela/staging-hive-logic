// Export runChecks + buildReport from health-cron so the one-time test endpoint
// can reuse the EXACT same report. Two zero-risk single-line edits (add `export`).
const fs = require('fs');
const p = 'api/health-cron.js';
let s = fs.readFileSync(p, 'utf8');
if (s.includes('export async function runChecks')) { console.log('ALREADY'); process.exit(0); }
function one(find, to) { if (s.split(find).length - 1 !== 1) { console.error('anchor not unique: ' + find); process.exit(1); } s = s.replace(find, to); }
one('async function runChecks() {', 'export async function runChecks() {');
one('function buildReport(checks) {', 'export function buildReport(checks) {');
fs.writeFileSync(p, s);
console.log('EXPORTED runChecks + buildReport');
