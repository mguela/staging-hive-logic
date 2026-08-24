// api/_lib/health-signals.js
//
// Silent-failure detection for the whole app (Chris, 2026-08-16).
//
// WHY THIS EXISTS
// Screen monitoring was dead company-wide for two weeks and nothing noticed.
// Chris found it because a green dot was lying. That is not a one-off: this
// repo's own api/_lib/guard.js documents SIX separate outages of the same
// shape -- the snapshot reads, the financial reads ("the financial data
// blackout"), monitor_prune ("every 08:00 run has died at the edge"), nine
// scheduled sends that "have never run, not once", and the Monitor agent.
// Every one of them was a thing that was supposed to happen periodically,
// quietly stopped happening, and stayed broken until a human tripped over it.
//
// WHY api/health-cron.js DIDN'T CATCH ANY OF THEM
// It checks a hand-written list. Every check exists because a person thought
// of it. Monitoring wasn't on the list, so monitoring died invisibly. Adding a
// check for monitoring fixes today's outage and leaves the identical hole for
// the next thing. So this module DERIVES what to watch instead of enumerating
// it:
//
//   * Scheduled jobs come from vercel.json itself. Add a cron, and it is
//     watched automatically -- and if you add one without saying how to tell
//     whether it ran, that is reported as `uncovered`, which is a FAILURE.
//     Coverage therefore cannot silently drift behind the schedule again.
//   * How fresh a signal should be is derived from its own cron expression,
//     not hand-tuned. A */15 job is expected every 15 minutes; a daily job
//     daily. No per-job guesswork to get wrong.
//   * Live (non-cron) signals are registered explicitly, because the outage
//     that started all this -- the Monitor agent -- is NOT a cron. A
//     cron-only checker would have missed the very bug it was built for.
//
// A NOTE ON HONESTY (this repo's "Law 1": never invent a status you can't
// back up). Some jobs only leave a trace when they have work to do -- the
// webhook drain writes nothing when Jobber's queue is empty, and a prune
// leaves no positive evidence of a successful run at all. For those, an idle
// system and a dead one look identical from the database. They are reported
// as `unverifiable` WITH the reason, never as green. That is the honest
// answer, and the count of them is the argument for a real run-ledger next.

/** A signal is healthy, or it is not, or we admit we cannot tell. */
export const STATUS = {
  OK: 'ok',                       // fresh evidence, within budget
  STALE: 'stale',                 // evidence exists but is too old -- THE ALARM
  NEVER: 'never',                 // no evidence has ever existed
  OFF_BY_DESIGN: 'off-by-design', // deliberately switched off; informational
  UNVERIFIABLE: 'unverifiable',   // no trustworthy evidence source exists
  UNCOVERED: 'uncovered',         // scheduled but nobody said how to check it
};

/** Statuses that mean something is actually wrong and a human should look. */
export const ALARM_STATUSES = [STATUS.STALE, STATUS.NEVER, STATUS.UNCOVERED];

// --- Expected cadence, derived from the cron expression --------------------

/**
 * How often a 5-field cron expression is expected to fire, in minutes.
 * Deliberately coarse: we only need an order of magnitude to judge staleness,
 * and a coarse answer that is always right beats a precise one that is
 * sometimes wrong. Unrecognised shapes fall back to daily, the most forgiving
 * option, so a parsing gap can never manufacture a false alarm.
 */
export function expectedIntervalMinutes(schedule) {
  const parts = String(schedule || '').trim().split(/\s+/);
  if (parts.length !== 5) return 1440;
  const [minute, hour, dom, month, dow] = parts;

  const everyN = (field) => {
    const m = /^\*\/(\d+)$/.exec(field);
    return m ? Number(m[1]) : null;
  };

  if (minute === '*') return 1;
  const perMinute = everyN(minute);
  if (perMinute) return perMinute;

  // Fixed minute. Now the hour field decides.
  if (hour === '*') return 60;
  const perHour = everyN(hour);
  if (perHour) return perHour * 60;

  // Fixed minute AND hour -> at most daily; weekly/monthly if narrowed further.
  if (dom === '*' && month === '*' && dow === '*') return 1440;
  return 10080;
}

/**
 * How stale a signal may get before we call it broken.
 * Three missed cycles plus slack, so ordinary jitter, a slow run, or one
 * skipped tick never pages anyone -- but a genuinely dead job trips it.
 * Floored at 20 minutes so a every-minute job doesn't alarm on a blip.
 */
export function stalenessBudgetMinutes(intervalMinutes) {
  return Math.max(20, intervalMinutes * 3 + 15);
}

// --- Reading the schedule --------------------------------------------------

/**
 * Stable identity for a scheduled job.
 *
 * Keeps the WHOLE query, not just ?resource=. The first cut of this only kept
 * `resource`, which silently collapsed `/api/jobber/webhook?drain=1` and
 * `?cleanup=1` -- two different jobs on different schedules -- into one key,
 * so neither matched its registry entry and both reported as uncovered. Params
 * are sorted so key identity does not depend on the order they were written in
 * vercel.json.
 */
export function cronKey(path) {
  const [p, query] = String(path || '').split('?');
  if (!query) return p;
  const pairs = [...new URLSearchParams(query).entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`);
  return pairs.length ? `${p}?${pairs.join('&')}` : p;
}

/** Turn vercel.json's `crons` array into the signals we expect to see. */
export function parseScheduledCrons(vercelJson) {
  const crons = (vercelJson && vercelJson.crons) || [];
  return crons.map((c) => {
    const interval = expectedIntervalMinutes(c.schedule);
    return {
      key: cronKey(c.path),
      kind: 'cron',
      path: c.path,
      schedule: c.schedule,
      intervalMinutes: interval,
      budgetMinutes: stalenessBudgetMinutes(interval),
    };
  });
}

// --- Evidence registry -----------------------------------------------------
//
// Each entry answers one question: "what row in the database proves this
// actually ran?" A probe is declarative -- {table, column} -- so the same
// registry can be evaluated through PostgREST (health-cron) or plain SQL (an
// operator checking by hand), and so it can be reviewed without reading code.

/** Evidence for the scheduled jobs in vercel.json. */
export const CRON_EVIDENCE = {
  // --- Jobber sync: each resource lands in its own table with synced_at. ---
  '/api/jobber/sync?resource=clients': { probe: { table: 'clients', column: 'synced_at' } },
  '/api/jobber/sync?resource=jobs': { probe: { table: 'jobs', column: 'synced_at' } },
  '/api/jobber/sync?resource=invoices': { probe: { table: 'invoices', column: 'synced_at' } },
  '/api/jobber/sync-extended?resource=quotes': { probe: { table: 'quotes', column: 'synced_at' } },
  '/api/jobber/sync-extended?resource=vehicles': { probe: { table: 'vehicles', column: 'synced_at' } },
  '/api/jobber/sync-extended?resource=requests': { probe: { table: 'requests', column: 'synced_at' } },
  '/api/jobber/sync-extended?resource=visits': { probe: { table: 'visits', column: 'synced_at' } },
  '/api/jobber/sync-extended?resource=expenses': { probe: { table: 'expenses', column: 'synced_at' } },
  '/api/jobber/sync-extended?resource=timesheets': { probe: { table: 'time_sheet_entries', column: 'synced_at' } },
  '/api/jobber/sync-extended?resource=users': { probe: { table: 'users', column: 'synced_at' } },
  '/api/jobber/sync-extended?resource=locations': { probe: { table: 'client_locations', column: 'synced_at' } },
  '/api/jobber/sync-extended?resource=geocode': { probe: { table: 'client_locations', column: 'geocoded_at' } },

  // --- Only observable when there is work to do. ---------------------------
  // An idle system and a dead job are indistinguishable here, so we say so
  // rather than paint them green. These are the case FOR a run-ledger.
  '/api/jobber/webhook?drain=1': {
    unverifiable: 'Writes nothing when Jobber has no queued events, so an empty queue looks exactly like a dead drain.',
  },
  '/api/jobber/webhook?cleanup=1': {
    unverifiable: 'A deletion job leaves no positive trace of a successful run.',
  },
  // Reina's unattended mail sweep. It stamps reina_push_subscriptions.last_sent_at
  // and writes reina_mail_triage rows -- but ONLY when there is new mail worth
  // interrupting him for. On a quiet evening it correctly does nothing, which
  // is indistinguishable from the sweep being dead. Saying so beats a probe
  // that paints a broken job green every weekend.
  '/api/reina/mail-sweep': {
    unverifiable: 'Writes only when new mail is worth a notification, so a quiet inbox looks exactly like a dead sweep.',
  },
  // The ops-event sweep writes a row per detector per run, so "did it run" is
  // answerable even on a quiet day when it found nothing worth raising.
  '/api/ops-events?resource=sweep': { probe: { table: 'ops_detector_runs', column: 'ran_at' } },
  '/api/track1?resource=monitor_prune': {
    unverifiable: 'Retention prune deletes rows; nothing is written to prove it ran. (guard.js records that every 08:00 run died at the edge until 2026-08-15.)',
  },
  '/api/import-companycam': {
    unverifiable: 'Only inserts media when CompanyCam has new photos; a quiet day is indistinguishable from a broken import.',
  },
  '/api/track1?resource=workforce_sweep_gone': {
    // Added in the same commit that scheduled it -- this checker refused to
    // let the cron ship without an entry, which is exactly what it is for.
    unverifiable: 'Only writes when someone actually closed their browser mid-shift and did not come back; on a day where nobody does, a healthy sweep and a dead one look identical. To confirm by hand, check that workforce_time_sessions has a recent row with close_reason = browser_closed.',
  },
  '/api/track1?resource=check_new_leads': {
    unverifiable: 'Only writes to lead_alerts_sent when a NEW lead appears; no new leads looks identical to a dead check.',
  },
  '/api/marketing?resource=process_scheduled_sends': {
    unverifiable: 'Only sends when a campaign is actually scheduled for that window.',
  },
  '/api/schedule/outbox?resource=process': {
    // Honest rather than green: with the master switch off (its default, and
    // its state through the whole prototype phase) this job deliberately sends
    // nothing and writes nothing, so a healthy tick and a dead one are
    // identical from the outside -- the same shape as the drain/prune jobs
    // above. To confirm by hand, call it with the cron secret and read the
    // JSON: it reports `due` and `blocked` even when it sends zero.
    unverifiable: 'Sends only when the messaging master switch is on AND a queued message is due; while OFF by design it writes nothing, so an idle tick and a dead cron look the same. Confirm by hand via the due/blocked report the endpoint returns, or check hl_outbox for a recent sent_at.',
  },

  // --- Company Setup automations: these DO have a run ledger. --------------
  // Unlike the jobs above, every tick writes an automation_runs row even when it
  // queues nothing (outcome = skipped_disabled / skipped_no_candidates), so a
  // quiet day and a dead cron are genuinely distinguishable. That ledger is the
  // "case FOR a run-ledger" noted above, actually built — see sql/087.
  '/api/automations?resource=missed_call_textback': {
    probe: { table: 'automation_runs', column: 'ran_at', filter: { automation: 'missed_call_textback' } },
  },
  '/api/automations?resource=invoice_overdue_nudge': {
    probe: { table: 'automation_runs', column: 'ran_at', filter: { automation: 'invoice_overdue_nudge' } },
  },
  '/api/reina/scan-change-requests?days=2': {
    unverifiable: 'Auto-scan is off by default and writes only when it finds something to raise.',
  },
  '/api/health-cron': {
    unverifiable: 'Reports by email and Chirp; it records nothing in the database that this check can read back.',
  },

  // --- Deliberately switched off. Must NOT alarm, or the report gets ------
  // ignored and we are back where we started. guard.js verified each of these
  // is independently disabled behind the guard.
  '/api/growth?resource=growth_scan': {
    probe: { table: 'growth_suggestions', column: 'created_at' },
  },
  '/api/social-posts?resource=process_scheduled_posts': {
    offByDesign: 'No social surface is connected (ad_platform_connections and social_posts are empty), so there is nothing to publish.',
  },
  '/api/marketing?resource=process_review_request_autosend': { offByDesign: 'Needs REVIEW_REQUEST_AUTOSEND_DAYS + GOOGLE_REVIEW_LINK; neither is set.' },
  '/api/marketing?resource=process_post_job_thank_you_autosend': { offByDesign: 'Lifecycle autosend; its env switch is not set.' },
  '/api/marketing?resource=process_service_anniversary_autosend': { offByDesign: 'Lifecycle autosend; its env switch is not set.' },
  '/api/marketing?resource=process_dormant_reactivation_autosend': { offByDesign: 'Lifecycle autosend; its env switch is not set.' },
  '/api/marketing?resource=process_maintenance_reminders_autosend': { offByDesign: 'Lifecycle autosend; its env switch is not set.' },
  '/api/marketing?resource=process_new_lead_followup_autosend': { offByDesign: 'Lifecycle autosend; its env switch is not set.' },
  '/api/marketing?resource=process_newsletter_autosend': { offByDesign: 'Lifecycle autosend; its env switch is not set.' },
  '/api/marketing?resource=process_referral_autosend': { offByDesign: 'Lifecycle autosend; its env switch is not set.' },
  // Fleet position recorder is live (FLEET_ENABLED=true, Slice 3 switched on
  // 2026-08-16): it records truck GPS into fleet_vehicle_latest every 5 minutes,
  // so a stale last_received_at means the recorder has silently failed.
  '/api/fleet/record-positions': { probe: { table: 'fleet_vehicle_latest', column: 'last_received_at' } },
  // Event-driven: writes a fleet_job_presence row only when a tracked truck is
  // actually detected at a scheduled job site. Quiet stretches (nights, no
  // dispatched jobs, all trucks at the shop) are normal, so staleness is not a
  // failure signal here -- off-by-design rather than a probe.
  '/api/fleet/detect-presence': { offByDesign: 'Job-presence detector; writes only when a tracked truck is at a scheduled job site, so gaps are expected and are not a staleness alarm.' },
};

/**
 * Live signals that are NOT scheduled jobs.
 *
 * This list exists because the outage that prompted all of this -- the
 * Monitor desktop agent going silent for two weeks -- is not a cron. A
 * cron-only checker would have missed the exact bug it was built to catch.
 */
export const LIVE_SIGNALS = [
  {
    key: 'monitor/agent-heartbeat',
    kind: 'live',
    label: 'Monitor agents checking in',
    // The agent heartbeats every 60s while running, and legitimately goes
    // quiet when the machine is off. A day of silence from a PAIRED, ACTIVE
    // agent is not "someone went home" -- it is broken or uninstalled.
    // Chris's agent sat at 14 days.
    budgetMinutes: 1440,
    probe: { table: 'monitor_agents', column: 'last_seen_at', filter: { status: 'active' } },
  },
  {
    key: 'fleet/gps-freshness',
    kind: 'live',
    label: 'Vehicle GPS positions',
    // Watch the column the app actually READS. Until 2026-08-16 this probed
    // vehicles.gps_updated_at -- Jobber's feed -- which is exactly why it
    // reported 19 days stale: correct, but about a source the app has now
    // stopped using entirely (Chris: "use FleetSharp only"). Left pointed
    // there it would alarm forever about a column nobody reads, which is how a
    // report earns its way into the ignore pile.
    //
    // This matters more now, not less. FleetSharp is the ONLY source of
    // vehicle position, so there is no second feed to mask an outage: if these
    // pushes stop, every map in the app silently freezes, and this probe is
    // the thing that says so. FleetSharp pushes every few minutes; 3 hours is
    // generous enough for a quiet fleet overnight without hiding a real
    // outage.
    budgetMinutes: 180,
    probe: { table: 'vehicles', column: 'fleetsharp_updated_at' },
  },
];

/**
 * The schedule of every cron in vercel.json, mirrored here.
 *
 * Why a mirror instead of reading vercel.json at runtime: a Vercel serverless
 * function is not guaranteed to have vercel.json in its bundle, and a checker
 * that silently checks NOTHING because a file was missing is worse than no
 * checker. So the expectation lives in code, and
 * test/health-signals.test.mjs asserts this map matches vercel.json exactly --
 * both directions, no missing entries and no orphans. Drift becomes a failing
 * test at development time, which is earlier than a daily email would catch it
 * anyway.
 */
export const CRON_SCHEDULES = {
  "/api/jobber/sync?resource=clients": "0 * * * *",
  "/api/jobber/sync?resource=jobs": "20 * * * *",
  "/api/jobber/sync?resource=invoices": "40 * * * *",
  "/api/jobber/webhook?drain=1": "* * * * *",
  "/api/jobber/sync-extended?resource=quotes": "50 13 * * *",
  "/api/jobber/sync-extended?resource=vehicles": "*/15 * * * *",
  "/api/fleet/record-positions": "*/5 * * * *",
  "/api/fleet/detect-presence": "*/15 * * * *",
  "/api/jobber/sync-extended?resource=requests": "0 14 * * *",
  "/api/jobber/sync-extended?resource=visits": "10 14 * * *",
  "/api/jobber/sync-extended?resource=expenses": "20 14 * * *",
  "/api/jobber/sync-extended?resource=timesheets": "30 14 * * *",
  "/api/jobber/sync-extended?resource=users": "40 14 * * *",
  "/api/jobber/sync-extended?resource=locations": "50 14 * * *",
  "/api/jobber/sync-extended?resource=geocode": "0 15 * * *",
  "/api/import-companycam": "*/15 * * * *",
  "/api/marketing?resource=process_scheduled_sends": "*/15 * * * *",
  "/api/track1?resource=check_new_leads": "*/15 * * * *",
  "/api/health-cron": "30 15 * * *",
  "/api/track1?resource=monitor_prune": "0 8 * * *",
  "/api/track1?resource=workforce_sweep_gone": "* * * * *",
  "/api/jobber/webhook?cleanup=1": "0 4 * * *",
  "/api/reina/scan-change-requests?days=2": "0 */2 * * *",
  "/api/growth?resource=growth_scan": "0 12 * * 1",
  "/api/social-posts?resource=process_scheduled_posts": "*/15 * * * *",
  "/api/marketing?resource=process_review_request_autosend": "0 15 * * *",
  "/api/marketing?resource=process_post_job_thank_you_autosend": "0 12 * * *",
  "/api/marketing?resource=process_service_anniversary_autosend": "15 12 * * *",
  "/api/marketing?resource=process_dormant_reactivation_autosend": "30 12 * * *",
  "/api/marketing?resource=process_maintenance_reminders_autosend": "45 12 * * *",
  "/api/marketing?resource=process_new_lead_followup_autosend": "0 */4 * * *",
  "/api/marketing?resource=process_newsletter_autosend": "0 13 * * *",
  "/api/marketing?resource=process_referral_autosend": "15 13 * * *",
  "/api/automations?resource=missed_call_textback": "*/5 * * * *",
  "/api/automations?resource=invoice_overdue_nudge": "0 14 * * *",
  "/api/schedule/outbox?resource=process": "*/10 * * * *",
  "/api/reina/mail-sweep": "*/10 * * * *",
  "/api/ops-events?resource=sweep": "*/20 * * * *",
};

/** Every scheduled job, as signals ready for evaluateSignals(). */
export function scheduledSignals() {
  return Object.entries(CRON_SCHEDULES).map(([key, schedule]) => {
    const intervalMinutes = expectedIntervalMinutes(schedule);
    return {
      key,
      kind: 'cron',
      schedule,
      intervalMinutes,
      budgetMinutes: stalenessBudgetMinutes(intervalMinutes),
    };
  });
}

/** All signals this app watches: scheduled jobs plus the live ones. */
export function allSignals() {
  return [...scheduledSignals(), ...LIVE_SIGNALS];
}

// --- Evaluation ------------------------------------------------------------

/**
 * Compare what should be happening against what the database says happened.
 *
 * @param {object}   opts
 * @param {Array}    opts.signals   from parseScheduledCrons() + LIVE_SIGNALS
 * @param {object}   opts.evidence  key -> {probe|offByDesign|unverifiable}
 * @param {Function} opts.lookup    async ({table,column,filter}) -> ISO string|null
 * @param {Date}     opts.now
 * @returns {Promise<Array>} one result per signal
 */
export async function evaluateSignals({ signals, evidence = CRON_EVIDENCE, lookup, now = new Date() }) {
  const results = [];
  for (const signal of signals) {
    const rule = signal.probe || signal.offByDesign || signal.unverifiable
      ? signal                    // live signals carry their own rule
      : evidence[signal.key];     // crons look theirs up

    // The anti-drift property: a scheduled job nobody described is a failure,
    // not a silent pass. This is what stops coverage falling behind again.
    if (!rule) {
      results.push({
        ...signal,
        status: STATUS.UNCOVERED,
        detail: 'Scheduled in vercel.json but absent from the evidence registry -- nobody has said how to tell whether it ran. Add an entry to CRON_EVIDENCE in api/_lib/health-signals.js.',
      });
      continue;
    }

    if (rule.offByDesign) {
      results.push({ ...signal, status: STATUS.OFF_BY_DESIGN, detail: rule.offByDesign });
      continue;
    }
    if (rule.unverifiable) {
      results.push({ ...signal, status: STATUS.UNVERIFIABLE, detail: rule.unverifiable });
      continue;
    }

    let lastSeen = null;
    try {
      lastSeen = await lookup(rule.probe);
    } catch (e) {
      results.push({
        ...signal,
        status: STATUS.UNVERIFIABLE,
        detail: `Could not read ${rule.probe.table}.${rule.probe.column}: ${e && e.message ? e.message : e}`,
      });
      continue;
    }

    if (!lastSeen) {
      results.push({
        ...signal,
        status: STATUS.NEVER,
        detail: `No row has ever been written to ${rule.probe.table}.${rule.probe.column}. If this job has never run, that is the bug.`,
      });
      continue;
    }

    const ageMinutes = Math.round((now.getTime() - new Date(lastSeen).getTime()) / 60000);
    const budget = signal.budgetMinutes;
    results.push({
      ...signal,
      status: ageMinutes > budget ? STATUS.STALE : STATUS.OK,
      lastSeen,
      ageMinutes,
      detail: `${rule.probe.table}.${rule.probe.column} last moved ${formatAge(ageMinutes)} ago (allowed: ${formatAge(budget)}).`,
    });
  }
  return results;
}

export function formatAge(minutes) {
  if (!Number.isFinite(minutes)) return 'unknown';
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Roll results up into the one line a human should read first. */
export function summarize(results) {
  const by = (s) => results.filter((r) => r.status === s);
  const alarms = results.filter((r) => ALARM_STATUSES.includes(r.status));
  return {
    total: results.length,
    ok: by(STATUS.OK).length,
    stale: by(STATUS.STALE).length,
    never: by(STATUS.NEVER).length,
    uncovered: by(STATUS.UNCOVERED).length,
    offByDesign: by(STATUS.OFF_BY_DESIGN).length,
    unverifiable: by(STATUS.UNVERIFIABLE).length,
    alarms,
    healthy: alarms.length === 0,
    headline: alarms.length === 0
      ? 'All watched signals are current.'
      : `${alarms.length} signal${alarms.length === 1 ? '' : 's'} not running: ${alarms.map((a) => a.key).join(', ')}`,
  };
}

/** Build a PostgREST lookup bound to a health-cron style sbGet(). */
export function postgrestLookup(sbGet) {
  return async ({ table, column, filter }) => {
    const params = [`select=${column}`, `order=${column}.desc`, 'limit=1', `${column}=not.is.null`];
    for (const [k, v] of Object.entries(filter || {})) params.push(`${k}=eq.${encodeURIComponent(v)}`);
    const { ok, rows } = await sbGet(`${table}?${params.join('&')}`);
    if (!ok) throw new Error(`query failed for ${table}`);
    return (rows && rows[0] && rows[0][column]) || null;
  };
}
