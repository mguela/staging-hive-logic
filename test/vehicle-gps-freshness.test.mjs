import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This check used to alarm on Jobber's GPS feed being dead, on the theory that
// losing it left FleetSharp as a single point of failure. Chris pushed back and
// he was right: Jobber's Vehicle.liveState is a passthrough of whatever
// telematics is wired into Jobber -- very likely the same FleetSharp hardware --
// so it was never an independent source. If a truck's tracker dies, both feeds
// go dark together, and "reconnect Jobber" buys a mirror, not a backup.
//
// So the check now watches FleetSharp only, and watches what is actionable:
// can we place the fleet at all, and has any individual tracker gone silent.
// A daily warning about a feed nobody intends to restore is how a health report
// turns into noise, which is the failure mode that makes the whole thing
// worthless.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'health-cron.js'), 'utf-8');

function extractCheck(src) {
  const start = src.indexOf("checks.push(await safe('Vehicle GPS freshness'");
  assert.ok(start > -1, 'the Vehicle GPS freshness check must exist');
  const open = src.indexOf('async () => {', start) + 'async () => {'.length;
  let depth = 1, i = open;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(open, i - 1);
}
const BODY = extractCheck(SRC);

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-08-16T14:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

async function runCheck(rows, { ok = true } = {}) {
  const ctx = {
    console, Math, Number, String, Object, Array, Infinity, JSON,
    Date: class extends Date {
      constructor(...args) { if (!args.length) super(NOW); else super(...args); }
      static now() { return NOW; }
      static parse(s) { return Date.parse(s); }
    },
    sbGet: async () => ({ ok, rows }),
  };
  vm.createContext(ctx);
  return vm.runInContext(`(async () => {${BODY}})()`, ctx);
}

// jobberAge is deliberately absurd on most rows: the check must not read it.
const vehicle = (name, fsAgeMs, jobberAgeMs = 19 * 24 * HOUR) => ({
  name,
  fleetsharp_updated_at: fsAgeMs === null ? null : ago(fsAgeMs),
  gps_updated_at: jobberAgeMs === null ? null : ago(jobberAgeMs),
});

test('a fleet reporting on FleetSharp passes, whatever Jobber is doing', async () => {
  const r = await runCheck([vehicle('2021 PROMASTER', 5 * 60 * 1000), vehicle('2018 Silverado', 40 * 60 * 1000)]);
  assert.equal(r.status, 'ok');
  assert.match(r.detail, /2\/2 vehicles placed/);
});

// The whole point of the rewrite: Jobber frozen for weeks is the normal state
// now and must not produce a daily warning anybody has to triage.
test("Jobber being frozen is no longer an alarm", async () => {
  const r = await runCheck([
    vehicle('2021 PROMASTER', 8 * 60 * 1000, 19 * 24 * HOUR),
    vehicle('2018 Silverado', 3 * 60 * 1000, 19 * 24 * HOUR),
  ]);
  assert.equal(r.status, 'ok', 'a feed we deliberately do not rely on must not warn');
  assert.doesNotMatch(r.detail, /Jobber/i, 'and must not even be mentioned in the daily report');
});

// A parked truck reports on movement, so overnight gaps are normal and must not
// alarm -- that is precisely the noise this rewrite exists to avoid.
test('an overnight gap on a parked truck is not a fault', async () => {
  const r = await runCheck([vehicle('2014 RAM5500', 13 * HOUR), vehicle('SmartCar', 20 * 60 * 1000)]);
  assert.equal(r.status, 'ok');
});

test('a tracker silent for over a day is named, because that is actionable', async () => {
  const r = await runCheck([
    vehicle('2021 PROMASTER', 4 * 60 * 1000),
    vehicle('Spare Van', 6 * 24 * HOUR),
  ]);
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /1 tracker\(s\) silent/);
  assert.match(r.detail, /Spare Van \(6d\)/, 'naming the truck is what makes it chaseable');
  assert.match(r.detail, /1\/2 vehicles placed/);
});

test('a vehicle that has never reported is called out rather than averaged away', async () => {
  const r = await runCheck([vehicle('2021 PROMASTER', 4 * 60 * 1000), vehicle('New Truck', null)]);
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /New Truck \(never\)/);
});

test('nothing placeable is a hard failure', async () => {
  const r = await runCheck([vehicle('A', 5 * HOUR), vehicle('B', 9 * HOUR)]);
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /FLEET DARK/);
  assert.match(r.detail, /newest 5h/);
});

test('a fleet that has never reported at all fails without claiming a bogus age', async () => {
  const r = await runCheck([vehicle('A', null), vehicle('B', null)]);
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /FLEET DARK/);
  assert.match(r.detail, /no vehicle has ever reported/);
  assert.doesNotMatch(r.detail, /Infinity|NaN/);
});

test('an empty or unreadable fleet table warns rather than claiming health', async () => {
  assert.equal((await runCheck([])).status, 'warn');
  assert.equal((await runCheck([], { ok: false })).status, 'warn');
});
