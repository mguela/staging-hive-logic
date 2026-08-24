// test/health-signals.test.mjs
//
// Covers api/_lib/health-signals.js -- the silent-failure detector built after
// screen monitoring was dead company-wide for two weeks with nothing watching.
//
// The tests that matter most here are the ones that keep the CHECKER honest:
//   * CRON_SCHEDULES must mirror vercel.json exactly, both directions. This is
//     the anti-drift property -- add a cron without describing how to tell it
//     ran, and this suite fails before the code ever ships.
//   * off-by-design signals must never raise an alarm. Alert fatigue is the
//     failure mode that would make the whole thing worthless.
//   * the real 2026-08 outage, replayed from the production timestamps, must
//     still be detected.
//
// No network, no DB.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  STATUS, ALARM_STATUSES,
  expectedIntervalMinutes, stalenessBudgetMinutes, cronKey,
  parseScheduledCrons, scheduledSignals, allSignals,
  CRON_SCHEDULES, CRON_EVIDENCE, LIVE_SIGNALS,
  evaluateSignals, summarize, formatAge, postgrestLookup,
} from '../api/_lib/health-signals.js';

const vercelJson = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));

// --- The anti-drift contract ----------------------------------------------

test('CRON_SCHEDULES mirrors vercel.json exactly -- no missing entries, no orphans', () => {
  const fromVercel = new Map(vercelJson.crons.map((c) => [cronKey(c.path), c.schedule]));

  for (const [key, schedule] of fromVercel) {
    assert.ok(
      key in CRON_SCHEDULES,
      `${key} is scheduled in vercel.json but missing from CRON_SCHEDULES -- add it (and its evidence) in api/_lib/health-signals.js`,
    );
    assert.equal(CRON_SCHEDULES[key], schedule, `${key} schedule drifted from vercel.json`);
  }
  for (const key of Object.keys(CRON_SCHEDULES)) {
    assert.ok(fromVercel.has(key), `${key} is in CRON_SCHEDULES but no longer scheduled in vercel.json -- remove it`);
  }
  assert.equal(Object.keys(CRON_SCHEDULES).length, vercelJson.crons.length);
});

test('every scheduled job says how to tell whether it ran', () => {
  const uncovered = Object.keys(CRON_SCHEDULES).filter((k) => !CRON_EVIDENCE[k]);
  assert.deepEqual(uncovered, [], `these crons have no evidence rule: ${uncovered.join(', ')}`);
  // Each rule must be exactly one of the three shapes, never an empty object
  // that would quietly evaluate as "fine".
  for (const [key, rule] of Object.entries(CRON_EVIDENCE)) {
    const shapes = ['probe', 'offByDesign', 'unverifiable'].filter((k) => rule[k]);
    assert.equal(shapes.length, 1, `${key} must have exactly one of probe/offByDesign/unverifiable, got: ${shapes.join(',') || 'none'}`);
    if (rule.probe) {
      assert.ok(rule.probe.table && rule.probe.column, `${key} probe needs a table and column`);
    } else {
      assert.equal(typeof rule[shapes[0]], 'string', `${key} must explain WHY in ${shapes[0]}`);
      assert.ok(rule[shapes[0]].length > 20, `${key}: give a real reason, not a shrug`);
    }
  }
});

test('the signal that started all this -- the Monitor agent -- is watched, and it is not a cron', () => {
  const agent = LIVE_SIGNALS.find((s) => s.key === 'monitor/agent-heartbeat');
  assert.ok(agent, 'the Monitor agent heartbeat must be watched');
  assert.equal(agent.kind, 'live');
  assert.ok(!Object.keys(CRON_SCHEDULES).some((k) => k.includes('monitor_heartbeat')),
    'the agent heartbeat is not scheduled -- a cron-only checker would miss the exact bug this was built for');
});

// --- Cadence derivation ----------------------------------------------------

test('expected cadence is derived from the cron expression, not hand-tuned', () => {
  assert.equal(expectedIntervalMinutes('* * * * *'), 1);
  assert.equal(expectedIntervalMinutes('*/15 * * * *'), 15);
  assert.equal(expectedIntervalMinutes('0 * * * *'), 60);
  assert.equal(expectedIntervalMinutes('40 * * * *'), 60);
  assert.equal(expectedIntervalMinutes('0 */2 * * *'), 120);
  assert.equal(expectedIntervalMinutes('0 */4 * * *'), 240);
  assert.equal(expectedIntervalMinutes('30 15 * * *'), 1440);
  assert.equal(expectedIntervalMinutes('0 8 * * 1'), 10080);
});

test('an unparseable schedule falls back to the most forgiving budget, never the strictest', () => {
  // A parsing gap must not be able to manufacture a false alarm.
  for (const junk of ['', null, undefined, 'nonsense', '* * *']) {
    assert.equal(expectedIntervalMinutes(junk), 1440, `${JSON.stringify(junk)} should fall back to daily`);
  }
});

test('the staleness budget tolerates missed cycles, with a floor for fast jobs', () => {
  assert.equal(stalenessBudgetMinutes(60), 195);        // hourly: ~3 misses
  assert.equal(stalenessBudgetMinutes(1440), 4335);     // daily: ~3 days
  assert.equal(stalenessBudgetMinutes(1), 20);          // per-minute: floored, no blip alarms
});

// --- Key identity (a real bug this caught on its first run) ----------------

test('cron keys keep the whole query, so different jobs on one path stay distinct', () => {
  // Regression: an earlier cut kept only ?resource=, collapsing these two --
  // different jobs, different schedules -- into one key. Both then failed to
  // match their evidence and reported as uncovered.
  assert.notEqual(cronKey('/api/jobber/webhook?drain=1'), cronKey('/api/jobber/webhook?cleanup=1'));
  assert.equal(cronKey('/api/jobber/webhook?drain=1'), '/api/jobber/webhook?drain=1');
  assert.equal(cronKey('/api/health-cron'), '/api/health-cron');
  // Key identity must not depend on param order.
  assert.equal(cronKey('/api/x?b=2&a=1'), cronKey('/api/x?a=1&b=2'));
});

// --- Evaluation ------------------------------------------------------------

const NOW = new Date('2026-08-16T12:22:00Z');
const lookupFrom = (map) => async ({ table, column }) => map[`${table}.${column}`] ?? null;

test('a fresh signal is ok and a long-dead one is STALE', async () => {
  const signals = [
    { key: 'fresh', budgetMinutes: 60, probe: { table: 't', column: 'c' } },
    { key: 'dead', budgetMinutes: 60, probe: { table: 'd', column: 'c' } },
  ];
  const results = await evaluateSignals({
    signals, evidence: {}, now: NOW,
    lookup: lookupFrom({ 't.c': '2026-08-16T12:00:00Z', 'd.c': '2026-08-01T12:00:00Z' }),
  });
  assert.equal(results[0].status, STATUS.OK);
  assert.equal(results[1].status, STATUS.STALE);
  assert.ok(results[1].detail.includes('15d'), 'the alarm should say how stale, in human units');
});

test('a signal with no evidence at all reports NEVER, not ok', async () => {
  const results = await evaluateSignals({
    signals: [{ key: 'x', budgetMinutes: 60, probe: { table: 't', column: 'c' } }],
    evidence: {}, now: NOW, lookup: async () => null,
  });
  assert.equal(results[0].status, STATUS.NEVER);
});

test('a scheduled job with no evidence rule is UNCOVERED -- a failure, not a silent pass', async () => {
  const results = await evaluateSignals({
    signals: [{ key: '/api/brand-new-cron', budgetMinutes: 60 }],
    evidence: {}, now: NOW, lookup: async () => null,
  });
  assert.equal(results[0].status, STATUS.UNCOVERED);
  assert.ok(ALARM_STATUSES.includes(STATUS.UNCOVERED), 'uncovered must count as an alarm');
});

test('a failed lookup is UNVERIFIABLE, never a false alarm and never a false green', async () => {
  const results = await evaluateSignals({
    signals: [{ key: 'x', budgetMinutes: 60, probe: { table: 't', column: 'c' } }],
    evidence: {}, now: NOW,
    lookup: async () => { throw new Error('relation does not exist'); },
  });
  assert.equal(results[0].status, STATUS.UNVERIFIABLE);
  assert.ok(results[0].detail.includes('relation does not exist'));
});

test('off-by-design signals never alarm -- this is the alert-fatigue guard', async () => {
  const offKeys = Object.entries(CRON_EVIDENCE).filter(([, r]) => r.offByDesign).map(([k]) => k);
  assert.ok(offKeys.length >= 9, 'the disabled marketing/social sends should be marked off-by-design');
  const results = await evaluateSignals({
    signals: offKeys.map((key) => ({ key, budgetMinutes: 60 })),
    now: NOW,
    lookup: async () => { throw new Error('should never be probed'); },
  });
  for (const r of results) {
    assert.equal(r.status, STATUS.OFF_BY_DESIGN, `${r.key} must not alarm`);
    assert.ok(!ALARM_STATUSES.includes(r.status));
  }
  assert.equal(summarize(results).alarms.length, 0, 'a deliberately-off system must produce a clean report');
});

// --- The real outage -------------------------------------------------------

test('replaying the real 2026-08 production timestamps, the outages are detected', async () => {
  // These are the actual values read from production on 2026-08-16.
  const PROD = {
    'clients.synced_at': '2026-08-16 12:00:34.313+00',
    'jobs.synced_at': '2026-08-16 12:21:15.244+00',
    'invoices.synced_at': '2026-08-16 11:41:47.269+00',
    'quotes.synced_at': '2026-08-15 13:51:10.916+00',
    'vehicles.synced_at': '2026-08-16 12:16:08.021+00',
    'requests.synced_at': '2026-08-15 14:01:18.073+00',
    'visits.synced_at': '2026-08-15 14:13:48.902+00',
    'expenses.synced_at': '2026-08-15 14:20:46.528+00',
    'time_sheet_entries.synced_at': '2026-08-15 14:32:37.168+00',
    'users.synced_at': '2026-08-15 14:40:22.237+00',
    'client_locations.synced_at': '2026-08-15 14:53:26.577+00',
    'client_locations.geocoded_at': '2026-08-01 15:01:36.178+00',  // 15 days dead
    'monitor_agents.last_seen_at': '2026-08-02 02:08:29.684+00',   // the reported outage
    'vehicles.gps_updated_at': '2026-07-28 15:21:40+00',           // 19 days dead
    'fleet_vehicle_latest.last_received_at': '2026-08-16 12:20:11.482+00',  // Slice 3 live, recording every 5 min
  };
  const results = await evaluateSignals({ signals: allSignals(), now: NOW, lookup: lookupFrom(PROD) });
  const s = summarize(results);
  const alarmKeys = s.alarms.map((a) => a.key).sort();

  // Signals introduced AFTER this snapshot was taken have no evidence in it,
  // because the crons did not exist on 2026-08-16. That is a property of the
  // fixture, not an outage — and the fixture is real production data, so the
  // fix is to scope the assertion rather than invent rows that never existed.
  const POST_SNAPSHOT = [
    '/api/automations?resource=missed_call_textback',
    '/api/automations?resource=invoice_overdue_nudge',
    '/api/ops-events?resource=sweep',
    '/api/growth?resource=growth_scan',
  ];
  const asOfSnapshot = alarmKeys.filter((k) => !POST_SNAPSHOT.includes(k));

  assert.deepEqual(asOfSnapshot, [
    '/api/jobber/sync-extended?resource=geocode',
    'fleet/gps-freshness',
    'monitor/agent-heartbeat',
  ], 'exactly the three genuinely-dead signals should alarm');

  // And they alarm for the right reason: no ledger row at all in this window,
  // not a stale one. If automation_runs ever stops being written, this is the
  // shape the real alarm will take.
  for (const key of POST_SNAPSHOT) {
    const r = results.find((x) => x.key === key);
    assert.ok(r && ALARM_STATUSES.includes(r.status),
      `${key} should register as unproven against a snapshot that predates it`);
  }

  // The whole point: the reported outage is caught.
  const agent = results.find((r) => r.key === 'monitor/agent-heartbeat');
  assert.equal(agent.status, STATUS.STALE);
  assert.ok(agent.ageMinutes > 14 * 24 * 60 - 60, 'the agent had been silent about 14 days');

  // And the healthy syncs are NOT dragged in with them.
  assert.equal(results.find((r) => r.key === '/api/jobber/sync?resource=clients').status, STATUS.OK);
  assert.equal(results.find((r) => r.key === '/api/jobber/sync-extended?resource=users').status, STATUS.OK,
    'a daily sync ~22h old is healthy, not stale');
  assert.equal(s.uncovered, 0);
  assert.ok(!s.healthy);
});

// --- Reporting -------------------------------------------------------------

test('the summary headline names what is broken, so the email is readable at a glance', () => {
  const s = summarize([
    { key: 'a', status: STATUS.OK }, { key: 'b', status: STATUS.STALE },
    { key: 'c', status: STATUS.OFF_BY_DESIGN }, { key: 'd', status: STATUS.UNVERIFIABLE },
  ]);
  assert.equal(s.healthy, false);
  assert.match(s.headline, /1 signal not running: b/);
  assert.equal(summarize([{ key: 'a', status: STATUS.OK }]).headline, 'All watched signals are current.');
});

test('ages read in human units', () => {
  assert.equal(formatAge(45), '45m');
  assert.equal(formatAge(200), '3h');
  assert.equal(formatAge(60 * 24 * 15), '15d');
});

test('the PostgREST adapter asks for the newest non-null value and honours filters', async () => {
  const seen = [];
  const lookup = postgrestLookup(async (q) => { seen.push(q); return { ok: true, rows: [{ last_seen_at: '2026-08-02T02:08:29Z' }] }; });
  const v = await lookup({ table: 'monitor_agents', column: 'last_seen_at', filter: { status: 'active' } });
  assert.equal(v, '2026-08-02T02:08:29Z');
  assert.match(seen[0], /^monitor_agents\?/);
  assert.match(seen[0], /order=last_seen_at\.desc/);
  assert.match(seen[0], /limit=1/);
  assert.match(seen[0], /last_seen_at=not\.is\.null/);
  assert.match(seen[0], /status=eq\.active/);
});

test('parseScheduledCrons stays usable for comparing against vercel.json directly', () => {
  const parsed = parseScheduledCrons(vercelJson);
  assert.equal(parsed.length, vercelJson.crons.length);
  assert.equal(parsed.length, scheduledSignals().length);
  for (const p of parsed) assert.ok(p.budgetMinutes >= 20);
});
