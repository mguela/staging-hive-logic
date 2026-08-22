// Add the daily health-check cron to vercel.json (Chris 2026-07-28).
// JSON-safe: parse -> add entry -> write. Idempotent. Schedule 15:30 UTC
// (11:30am EDT), right after the last Jobber sync (geocode at 15:00 UTC) so it
// checks fresh data. Chris can adjust the time later.
const fs = require('fs');
const p = 'vercel.json';
const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
cfg.crons = cfg.crons || [];
if (cfg.crons.some(c => c.path && c.path.indexOf('/api/health-cron') === 0)) { console.log('ALREADY PRESENT'); process.exit(0); }
cfg.crons.push({ path: '/api/health-cron', schedule: '30 15 * * *' });
// give the function a sane timeout (it pings 4 endpoints + several DB queries)
cfg.functions = cfg.functions || {};
cfg.functions['api/health-cron.js'] = { maxDuration: 60 };
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
console.log('ADDED /api/health-cron @ 30 15 * * *  (total crons: ' + cfg.crons.length + ')');
